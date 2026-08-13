import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateAppMode } from '../src/app-mode.mjs';
import { BridgeServer } from '../src/bridge.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { installCodexProfile } from '../src/install.mjs';

const CODEX_BIN = process.env.CODEX_BIN;
const agent = { id: 'agent-sol-123456', name: 'Sol Coder', description: 'Sol test agent', model: 'openai/gpt-5.6-sol' };

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('real Codex CLI accepts generated profile, catalog, auth, and Responses SSE', { skip: !CODEX_BIN, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hacb-codex-e2e-'));
  const oldHacb = process.env.HACB_HOME;
  const oldCodex = process.env.CODEX_HOME;
  process.env.HACB_HOME = join(root, 'state');
  process.env.CODEX_HOME = join(root, 'codex');
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    bridgePort: 0,
    localApiToken: 'codex-e2e-local-token-12345678901234567890',
    aliases: { 'hyperagent/sol-coder': agent.id }
  };
  let relayPrompt = '';
  let sampleCount = 0;
  const factory = () => ({
    async listAgents() { return [agent]; },
    async createThread(_agentId, prompt) {
      relayPrompt = prompt;
      return `thread_codex_e2e_${sampleCount + 1}`;
    },
    async waitForThread() {
      sampleCount += 1;
      if (sampleCount === 1) {
        const payload = JSON.parse(relayPrompt.slice(relayPrompt.lastIndexOf('\n{') + 1));
        const tool = payload.client_tools.find(item => item.type === 'function' && ['exec_command', 'shell', 'shell_command', 'container.exec'].includes(item.name));
        assert.ok(tool, `Expected a Codex shell tool in ${JSON.stringify(payload.client_tools.map(item => item.name))}`);
        const commandSchema = tool.parameters?.properties?.command;
        const command = commandSchema?.type === 'array'
          ? ['bash', '-lc', 'printf codex_tool_loop_ok']
          : 'printf codex_tool_loop_ok';
        const argumentsValue = tool.name === 'exec_command'
          ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 1000 }
          : { command, timeout_ms: 5000 };
        return {
          text: JSON.stringify({ type: 'function_call', name: tool.name, arguments: argumentsValue }),
          status: 'completed'
        };
      }
      assert.match(relayPrompt, /codex_tool_loop_ok/);
      return { text: '{"type":"final","text":"native codex bridge works"}', status: 'completed' };
    },
    async close() {}
  });
  const bridge = new BridgeServer(config, { clientFactory: factory });

  try {
    await bridge.start();
    config.bridgePort = bridge.server.address().port;
    await installCodexProfile(config, { agents: [agent] });
    const result = await run(CODEX_BIN, [
      'exec',
      '--profile', 'hyperagent',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      'Reply with the test phrase.'
    ], {
      cwd: root,
      env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.code, 0, `Codex failed. stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /native codex bridge works/);
    assert.ok(sampleCount >= 2, `Expected a Codex tool round trip, got ${sampleCount} sampling request(s).`);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
    if (oldHacb === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = oldHacb;
    if (oldCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodex;
  }
});

test('real Codex CLI uses App Mode from main config without a profile flag', { skip: !CODEX_BIN, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'hacb-codex-app-e2e-'));
  const oldHacb = process.env.HACB_HOME;
  const oldCodex = process.env.CODEX_HOME;
  process.env.HACB_HOME = join(root, 'state');
  process.env.CODEX_HOME = join(root, 'codex');
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    bridgePort: 0,
    localApiToken: 'codex-app-local-token-12345678901234567890',
    aliases: { 'hyperagent/sol-coder': agent.id }
  };
  const factory = () => ({
    async listAgents() { return [agent]; },
    async createThread() { return 'thread_codex_app_e2e'; },
    async waitForThread() { return { text: '{"type":"final","text":"codex app mode works"}', status: 'completed' }; },
    async close() {}
  });
  const bridge = new BridgeServer(config, { clientFactory: factory });

  try {
    await bridge.start();
    config.bridgePort = bridge.server.address().port;
    await activateAppMode(config, { model: 'hyperagent/sol-coder', agents: [agent] });
    const result = await run(CODEX_BIN, [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--color', 'never',
      'Reply with the app-mode test phrase.'
    ], {
      cwd: root,
      env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.code, 0, `Codex App Mode failed. stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /codex app mode works/);
    assert.match(result.stderr, /provider: hyperagent_credits/);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
    if (oldHacb === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = oldHacb;
    if (oldCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodex;
  }
});
