import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, receiptMarkdown } from '../src/receipts.mjs';

test('public receipts aggregate latency and hash thread IDs without content', () => {
  const entries = [
    { at: '2026-07-21T00:00:00Z', event: 'request', requestId: 'hacb_1', model: 'hyperagent/sol', promptChars: 1000, toolCount: 2, costMeasurement: 'unavailable_from_supported_mcp' },
    { at: '2026-07-21T00:00:01Z', event: 'thread_created', requestId: 'hacb_1', model: 'hyperagent/sol', threadId: 'private_thread_123', createThreadMs: 100 },
    { at: '2026-07-21T00:00:02Z', event: 'completed', requestId: 'hacb_1', model: 'hyperagent/sol', threadId: 'private_thread_123', outputType: 'function_call', totalMs: 2000 },
    { at: '2026-07-21T00:00:03Z', event: 'request', requestId: 'hacb_2', model: 'hyperagent/sol', promptChars: 500, toolCount: 1 },
    { at: '2026-07-21T00:00:04Z', event: 'failed', requestId: 'hacb_2', model: 'hyperagent/sol', threadId: 'private_thread_456', errorCode: 'relay_invalid_json', totalMs: 900 }
  ];
  const receipt = buildReceipt(entries);
  assert.deepEqual(receipt.summary, { requests: 2, completed: 1, failed: 1, incomplete: 0, p50TotalMs: 2000, p95TotalMs: 2000 });
  assert.match(receipt.requests[0].threadId, /^sha256:/);
  assert.doesNotMatch(JSON.stringify(receipt), /private_thread/);
  assert.doesNotMatch(receiptMarkdown(receipt), /prompt text|answer text|token-/);
});
