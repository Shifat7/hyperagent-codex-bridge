import { randomUUID } from 'node:crypto';

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'agent';
}

export function buildAgentModels(agents) {
  const used = new Map();
  return agents.map((agent, index) => {
    const base = slugify(agent.name);
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    const suffix = count === 1 ? '' : `-${String(agent.id).slice(-6)}`;
    return {
      agent,
      slug: `hyperagent/${base}${suffix}`,
      displayName: agent.model ? `${agent.name} · ${agent.model}` : agent.name,
      priority: index + 1
    };
  });
}

export function resolveAgent(model, agents, config) {
  const requested = String(model || '').trim();
  const alias = config.aliases?.[requested];
  if (alias) {
    const matched = agents.find(agent => agent.id === alias);
    if (matched) return matched;
    throw new Error(`Model alias ${requested} points to unavailable agent ${alias}.`);
  }

  const models = buildAgentModels(agents);
  const bySlug = models.find(item => item.slug === requested);
  if (bySlug) return bySlug.agent;
  const direct = agents.find(agent => agent.id === requested);
  if (direct) return direct;
  const tail = requested.replace(/^hyperagent\//, '');
  const byName = agents.find(agent =>
    agent.name.toLowerCase() === requested.toLowerCase() ||
    slugify(agent.name) === tail
  );
  if (byName) return byName;
  throw new Error(`Unknown Hyperagent model '${requested}'. Run hacb models and choose one of the listed model IDs.`);
}

export class RelayProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RelayProtocolError';
    this.code = code;
    this.status = 502;
  }
}

