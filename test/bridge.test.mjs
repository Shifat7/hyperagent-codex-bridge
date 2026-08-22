import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer } from '../src/bridge.mjs';
import { createMemoryIdempotencyManager } from './support/memory-state.mjs';

const agent = { id: 'agent-sol-123456', name: 'Sol Coder', description: 'Sol coding agent', model: 'openai/gpt-5.6-sol' };
const AUTH = { authorization: 'Bearer test-local-token-12345678901234567890' };

function createHarness(reply) {
  const calls = [];
  const audits = [];
  const logs = [];
  const factory = () => ({
    async listAgents() { return [agent]; },
    async createThread(agentId, prompt) {
      calls.push({ agentId, prompt });
      return 'thread_test_123';
    },
    async waitForThread() {
      return { text: typeof reply === 'function' ? reply(calls.at(-1)) : reply, status: 'completed', thread: {} };
    },
    async close() {}
  });
  const config = {
    bridgeHost: '127.0.0.1',
    bridgePort: 0,
    aliases: {},
    exposeAllAgents: true,
    defaultAgentId: null,
    runTimeoutMs: 300000,
    pollIntervalMs: 5,
    localApiToken: 'test-local-token-12345678901234567890'
  };
  return { bridge: new BridgeServer(config, { clientFactory: factory, auditWriter: async event => audits.push(event), logWriter: async event => logs.push(event), budgetGuard: async () => ({ used: 1, committed: 1, reserved: 0, limit: 20, remaining: 19 }), idempotencyManager: createMemoryIdempotencyManager() }), calls, audits, logs };
}

