import { readFile } from 'node:fs/promises';
import { auditPath, promptExcerptsPath } from './config.mjs';

export async function loadAuditEntries(path = auditPath()) {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return parseAuditLines(text);
}

export function parseAuditLines(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) entries.push(value);
    } catch {}
  }
  return entries;
}

export function buildCostRecords(entries) {
  const byRequest = new Map();
  const order = [];
  for (const entry of entries) {
    const id = entry?.requestId;
    if (!id) continue;
    if (!byRequest.has(id)) {
      byRequest.set(id, {});
      order.push(id);
    }
    const record = byRequest.get(id);
    if (entry.event === 'request_reserved') record.reserved = entry;
    else if (entry.event === 'completed') record.completed = entry;
    else if (entry.event === 'thread_created') record.threadCreated = entry;
  }
  const records = [];
  for (const id of order) {
    const { reserved, completed, threadCreated } = byRequest.get(id);
    if (!reserved) continue;
    records.push({
      requestId: id,
      timestamp: reserved.at,
      model: reserved.model ?? null,
      agentRef: reserved.agentRef ?? null,
      streaming: Boolean(reserved.streaming),
      promptChars: Number(reserved.promptChars ?? 0),
      estimatedPromptTokens: Number(reserved.estimatedPromptTokens ?? 0),
      conversationChars: Number(reserved.conversationChars ?? 0),
      toolSchemaChars: Number(reserved.toolSchemaChars ?? 0),
      toolResultChars: Number(reserved.toolResultChars ?? 0),
      relayInstructionChars: Number(reserved.relayInstructionChars ?? 0),
      payloadChars: Number(reserved.payloadChars ?? 0),
      toolCount: Number(reserved.toolCount ?? 0),
      retainedTurns: reserved.retainedTurns ?? null,
      maxInputChars: reserved.maxInputChars ?? null,
      maxTurnChars: reserved.maxTurnChars ?? null,
      maxConversationTurns: reserved.maxConversationTurns ?? null,
      maxForwardedTools: reserved.maxForwardedTools ?? null,
      dailyUsed: reserved.dailyUsed ?? null,
      dailyLimit: reserved.dailyLimit ?? null,
      outputType: completed?.outputType ?? null,
      threadRef: completed?.threadRef ?? threadCreated?.threadRef ?? null,
      usageSource: reserved.usageSource ?? completed?.usageSource ?? null,
      outcome: completed ? 'completed' : 'incomplete'
    });
  }
  return records;
}

export function summarizeCostRecords(records) {
  if (!records.length) {
    return {
      count: 0,
      totalEstimatedTokens: 0,
      avgEstimatedTokens: 0,
      totalPromptChars: 0,
      avgPromptChars: 0,
      maxPromptChars: 0,
      avgToolCount: 0,
      maxToolCount: 0,
      byOutcome: {},
      byOutputType: {},
      firstAt: null,
      lastAt: null
    };
  }
  const sum = field => records.reduce((total, record) => total + (Number(record[field]) || 0), 0);
  const tally = field => records.reduce((counts, record) => {
    const key = record[field] == null ? 'unknown' : String(record[field]);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const count = records.length;
  return {
    count,
    totalEstimatedTokens: sum('estimatedPromptTokens'),
    avgEstimatedTokens: Math.round(sum('estimatedPromptTokens') / count),
    totalPromptChars: sum('promptChars'),
    avgPromptChars: Math.round(sum('promptChars') / count),
    maxPromptChars: records.reduce((max, record) => Math.max(max, Number(record.promptChars) || 0), 0),
    avgToolCount: Math.round((sum('toolCount') / count) * 10) / 10,
    maxToolCount: records.reduce((max, record) => Math.max(max, Number(record.toolCount) || 0), 0),
    byOutcome: tally('outcome'),
    byOutputType: tally('outputType'),
    firstAt: records[0].timestamp,
    lastAt: records[count - 1].timestamp
  };
}

export async function loadPromptExcerpts(requestId, path = promptExcerptsPath()) {
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return parseAuditLines(text).filter(entry => entry.requestId === requestId);
}
