import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentModels,
  buildRelayPrompt,
  buildRelayPromptWithMetrics,
  classifyTurn,
  estimateTokens,
  extractClientTools,
  modelInfo,
  normalizeInput,
  parseRelayOutput,
  reduceToolOutput,

  pickAgentRoute,
  resolveAgent,
  retentionLimits,
  slugify,
  nonStreamingResponse,
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

test('relay prompt metrics break the prompt into auditable sections', () => {
  const body = {
    model: 'hyperagent/sol-coder',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(400) }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'y'.repeat(600) },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: 'z'.repeat(200) }
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'Run shell commands.', parameters: { type: 'object' } },
      { type: 'function', name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }
    ]
  };
  const config = { defaultReasoningEffort: 'low', maxInputChars: 24000, maxTurnChars: 6000, maxConversationTurns: 8, maxForwardedTools: 32 };
  const { prompt, breakdown } = buildRelayPromptWithMetrics(body, agents[0], config);
  assert.equal(prompt, buildRelayPrompt(body, agents[0], config));
  assert.equal(breakdown.totalChars, prompt.length);
  assert.equal(breakdown.estimatedTokens, Math.ceil(prompt.length / 4));
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(7), 2);
  assert.equal(
    breakdown.sections.relayInstructionChars + breakdown.sections.payloadChars,
    breakdown.totalChars
  );
  const toolResultText = (callId, output) => JSON.stringify({ call_id: callId, output });
  const expectedToolResults = toolResultText('call_1', 'y'.repeat(600)).length + toolResultText('call_2', 'z'.repeat(200)).length;
  assert.equal(breakdown.sections.conversationChars, 400 + expectedToolResults);
  assert.equal(breakdown.sections.toolResultChars, expectedToolResults);
  assert.ok(breakdown.sections.toolSchemaChars > 0 && breakdown.sections.toolSchemaChars <= breakdown.sections.payloadChars);
  assert.equal(breakdown.limits.maxInputChars, 24000);
  assert.equal(breakdown.limits.maxTurnChars, 6000);
  assert.equal(breakdown.limits.maxConversationTurns, 8);
  assert.equal(breakdown.limits.maxForwardedTools, 32);
  assert.equal(breakdown.forwardedToolCount, 2);
  assert.equal(breakdown.retainedTurns, 3);
  assert.doesNotMatch(JSON.stringify(breakdown), /x{20,}|y{20,}|z{20,}/);
});

test('prompt excerpt capture is opt-in and bounded', () => {
  const body = { model: 'hyperagent/sol-coder', input: 'secret-user-content-marker-' + 'a'.repeat(500) };
  const withoutFlag = buildRelayPromptWithMetrics(body, agents[0], {});
  assert.equal(withoutFlag.excerpts, undefined);
  const withFlag = buildRelayPromptWithMetrics(body, agents[0], { debugPromptExcerpts: true });
  assert.ok(withFlag.excerpts.conversationExcerpt.includes('secret-user-content-marker'));
  for (const value of Object.values(withFlag.excerpts)) assert.ok(String(value).length <= 240);
});

