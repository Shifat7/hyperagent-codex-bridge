import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient } from '../src/openrouter.mjs';
import { createUpstreamClient } from '../src/bridge.mjs';
import { HyperagentClient } from '../src/hyperagent.mjs';
import { buildAgentModels, resolveAgent } from '../src/protocol.mjs';

const BASE_CONFIG = {
  upstream: 'openrouter',
  openrouterBaseUrl: 'https://openrouter.example/api/v1',
  openrouterModel: 'test/model-x',
  openrouterApiKey: 'test-openrouter-key',
  runTimeoutMs: 5000
};

function jsonResponder(payload, status = 200) {
  return async (url, options) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  });
}

test('openrouter client exposes a resolvable agent backed by the configured model', async () => {
  const client = new OpenRouterClient(BASE_CONFIG);
  try {
    const agents = await client.listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].model, 'test/model-x');
    const models = buildAgentModels(agents);
    const resolved = resolveAgent(models[0].slug, agents, {});
    assert.equal(resolved.id, agents[0].id);
  } finally {
    await client.close();
  }
});

test('waitForThread relays the stored prompt to chat completions and parses the reply', async () => {
  const calls = [];
  const client = new OpenRouterClient(BASE_CONFIG, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponder({
        choices: [{ message: { role: 'assistant', content: '{"type":"final","text":"done"}' } }]
      })(url, options);
    }
  });
  try {
    const threadId = await client.createThread('agent-x', 'RELAY PROMPT BODY');
    assert.match(threadId, /^or_[a-z0-9]{12,}$/);
    const result = await client.waitForThread(threadId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.example/api/v1/chat/completions');
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-openrouter-key');
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, 'test/model-x');
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'RELAY PROMPT BODY' }]);
    assert.equal(result.text, '{"type":"final","text":"done"}');
    assert.equal(result.status, 'completed');
  } finally {
    await client.close();
  }
});

test('missing api key fails closed without any network call', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  let networkCalls = 0;
  try {
    const client = new OpenRouterClient({ ...BASE_CONFIG, openrouterApiKey: null }, {
      fetchImpl: async () => { networkCalls += 1; return jsonResponder({})(null, null); }
    });
    const threadId = await client.createThread('agent-x', 'prompt');
    await assert.rejects(
      () => client.waitForThread(threadId),
      error => error.code === 'upstream_not_configured' && error.status === 503
    );
    assert.equal(networkCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test('upstream errors surface as upstream_error with the upstream status', async () => {
  const client = new OpenRouterClient(BASE_CONFIG, { fetchImpl: jsonResponder({ error: 'nope' }, 401) });
  try {
    const threadId = await client.createThread('agent-x', 'prompt');
    await assert.rejects(
      () => client.waitForThread(threadId),
      error => error.code === 'upstream_error' && error.status === 401
    );
  } finally {
    await client.close();
  }
});

test('client aborts when the request signal fires and cleans up pending state on close', async () => {
  const controller = new AbortController();
  const client = new OpenRouterClient(BASE_CONFIG, {
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () =>
        reject(options.signal.reason || new Error('aborted')), { once: true });
    })
  });
  try {
    const threadId = await client.createThread('agent-x', 'slow');
    controller.abort(Object.assign(new Error('Request aborted.'), { code: 'client_disconnected' }));
    await assert.rejects(() => client.waitForThread(threadId, { signal: controller.signal }));
  } finally {
    await client.close();
    assert.equal(client.pending.size, 0);
  }
});

test('bridge selects the upstream client based on config.upstream', () => {
  const openrouter = createUpstreamClient({ ...BASE_CONFIG });
  assert.ok(openrouter instanceof OpenRouterClient);

  const hyperagent = createUpstreamClient({ mcpUrl: 'https://example/api/mcp' });
  assert.ok(hyperagent instanceof HyperagentClient);

  assert.throws(
    () => createUpstreamClient({ upstream: 'carrier-pigeon' }),
    error => /unsupported upstream/i.test(error.message)
  );
});