async function withBridge(reply, fn) {
  const harness = createHarness(reply);
  await harness.bridge.start();
  const address = harness.bridge.server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`, harness);
  } finally {
    await harness.bridge.close();
  }
}

test('health and models endpoints expose reachable agents', async () => {
  await withBridge('{"type":"final","text":"ok"}', async base => {
    const health = await fetch(`${base}/health`).then(response => response.json());
    assert.equal(health.ok, true);
    const response = await fetch(`${base}/v1/models`, { headers: AUTH });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('etag'), /^"/);
    const data = await response.json();
    assert.equal(data.models[0].slug, 'hyperagent/sol-coder');
    assert.equal(data.data[0].owned_by, 'hyperagent');

    const cached = await fetch(`${base}/v1/models`, { headers: { ...AUTH, 'if-none-match': response.headers.get('etag') } });
    assert.equal(cached.status, 304);
  });
});

test('models and responses require the local bearer token', async () => {
  await withBridge('{"type":"final","text":"ok"}', async base => {
    const models = await fetch(`${base}/v1/models`);
    assert.equal(models.status, 401);
    assert.match(models.headers.get('www-authenticate'), /^Bearer/);
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test' })
    });
    assert.equal(response.status, 401);
  });
});

test('streaming Responses endpoint returns assistant output and trace metadata', async () => {
  await withBridge('{"type":"final","text":"route works"}', async (base, harness) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'hyperagent/sol-coder',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
        tools: [],
        stream: true
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-hyperagent-thread-id'), 'thread_test_123');
    const text = await response.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /route works/);
    assert.match(text, /event: response\.completed/);
    assert.equal(harness.calls[0].agentId, agent.id);
    assert.match(harness.calls[0].prompt, /Act as the reasoning\/model backend/);
    assert.deepEqual(harness.audits.map(item => item.event), ['request_reserved', 'thread_created', 'completed']);
    assert.match(harness.audits[1].threadRef, /^thread_[A-Za-z0-9_-]{16}$/);
    assert.doesNotMatch(JSON.stringify(harness.audits), /agent-sol-123456|thread_test_123/);
    assert.match(response.headers.get('x-request-id'), /^req_/);
    assert.equal(response.headers.get('x-usage-source'), 'unavailable');
    assert.doesNotMatch(text, /"usage":\{"input_tokens":0/);
  });
});

test('Responses endpoint maps Hyperagent JSON to a Codex function call', async () => {
  await withBridge('{"type":"function_call","name":"shell","arguments":{"command":"pwd"}}', async base => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'hyperagent/sol-coder',
        input: 'inspect',
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
        stream: true
      })
    });
    const text = await response.text();
    assert.match(text, /"type":"function_call"/);
    assert.match(text, /"name":"shell"/);
    assert.match(text, /\\"command\\":\\"pwd\\"/);
  });
});

test('Responses endpoint accepts namespaced tools supplied through additional_tools', async () => {
  await withBridge('{"type":"function_call","name":"mcp__node_repl__js","arguments":{"code":"1+1"}}', async base => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'hyperagent/sol-coder',
        input: [{
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'namespace', name: 'mcp__node_repl__', tools: [{ type: 'function', name: 'js', parameters: { type: 'object' } }] }]
        }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use Chrome.' }] }],
        stream: true
      })
    });
    const text = await response.text();
    assert.match(text, /"type":"function_call"/);
    assert.match(text, /"name":"mcp__node_repl__js"/);
    assert.doesNotMatch(text, /unavailable function tool/);
  });
});

test('non-streaming Responses endpoint returns a standard response object', async () => {
  await withBridge('{"type":"final","text":"finished"}', async base => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test', stream: false })
    });
    const data = await response.json();
    assert.equal(data.object, 'response');
    assert.equal(data.status, 'completed');
    assert.equal(data.output[0].content[0].text, 'finished');
    assert.equal(data.metadata.hyperagent_thread_id, 'thread_test_123');
    assert.equal(data.metadata.usage_source, 'unavailable');
    assert.equal('usage' in data, false);
  });
});

test('omitting stream selects SSE and only literal false selects JSON', async () => {
  await withBridge('{"type":"final","text":"default stream"}', async base => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test' })
    });
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.completed/);
  });
});

test('request IDs are adapter generated and replay attempts remain independently traceable', async () => {
  await withBridge('{"type":"final","text":"trace"}', async base => {
    const headers = {
      ...AUTH,
      'content-type': 'application/json',
      'idempotency-key': 'request-id-semantics',
      'x-request-id': 'client-controlled-value'
    };
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'same', stream: false });
    const first = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body });
    const firstData = await first.json();
    const firstRequestId = first.headers.get('x-request-id');
    assert.match(firstRequestId, /^req_[a-f0-9]{32}$/);
    assert.notEqual(firstRequestId, 'client-controlled-value');
    assert.equal(firstData.metadata.request_id, firstRequestId);

    const replay = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body });
    const replayData = await replay.json();
    assert.match(replay.headers.get('x-request-id'), /^req_[a-f0-9]{32}$/);
    assert.notEqual(replay.headers.get('x-request-id'), firstRequestId);
    assert.equal(replayData.metadata.request_id, firstRequestId);
    assert.equal(replayData.id, firstData.id);
  });
});

test('upstream failures are sanitized in JSON and SSE error responses', async () => {
  const marker = 'private-upstream-error-agent-123-thread-456';
  const preflight = createHarness('{"type":"final","text":"unused"}');
  preflight.bridge.clientFactory = () => ({
    async listAgents() { return [agent]; },
    async createThread() {
      const error = new Error(marker);
      error.dispatchState = 'not_dispatched';
      throw error;
    },
    async close() {}
  });
  await preflight.bridge.start();
  try {
    const base = `http://127.0.0.1:${preflight.bridge.server.address().port}`;
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test', stream: false })
    });
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), new RegExp(marker));
  } finally {
    await preflight.bridge.close();
  }

  const streaming = createHarness('{"type":"final","text":"unused"}');
  streaming.bridge.clientFactory = () => ({
    async listAgents() { return [agent]; },
    async createThread() { return 'thread_private_failure'; },
    async waitForThread() { throw new Error(marker); },
    async close() {}
  });
  await streaming.bridge.start();
  try {
    const base = `http://127.0.0.1:${streaming.bridge.server.address().port}`;
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test' })
    });
    const text = await response.text();
    assert.match(text, /event: response\.failed/);
    assert.doesNotMatch(text, new RegExp(marker));
  } finally {
    await streaming.bridge.close();
  }
});