test('retention limits clamp unsafe config values', () => {
  assert.deepEqual(retentionLimits({}), { maxTurnChars: 12000, maxConversationTurns: 12, maxInputChars: 48000, maxForwardedTools: 10 });
  const clamped = retentionLimits({ maxTurnChars: 10, maxConversationTurns: 1, maxInputChars: 10, maxForwardedTools: 1 });
  assert.deepEqual(clamped, { maxTurnChars: 1000, maxConversationTurns: 2, maxInputChars: 1000, maxForwardedTools: 4 });
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


test('recommended_plugins chrome is scrubbed from conversation turns', () => {
  const turns = normalizeInput([
    { type: 'message', role: 'user', content: '<recommended_plugins>\n- Airtable\n</recommended_plugins>\n\nImplement fizzbuzz.' },
    { type: 'message', role: 'user', content: '<recommended_plugins>only plugins</recommended_plugins>' }
  ], { maxTurnChars: 6000, maxConversationTurns: 8, maxInputChars: 24000 });
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /Implement fizzbuzz/);
  assert.doesNotMatch(turns[0].text, /Airtable|recommended_plugins/);
});

test('relay parser coerces tool-named type misfires into function_call', () => {
  const tools = [{ type: 'function', name: 'exec_command' }];
  assert.deepEqual(
    parseRelayOutput('{"type":"exec_command","cmd":"cat README.md"}', tools),
    { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat README.md"}' }
  );
  assert.deepEqual(
    parseRelayOutput('{"type":"exec_command","arguments":{"cmd":"ls"}}', tools),
    { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}' }
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
    { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }
  );
  assert.deepEqual(
    parseRelayOutput(JSON.stringify({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Update File: a.js\n@@\n-old\n+new' }), [{ type: 'custom', name: 'apply_patch' }]),
    { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.js\n@@\n-old\n+new\n*** End Patch' }
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

test('relay prompt is minimised without losing JSON-action reliability', () => {
  const body = {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    tools: [{ type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object' } }]
  };
  const prompt = buildRelayPrompt(body, { id: 'a1', name: 'Sol Coder' }, {});
  assert.ok(prompt.length < 1900, `expected a minimised prompt, got ${prompt.length} chars (legacy trivial baseline: 1978)`);
  for (const phrase of [
    'Available client tool names',
    'Return exactly one JSON object',
    '{"type":"final","text":"your final answer to show the user"}',
    '{"type":"function_call","name":"exact tool name from the list above","arguments":{}}',
    '{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch',
    '{"type":"tool_search_call","arguments":{"query":"tool capability to find"}}',
    'Never invent a tool name',
    'Your entire response must be one JSON object'
  ]) {
    assert.ok(prompt.includes(phrase), `minimised prompt lost required phrase: ${phrase}`);
  }
});

test('turn classification recognises common coding task types', () => {
  const userSay = text => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];
  assert.equal(classifyTurn(userSay('What is the capital of France?')), 'final_answer_only');
  assert.equal(classifyTurn(userSay('Inspect the repo structure and list the entry points.')), 'read_or_search');
  assert.equal(classifyTurn(userSay('Refactor the auth module to use the new session API.')), 'edit_code');
  assert.equal(classifyTurn(userSay('Run the test suite now.')), 'run_command');
  assert.equal(classifyTurn(userSay('The build fails with AssertionError: expected 4 to be 2. Fix it.')), 'debug_failure');
  assert.equal(classifyTurn(userSay('Please proceed with that approach.')), 'unknown');
});

test('classification never drops tools once a conversation has used them', () => {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What should we do next?' }] },
    { type: 'function_call_output', call_id: 'call_1', output: 'some result' }
  ];
  assert.notEqual(classifyTurn(input), 'final_answer_only');
});

const TOOLBOX = [
  { type: 'function', name: 'shell', description: 'Runs a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { type: 'function', name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { type: 'function', name: 'grep_search', description: 'Searches file contents.', parameters: { type: 'object' } },
  { type: 'function', name: 'apply_patch', description: 'Applies a patch.', parameters: { type: 'object' } },
  { type: 'function', name: 'write_file', description: 'Writes a file.', parameters: { type: 'object' } }
];

function bodyWith(text, extra = {}) {
  return { model: 'hyperagent/sol-coder', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], tools: TOOLBOX, ...extra };
}

test('smart selection forwards fewer tools for inspection and run tasks', () => {
  const config = { enableSmartToolSelection: true, maxForwardedTools: 32 };
  const inspect = extractClientTools(bodyWith('Inspect how this project wires up its entry point.'), config);
  assert.ok(inspect.length < TOOLBOX.length);
  assert.ok(inspect.some(tool => tool.name === 'read_file'));
  assert.ok(inspect.every(tool => !['write_file'].includes(tool.name)));
  const run = extractClientTools(bodyWith('Run the test suite.'), config);
  assert.deepEqual(run.map(tool => tool.name), ['shell']);
});

test('smart selection preserves edit and debug toolchains', () => {
  const config = { enableSmartToolSelection: true, maxForwardedTools: 32 };
  for (const text of ['Edit src/index.ts to add the export.', 'Tests fail with AssertionError. Fix the bug in parse().']) {
    const tools = extractClientTools(bodyWith(text), config);
    assert.ok(tools.some(tool => tool.name === 'apply_patch'), `missing patch tool for: ${text}`);
    assert.ok(tools.some(tool => tool.name === 'read_file'), `missing read tool for: ${text}`);
    assert.ok(tools.some(tool => tool.name === 'shell'), `missing shell for: ${text}`);
  }
});

test('plain questions forward no tools while mid-task conversations keep a coding toolchain', () => {
  const config = { enableSmartToolSelection: true, maxForwardedTools: 32 };
  assert.deepEqual(extractClientTools(bodyWith('What is the capital of France?'), config), []);
  const midTask = extractClientTools({
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What should we try next?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' }
    ],
    tools: TOOLBOX
  }, config);
  assert.ok(midTask.some(tool => tool.name === 'shell'));
  assert.ok(midTask.some(tool => tool.name === 'apply_patch'));
  assert.ok(midTask.length <= TOOLBOX.length);
});

test('disabling smart selection preserves inventory; unknown turns keep a bounded coding set', () => {
  const off = extractClientTools(bodyWith('Inspect the repo.'), { enableSmartToolSelection: false, maxForwardedTools: 32 });
  assert.deepEqual(off.map(tool => tool.name), TOOLBOX.map(tool => tool.name));
  const unknown = extractClientTools(bodyWith('Please proceed.'), { enableSmartToolSelection: true, maxForwardedTools: 32 });
  assert.deepEqual(new Set(unknown.map(tool => tool.name)), new Set(TOOLBOX.map(tool => tool.name)));
});

test('deferred MCP tools are omitted unless already used', () => {
  const tools = [
    ...TOOLBOX,
    { type: 'function', name: 'list_mcp_resources', description: 'List MCP resources', parameters: { type: 'object' } },
    { type: 'function', name: 'mcp__browser__click', description: 'Click', parameters: { type: 'object' } }
  ];
  const body = bodyWith('Edit src/index.ts and run tests.');
  body.tools = tools;
  const selected = extractClientTools(body, { enableSmartToolSelection: true, maxForwardedTools: 32 });
  assert.ok(selected.every(tool => !['list_mcp_resources', 'mcp__browser__click'].includes(tool.name)));
  const used = extractClientTools({
    ...body,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
      { type: 'function_call', name: 'list_mcp_resources', call_id: 'c1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '[]' }
    ]
  }, { enableSmartToolSelection: true, maxForwardedTools: 32 });
  assert.ok(used.some(tool => tool.name === 'list_mcp_resources'));
  assert.ok(used.every(tool => tool.name !== 'mcp__browser__click'));
});

test('schema minimisation keeps names and argument shapes but trims descriptions', () => {
  const config = { enableSmartToolSelection: true, forwardFullToolSchemas: false, maxToolDescriptionChars: 20 };
  const [shell] = extractClientTools(bodyWith('Run the tests.'), config);
  assert.equal(shell.name, 'shell');
  assert.equal(shell.description.length <= 20, true);
  assert.deepEqual(shell.parameters.required, ['command']);
  assert.equal(shell.parameters.properties.command.type, 'string');
  assert.equal(shell.parameters.properties.command.description, undefined);

  const full = extractClientTools(bodyWith('Run the tests.', {
    tools: [{ ...TOOLBOX[0], description: 'x'.repeat(400), parameters: { type: 'object', properties: { command: { type: 'string', description: 'full' } }, required: ['command'] } }]
  }), { enableSmartToolSelection: true, forwardFullToolSchemas: true, maxForwardedTools: 32 });
  assert.equal(full[0].description.length, 400);
  assert.equal(full[0].parameters.properties.command.description, 'full');
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

test('relay prompt injects the checkpoint before the conversation', () => {
  const prompt = buildRelayPrompt({
    model: 'hyperagent/sol-coder',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue the task' }] },
      { type: 'function_call_output', call_id: 'call_1', output: 'old result' }
    ],
    tools: []
  }, agents[0], { maxConversationTurns: 1 }, null, '# Codex State\nGoal: ship PRs');
  assert.match(prompt, /Project checkpoint:\\n# Codex State\\nGoal: ship PRs/);
  assert.ok(prompt.indexOf('"project_checkpoint"') >= 0 && prompt.indexOf('"project_checkpoint"') < prompt.indexOf('"conversation":'));
});

test('checkpoint survives while old conversation turns are dropped', () => {
  const turns = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ancient first request' }] },
    { type: 'function_call_output', call_id: 'call_1', output: 'ancient tool result' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'middle request' }] },
    { type: 'function_call_output', call_id: 'call_2', output: 'recent tool result' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest request' }] }
  ];
  const prompt = buildRelayPrompt({ input: turns, tools: [] }, agents[0], { maxConversationTurns: 2 }, null, 'Goal: ship PRs');
  assert.match(prompt, /Goal: ship PRs/);
  assert.match(prompt, /latest request/);
  assert.doesNotMatch(prompt, /ancient first request/);
  assert.doesNotMatch(prompt, /ancient tool result/);
});

test('multi-tool calls parse, validate, and fail safely', () => {
  const tools = [
    { type: 'function', name: 'shell' },
    { type: 'function', name: 'read_file' }
  ];
  const config = { enableMultiToolCalls: true, maxToolCallsPerResponse: 3 };
  assert.deepEqual(
    parseRelayOutput('{"type":"function_calls","calls":[{"name":"shell","arguments":{"command":"pwd"}},{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}]}', tools, config),
    { type: 'function_calls', calls: [{ name: 'shell', arguments: '{"command":"pwd"}' }, { name: 'read_file', arguments: '{"path":"a.ts"}' }] }
  );

  assert.equal(parseRelayOutput('{"type":"function_calls","calls":[{"name":"shell"},{"name":"nonexistent_tool"}]}', tools, config).type, 'final');

  assert.match(
    parseRelayOutput('{"type":"function_calls","calls":[{"name":"shell"},{"name":"shell"},{"name":"shell"},{"name":"shell"}]}', tools, config).text,
    /requested 4 tool calls.*maximum is 3/s
  );
});

test('multi-tool calls stay inert unless explicitly enabled', () => {
  const raw = '{"type":"function_calls","calls":[{"name":"shell","arguments":{}}]}';
  const parsed = parseRelayOutput(raw, [{ type: 'function', name: 'shell' }], { enableMultiToolCalls: false });
  assert.equal(parsed.type, 'final');
  const legacy = parseRelayOutput(raw, [{ type: 'function', name: 'shell' }]);
  assert.equal(legacy.type, 'final');
});

test('multi-tool outputs render as multiple Responses items with distinct call ids', () => {
  const output = {
    type: 'function_calls',
    calls: [{ name: 'shell', arguments: '{"command":"pwd"}' }, { name: 'read_file', arguments: '{"path":"a"}' }]
  };
  const events = sseEvents(output, { responseId: 'resp_9', itemId: 'msg_9', callId: 'call_9' }, { model: 'hyperagent/sol-coder', threadId: 'thread_9' });
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_item.done', 'response.output_item.done', 'response.completed']);
  assert.deepEqual(events.map(event => event.item?.call_id).filter(Boolean), ['call_9_0', 'call_9_1']);
  assert.equal(events[1].item.name, 'shell');
  assert.equal(events[2].item.name, 'read_file');

  const response = nonStreamingResponse(output, { responseId: 'resp_10', itemId: 'msg_10', callId: 'call_10' }, { model: 'hyperagent/sol-coder' });
  assert.equal(response.output.length, 2);
  assert.deepEqual(response.output.map(item => item.call_id), ['call_10_0', 'call_10_1']);
});

test('route selection is deterministic with explicit precedence', () => {
  const say = text => ({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });
  const tools = [{ type: 'function', name: 'shell' }];
  const config = {};
  assert.deepEqual(pickAgentRoute(say('Tests fail with AssertionError, fix it.'), tools, config), { route: 'debug_failure', reason: 'failure indicators in request' });
  assert.deepEqual(pickAgentRoute(say('Migrate the whole app to the new API.'), tools, config), { route: 'large_refactor', reason: 'refactor/migration request' });
  assert.deepEqual(pickAgentRoute(say('Design the approach for the caching layer.'), [], config), { route: 'planning', reason: 'planning/design request' });
  assert.deepEqual(pickAgentRoute(say('Inspect the auth module.'), tools, config), { route: 'tool_selection', reason: 'client tools are forwarded' });
  assert.deepEqual(pickAgentRoute(say('Thanks, that wraps it up.'), [], config), { route: 'final_answer', reason: 'no local action indicated' });
  const a = pickAgentRoute(say('Fix the failing test.'), tools, config);
  const b = pickAgentRoute(say('Fix the failing test.'), tools, config);
  assert.deepEqual(a, b);
});

const ROUTING_AGENTS = [
  { id: 'agent-cheap', name: 'cheap-coder' },
  { id: 'agent-strong', name: 'strong-coder' },
  { id: 'agent-debugger', name: 'debugger' },
  { id: 'agent-planner', name: 'planner' }
];
