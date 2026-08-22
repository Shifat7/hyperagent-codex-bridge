import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCostRecords,
  loadAuditEntries,
  loadPromptExcerpts,
  parseAuditLines,
  summarizeCostRecords
} from '../src/cost-report.mjs';

const reserved = {
  at: '2026-08-22T10:00:00.000Z',
  event: 'request_reserved',
  requestId: 'req_aaa111',
  model: 'hyperagent/sol-coder',
  agentRef: 'agent_AAAA',
  streaming: true,
  promptChars: 40000,
  estimatedPromptTokens: 10000,
  relayInstructionChars: 1200,
  conversationChars: 20000,
  toolResultChars: 15000,
  toolSchemaChars: 3000,
  payloadChars: 38000,
  retainedTurns: 6,
  toolCount: 7,
  maxInputChars: 24000,
  maxTurnChars: 6000,
  maxConversationTurns: 8,
  maxForwardedTools: 32,
  usageSource: 'unavailable',
  dailyUsed: 3,
  dailyLimit: 6
};

const created = {
  at: '2026-08-22T10:00:02.000Z',
  event: 'thread_created',
  requestId: 'req_aaa111',
  threadRef: 'thread_AAAA'
};

const completed = {
  at: '2026-08-22T10:00:05.000Z',
  event: 'completed',
  requestId: 'req_aaa111',
  model: 'hyperagent/sol-coder',
  agentRef: 'agent_AAAA',
  threadRef: 'thread_AAAA',
  outputType: 'function_call',
  promptChars: 40000,
  estimatedPromptTokens: 10000,
  usageSource: 'unavailable',
  dailyCommitted: 4,
  dailyLimit: 6
};

test('audit line parsing skips malformed and non-object lines', () => {
  const entries = parseAuditLines('{"event":"a","requestId":"req_1"}\nnot json\n[1,2]\n\n{"event":"b"}');
  assert.deepEqual(entries.map(entry => entry.event), ['a', 'b']);
});

test('cost records join reservation, thread, and completion events per request', () => {
  const records = buildCostRecords([
    { ...reserved },
    { ...created },
    { at: '2026-08-22T10:01:00.000Z', event: 'request_error', requestId: 'req_aaa111' },
    { ...completed }
  ]);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.requestId, 'req_aaa111');
  assert.equal(record.timestamp, reserved.at);
  assert.equal(record.model, 'hyperagent/sol-coder');
  assert.equal(record.agentRef, 'agent_AAAA');
  assert.equal(record.promptChars, 40000);
  assert.equal(record.estimatedPromptTokens, 10000);
  assert.equal(record.conversationChars, 20000);
  assert.equal(record.toolSchemaChars, 3000);
  assert.equal(record.toolResultChars, 15000);
  assert.equal(record.relayInstructionChars, 1200);
  assert.equal(record.toolCount, 7);
  assert.equal(record.maxInputChars, 24000);
  assert.equal(record.maxTurnChars, 6000);
  assert.equal(record.maxConversationTurns, 8);
  assert.equal(record.maxForwardedTools, 32);
  assert.equal(record.dailyUsed, 3);
  assert.equal(record.dailyLimit, 6);
  assert.equal(record.outputType, 'function_call');
  assert.equal(record.threadRef, 'thread_AAAA');
  assert.equal(record.usageSource, 'unavailable');
  assert.equal(record.outcome, 'completed');

  const incomplete = buildCostRecords([{ ...reserved }, { ...created }]);
  assert.equal(incomplete[0].outcome, 'incomplete');
  assert.equal(incomplete[0].threadRef, 'thread_AAAA');
  assert.equal(incomplete[0].outputType, null);

  const withoutReserved = buildCostRecords([completed, created]);
  assert.deepEqual(withoutReserved, []);
});

test('summaries aggregate tokens, chars, tools, and outcome tallies', () => {
  const records = [
    { estimatedPromptTokens: 1000, promptChars: 4000, toolCount: 2, outputType: 'final', outcome: 'completed' },
    { estimatedPromptTokens: 2000, promptChars: 8000, toolCount: 4, outputType: 'function_call', outcome: 'completed' },
    { estimatedPromptTokens: 500, promptChars: 2000, toolCount: 0, outputType: null, outcome: 'incomplete' }
  ];
  const summary = summarizeCostRecords(records);
  assert.equal(summary.count, 3);
  assert.equal(summary.totalEstimatedTokens, 3500);
  assert.equal(summary.avgEstimatedTokens, 1167);
  assert.equal(summary.totalPromptChars, 14000);
  assert.equal(summary.avgPromptChars, 4667);
  assert.equal(summary.maxPromptChars, 8000);
  assert.equal(summary.avgToolCount, 2);
  assert.equal(summary.maxToolCount, 4);
  assert.deepEqual(summary.byOutcome, { completed: 2, incomplete: 1 });
  assert.deepEqual(summary.byOutputType, { final: 1, function_call: 1, unknown: 1 });

  assert.equal(summarizeCostRecords([]).count, 0);
  assert.equal(summarizeCostRecords([]).avgEstimatedTokens, 0);
});

test('loaders return empty results when local log files do not exist yet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hacb-cost-report-'));
  try {
    const missing = join(home, 'missing.jsonl');
    assert.deepEqual(await loadAuditEntries(missing), []);
    assert.deepEqual(await loadPromptExcerpts('req_x', missing), []);

    await writeFile(missing, `${JSON.stringify(reserved)}\n${JSON.stringify(completed)}\n`);
    assert.equal((await loadAuditEntries(missing)).length, 2);
    await writeFile(join(home, 'excerpts.jsonl'), `${JSON.stringify({ requestId: 'req_aaa111' })}\n`);
    assert.equal((await loadPromptExcerpts('req_aaa111', join(home, 'excerpts.jsonl'))).length, 1);
    assert.deepEqual(await loadPromptExcerpts('req_other', join(home, 'excerpts.jsonl')), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