test('proven pre-dispatch failures release reservations and permit an idempotent retry', async () => {
  const events = [];
  let attempts = 0;
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    localApiToken: 'test-local-token-12345678901234567890'
  }, {
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('local setup failed');
          error.dispatchState = 'not_dispatched';
          throw error;
        }
        return 'thread_retry_success';
      },
      async waitForThread() { return { text: '{"type":"final","text":"ok"}' }; },
      async close() {}
    }),
    auditWriter: async () => {}, logWriter: async () => {},
    idempotencyManager: createMemoryIdempotencyManager(),
    budgetManager: {
      async reserve() { events.push('reserve'); return { id: `reservation_${attempts}` }; },
      async dispatch(value) { events.push('dispatch'); return value; },
      async commit(value) { events.push('commit'); return { ...value, committed: 1, limit: 6 }; },
      async release(value, _config, options) { events.push(`release:${options.provenPreDispatch}`); return value; },
      async status() { return { remaining: 6 }; },
      async reconcile() { return { remaining: 6 }; }
    }
  });
  await bridge.start();
  try {
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const headers = { ...AUTH, 'content-type': 'application/json', 'idempotency-key': 'safe-retry' };
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test', stream: false });
    assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST', headers, body })).status, 500);
    assert.equal((await fetch(`${base}/v1/responses`, { method: 'POST', headers, body })).status, 200);
    assert.deepEqual(events, ['reserve', 'dispatch', 'release:true', 'reserve', 'dispatch', 'commit']);
  } finally {
    await bridge.close();
  }
});

test('indeterminate create_thread outcomes survive a gateway restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hacb-bridge-idempotency-'));
  const previous = process.env.HACB_HOME;
  process.env.HACB_HOME = home;
  const config = {
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    localApiToken: 'test-local-token-12345678901234567890', maxRequestsPerDay: 6
  };
  const options = {
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() {
        const error = new Error('socket closed after dispatch');
        error.dispatchState = 'indeterminate';
        throw error;
      },
      async close() {}
    }),
    auditWriter: async () => {}, logWriter: async () => {}
  };
  try {
    const first = new BridgeServer(config, options);
    await first.start();
    const headers = { ...AUTH, 'content-type': 'application/json', 'idempotency-key': 'restart-key' };
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'test', stream: false });
    const firstBase = `http://127.0.0.1:${first.server.address().port}`;
    assert.equal((await fetch(`${firstBase}/v1/responses`, { method: 'POST', headers, body })).status, 500);
    await first.close();

    let redispatched = 0;
    const second = new BridgeServer(config, {
      ...options,
      clientFactory: () => ({
        async listAgents() { return [agent]; },
        async createThread() { redispatched += 1; return 'thread_duplicate'; },
        async close() {}
      })
    });
    await second.start();
    try {
      const secondBase = `http://127.0.0.1:${second.server.address().port}`;
      const response = await fetch(`${secondBase}/v1/responses`, { method: 'POST', headers, body });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'idempotency_indeterminate');
      assert.equal(redispatched, 0);
    } finally {
      await second.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = previous;
  }
});

test('structured gateway logs exclude bearer tokens, prompts, and model output', async () => {
  await withBridge('{"type":"final","text":"private-output-marker"}', async (base, harness) => {
    await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'private-prompt-marker', stream: false })
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const serialized = JSON.stringify(harness.logs);
    assert.match(serialized, /http_request_completed/);
    assert.doesNotMatch(serialized, /test-local-token/);
    assert.doesNotMatch(serialized, /private-prompt-marker/);
    assert.doesNotMatch(serialized, /private-output-marker/);
  });
});

test('Idempotency-Key replays a completed response without another Hyperagent request', async () => {
  await withBridge('{"type":"final","text":"once"}', async (base, harness) => {
    const headers = { ...AUTH, 'content-type': 'application/json', 'idempotency-key': 'retry-key-1' };
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'same', stream: false });
    const first = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body });
    const firstData = await first.json();
    const second = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body });
    const secondData = await second.json();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-idempotency-replayed'), 'true');
    assert.equal(secondData.id, firstData.id);
    assert.equal(harness.calls.length, 1);

    const conflict = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'different', stream: false })
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'idempotency_conflict');
  });
});

test('concurrent idempotent requests fail closed instead of dispatching twice', async () => {
  let release;
  let started;
  const threadStarted = new Promise(resolve => { started = resolve; });
  const completion = new Promise(resolve => { release = resolve; });
  let createCount = 0;
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    defaultAgentId: null, localApiToken: 'test-local-token-12345678901234567890'
  }, {
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() { createCount += 1; started(); return 'thread_idempotent_123'; },
      async waitForThread() { await completion; return { text: '{"type":"final","text":"done"}' }; },
      async close() {}
    }),
    auditWriter: async () => {}, logWriter: async () => {}, idempotencyManager: createMemoryIdempotencyManager(),
    budgetGuard: async () => ({ used: 1, committed: 1, reserved: 0, limit: 6, remaining: 5 })
  });
  await bridge.start();
  try {
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const headers = { ...AUTH, 'content-type': 'application/json', 'idempotency-key': 'concurrent-key' };
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'same', stream: false });
    const first = fetch(`${base}/v1/responses`, { method: 'POST', headers, body });
    await threadStarted;
    const duplicate = await fetch(`${base}/v1/responses`, { method: 'POST', headers, body });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'idempotency_indeterminate');
    release();
    assert.equal((await first).status, 200);
    assert.equal(createCount, 1);
  } finally {
    release();
    await bridge.close();
  }
});

