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
  validateAgentCatalog(agents);
  return agents.map((agent, index) => {
    const base = slugify(agent.name);
    return {
      agent,
      slug: `hyperagent/${base}`,
      displayName: agent.model ? `${agent.name} · ${agent.model}` : agent.name,
      priority: index + 1
    };
  });
}

function selectionError(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

export function validateAgentCatalog(agents) {
  const ids = new Set();
  const names = new Set();
  const slugs = new Set();
  for (const agent of agents) {
    const id = String(agent?.id || '').trim();
    const name = String(agent?.name || '').trim();
    const foldedName = name.toLocaleLowerCase('en-US');
    const slug = slugify(name);
    if (!id || !name) throw selectionError('The reachable agent catalog contains an invalid entry.', 'invalid_agent_catalog');
    if (ids.has(id)) throw selectionError('The reachable agent catalog contains duplicate identifiers.', 'duplicate_agent_identifier');
    if (names.has(foldedName)) throw selectionError('The reachable agent catalog contains duplicate names.', 'duplicate_agent_name');
    if (slugs.has(slug)) throw selectionError('The reachable agent catalog contains ambiguous names.', 'ambiguous_agent_slug');
    ids.add(id);
    names.add(foldedName);
    slugs.add(slug);
  }
  return agents;
}

function validatedAliases(agents, config) {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const natural = new Map();
  for (const agent of agents) {
    for (const identifier of [agent.id, agent.name, `hyperagent/${slugify(agent.name)}`]) {
      natural.set(String(identifier).toLocaleLowerCase('en-US'), agent.id);
    }
  }
  const aliases = new Map();
  const folded = new Map();
  for (const [rawAlias, rawAgentId] of Object.entries(config.aliases || {})) {
    const alias = String(rawAlias || '').trim();
    const agentId = String(rawAgentId || '').trim();
    const agent = byId.get(agentId);
    if (!alias || !agent) throw selectionError('A configured model alias is invalid or unavailable.', 'invalid_model_alias');
    const key = alias.toLocaleLowerCase('en-US');
    if (folded.has(key) && folded.get(key) !== agentId) {
      throw selectionError('Configured model aliases are ambiguous.', 'ambiguous_model_alias');
    }
    if (natural.has(key) && natural.get(key) !== agentId) {
      throw selectionError('A configured model alias conflicts with another model identifier.', 'ambiguous_model_alias');
    }
    folded.set(key, agentId);
    aliases.set(alias, agent);
  }
  return aliases;
}

export function resolveAgent(model, agents, config) {
  validateAgentCatalog(agents);
  const requested = String(model || '').trim();
  const aliases = validatedAliases(agents, config);
  if (aliases.has(requested)) return aliases.get(requested);

  const models = buildAgentModels(agents);
  const bySlug = models.find(item => item.slug === requested);
  if (bySlug) return bySlug.agent;
  const direct = agents.find(agent => agent.id === requested);
  if (direct) return direct;
  const byName = agents.find(agent => agent.name === requested);
  if (byName) return byName;
  throw selectionError('Unknown model identifier. Choose an exact identifier returned by the models endpoint.', 'unknown_model');
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
      for (const child of tool.tools) {
        if (child?.type !== 'function') {
          throw selectionError('Tool namespaces may contain function tools only.', 'invalid_request');
        }
      }
      if (blockedTool(tool.name || '', config)) continue;
      for (const child of tool.tools) {
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
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseRelayOutput(text, tools = [], config = {}) {
  const parsed = parseJsonCandidate(text);
  if (!parsed || typeof parsed !== 'object') return { type: 'final', text: String(text || '') };
  if (parsed.type === 'function_calls' && Array.isArray(parsed.calls) && config.enableMultiToolCalls === true) {
    const maxCalls = Math.max(1, Number(config.maxToolCallsPerResponse || 3));
    if (parsed.calls.length > maxCalls) {
      return { type: 'final', text: `Hyperagent requested ${parsed.calls.length} tool calls; the maximum is ${maxCalls}. Re-run with fewer calls.` };
    }
    const calls = [];
    for (const call of parsed.calls) {
      const tool = tools.find(item => item?.type === 'function' && item.name === call?.name);
      if (!tool) {
        return { type: 'final', text: `Hyperagent requested unavailable function tool '${call?.name}'.\n\n${text}` };
      }
      calls.push({ name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}) });
    }
    return { type: 'function_calls', calls };
  }
  if (parsed.type === 'function_call') {
    const tool = tools.find(item => item?.type === 'function' && item.name === parsed.name);
    if (!tool) return { type: 'final', text: `Hyperagent requested unavailable function tool '${parsed.name}'.\n\n${text}` };
    return {
      type: 'function_call',
      name: parsed.name,
      arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
    };
  }
  if (parsed.type === 'custom_tool_call') {
    const tool = tools.find(item => item?.type === 'custom' && item.name === parsed.name);
    if (!tool) return { type: 'final', text: `Hyperagent requested unavailable custom tool '${parsed.name}'.\n\n${text}` };
    return { type: 'custom_tool_call', name: parsed.name, input: String(parsed.input || '') };
  }
  if (parsed.type === 'tool_search_call' || parsed.type === 'tool_search') {
    const tool = tools.find(item => item?.type === 'tool_search');
    if (!tool) return { type: 'final', text: `Hyperagent requested unavailable tool_search.\n\n${text}` };
    return { type: 'tool_search_call', arguments: parsed.arguments || { query: String(parsed.query || '') } };
  }
  if (parsed.type === 'final' && typeof parsed.text === 'string') return parsed;
  return { type: 'final', text: typeof parsed.text === 'string' ? parsed.text : String(text || '') };
}

export function responseIds() {
  const id = randomUUID().replace(/-/g, '');
  return { responseId: `resp_${id}`, itemId: `msg_${id}`, callId: `call_${id}` };
}

function responseMetadata(threadId, requestId) {
  return {
    hyperagent_thread_id: threadId,
    ...(requestId ? { request_id: requestId } : {}),
    usage_source: 'unavailable'
  };
}

export function sseEvents(output, ids, { model, threadId, requestId } = {}) {
  const metadata = responseMetadata(threadId, requestId);
  const response = { id: ids.responseId, status: 'in_progress', model, output: [], metadata };
  const events = [{ type: 'response.created', response }];
  if (output.type === 'function_calls' && Array.isArray(output.calls)) {
    output.calls.forEach((call, index) => {
      events.push({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: `${ids.callId}_${index}`, name: call.name, arguments: call.arguments }
      });
    });
  } else if (output.type === 'function_call') {
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
      metadata
    }
  });
  return events;
}

export function nonStreamingResponse(output, ids, { model, threadId, requestId } = {}) {
  const items = output.type === 'function_calls' && Array.isArray(output.calls)
    ? output.calls.map((call, index) => ({
        type: 'function_call',
        call_id: `${ids.callId}_${index}`,
        name: call.name,
        arguments: call.arguments
      }))
    : [output.type === 'function_call'
        ? { type: 'function_call', call_id: ids.callId, name: output.name, arguments: output.arguments }
        : output.type === 'custom_tool_call'
          ? { type: 'custom_tool_call', call_id: ids.callId, name: output.name, input: output.input }
          : output.type === 'tool_search_call'
            ? { type: 'tool_search_call', call_id: ids.callId, status: 'completed', execution: 'client', arguments: output.arguments }
            : { type: 'message', role: 'assistant', id: ids.itemId, content: [{ type: 'output_text', text: output.text || '' }] }];
  return {
    id: ids.responseId,
    object: 'response',
    status: 'completed',
    model,
    output: items,
    metadata: responseMetadata(threadId, requestId)
  };
}