export function modelInfo(item) {
  return {
    slug: item.slug,
    display_name: item.displayName,
    description: item.agent.description || `Hyperagent agent: ${item.agent.name}`,
    default_reasoning_level: 'low',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Cost-controlled default' },
      { effort: 'medium', description: 'Use only when the task needs more depth' },
      { effort: 'high', description: 'Explicit opt-in for difficult tasks' }
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: item.priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: 'You are a coding agent. Use the client tools when needed, then return a concise final answer.',
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'auto',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: 262144,
    max_context_window: 262144,
    auto_compact_token_limit: 235000,
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    use_responses_lite: false
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (part?.type === 'input_image' && typeof part.image_url === 'string') {
        return `[Image URL supplied by Codex: ${part.image_url}]`;
      }
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join('\n');
}

function injectedContext(text, role) {
  const value = String(text || '').trimStart();
  if (role === 'developer' || role === 'system') return true;
  return [
    '<environment_context>',
    '<permissions instructions>',
    '<app-context>',
    '<collaboration_mode>',
    '<apps_instructions>',
    '<plugins_instructions>',
    '<skills_instructions>',
    '<skill>',
    '# AGENTS.md instructions for '
  ].some(prefix => value.startsWith(prefix));
}

function compact(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated by Hyperagent Codex Bridge]`;
}

function normalizeInput(input, config = {}) {
  if (typeof input === 'string') return [{ role: 'user', text: compact(input, 12000) }];
  if (!Array.isArray(input)) return [{ role: 'user', text: compact(input, 12000) }];
  const perTurnLimit = Math.max(1000, Number(config.maxTurnChars || 12000));
  const maxTurns = Math.max(2, Number(config.maxConversationTurns || 12));
  const maxTotal = Math.max(perTurnLimit, Number(config.maxInputChars || 48000));
  const turns = [];
  for (const item of input) {
    const type = item?.type || 'message';
    if (type === 'additional_tools') continue;
    if (type === 'message') {
      const role = item.role || 'user';
      const text = contentToText(item.content);
      if (injectedContext(text, role)) continue;
      turns.push({ role, text: compact(text, perTurnLimit) });
      continue;
    }
    if (type === 'function_call') {
      turns.push({ role: 'assistant_tool_call', text: compact({ call_id: item.call_id, name: item.name, namespace: item.namespace, arguments: item.arguments }, perTurnLimit) });
      continue;
    }
    if (type === 'function_call_output') {
      turns.push({ role: 'tool_result', text: compact({ call_id: item.call_id, output: item.output }, perTurnLimit) });
      continue;
    }
    if (type === 'custom_tool_call') {
      turns.push({ role: 'assistant_custom_tool_call', text: compact({ call_id: item.call_id, name: item.name, namespace: item.namespace, input: item.input }, perTurnLimit) });
      continue;
    }
    if (type === 'custom_tool_call_output') {
      turns.push({ role: 'custom_tool_result', text: compact({ call_id: item.call_id, output: item.output }, perTurnLimit) });
      continue;
    }
    if (type === 'tool_search_call') {
      turns.push({ role: 'assistant_tool_search', text: compact({ call_id: item.call_id, arguments: item.arguments }, perTurnLimit) });
      continue;
    }
    if (type === 'tool_search_output') {
      turns.push({ role: 'tool_search_result', text: compact({ call_id: item.call_id, status: item.status, tools: item.tools }, perTurnLimit) });
    }
  }
  const recent = turns.slice(-maxTurns);
  const bounded = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index];
    if (used + turn.text.length > maxTotal && bounded.length) break;
    bounded.unshift(turn);
    used += turn.text.length;
  }
  return bounded;
}

function namespaceToolName(namespace, child) {
  if (namespace.endsWith('__')) return `${namespace}${child}`;
  if (namespace.startsWith('mcp__')) return `${namespace}__${child}`;
  return `${namespace}.${child}`;
}

function blockedTool(name, config) {
  if (!config.blockMultiAgentTools) return false;
  return /(^|[._])(?:spawn_agent|send_input|wait_agent|close_agent|resume_agent)$/.test(name)
    || name === 'collaboration'
    || name.startsWith('multi_agent');
}

function normalizeTools(tools, config = {}) {
  if (!Array.isArray(tools)) return [];
  const normalized = [];
  const add = tool => {
    if (!tool?.name || blockedTool(tool.name, config)) return;
    if (normalized.some(existing => existing.name === tool.name && existing.type === tool.type)) return;
    normalized.push(tool);
  };
  for (const tool of tools) {
    if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
      if (blockedTool(tool.name || '', config)) continue;
      for (const child of tool.tools) {
        if (child?.type !== 'function') continue;
        const name = namespaceToolName(tool.name, child.name);
        add({
          type: 'function',
          name,
          description: compact(child.description || tool.description || '', 800),
          parameters: child.parameters || child.input_schema || { type: 'object' }
        });
      }
      continue;
    }
    if (tool?.type === 'function') {
      add({
        type: 'function',
        name: tool.name,
        description: compact(tool.description || '', 800),
        parameters: tool.parameters || tool.input_schema || { type: 'object' }
      });
      continue;
    }
    if (tool?.type === 'custom') {
      add({
        type: 'custom',
        name: tool.name,
        description: compact(tool.description || '', 800),
        format: tool.format || null
      });
      continue;
    }
    if (tool?.type === 'tool_search') {
      add({ type: 'tool_search', name: 'tool_search', description: compact(tool.description || 'Search deferred client tools.', 800), execution: tool.execution || 'client' });
    }
  }
  return normalized.slice(0, Math.max(4, Number(config.maxForwardedTools || 64)));
}

export function extractClientTools(body, config = {}) {
  const tools = Array.isArray(body?.tools) ? [...body.tools] : [];
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === 'additional_tools' && Array.isArray(item.tools)) tools.push(...item.tools);
      if (item?.type === 'tool_search_output' && Array.isArray(item.tools)) tools.push(...item.tools);
    }
  }
  return normalizeTools(tools, config);
}

export function buildRelayPrompt(body, agent, config = {}, extractedTools = null) {
  const turns = normalizeInput(body.input, config);
  const tools = extractedTools || extractClientTools(body, config);
  const instructions = 'Act as the Codex reasoning backend. Use only the forwarded client tools and return one compact JSON action.';
  const effort = config.allowClientReasoningEffort && body.reasoning?.effort
    ? body.reasoning.effort
    : (config.defaultReasoningEffort || 'low');

  const toolNames = tools.map(tool => tool.name).filter(Boolean);
  const toolList = toolNames.length
    ? `Available client tool names you may call: ${toolNames.map(name => `"${name}"`).join(', ')}.`
    : 'No client tools are available for this turn.';

  const payload = {
    task: 'Act as the reasoning/model backend for a local Codex coding session.',
    selected_hyperagent_agent: agent.name,
    reasoning_effort: effort,
    developer_instructions: instructions,
    conversation: turns,
    client_tools: tools
  };

  return [
    'You are the model behind Codex. You do NOT have direct access to files, shell, or the internet.',
    'Codex owns the local filesystem, shell, patches, and approvals. You can ONLY act by returning a JSON instruction for Codex to execute a client tool.',
    '',
    `IMPORTANT: ${toolList}`,
    'If you need to read a file, run a command, or edit code, you MUST return a function_call JSON object naming one of the tools listed above. Do not say you cannot access files. Instead, return the JSON to ask Codex to do it for you.',
    'Do not explain that you lack tools. The tools are listed above. Use them by returning JSON.',
    '',
    'Return exactly one JSON object, with no markdown fence, no explanation, and no extra text before or after the JSON.',
    'Choose exactly one shape:',
    '{"type":"final","text":"your final answer to show the user"}',
    '{"type":"function_call","name":"exact tool name from the list above","arguments":{}}',
    '{"type":"custom_tool_call","name":"exact custom tool name from the list above","input":"raw tool input"}',
    '{"type":"tool_search_call","arguments":{"query":"tool capability to find"}}',
    '',
    'Rules:',
    '1. If the user asks you to read, write, edit, or run something locally, return a function_call with the matching tool name. Do not refuse. Do not say you cannot do it. Return the JSON.',
    '2. Never invent a tool name. Only use names from the list above.',
    '3. After a tool result appears in the conversation, either call another tool or return final.',
    '4. Keep final answers concise.',
    '5. Your entire response must be one JSON object. Nothing else.',
    '',
    JSON.stringify(payload)
  ].join('\n');
}

function parseJsonCandidate(text) {
  const trimmed = String(text || '').trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < unfenced.length; index += 1) {
      const char = unfenced[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        continue;
      }
      if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            return JSON.parse(unfenced.slice(start, index + 1));
          } catch {
            start = -1;
          }
        }
      }
    }
    return null;
  }
}

function typeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validateSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return null;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => typeMatches(value, type))) {
    return `${path} must be ${types.join(' or ')}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
    return `${path} must be one of the declared enum values`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!(required in value)) return `${path}.${required} is required`;
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        const error = validateSchema(child, schema.properties[key], `${path}.${key}`);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not allowed`;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateSchema(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  return null;
}

function relayError(code, message, strict) {
  if (strict) throw new RelayProtocolError(code, message);
  return { type: 'final', text: `Hyperagent relay protocol error (${code}).` };
}

export function parseRelayOutput(text, tools = [], { strict = true } = {}) {
  const parsed = parseJsonCandidate(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return relayError('relay_invalid_json', 'Hyperagent relay returned no valid JSON action.', strict);
  }
  if (parsed.type === 'function_call') {
    const tool = tools.find(item => item?.type === 'function' && item.name === parsed.name);
    if (!tool) return relayError('relay_unknown_tool', 'Hyperagent relay requested an unavailable function tool.', strict);
    let args = parsed.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return relayError('relay_invalid_arguments', 'Hyperagent relay returned invalid JSON tool arguments.', strict); }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return relayError('relay_invalid_arguments', 'Hyperagent relay tool arguments must be an object.', strict);
    }
    const validationError = validateSchema(args, tool.parameters || { type: 'object' });
    if (validationError) return relayError('relay_arguments_schema_mismatch', `Hyperagent relay tool arguments failed validation: ${validationError}.`, strict);
    return {
      type: 'function_call',
      name: parsed.name,
      arguments: JSON.stringify(args)
    };
  }
  if (parsed.type === 'custom_tool_call') {
    const tool = tools.find(item => item?.type === 'custom' && item.name === parsed.name);
    if (!tool) return relayError('relay_unknown_tool', 'Hyperagent relay requested an unavailable custom tool.', strict);
    if (typeof parsed.input !== 'string') return relayError('relay_invalid_custom_input', 'Hyperagent relay custom-tool input must be a string.', strict);
    return { type: 'custom_tool_call', name: parsed.name, input: parsed.input };
  }
  if (parsed.type === 'tool_search_call' || parsed.type === 'tool_search') {
    const tool = tools.find(item => item?.type === 'tool_search');
    if (!tool) return relayError('relay_unknown_tool', 'Hyperagent relay requested unavailable tool search.', strict);
    const argumentsValue = parsed.arguments || { query: String(parsed.query || '') };
    if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue) || typeof argumentsValue.query !== 'string' || !argumentsValue.query.trim()) {
      return relayError('relay_invalid_tool_search', 'Hyperagent relay tool-search arguments require a non-empty query.', strict);
    }
    return { type: 'tool_search_call', arguments: argumentsValue };
  }
  if (parsed.type === 'final' && typeof parsed.text === 'string') return parsed;
  return relayError('relay_unknown_action', 'Hyperagent relay returned an unsupported action shape.', strict);
}

export function responseIds() {
  const id = randomUUID().replace(/-/g, '');
  return { responseId: `resp_${id}`, itemId: `msg_${id}`, callId: `call_${id}` };
}

export function sseEvents(output, ids, { model, threadId } = {}) {
  const response = { id: ids.responseId, status: 'in_progress', model, output: [], metadata: { hyperagent_thread_id: threadId } };
  const events = [{ type: 'response.created', response }];
  if (output.type === 'function_call') {
    events.push({
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: ids.callId, name: output.name, arguments: output.arguments }
    });
  } else if (output.type === 'custom_tool_call') {
    events.push({
      type: 'response.output_item.done',
      item: { type: 'custom_tool_call', call_id: ids.callId, name: output.name, input: output.input }
    });
  } else if (output.type === 'tool_search_call') {
    events.push({
      type: 'response.output_item.done',
      item: { type: 'tool_search_call', call_id: ids.callId, status: 'completed', execution: 'client', arguments: output.arguments }
    });
  } else {
    events.push({
      type: 'response.output_item.added',
      item: { type: 'message', role: 'assistant', id: ids.itemId, content: [] }
    });
    if (output.text) events.push({ type: 'response.output_text.delta', item_id: ids.itemId, delta: output.text });
    events.push({
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', id: ids.itemId, content: [{ type: 'output_text', text: output.text || '' }] }
    });
  }
  events.push({
    type: 'response.completed',
    response: {
      id: ids.responseId,
      status: 'completed',
      model,
      metadata: { hyperagent_thread_id: threadId },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
    }
  });
  return events;
}

export function nonStreamingResponse(output, ids, { model, threadId } = {}) {
  const item = output.type === 'function_call'
    ? { type: 'function_call', call_id: ids.callId, name: output.name, arguments: output.arguments }
    : output.type === 'custom_tool_call'
      ? { type: 'custom_tool_call', call_id: ids.callId, name: output.name, input: output.input }
      : output.type === 'tool_search_call'
        ? { type: 'tool_search_call', call_id: ids.callId, status: 'completed', execution: 'client', arguments: output.arguments }
        : { type: 'message', role: 'assistant', id: ids.itemId, content: [{ type: 'output_text', text: output.text || '' }] };
  return {
    id: ids.responseId,
    object: 'response',
    status: 'completed',
    model,
    output: [item],
    metadata: { hyperagent_thread_id: threadId },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  };
}