test('readiness checks provider reachability and remaining local budget', async () => {
  const harness = createHarness('{"type":"final","text":"ok"}');
  harness.bridge.budgetManager.status = async () => ({ used: 0, committed: 0, reserved: 0, limit: 6, remaining: 6 });
  await harness.bridge.start();
  const base = `http://127.0.0.1:${harness.bridge.server.address().port}`;
  try {
    const response = await fetch(`${base}/ready`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ready, true);
    harness.bridge.budgetManager.status = async () => ({ used: 6, committed: 6, reserved: 0, limit: 6, remaining: 0 });
    const exhausted = await fetch(`${base}/ready`);
    assert.equal(exhausted.status, 503);
  } finally {
    await harness.bridge.close();
  }
});

test('non-loopback gateway binds fail closed', async () => {
  const harness = createHarness('{"type":"final","text":"ok"}');
  harness.bridge.config.bridgeHost = '0.0.0.0';
  await assert.rejects(() => harness.bridge.start(), /Refusing to bind/);
});

test('client disconnect cancels local polling and conservatively keeps dispatched budget committed', async () => {
  const audits = [];
  const budgetEvents = [];
  let pollingCancelled;
  const cancelled = new Promise(resolve => { pollingCancelled = resolve; });
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1',
    bridgePort: 0,
    aliases: {},
    exposeAllAgents: true,
    defaultAgentId: null,
    localApiToken: 'test-local-token-12345678901234567890'
  }, {
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() { return 'thread_cancel_123'; },
      async waitForThread(_threadId, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            pollingCancelled();
            reject(signal.reason);
          }, { once: true });
        });
      },
      async close() {}
    }),
    auditWriter: async event => audits.push(event), idempotencyManager: createMemoryIdempotencyManager(),
    logWriter: async () => {},
    budgetManager: {
      async reserve() {
        budgetEvents.push('reserved');
        return { id: 'budget_cancel', used: 1, committed: 0, reserved: 1, limit: 6, remaining: 5 };
      },
      async commit(reservation) {
        budgetEvents.push('committed');
        return { ...reservation, committed: 1, reserved: 0 };
      },
      async release(reservation) {
        budgetEvents.push('released');
        return reservation;
      },
      async status() { return { remaining: 5 }; }
    }
  });
  await bridge.start();
  try {
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'cancel me', stream: true });
    const response = await new Promise((resolve, reject) => {
      const clientRequest = httpRequest(`${base}/v1/responses`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, resolve);
      clientRequest.on('error', reject);
      clientRequest.end(body);
    });
    assert.equal(response.statusCode, 200);
    response.destroy();
    await cancelled;
    for (let attempt = 0; attempt < 20 && !audits.some(item => item.event === 'cancelled'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(budgetEvents, ['reserved', 'committed']);
    const receipt = audits.find(item => item.event === 'cancelled');
    assert.equal(receipt.errorCode, 'client_disconnected');
    assert.equal(receipt.dispatched, true);
    assert.equal(receipt.cancellationScope, 'local_polling_only');
  } finally {
    await bridge.close();
  }
});

test('disconnect during preflight never reserves budget or creates a Hyperagent thread', async () => {
  let releaseAgents;
  let agentsStarted;
  const started = new Promise(resolve => { agentsStarted = resolve; });
  const agentsReady = new Promise(resolve => { releaseAgents = resolve; });
  let created = 0;
  let reserved = 0;
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    defaultAgentId: null, localApiToken: 'test-local-token-12345678901234567890'
  }, {
    clientFactory: () => ({
      async listAgents() { agentsStarted(); await agentsReady; return [agent]; },
      async createThread() { created += 1; return 'thread_should_not_exist'; },
      async close() {}
    }),
    auditWriter: async () => {}, logWriter: async () => {}, idempotencyManager: createMemoryIdempotencyManager(),
    budgetManager: {
      async reserve() { reserved += 1; return { id: 'unexpected' }; },
      async commit(value) { return value; }, async release(value) { return value; },
      async status() { return { remaining: 1 }; }
    }
  });
  await bridge.start();
  try {
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'stop before dispatch' });
    let clientRequest;
    const pending = new Promise(resolve => {
      clientRequest = httpRequest(`${base}/v1/responses`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      });
      clientRequest.on('error', resolve);
      clientRequest.end(body);
    });
    await started;
    clientRequest.destroy();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 10));
    releaseAgents();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reserved, 0);
    assert.equal(created, 0);
  } finally {
    releaseAgents();
    await bridge.close();
  }
});

