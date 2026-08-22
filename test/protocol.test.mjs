import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentModels,
  buildRelayPrompt,
  extractClientTools,
  modelInfo,
  normalizeInput,
  parseRelayOutput,
  reduceToolOutput,
  resolveAgent,
  slugify,
  sseEvents
} from '../src/protocol.mjs';

const agents = [
  { id: 'agent-sol-123456', name: 'Sol Coder', description: 'GPT 5.6 Sol coding agent', model: 'openai/gpt-5.6-sol' },
  { id: 'agent-fable-654321', name: 'Fable Coder', description: 'Fable coding agent', model: 'claude-fable-5' }
];

test('agent names become stable Hyperagent model slugs', () => {
  assert.equal(slugify('Fàble Coder!'), 'fable-coder');
  const models = buildAgentModels(agents);
  assert.deepEqual(models.map(model => model.slug), ['hyperagent/sol-coder', 'hyperagent/fable-coder']);
});

test('aliases and generated slugs resolve to agents', () => {
  const config = { aliases: { 'hyperagent/sol': agents[0].id }, defaultAgentId: null };
  assert.equal(resolveAgent('hyperagent/sol', agents, config).id, agents[0].id);
  assert.equal(resolveAgent('hyperagent/fable-coder', agents, config).id, agents[1].id);
  assert.throws(() => resolveAgent('hyperagent/missing', agents, config), /Unknown model identifier/);
});

test('model selection fails closed for fallbacks, duplicate names, and ambiguous aliases', () => {
  assert.throws(() => resolveAgent('missing', agents, {
    aliases: {}, defaultAgentId: agents[0].id
  }), error => error.code === 'unknown_model');
  assert.throws(() => buildAgentModels([
    agents[0],
    { ...agents[1], name: 'sol coder' }
  ]), error => error.code === 'duplicate_agent_name');
  assert.throws(() => resolveAgent('hyperagent/sol-coder', agents, {
    aliases: { 'hyperagent/sol-coder': agents[1].id }
  }), error => error.code === 'ambiguous_model_alias');
  assert.throws(() => resolveAgent('hyperagent/sol', agents, {
    aliases: { 'hyperagent/sol': 'unknown-agent' }
  }), error => error.code === 'invalid_model_alias');
});

test('relay prompt strips injected context, bounds history, and defaults to low effort', () => {
  const prompt = buildRelayPrompt({
    model: 'hyperagent/sol-coder',
    instructions: 'Work carefully.',
    reasoning: { effort: 'high' },
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>huge injected skill inventory</skills_instructions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>private local context</environment_context>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the repo.' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'README contents' }
    ],
    tools: [{ type: 'function', name: 'shell', description: 'Run shell', parameters: { type: 'object' } }]
  }, agents[0], { defaultReasoningEffort: 'low', allowClientReasoningEffort: false });
  assert.doesNotMatch(prompt, /Work carefully/);
  assert.doesNotMatch(prompt, /skills_instructions/);
  assert.doesNotMatch(prompt, /private local context/);
  assert.match(prompt, /Inspect the repo/);
  assert.match(prompt, /README contents/);
  assert.match(prompt, /"name":"shell"/);
  assert.match(prompt, /"reasoning_effort":"low"/);
});

test('additional_tools and MCP namespaces are flattened while multi-agent tools are blocked', () => {
  const body = {
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [
        { type: 'namespace', name: 'mcp__node_repl__', description: 'Node tools', tools: [{ type: 'function', name: 'js', description: 'Run JS', parameters: { type: 'object' } }] },
        { type: 'namespace', name: 'multi_agent_v1', description: 'Agents', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] },
        { type: 'tool_search', execution: 'client' }
      ]
    }]
  };
  const tools = extractClientTools(body, { blockMultiAgentTools: true, maxForwardedTools: 32 });
  assert.ok(tools.some(tool => tool.name === 'mcp__node_repl__js'));
  assert.ok(tools.some(tool => tool.type === 'tool_search'));
  assert.ok(!tools.some(tool => tool.name.includes('spawn_agent')));
  assert.deepEqual(
    parseRelayOutput('{"type":"function_call","name":"mcp__node_repl__js","arguments":{"code":"1+1"}}', tools),
    { type: 'function_call', name: 'mcp__node_repl__js', arguments: '{"code":"1+1"}' }
  );
});

test('namespaces reject non-function children instead of silently omitting them', () => {
  assert.throws(
    () => extractClientTools({
      tools: [{
        type: 'namespace',
        name: 'invalid',
        tools: [{ type: 'custom', name: 'silently_dropped_before' }]
      }]
    }),
    error => error.status === 400
      && error.code === 'invalid_request'
      && /function tools only/.test(error.message)
  );
});

