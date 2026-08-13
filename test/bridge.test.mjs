import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeServer } from '../src/bridge.mjs';

const agent = { id: 'agent-sol-123456', name: 'Sol Coder', description: 'Sol coding agent', model: 'openai/gpt-5.6-sol' };
const AUTH = { authorization: 'Bearer test-local-token-12345678901234567890' };

function createHarness(reply) {
  const calls = [];
  const audits = [];
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
  return { bridge: new BridgeServer(config, { clientFactory: factory, auditWriter: async event => audits.push(event), budgetGuard: async () => ({ used: 1, limit: 20, remaining: 19 }) }), calls, audits };
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
    assert.deepEqual(harness.audits.map(item => item.event), ['request', 'thread_created', 'completed']);
    assert.equal(harness.audits[1].threadId, 'thread_test_123');
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
  });
});

test('malformed relay output fails closed with a deterministic redacted receipt', async () => {
  await withBridge('I cannot access your files.', async (base, harness) => {
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
    assert.match(text, /event: response\.failed/);
    assert.match(text, /relay_invalid_json/);
    assert.equal(harness.audits.at(-1).event, 'failed');
    assert.equal(harness.audits.at(-1).errorCode, 'relay_invalid_json');
    assert.equal('error' in harness.audits.at(-1), false);
    assert.doesNotMatch(JSON.stringify(harness.audits), /I cannot access/);
  });
});
