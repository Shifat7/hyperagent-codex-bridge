import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalPreprocessor } from '../src/preprocessor.mjs';

function fakeSpawn(stdout, { delayMs = 0, exitCode = 0 } = {}) {
  const calls = [];
  const impl = (command, options) => {
    calls.push({ command, options });
    return {
      stdin: {
        write(chunk) { calls.at(-1).stdin = String(chunk); },
        end() {}
      },
      stdout: { on(event, handler) { if (event === 'data') setTimeout(() => handler(Buffer.from(stdout)), delayMs); } },
      stderr: { on() {} },
      on(event, handler) {
        if (event === 'close') setTimeout(() => handler(exitCode), delayMs + 5);
      },
      kill() { calls.at(-1).killed = true; }
    };
  };
  return { impl, calls };
}

const ENABLED = {
  enableLocalPreprocessor: true,
  localPreprocessorCommand: 'hacb-guard',
  localPreprocessorTimeoutMs: 1000,
  localPreprocessorFailureMode: 'fallback'
};

test('disabled or unconfigured preprocessors never spawn anything', async () => {
  for (const config of [{}, { enableLocalPreprocessor: false, localPreprocessorCommand: 'x' }, { enableLocalPreprocessor: true }]) {
    const { impl, calls } = fakeSpawn('');
    const result = await runLocalPreprocessor(config, { requestId: 'req_1' }, { spawnImpl: impl });
    assert.deepEqual(result, { action: 'allow', skipped: true });
    assert.equal(calls.length, 0);
  }
});

test('sanitised payload only and explicit decisions are honoured', async () => {
  const allowSpawn = fakeSpawn('{"action":"allow"}');
  const allow = await runLocalPreprocessor(ENABLED, { requestId: 'req_a', model: 'm', promptChars: 10 }, { spawnImpl: allowSpawn.impl });
  assert.equal(allow.action, 'allow');
  assert.match(allowSpawn.calls[0].stdin, /"promptChars":10/);
  for (const forbidden of ['rawPrompt', 'conversation', 'secret']) {
    assert.doesNotMatch(allowSpawn.calls[0].stdin, new RegExp(forbidden));
  }

  const rejectSpawn = fakeSpawn('{"action":"reject","reason":"no-op request"}');
  const reject = await runLocalPreprocessor(ENABLED, { requestId: 'req_b' }, { spawnImpl: rejectSpawn.impl });
  assert.equal(reject.action, 'reject');
  assert.equal(reject.reason, 'no-op request');
});

test('timeouts fall back safely by default and fail closed when configured', async () => {
  const slowSpawn = fakeSpawn('{"action":"allow"}', { delayMs: 5000 });
  const fallback = await runLocalPreprocessor({ ...ENABLED, localPreprocessorTimeoutMs: 30 }, { requestId: 'req_c' }, { spawnImpl: slowSpawn.impl });
  assert.deepEqual(fallback, { action: 'allow', fallback: true, reason: 'timeout' });
  assert.equal(slowSpawn.calls[0].killed, true);

  const strict = await assert.rejects(
    () => runLocalPreprocessor(
      { ...ENABLED, localPreprocessorTimeoutMs: 30, localPreprocessorFailureMode: 'fail_closed' },
      { requestId: 'req_d' },
      { spawnImpl: slowSpawn.impl }
    ),
    error => error.code === 'preprocessor_failed'
  );
});

test('invalid JSON output follows the failure mode too', async () => {
  const garbage = fakeSpawn('not json at all');
  const fallback = await runLocalPreprocessor(ENABLED, { requestId: 'req_e' }, { spawnImpl: garbage.impl });
  assert.deepEqual(fallback, { action: 'allow', fallback: true, reason: 'invalid_output' });

  await assert.rejects(
    () => runLocalPreprocessor({ ...ENABLED, localPreprocessorFailureMode: 'fail_closed' }, { requestId: 'req_f' }, { spawnImpl: garbage.impl }),
    error => error.code === 'preprocessor_failed'
  );
});
