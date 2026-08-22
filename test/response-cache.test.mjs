import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookupResponseCache, storeResponseCache } from '../src/config.mjs';

const RESULT = { output: { type: 'final', text: 'once' }, model: 'hyperagent/sol-coder' };

async function withCacheHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'hacb-response-cache-'));
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

test('stored fingerprints replay the exact completed result', async () => {
  await withCacheHome(async () => {
    const config = { enableResponseCache: true, responseCacheTtlMs: 60000, responseCacheMaxEntries: 8 };
    assert.equal(await lookupResponseCache('fp_missing', config), null);
    await storeResponseCache('fp_a', RESULT, config);
    const hit = await lookupResponseCache('fp_a', config);
    assert.deepEqual(hit.result, RESULT);
    assert.ok(hit.completedAt <= Date.now());
  });
});

test('expired entries miss and are pruned from the cache file', async () => {
  await withCacheHome(async () => {
    const config = { enableResponseCache: true, responseCacheTtlMs: 1000, responseCacheMaxEntries: 8 };
    await storeResponseCache('fp_old', RESULT, config, { completedAt: Date.now() - 5000 });
    assert.equal(await lookupResponseCache('fp_old', config), null);
    await lookupResponseCache('fp_trigger_prune', config);
    assert.equal(await lookupResponseCache('fp_old', config), null);
    await storeResponseCache('fp_new', RESULT, config, { completedAt: Date.now() });
    assert.deepEqual((await lookupResponseCache('fp_new', config)).result, RESULT);
  });
});

test('the cache evicts oldest entries beyond maxEntries', async () => {
  await withCacheHome(async () => {
    const config = { enableResponseCache: true, responseCacheTtlMs: 600000, responseCacheMaxEntries: 2 };
    await storeResponseCache('fp_1', { n: 1 }, config, { completedAt: Date.now() - 4000 });
    await storeResponseCache('fp_2', { n: 2 }, config, { completedAt: Date.now() - 2000 });
    await storeResponseCache('fp_3', { n: 3 }, config, { completedAt: Date.now() });
    assert.equal(await lookupResponseCache('fp_1', config), null);
    assert.deepEqual((await lookupResponseCache('fp_2', config)).result, { n: 2 });
    assert.deepEqual((await lookupResponseCache('fp_3', config)).result, { n: 3 });
  });
});
