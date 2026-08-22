import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getActiveTask,
  reserveTaskRequest,
  startTask,
  stopTask
} from '../src/config.mjs';

const CONFIG = {
  maxRequestsPerTask: 3,
  maxPromptCharsPerTask: 10000,
  warnAtPromptCharsPerTask: 6000
};

async function withTaskHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'hacb-task-budget-'));
  const previous = process.env.HACB_HOME;
  process.env.HACB_HOME = home;
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('task lifecycle persists across independent processes', async () => {
  await withTaskHome(async home => {
    assert.equal(await getActiveTask(), null);
    const started = await startTask('fix-auth-bug');
    assert.equal(started.name, 'fix-auth-bug');
    assert.equal(started.requestCount, 0);

    const status = await getActiveTask();
    assert.equal(status.name, 'fix-auth-bug');

    const stopped = await stopTask();
    assert.equal(stopped.name, 'fix-auth-bug');
    assert.equal(await getActiveTask(), null);

    const raw = JSON.parse(await readFile(join(home, 'tasks.json'), 'utf8'));
    assert.equal(raw.active, null);
    assert.ok(raw.history.includes('fix-auth-bug'));
  });
});

test('request reservations count up to the cap then fail closed', async () => {
  await withTaskHome(async () => {
    await startTask('looping-task', { maxRequestsPerTask: 2 });
    await reserveTaskRequest({ promptChars: 1000 });
    await reserveTaskRequest({ promptChars: 2000 });
    await assert.rejects(
      () => reserveTaskRequest({ promptChars: 500 }),
      error => {
        assert.equal(error.status, 429);
        assert.equal(error.code, 'task_budget_exhausted');
        assert.match(error.message, /task budget is exhausted/);
        return true;
      }
    );
    const task = await getActiveTask();
    assert.equal(task.requestCount, 2);
  });
});

test('prompt char budgets accumulate and trigger warnings before failing closed', async () => {
  await withTaskHome(async () => {
    await startTask('big-prompt-task', { maxRequestsPerTask: 50, maxPromptCharsPerTask: 10000, warnAtPromptCharsPerTask: 6000 });
    const first = await reserveTaskRequest({ promptChars: 4000 });
    assert.equal(first.warned, false);
    const second = await reserveTaskRequest({ promptChars: 3000 });
    assert.equal(second.warned, true);
    await assert.rejects(() => reserveTaskRequest({ promptChars: 4000 }), error => error.code === 'task_budget_exhausted');
    const task = await getActiveTask();
    assert.equal(task.requestCount, 2);
    assert.equal(task.promptChars, 7000);
  });
});

test('without an active task, reservations are no-ops and daily caps stay authoritative', async () => {
  await withTaskHome(async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await reserveTaskRequest({ promptChars: 99999 }, { maxRequestsPerTask: 1, maxPromptCharsPerTask: 10 });
      assert.deepEqual(result, { skipped: true, warned: false });
    }
  });
});

test('stopping a task resets counters for the next one', async () => {
  await withTaskHome(async () => {
    await startTask('one', { maxRequestsPerTask: 1, maxPromptCharsPerTask: 100000 });
    await reserveTaskRequest({ promptChars: 10 });
    await assert.rejects(() => reserveTaskRequest({ promptChars: 10 }), /exhausted/);
    await stopTask();
    await startTask('two', { maxRequestsPerTask: 1, maxPromptCharsPerTask: 100000 });
    const ok = await reserveTaskRequest({ promptChars: 10 });
    assert.equal(ok.skipped, false);
  });
});
