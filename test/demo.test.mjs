import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalDemo, runLiveDemo } from '../src/demo.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

test('one-command local demo exercises a real Codex local-tool round trip without credits', { skip: !process.env.CODEX_BIN, timeout: 30000 }, async () => {
  const result = await runLocalDemo({ codexBin: process.env.CODEX_BIN });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'local-no-credit');
  assert.equal(result.localToolRoundTrip, true);
  assert.ok(result.samples >= 2);
  assert.ok(result.receipt.summary.completed >= 2);
});

test('live demo requires explicit spend confirmation before any route call', async () => {
  await assert.rejects(
    () => runLiveDemo({ ...structuredClone(DEFAULT_CONFIG) }),
    /--confirm-spend/
  );
});
