import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { auditPath, VERSION } from './config.mjs';

export async function readAuditEntries(limit = 500) {
  let text = '';
  try {
    text = await readFile(auditPath(), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-limit).map(line => JSON.parse(line));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function publicThreadId(value, includeThreadIds) {
  if (!value) return null;
  if (includeThreadIds) return value;
  return `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

export function buildReceipt(entries, { includeThreadIds = false } = {}) {
  const requests = new Map();
  for (const entry of entries) {
    if (!entry.requestId) continue;
    const current = requests.get(entry.requestId) || { requestId: entry.requestId, events: [] };
    current.events.push(entry.event);
    Object.assign(current, entry);
    if (entry.threadId) current.threadId = publicThreadId(entry.threadId, includeThreadIds);
    requests.set(entry.requestId, current);
  }
  const rows = [...requests.values()].map(item => ({
    requestId: item.requestId,
    model: item.model || null,
    threadId: item.threadId || null,
    status: item.events.includes('completed') ? 'completed' : item.events.includes('failed') ? 'failed' : 'incomplete',
    outputType: item.outputType || null,
    promptChars: item.promptChars || null,
    toolCount: item.toolCount ?? null,
    totalMs: item.totalMs ?? null,
    errorCode: item.errorCode || null,
    costMeasurement: item.costMeasurement || 'unavailable_from_supported_mcp',
    events: item.events
  }));
  const completed = rows.filter(row => row.status === 'completed');
  const durations = completed.map(row => row.totalMs).filter(Number.isFinite);
  return {
    schema: 'hacb.public-receipt.v1',
    bridgeVersion: VERSION,
    generatedAt: new Date().toISOString(),
    privacy: 'No prompts, answers, OAuth tokens, refresh tokens, or local bearer tokens.',
    costBoundary: 'The supported Hyperagent MCP surface does not return machine-readable per-request cost. Request counts and latency are measured; account credit delta requires operator observation.',
    summary: {
      requests: rows.length,
      completed: completed.length,
      failed: rows.filter(row => row.status === 'failed').length,
      incomplete: rows.filter(row => row.status === 'incomplete').length,
      p50TotalMs: percentile(durations, 0.5),
      p95TotalMs: percentile(durations, 0.95)
    },
    requests: rows
  };
}

export function receiptMarkdown(receipt) {
  const lines = [
    `# Hyperagent Codex Bridge ${receipt.bridgeVersion} sanitized receipt`,
    '',
    `Generated: ${receipt.generatedAt}`,
    '',
    `Privacy: ${receipt.privacy}`,
    '',
    `Cost boundary: ${receipt.costBoundary}`,
    '',
    '| Requests | Completed | Failed | Incomplete | p50 latency | p95 latency |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${receipt.summary.requests} | ${receipt.summary.completed} | ${receipt.summary.failed} | ${receipt.summary.incomplete} | ${receipt.summary.p50TotalMs ?? 'n/a'} ms | ${receipt.summary.p95TotalMs ?? 'n/a'} ms |`,
    '',
    '| Request | Model | Thread | Status | Output | Prompt chars | Tools | Total ms | Cost |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |'
  ];
  for (const row of receipt.requests) {
    lines.push(`| ${row.requestId} | ${row.model || ''} | ${row.threadId || ''} | ${row.status}${row.errorCode ? ` (${row.errorCode})` : ''} | ${row.outputType || ''} | ${row.promptChars ?? ''} | ${row.toolCount ?? ''} | ${row.totalMs ?? ''} | unavailable via supported MCP |`);
  }
  return `${lines.join('\n')}\n`;
}
