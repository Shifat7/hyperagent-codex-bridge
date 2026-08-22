import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer } from '../src/bridge.mjs';
import { buildRelayPromptWithMetrics, extractClientTools } from '../src/protocol.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { createMemoryIdempotencyManager } from './support/memory-state.mjs';

const agent = { id: 'agent-sol-123456', name: 'Sol Coder', description: 'Sol coding agent', model: 'hyperagent/sol-coder' };
const AUTH = { authorization: 'Bearer test-local-token-12345678901234567890' };

const TOOLBOX = [
  { type: 'function', name: 'shell', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { type: 'function', name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
];

test('cost metrics stay consistent with the minimised prompt and shortlisted tools', () => {
  const body = {
    model: 'hyperagent/sol-coder',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the test suite.' }] }],
    tools: [
      ...TOOLBOX,
      { type: 'function', name: 'browser_click', description: 'Click an element in a browser session.', parameters: { type: 'object' } }
    ]
  };
  const tools = extractClientTools(body, DEFAULT_CONFIG);
  const { prompt, breakdown } = buildRelayPromptWithMetrics(body, agent, DEFAULT_CONFIG, tools);
  const sectionSum = breakdown.sections.relayInstructionChars
    + breakdown.sections.conversationChars
    + breakdown.sections.toolResultChars
    + breakdown.sections.toolSchemaChars;
  assert.equal(sectionSum <= breakdown.totalChars, true);
  assert.equal(breakdown.sections.toolSchemaChars < 4000, true);
  assert.match(prompt, /"shell"/);
  assert.doesNotMatch(prompt, /browser_click/);
  assert.equal(breakdown.estimatedTokens > 0, true);
  assert.equal(breakdown.totalChars >= prompt.length, true);
});

test('checkpoint injection is reflected in payload cost accounting', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hacb-integration-'));
  const previous = process.env.HACB_HOME;
  const previousCwd = process.cwd();
  process.env.HACB_HOME = home;
  process.chdir(home);
  try {
    await mkdir(join(home, '.hacb'), { recursive: true });
    await writeFile(join(home, '.hacb', 'CODEX_STATE.md'), '# Codex State\nGoal: ship PRs\n');
    const { loadCheckpoint } = await import('../src/checkpoint.mjs');
    const checkpointText = (await loadCheckpoint({
      enableCheckpointMemory: true,
      checkpointDir: '.hacb',
      checkpointFiles: ['CODEX_STATE.md']
    }))?.text;
    assert.match(checkpointText, /## CODEX_STATE\.md\n# Codex State/);
    const body = {
      model: 'hyperagent/sol-coder',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }],
      tools: []
    };
    const withoutCheckpoint = buildRelayPromptWithMetrics(body, agent, DEFAULT_CONFIG, []);
    const withCheckpoint = buildRelayPromptWithMetrics(body, agent, DEFAULT_CONFIG, [], checkpointText);
    assert.ok(withCheckpoint.prompt.includes('Project checkpoint:'));
    assert.equal(
      withCheckpoint.breakdown.sections.payloadChars > withoutCheckpoint.breakdown.sections.payloadChars,
      true
    );
    assert.match(withCheckpoint.prompt, /continue/);
  } finally {
    process.chdir(previousCwd);
    if (previous === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

async function integrationBridge(configOverrides = {}, overrides = {}) {
  const audits = [];
  const logs = [];
  let created = 0;
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    localApiToken: 'test-local-token-12345678901234567890',
    maxRequestsPerDay: 20,
    ...configOverrides
  }, {
    clientFactory: () => ({
      async listAgents() { return [agent]; },
      async createThread() { created += 1; return `thread_int_${created}`; },
      async waitForThread() { return { text: '{"type":"final","text":"ok"}' }; },
      async close() {}
    }),
    auditWriter: async event => audits.push(event),
    logWriter: async event => logs.push(event),
    idempotencyManager: createMemoryIdempotencyManager(),
    ...overrides
  });
  await bridge.start();
  return { bridge, audits, logs, createdRef: () => created };
}

test('task-budget exhaustion releases the daily slot and keeps cost fields on the audit trail', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hacb-int-task-'));
  const previous = process.env.HACB_HOME;
  process.env.HACB_HOME = home;
  try {
    const { startTask } = await import('../src/config.mjs');
    await startTask('integration-task', { maxRequestsPerTask: 1, maxPromptCharsPerTask: 1000000 });
    const harness = await integrationBridge();
    try {
      const base = `http://127.0.0.1:${harness.bridge.server.address().port}`;
      const call = () => fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'work', stream: false })
      });
      const first = await call();
      assert.equal(first.status, 200);
      const reservedAudit = harness.audits.find(event => event.event === 'request_reserved');
      assert.equal(typeof reservedAudit.estimatedPromptTokens, 'number');
      assert.equal(typeof reservedAudit.payloadChars, 'number');
      assert.equal(reservedAudit.taskRequests, '1/1');

      const second = await call();
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error.code, 'task_budget_exhausted');
    } finally {
      await harness.bridge.close();
    }
  } finally {
    if (previous === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('cache replay consumes no daily budget slot and skips thread creation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hacb-int-cache-'));
  const previous = process.env.HACB_HOME;
  process.env.HACB_HOME = home;
  try {
    const harness = await integrationBridge({ enableResponseCache: true, responseCacheTtlMs: 600000 });
    try {
      const base = `http://127.0.0.1:${harness.bridge.server.address().port}`;
      const body = JSON.stringify({ model: 'hyperagent/sol-coder', input: 'repeat me', stream: false });
      const first = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body });
      assert.equal(first.status, 200);
      const second = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body });
      assert.equal(second.status, 200);
      assert.equal(second.headers.get('x-response-cache-replayed'), 'true');
      assert.equal(harness.createdRef(), 1);

      for (let index = 0; index < 19; index += 1) {
        const response = await fetch(`${base}/v1/responses`, {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'hyperagent/sol-coder', input: `unique-${index}`, stream: false })
        });
        assert.equal(response.status, 200);
      }
      const overCap = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'hyperagent/sol-coder', input: 'one too many', stream: false })
      });
      assert.equal(overCap.status, 429);
      assert.equal((await overCap.json()).error.code, 'budget_exhausted');
    } finally {
      await harness.bridge.close();
    }
  } finally {
    if (previous === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('multi-tool output renders under agent routing and audit carries route fields', async () => {
  const agents = [
    { id: 'agent-cheap-000001', name: 'cheap-coder', description: 'cheap', model: 'm/cheap' },
    { id: 'agent-debug-000002', name: 'debugger', description: 'debug', model: 'm/debug' }
  ];
  const audits = [];
  const createdFor = [];
  const bridge = new BridgeServer({
    bridgeHost: '127.0.0.1', bridgePort: 0, aliases: {}, exposeAllAgents: true,
    localApiToken: 'test-local-token-12345678901234567890',
    enableAgentRouting: true,
    agentRoutes: { debug_failure: 'debugger' },
    enableMultiToolCalls: true
  }, {
    clientFactory: () => ({
      async listAgents() { return agents; },
      async createThread(agentId) { createdFor.push(agentId); return `thread_${agentId}`; },
      async waitForThread() {
        return { text: '{"type":"function_calls","calls":[{"name":"shell","arguments":{"command":"ls"}},{"name":"read_file","arguments":{"path":"a"}}]}' };
      },
      async close() {}
    }),
    auditWriter: async event => audits.push(event),
    logWriter: async () => {},
    budgetGuard: async () => ({ used: 0, committed: 0, reserved: 0, limit: 20, remaining: 20 }),
    idempotencyManager: createMemoryIdempotencyManager()
  });
  await bridge.start();
  try {
    const base = `http://127.0.0.1:${bridge.server.address().port}`;
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'cheap-coder',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tests fail with AssertionError.' }] }],
        tools: [
          { type: 'function', name: 'shell', description: 'Run shell.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
          { type: 'function', name: 'read_file', description: 'Read file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(createdFor, ['agent-debug-000002']);
    const text = await response.text();
    assert.match(text, /"call_id"/);
    const reserved = audits.find(event => event.event === 'request_reserved');
    assert.equal(reserved.route, 'debug_failure');
    assert.equal(reserved.routeTarget, 'debugger');
  } finally {
    await bridge.close();
  }
});
