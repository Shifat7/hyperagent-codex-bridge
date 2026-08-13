import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentModels,
  buildRelayPrompt,
  extractClientTools,
  modelInfo,
  parseRelayOutput,
  RelayProtocolError,
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
  assert.throws(() => resolveAgent('hyperagent/missing', agents, config), /Unknown Hyperagent model/);
  assert.throws(
    () => resolveAgent('hyperagent/missing', agents, { aliases: {}, defaultAgentId: agents[0].id }),
    /Unknown Hyperagent model/,
    'explicit unknown routes must never silently fall back'
  );
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
  assert.throws(() => parseRelayOutput('plain answer'), error => error instanceof RelayProtocolError && error.code === 'relay_invalid_json');
  assert.deepEqual(parseRelayOutput('plain answer', [], { strict: false }), { type: 'final', text: 'Hyperagent relay protocol error (relay_invalid_json).' });
});

test('relay protocol extracts a single fenced action and validates tool arguments', () => {
  const tools = [{
    type: 'function',
    name: 'shell',
    parameters: {
      type: 'object',
      required: ['command'],
      additionalProperties: false,
      properties: { command: { type: 'string' } }
    }
  }];
  assert.deepEqual(
    parseRelayOutput('```json\n{"type":"function_call","name":"shell","arguments":{"command":"pwd"}}\n```', tools),
    { type: 'function_call', name: 'shell', arguments: '{"command":"pwd"}' }
  );
  assert.throws(
    () => parseRelayOutput('{"type":"function_call","name":"shell","arguments":{"cmd":"pwd"}}', tools),
    error => error instanceof RelayProtocolError && error.code === 'relay_arguments_schema_mismatch'
  );
  assert.throws(
    () => parseRelayOutput('{"type":"function_call","name":"invented","arguments":{}}', tools),
    error => error instanceof RelayProtocolError && error.code === 'relay_unknown_tool'
  );
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

  const searchEvents = sseEvents(
    { type: 'tool_search_call', arguments: { query: 'Chrome' } },
    { responseId: 'resp_2', itemId: 'msg_2', callId: 'call_2' },
    { model: info.slug, threadId: 'thread_2' }
  );
  assert.equal(searchEvents[1].item.type, 'tool_search_call');
  assert.equal(searchEvents[1].item.execution, 'client');
});