test('disconnect while awaiting an idempotency claim cannot reserve or dispatch', async () => {
  let resolveClaim;
  let claimStarted;
  const started = new Promise(resolve => { claimStarted = resolve; });
  const claimReady = new Promise(resolve => { resolveClaim = resolve; });
  let deleted = 0;
  let created = 0;
  let reserved = 0;
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    defaultAgentId: null, localApiToken: 'test-local-token-12345678901234567890'
  }, {
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() { created += 1; return 'thread_should_not_exist'; },
      async close() {}
    }),
    auditWriter: async () => {},
    logWriter: async () => {},
    idempotencyManager: {
      async claim() {
        claimStarted();
        await claimReady;
        return { claimed: true };
      },
      async delete() { deleted += 1; },
      async update() {},
      async reconcile() {}
    },
    budgetManager: {
      async reserve() { reserved += 1; return { id: 'unexpected' }; },
      async commit(value) { return value; },
      async release(value) { return value; },
      async status() { return { remaining: 1 }; }
    }
  });
  await bridge.start();
  try {
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'stop during claim' });
    let clientRequest;
    const pending = new Promise(resolve => {
      clientRequest = httpRequest(`${base}/v1/responses`, {
        method: 'POST',
        headers: {
          ...AUTH,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'idempotency-key': 'disconnect-during-claim'
        }
      });
      clientRequest.on('error', resolve);
      clientRequest.end(body);
    });
    await started;
    clientRequest.destroy();
    await pending;
    await new Promise(resolve => setTimeout(resolve, 10));
    resolveClaim();
    for (let attempt = 0; attempt < 40 && deleted === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(deleted, 1);
    assert.equal(reserved, 0);
    assert.equal(created, 0);
  } finally {
    resolveClaim();
    await bridge.close();
  }
});

test('local preprocessor rejects, falls back, and fails closed per config', async () => {
  const baseConfig = {
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    localApiToken: 'test-local-token-12345678901234567890'
  };
  const factory = {
    async listAgents() { return [agent]; },
    async createThread() { throw new Error('must never dispatch'); },
    async close() {}
  };
  const options = extras => ({
    clientFactory: () => ({ ...factory }),
    auditWriter: async () => {}, logWriter: async () => {},
    idempotencyManager: createMemoryIdempotencyManager(),
    budgetGuard: async () => ({ used: 0, committed: 0, reserved: 0, limit: 6, remaining: 6 }),
    ...extras
  });

  const rejecting = new BridgeServer(baseConfig, options({
    preprocessor: async payload => {
      assert.doesNotMatch(JSON.stringify(payload), /private-prompt-marker/);
      return { action: 'reject', reason: 'no-op request' };
    }
  }));
  await rejecting.start();
  try {
    const response = await fetch(`http://127.0.0.1:${rejecting.server.address().port}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'private-prompt-marker', stream: false })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'preprocessor_rejected');
  } finally {
    await rejecting.close();
  }

  let called = false;
  const inactive = new BridgeServer(baseConfig, options({
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() { return 'thread_preprocessor_pass'; },
      async waitForThread() { return { text: '{"type":"final","text":"ok"}' }; },
      async close() {}
    }),
    preprocessor: async () => { called = true; return { action: 'allow' }; }
  }));
  await inactive.start();
  try {
    const response = await fetch(`http://127.0.0.1:${inactive.server.address().port}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'normal', stream: false })
    });
    assert.equal(response.status, 200);
    assert.equal(called, true);
  } finally {
    await inactive.close();
  }

  const strict = new BridgeServer(
    { ...baseConfig, enableLocalPreprocessor: true, localPreprocessorFailureMode: 'fail_closed' },
    options({ preprocessor: async () => { throw Object.assign(new Error('boom'), { code: 'preprocessor_failed' }); } })
  );
  await strict.start();
  try {
    const response = await fetch(`http://127.0.0.1:${strict.server.address().port}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'strict', stream: false })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'preprocessor_failed');
  } finally {
    await strict.close();
  }
});
