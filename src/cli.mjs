#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { activateAppMode, appModeStatus, deactivateAppMode } from './app-mode.mjs';
import { BridgeServer } from './bridge.mjs';
import {
  atomicWriteText,
  auditPath,
  getDailyBudgetStatus,
  loadConfig,
  logPath,
  pidPath,
  saveConfig,
  stateDir,
  VERSION
} from './config.mjs';
import { HyperagentClient } from './hyperagent.mjs';
import {
  codexProfilePath,
  generateCatalog,
  installCodexProfile,
  installCommand,
  installSkill,
  uninstallCodexProfile
} from './install.mjs';
import { getAccessToken, invalidateTokens, login } from './oauth.mjs';
import { buildAgentModels, slugify } from './protocol.mjs';
import { buildReceipt, readAuditEntries, receiptMarkdown } from './receipts.mjs';
import { runLiveDemo, runLocalDemo } from './demo.mjs';

const command = process.argv[2] || 'help';
const args = process.argv.slice(3);

function printHelp() {
  console.log(`Hyperagent Codex Bridge ${VERSION}

Usage:
  hacb setup                 Install, OAuth-login, create Codex profile, start bridge
  hacb install               Install the hacb command into a user-local bin directory
  hacb install-skill         Install the bundled Codex skill into CODEX_HOME/skills
  hacb login [--no-browser]  Authorize this bridge with Hyperagent
  hacb logout                Remove locally stored Hyperagent OAuth tokens
  hacb models [--all] [--json]
                            List pinned routes; --all discovers candidates
  hacb alias <slug> <agent>  Add a stable model alias mapped to an agent ID or name
  hacb profile [model]       Regenerate the Codex hyperagent profile
  hacb app-on [model]        Make Hyperagent the default for new Codex App chats
  hacb app-off               Restore normal App defaults; keep old bridge chats resumable
  hacb app-status            Show whether Codex App mode is active
  hacb audit [count]         Show recent sanitized bridge routing receipts
  hacb receipt [count]       Emit a publishable latency/routing receipt
  hacb demo                  Run a no-credit real-Codex local tool-loop demo
  hacb demo --live --confirm-spend
                            Run the controlled route through Hyperagent credits
  hacb budget                Show the local daily Hyperagent request cap
  hacb serve                 Run the local bridge in the foreground
  hacb start                 Run the local bridge in the background
  hacb stop                  Stop the background bridge
  hacb status                Show bridge status
  hacb doctor [--json]       Check security, OAuth, routes, bridge, and Codex
  hacb uninstall-profile     Remove only the generated Codex profile

Run Codex with Hyperagent credits:
  codex --profile hyperagent

The bridge binds only to 127.0.0.1. Revoke OAuth access anytime at:
  https://hyperagent.com/settings/mcp-access`);
}

async function listAgents(config) {
  const client = new HyperagentClient(config);
  try {
    return await client.listAgents();
  } finally {
    await client.close();
  }
}

async function printModels(config, { json = false, all = false } = {}) {
  const agents = await listAgents(config);
  const models = buildAgentModels(agents);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const rows = [
    ...Object.entries(config.aliases || {})
      .filter(([, id]) => byId.has(id))
      .map(([slug, id]) => ({ slug, agent: byId.get(id), alias: true })),
    ...((all || config.exposeAllAgents) ? models.map(item => ({ slug: item.slug, agent: item.agent, alias: false })) : [])
  ];
  if (!rows.length) {
    if (json) console.log(JSON.stringify({ models: [] }, null, 2));
    else console.log('No exposed models. Add an alias or enable exposeAllAgents.');
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      models: rows.map(row => ({ model: row.slug, agent: row.agent.name, agentId: row.agent.id, underlyingModel: row.agent.model || null, route: row.alias ? 'alias' : 'generated' }))
    }, null, 2));
    return;
  }
  console.log('MODEL ID'.padEnd(46), 'HYPERAGENT AGENT'.padEnd(30), 'AGENT ID');
  for (const row of rows) {
    console.log(row.slug.padEnd(46), row.agent.name.slice(0, 29).padEnd(30), row.agent.id);
  }
}

