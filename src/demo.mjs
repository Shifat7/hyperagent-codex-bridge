import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer } from './bridge.mjs';
import { DEFAULT_CONFIG, getDailyBudgetStatus } from './config.mjs';
import { installCodexProfile } from './install.mjs';
import { buildReceipt, readAuditEntries } from './receipts.mjs';

const DEMO_AGENT = { id: 'hacb-local-demo-agent', name: 'HACB Local Demo', description: 'No-credit deterministic local harness demo', model: 'deterministic-fixture' };

function run(command, args, options, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Demo timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function runLocalDemo({ codexBin = process.env.CODEX_BIN || 'codex' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hacb-local-demo-'));
  const previousHacb = process.env.HACB_HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.HACB_HOME = join(root, 'state');
  process.env.CODEX_HOME = join(root, 'codex');
  const marker = `hacb_local_tool_${randomBytes(6).toString('hex')}`;
  const audits = [];
  let samples = 0;
  let latestPrompt = '';
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    bridgePort: 0,
    localApiToken: randomBytes(32).toString('base64url'),
    aliases: { 'hyperagent/hacb-local-demo': DEMO_AGENT.id }
  };
  const factory = () => ({
    async listAgents() { return [DEMO_AGENT]; },
    async createThread(_agentId, prompt) {
      latestPrompt = prompt;
      return `local_demo_thread_${samples + 1}`;
    },
    async waitForThread() {
      samples += 1;
      if (samples === 1) {
        const payload = JSON.parse(latestPrompt.slice(latestPrompt.lastIndexOf('\n{') + 1));
        const tool = payload.client_tools.find(item => item.type === 'function' && ['exec_command', 'shell', 'shell_command', 'container.exec'].includes(item.name));
        if (!tool) throw new Error('Codex did not expose a supported local shell tool to the bridge demo.');
        const commandSchema = tool.parameters?.properties?.command;
        const command = commandSchema?.type === 'array' ? ['bash', '-lc', `printf ${marker}`] : `printf ${marker}`;
        const argumentsValue = tool.name === 'exec_command'
          ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 1000 }
          : { command, timeout_ms: 5000 };
        return { text: JSON.stringify({ type: 'function_call', name: tool.name, arguments: argumentsValue }), status: 'completed' };
      }
      if (!latestPrompt.includes(marker)) throw new Error('The local shell result did not return through Codex to the relay.');
      return { text: '{"type":"final","text":"HACB_LOCAL_DEMO_OK"}', status: 'completed' };
    },
    async close() {}
  });
  const bridge = new BridgeServer(config, {
    clientFactory: factory,
    auditWriter: async event => audits.push({ at: new Date().toISOString(), ...event }),
    budgetGuard: async () => ({ day: 'local-demo', used: samples + 1, limit: 99, remaining: 98 - samples })
  });
  const startedAt = Date.now();
  try {
    await bridge.start();
    config.bridgePort = bridge.server.address().port;
    await installCodexProfile(config, { defaultModel: 'hyperagent/hacb-local-demo', agents: [DEMO_AGENT] });
    const result = await run(codexBin, [
      'exec', '--profile', 'hyperagent', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', 'read-only', '--color', 'never',
      'Use the local shell tool once, then return the relay final answer.'
    ], {
      cwd: root,
      env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes('HACB_LOCAL_DEMO_OK')) {
      throw new Error(`Codex local demo failed with exit code ${result.code}. No prompt or answer content was retained.`);
    }
    return {
      schema: 'hacb.demo.v1',
      mode: 'local-no-credit',
      ok: true,
      codexBinary: codexBin,
      samples,
      localToolRoundTrip: samples >= 2,
      totalMs: Date.now() - startedAt,
      receipt: buildReceipt(audits)
    };
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
    if (previousHacb === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = previousHacb;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
}

export async function runLiveDemo(config, { codexBin = process.env.CODEX_BIN || 'codex', confirmSpend = false } = {}) {
  if (!confirmSpend) throw new Error('Live demo spends Hyperagent credits. Re-run with: hacb demo --live --confirm-spend');
  const budget = await getDailyBudgetStatus(config);
  if (budget.remaining < 2) throw new Error(`Live demo needs at least two remaining requests; ${budget.remaining} remain today.`);
  const root = await mkdtemp(join(tmpdir(), 'hacb-live-demo-'));
  const marker = `hacb_live_tool_${randomBytes(6).toString('hex')}`;
  const before = new Date();
  const startedAt = Date.now();
  try {
    const result = await run(codexBin, [
      'exec', '--profile', 'hyperagent', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', 'read-only', '--color', 'never',
      `Use the local shell tool to run printf ${marker}. After the tool result returns, reply exactly HACB_LIVE_DEMO_OK.`
    ], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    }, Math.min(config.runTimeoutMs || 600000, 600000));
    if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes('HACB_LIVE_DEMO_OK')) {
      throw new Error(`Live Codex route failed with exit code ${result.code}. Inspect hacb audit; no prompt or answer content was retained by the demo.`);
    }
    const entries = (await readAuditEntries(200)).filter(entry => Date.parse(entry.at) >= before.getTime());
    const receipt = buildReceipt(entries);
    if (receipt.summary.completed < 2 || !receipt.requests.some(item => item.outputType === 'function_call') || !receipt.requests.some(item => item.outputType === 'final')) {
      throw new Error('Live route returned an answer but did not produce a complete function_call -> final audit sequence.');
    }
    return {
      schema: 'hacb.demo.v1',
      mode: 'live-hyperagent-credits',
      ok: true,
      localToolRoundTrip: true,
      totalMs: Date.now() - startedAt,
      receipt,
      billingProofRequired: 'Compare Hyperagent credits before/after; supported MCP does not expose per-request cost.'
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