test('relay output maps final and tool calls', () => {
  assert.deepEqual(parseRelayOutput('{"type":"final","text":"done"}'), { type: 'final', text: 'done' });
  assert.deepEqual(
    parseRelayOutput('{"type":"function_call","name":"shell","arguments":{"command":"pwd"}}', [{ type: 'function', name: 'shell' }]),
    { type: 'function_call', name: 'shell', arguments: '{"command":"pwd"}' }
  );
  assert.deepEqual(
    parseRelayOutput('{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch"}', [{ type: 'custom', name: 'apply_patch' }]),
    { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' }
  );
  assert.deepEqual(
    parseRelayOutput('{"type":"tool_search_call","arguments":{"query":"Chrome control"}}', [{ type: 'tool_search', name: 'tool_search' }]),
    { type: 'tool_search_call', arguments: { query: 'Chrome control' } }
  );
  assert.deepEqual(parseRelayOutput('plain answer'), { type: 'final', text: 'plain answer' });
});

test('Codex model metadata and SSE fixtures include required fields', () => {
  const item = buildAgentModels(agents)[0];
  const info = modelInfo(item);
  assert.equal(info.slug, 'hyperagent/sol-coder');
  assert.equal(info.visibility, 'list');
  assert.equal(info.shell_type, 'shell_command');
  assert.equal(info.apply_patch_tool_type, 'freeform');

  const events = sseEvents(
    { type: 'function_call', name: 'shell', arguments: '{"command":"pwd"}' },
    { responseId: 'resp_1', itemId: 'msg_1', callId: 'call_1' },
    { model: info.slug, threadId: 'thread_1' }
  );
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_item.done', 'response.completed']);
  assert.equal(events[1].item.type, 'function_call');
  assert.equal(events[1].item.call_id, 'call_1');
  assert.equal('usage' in events.at(-1).response, false);

  const searchEvents = sseEvents(
    { type: 'tool_search_call', arguments: { query: 'Chrome' } },
    { responseId: 'resp_2', itemId: 'msg_2', callId: 'call_2' },
    { model: info.slug, threadId: 'thread_2' }
  );
  assert.equal(searchEvents[1].item.type, 'tool_search_call');
  assert.equal(searchEvents[1].item.execution, 'client');
});

test('tool result reducer strips ANSI noise and keeps the tail of successful output', () => {
  const lines = [];
  for (let i = 1; i <= 200; i += 1) lines.push(`step ${i} completed`);
  lines.push('All tests passed. Exit code: 0');
  const noisy = '\x1B[32m\x1B[1m$ npm test\x1B[0m\r\n' + lines.join('\n');
  const reduced = reduceToolOutput(noisy, { enableToolResultReducer: true });
  assert.doesNotMatch(reduced, /\x1B\[|npm test/);
  assert.match(reduced, /Exit code: 0/);
  assert.doesNotMatch(reduced, /step 10 completed\nstep 11 completed\nstep 12 completed/);
  assert.match(reduced, /step 199 completed/);
  assert.match(reduced, /\[tool output reduced by Hyperagent Codex Bridge: \d+ lines -> \d+\]/);
});

test('tool result reducer preserves error blocks and assertion diffs in failures', () => {
  const lines = ['$ npm test'];
  for (let i = 1; i <= 150; i += 1) lines.push(`passing suite ${i}`);
  lines.push('FAIL src/auth.test.js', 'AssertionError: expected 4 to be 2', '  at parse (src/auth.js:42:11)', 'Exit code: 1');
  const reduced = reduceToolOutput(lines.join('\n'), { enableToolResultReducer: true });
  assert.match(reduced, /AssertionError: expected 4 to be 2/);
  assert.match(reduced, /src\/auth\.js:42:11/);
  assert.match(reduced, /auth\.test\.js/);
  assert.match(reduced, /Exit code: 1/);
  assert.ok(reduced.length < lines.join('\n').length);
});

test('search output is capped per file with an explicit remainder note', () => {
  const lines = [];
  for (let i = 1; i <= 9; i += 1) lines.push(`src/a.ts:${i}: export const thing${i} = ${i}`);
  for (let i = 1; i <= 2; i += 1) lines.push(`src/b.ts:${i}: import { thing${i} } from './a'`);
  const reduced = reduceToolOutput(lines.join('\n'), { enableToolResultReducer: true });
  assert.equal((reduced.match(/src\/a\.ts:/g) || []).length, 5);
  assert.equal((reduced.match(/src\/b\.ts:/g) || []).length, 2);
  assert.match(reduced, /\+4 more matches in src\/a\.ts/);
});

test('reducer applies only to typed tool outputs and can be disabled', () => {
  const longToolOutput = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join('\n');
  const config = { enableToolResultReducer: true, maxTurnChars: 12000 };
  const turns = normalizeInput([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: longToolOutput }] },
    { type: 'function_call_output', call_id: 'call_1', output: longToolOutput }
  ], config);
  assert.match(turns[0].text, /^line-1\nline-2/);
  assert.match(turns[1].text, /\[tool output reduced by Hyperagent Codex Bridge/);

  const untouched = normalizeInput(
    [{ type: 'function_call_output', call_id: 'call_1', output: longToolOutput }],
    { enableToolResultReducer: false }
  );
  assert.match(untouched[0].text, /line-60/);
  assert.doesNotMatch(untouched[0].text, /reduced by Hyperagent/);
});