async function waitForHealth(config, timeoutMs = 8000) {
  const url = `http://${config.bridgeHost}:${config.bridgePort}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function startBackground(config) {
  if (await waitForHealth(config, 500)) {
    console.log(`Bridge already running on http://${config.bridgeHost}:${config.bridgePort}/v1`);
    return;
  }
  const logFile = await open(logPath(), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true,
    stdio: ['ignore', logFile.fd, logFile.fd],
    env: process.env
  });
  child.on('error', () => {});
  child.unref();
  await logFile.close();
  if (!(await waitForHealth(config))) throw new Error(`Bridge did not start. Run hacb serve to see the error. Log: ${logPath()}`);
  console.log(`Bridge started on http://${config.bridgeHost}:${config.bridgePort}/v1`);
}

async function stopBackground() {
  let pid;
  try {
    pid = Number((await readFile(pidPath(), 'utf8')).trim());
  } catch {
    console.log('No background bridge PID found.');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Stopped bridge process ${pid}.`);
  } catch (error) {
    if (error.code === 'ESRCH') console.log('Bridge process was not running.');
    else throw error;
  } finally {
    await rm(pidPath(), { force: true });
  }
}

function commandOutput(commandName, commandArgs) {
  return new Promise(resolve => {
    const child = spawn(commandName, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? text.trim() : null));
  });
}

async function runDoctor(config, { json = false } = {}) {
  let failed = false;
  const checks = [];
  const report = (ok, label, detail = '') => {
    checks.push({ ok, label, detail });
    if (!json) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) failed = true;
  };
  report(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js 20+', process.version);
  const codexVersion = await commandOutput(process.env.CODEX_BIN || 'codex', ['--version']);
  report(Boolean(codexVersion), 'Codex CLI', codexVersion || 'not found');
  report(config.bridgeHost === '127.0.0.1', 'Loopback-only bridge', config.bridgeHost);
  report(config.mcpUrl === 'https://hyperagent.com/api/mcp', 'Supported Hyperagent MCP endpoint', config.mcpUrl);
  report(config.issuer === 'https://hyperagent.com', 'OAuth issuer binding', config.issuer);
  report(Array.isArray(config.scopes) && config.scopes.length === 3 && ['threads:read', 'threads:write', 'offline_access'].every(scope => config.scopes.includes(scope)), 'Least-privilege OAuth scopes', (config.scopes || []).join(', '));
  report(typeof config.localApiToken === 'string' && config.localApiToken.length >= 32, 'Local bridge bearer token', 'stored in protected config');
  try {
    const mode = (await stat(stateDir())).mode & 0o777;
    report(process.platform === 'win32' || mode === 0o700, 'Private state directory permissions', process.platform === 'win32' ? 'Windows ACLs apply' : mode.toString(8));
  } catch (error) {
    report(false, 'Private state directory permissions', error.message);
  }
  const budget = await getDailyBudgetStatus(config);
  report(budget.remaining > 0, 'Daily request budget', `${budget.used}/${budget.limit} used, ${budget.remaining} remaining`);
  try {
    const token = await getAccessToken(config, { require: false });
    report(Boolean(token), 'Hyperagent OAuth', token ? 'connected' : 'run hacb login');
  } catch (error) {
    report(false, 'Hyperagent OAuth', error.message);
  }
  try {
    const agents = await listAgents(config);
    report(agents.length > 0, 'Reachable named agents', String(agents.length));
    const agentIds = new Set(agents.map(agent => agent.id));
    const staleAliases = Object.entries(config.aliases || {}).filter(([, id]) => !agentIds.has(id)).map(([slug]) => slug);
    report(staleAliases.length === 0, 'Pinned model routes', staleAliases.length ? `stale: ${staleAliases.join(', ')}` : `${Object.keys(config.aliases || {}).length} aliases valid`);
  } catch (error) {
    report(false, 'Reachable named agents', error.message);
  }
  const health = await waitForHealth(config, 750);
  report(health, 'Local bridge', health ? `127.0.0.1:${config.bridgePort}` : 'run hacb start');
  try {
    const profileText = await readFile(codexProfilePath(), 'utf8');
    report(profileText.includes('wire_api = "responses"') && profileText.includes('model_provider = "hyperagent_credits"'), 'Codex Responses profile', codexProfilePath());
  } catch {
    report(false, 'Codex profile', 'run hacb profile');
  }
  if (json) console.log(JSON.stringify({ version: VERSION, ok: !failed, checks }, null, 2));
  process.exitCode = failed ? 1 : 0;
  return { ok: !failed, checks };
}

async function main() {
  const config = await loadConfig();
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    case '--version':
    case 'version':
      console.log(VERSION);
      break;
    case 'install': {
      const result = await installCommand();
      console.log(`Installed command: ${result.launcher}`);
      console.log(`If hacb is not found, add ${result.launcher.replace(/[/\\]hacb(?:\.cmd)?$/, '')} to PATH.`);
      break;
    }
    case 'install-skill': {
      const result = await installSkill();
      console.log(`Installed Codex skill: ${result.target}`);
      console.log('Start a new Codex chat, then invoke it as $hyperagent-codex-bridge or browse /skills.');
      break;
    }
    case 'login': {
      const result = await login(config, { launchBrowser: !args.includes('--no-browser') });
      console.log(`Connected to Hyperagent (${result.issuer}).`);
      break;
    }
    case 'logout':
      await invalidateTokens(config);
      console.log('Removed locally stored Hyperagent OAuth tokens. Revoke the connection in Hyperagent settings if desired.');
      break;
    case 'models':
      await printModels(config, { json: args.includes('--json'), all: args.includes('--all') });
      break;
    case 'alias': {
      const [slugRaw, agentRef] = args;
      if (!slugRaw || !agentRef) throw new Error('Usage: hacb alias <slug> <agent-id-or-exact-name>');
      const slug = slugRaw.includes('/') ? slugRaw : `hyperagent/${slugify(slugRaw)}`;
      if (!/^hyperagent\/[a-z0-9][a-z0-9._-]*$/.test(slug)) throw new Error(`Invalid model alias: ${slug}`);
      const agents = await listAgents(config);
      const matches = agents.filter(agent => agent.id === agentRef || agent.name.toLowerCase() === agentRef.toLowerCase());
      if (matches.length !== 1) throw new Error(matches.length ? 'Agent reference is ambiguous; use the exact agent ID.' : `No reachable agent matches '${agentRef}'.`);
      config.aliases ||= {};
      config.aliases[slug] = matches[0].id;
      await saveConfig(config);
      await generateCatalog(config, agents);
      console.log(`Mapped ${slug} -> ${matches[0].name} (${matches[0].id}).`);
      break;
    }
    case 'profile': {
      const result = await installCodexProfile(config, { defaultModel: args[0] });
      console.log(`Wrote Codex profile: ${result.profile}`);
      console.log(`Default model: ${result.selected}`);
      if (result.backupPath) console.log(`Previous profile backed up: ${result.backupPath}`);
      break;
    }
    case 'app-on': {
      await startBackground(config);
      const result = await activateAppMode(config, { model: args[0] });
      console.log(`Codex App mode ON: ${result.selected}`);
      console.log(`Config: ${result.path}`);
      console.log(`Backup: ${result.backup}`);
      console.log('Fully quit and reopen the Codex App, then start a new chat.');
      break;
    }
    case 'app-off': {
      const result = await deactivateAppMode(config);
      console.log('Codex App mode OFF. Normal OpenAI defaults restored.');
      console.log(`The ${config.codexProviderId} provider block remains so existing bridge chats can resume.`);
      console.log(`Config: ${result.path}`);
      break;
    }
    case 'app-status': {
      const status = await appModeStatus(config);
      console.log(status.active ? 'ON' : 'OFF');
      console.log(`Config: ${status.configPath}`);
      console.log(`Model: ${status.model || '(base/default)'}`);
      console.log(`Provider: ${status.provider || '(base/default)'}`);
      console.log(`Bridge provider configured: ${status.providerConfigured ? 'yes' : 'no'}`);
      break;
    }
    case 'audit': {
      const count = Math.min(100, Math.max(1, Number(args[0] || 12)));
      let text = '';
      try {
        text = await readFile(auditPath(), 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const entries = text.trim().split(/\r?\n/).filter(Boolean).slice(-count);
      if (!entries.length) {
        console.log('No bridge routing receipts yet.');
        break;
      }
      for (const line of entries) {
        const item = JSON.parse(line);
        console.log([
          item.at,
          item.event,
          item.model || '',
          item.threadId || '',
          item.outputType || '',
          item.requestId || '',
          item.promptChars ? `promptChars=${item.promptChars}` : '',
          Number.isFinite(item.totalMs) ? `totalMs=${item.totalMs}` : '',
          item.dailyUsed ? `daily=${item.dailyUsed}/${item.dailyLimit}` : '',
          item.errorCode || ''
        ].filter(Boolean).join('  '));
      }
      break;
    }
    case 'receipt': {
      const count = Math.min(500, Math.max(1, Number(args.find(value => /^\d+$/.test(value)) || 24)));
      const receipt = buildReceipt(await readAuditEntries(count * 3), { includeThreadIds: args.includes('--include-thread-ids') });
      if (args.includes('--json')) console.log(JSON.stringify(receipt, null, 2));
      else console.log(receiptMarkdown(receipt).trimEnd());
      break;
    }
    case 'budget': {
      const budget = await getDailyBudgetStatus(config);
      console.log(`${budget.day}  ${budget.used}/${budget.limit} requests used  ${budget.remaining} remaining`);
      console.log('Each Codex tool loop can consume multiple Hyperagent requests. Change maxRequestsPerDay only after reviewing credits.');
      break;
    }
    case 'demo': {
      const live = args.includes('--live');
      if (live) await startBackground(config);
      const result = live
        ? await runLiveDemo(config, { confirmSpend: args.includes('--confirm-spend') })
        : await runLocalDemo();
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'setup': {
      const installed = await installCommand();
      console.log(`Installed command: ${installed.launcher}`);
      const skill = await installSkill();
      console.log(`Installed Codex skill: ${skill.target}`);
      await login(config, { launchBrowser: !args.includes('--no-browser') });
      if (!Object.keys(config.aliases || {}).length) {
        const agents = await listAgents(config);
        const relayCandidates = agents.filter(agent => /(?:^|\s)relay(?:\s|$)/i.test(agent.name));
        if (relayCandidates.length !== 1) {
          throw new Error(`Setup found ${relayCandidates.length} clearly named relay agents. Run 'hacb models --all', then 'hacb alias <slug> <exact-agent-id>' before creating a profile.`);
        }
        config.aliases = { 'hyperagent/default': relayCandidates[0].id };
        config.defaultAgentId = relayCandidates[0].id;
        config.exposeAllAgents = false;
        await saveConfig(config);
        console.log(`Pinned hyperagent/default to ${relayCandidates[0].name}.`);
      }
      const profile = await installCodexProfile(config);
      console.log(`Wrote Codex profile: ${profile.profile}`);
      await startBackground(config);
      const doctor = await runDoctor(config, { json: false });
      if (!doctor.ok) throw new Error('Setup completed but verification failed. Fix the failed checks before using credits.');
      console.log('Ready. Prove the local harness without spending credits: hacb demo');
      console.log('Then start Codex with: codex --profile hyperagent');
      break;
    }
    case 'serve': {
      const bridge = new BridgeServer(config);
      await bridge.start();
      await atomicWriteText(pidPath(), `${process.pid}\n`, 0o600);
      console.log(`Hyperagent Codex Bridge listening on http://${config.bridgeHost}:${config.bridgePort}/v1`);
      const shutdown = async () => {
        await bridge.close();
        await rm(pidPath(), { force: true });
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
      break;
    }
    case 'start':
      await startBackground(config);
      break;
    case 'stop':
      await stopBackground();
      break;
    case 'status': {
      const ok = await waitForHealth(config, 750);
      console.log(ok
        ? `RUNNING http://${config.bridgeHost}:${config.bridgePort}/v1`
        : `STOPPED (state: ${stateDir()})`);
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'doctor':
      await runDoctor(config, { json: args.includes('--json') });
      break;
    case 'uninstall-profile': {
      const result = await uninstallCodexProfile();
      console.log(`Removed ${result.profile}.`);
      break;
    }
    default:
      throw new Error(`Unknown command '${command}'. Run hacb help.`);
  }
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
