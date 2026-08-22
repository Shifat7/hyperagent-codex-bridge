import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadCheckpoint } from '../src/checkpoint.mjs';

const ROOT = process.cwd();
const p = (...parts) => resolve(ROOT, ...parts);

const DEFAULT_FILES = ['CODEX_STATE.md', 'TASK_PLAN.md', 'TEST_LOG.md', 'DECISIONS.md'];

function fakeFs(files) {
  const reads = [];
  const byPath = new Map(Object.entries(files).map(([name, content]) => [p(name), content]));
  return async path => {
    reads.push(path);
    if (byPath.has(path)) return byPath.get(path);
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
}

test('checkpoint loader reads only existing configured files and labels them', async () => {
  const reader = fakeFs({
    '.hacb/CODEX_STATE.md': '# Codex State\nGoal: ship PRs',
    '.hacb/DECISIONS.md': 'Use TDD'
  });
  const result = await loadCheckpoint({
    enableCheckpointMemory: true,
    checkpointDir: '.hacb',
    checkpointFiles: DEFAULT_FILES
  }, reader);
  assert.match(result.text, /## CODEX_STATE\.md\n# Codex State\nGoal: ship PRs/);
  assert.match(result.text, /## DECISIONS\.md\nUse TDD/);
  assert.doesNotMatch(result.text, /TASK_PLAN/);
  assert.equal(result.files.length, 2);
});

test('checkpoint content is capped at maxCheckpointChars', async () => {
  const big = 'x'.repeat(5000);
  const reader = fakeFs({ '.hacb/CODEX_STATE.md': big });
  const result = await loadCheckpoint({
    enableCheckpointMemory: true,
    checkpointDir: '.hacb',
    checkpointFiles: ['CODEX_STATE.md'],
    maxCheckpointChars: 1000
  }, reader);
  assert.ok(result.text.length <= 1050);
  assert.match(result.text, /\[checkpoint truncated by Hyperagent Codex Bridge\]/);
});

test('path traversal in configured file names is ignored', async () => {
  const reads = [];
  const reader = async path => {
    reads.push(path);
    if (String(path).endsWith('secrets.txt')) return 'secret';
    if (String(path).endsWith('CODEX_STATE.md')) return 'goal state';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const result = await loadCheckpoint({
    enableCheckpointMemory: true,
    checkpointDir: '.hacb',
    checkpointFiles: ['../secrets.txt', 'CODEX_STATE.md']
  }, reader);
  assert.equal(result.files.length, 1);
  assert.deepEqual(reads, [p('.hacb', 'CODEX_STATE.md')]);
  assert.doesNotMatch(result.text, /secret/);
});

test('disabled checkpoints never touch the filesystem', async () => {
  let calls = 0;
  const reader = async () => {
    calls += 1;
    return 'unused';
  };
  const result = await loadCheckpoint({ enableCheckpointMemory: false, checkpointDir: '.hacb', checkpointFiles: DEFAULT_FILES }, reader);
  assert.equal(calls, 0);
  assert.equal(result.text, '');
});
