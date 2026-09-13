#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { activateAppMode, appModeStatus, deactivateAppMode } from './app-mode.mjs';
import { BridgeServer } from './bridge.mjs';
import {
  atomicWriteText,
  auditPath,
  getDailyBudgetStatus,
  getActiveTask,
  loadConfig,
  logPath,
  pidPath,
  saveConfig,
  startTask,
  stopTask,
  SAFE_MAX_REQUESTS_PER_DAY,
  stateDir,
  VERSION,
  bridgeUrl
} from './config.mjs';
import { HyperagentClient } from './hyperagent.mjs';
import { OpenRouterClient } from './openrouter.mjs';
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
import {
  buildCostRecords,
  loadAuditEntries,
  loadPromptExcerpts,
  summarizeCostRecords
} from './cost-report.mjs';

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
  hacb models                List model IDs exposed to Codex
  hacb alias <slug> <agent>  Add a stable model alias mapped to an agent ID or name
  hacb profile [model]       Regenerate the Codex hyperagent profile
  hacb app-on [model]        Make Hyperagent the default for new Codex App chats
  hacb app-off               Restore normal App defaults; keep old bridge chats resumable
  hacb app-status            Show whether Codex App mode is active
  hacb audit [count]         Show recent sanitized bridge routing receipts
  hacb audit --cost [count]  Show receipts with estimated prompt token breakdown
  hacb cost-report [--last N]  Summarize recent dispatched requests (chars, ~tokens, tools)
  hacb explain-prompt [--verbose]  Break down where the last relay prompt's characters went
  hacb budget                Show the local daily Hyperagent request cap
  hacb budget --safe         Restore the six-request safe default
  hacb budget --set <count>  Explicitly set a custom daily request cap (1-100)
  hacb task start <name>     Start a named task with its own Hyperagent budget
  hacb task status           Show the active task and its budget usage
  hacb task stop             Close the active task
  hacb serve                 Run the local bridge in the foreground
  hacb start                 Run the local bridge in the background
  hacb stop                  Stop the background bridge
  hacb status                Show bridge status
  hacb doctor                Check OAuth, agents, bridge, and Codex profile
  hacb uninstall-profile     Remove only the generated Codex profile

Run Codex with Hyperagent credits:
  codex --profile hyperagent

The bridge binds only to 127.0.0.1. Revoke OAuth access anytime at:
  https://hyperagent.com/settings/mcp-access`);
}

async function listAgents(config) {
  if (config.upstream === 'openrouter') {
    const client = new OpenRouterClient(config);
    try {
      return await client.listAgents();
    } finally {
      await client.close();
    }
  }
  const client = new HyperagentClient(config);
  try {
    return await client.listAgents();
  } finally {
    await client.close();
  }
}

async function printModels(config) {
  const agents = await listAgents(config);
  const models = buildAgentModels(agents);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const rows = [
    ...Object.entries(config.aliases || {})
      .filter(([, id]) => byId.has(id))
      .map(([slug, id]) => ({ slug, agent: byId.get(id), alias: true })),
    ...(config.exposeAllAgents ? models.map(item => ({ slug: item.slug, agent: item.agent, alias: false })) : [])
  ];
  if (!rows.length) {
    console.log('No exposed models. Add an alias or enable exposeAllAgents.');
    return;
  }
  console.log('MODEL ID'.padEnd(46), 'HYPERAGENT AGENT'.padEnd(30), 'AGENT ID');
  for (const row of rows) {
    console.log(row.slug.padEnd(46), row.agent.name.slice(0, 29).padEnd(30), row.agent.id);
  }
}

async function waitForHealth(config, timeoutMs = 8000) {
  const url = bridgeUrl(config, '/health');
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
    console.log(`Bridge already running on ${bridgeUrl(config, '/v1')}`);
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
  console.log(`Bridge started on ${bridgeUrl(config, '/v1')}`);
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

async function runDoctor(config) {
  let failed = false;
  const report = (ok, label, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) failed = true;
  };
  report(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js 20+', process.version);
  report(typeof config.localApiToken === 'string' && config.localApiToken.length >= 32, 'Local bridge bearer token', 'stored in protected config');
  const budget = await getDailyBudgetStatus(config);
  report(budget.remaining > 0, 'Daily request budget', `${budget.used}/${budget.limit} used, ${budget.remaining} remaining`);
  report(budget.limit <= SAFE_MAX_REQUESTS_PER_DAY, 'Safe request ceiling', budget.limit <= SAFE_MAX_REQUESTS_PER_DAY ? `${budget.limit} per UTC day` : `custom cap ${budget.limit} exceeds safe default ${SAFE_MAX_REQUESTS_PER_DAY}`);
  if (config.upstream === 'openrouter') {
    report(true, 'Upstream', `openrouter (${config.openrouterModel || 'unconfigured model'})`);
    report(Boolean(process.env.OPENROUTER_API_KEY || config.openrouterApiKey), 'OpenRouter API key', process.env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY' : (config.openrouterApiKey ? 'config' : 'missing'));
  } else {
    try {
      const token = await getAccessToken(config, { require: false });
      report(Boolean(token), 'Hyperagent OAuth', token ? 'connected' : 'run hacb login');
    } catch (error) {
      report(false, 'Hyperagent OAuth', error.message);
    }
  }
  try {
    const agents = await listAgents(config);
    report(agents.length > 0, 'Reachable named agents', String(agents.length));
  } catch (error) {
    report(false, 'Reachable named agents', error.message);
  }
  const health = await waitForHealth(config, 750);
  report(health, 'Local bridge', health ? `127.0.0.1:${config.bridgePort}` : 'run hacb start');
  try {
    await readFile(codexProfilePath(), 'utf8');
    report(true, 'Codex profile', codexProfilePath());
  } catch {
    report(false, 'Codex profile', 'run hacb profile');
  }
  process.exitCode = failed ? 1 : 0;
}

function argFlagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function formatInt(value) {
  return Number(value || 0).toLocaleString('en-US');
}

async function runCostReport(args) {
  const lastRaw = argFlagValue(args, '--last');
  const count = Math.min(500, Math.max(1, Number(lastRaw) || 20));
  const records = buildCostRecords(await loadAuditEntries()).slice(-count);
  if (!records.length) {
    console.log('No dispatched bridge requests recorded yet.');
    return;
  }
  console.log(`Last ${records.length} dispatched request${records.length === 1 ? '' : 's'} (local estimates; ceil(chars / 4)):\n`);
  console.log(
    'TIME'.padEnd(21),
    'REQUEST'.padEnd(18),
    'OUTCOME'.padEnd(15),
    'PROMPT'.padStart(8),
    '~TOKENS'.padStart(9),
    'CONV'.padStart(8),
    'SCHEMA'.padStart(8),
    'RESULT'.padStart(8),
    'TOOLS'.padStart(6),
    'DAILY'.padStart(7)
  );
  for (const record of records) {
    console.log(
      String(record.timestamp || '').slice(0, 19).replace('T', ' ').padEnd(21),
      record.requestId.replace(/^req_/, '').slice(0, 14).padEnd(18),
      (record.outcome === 'completed' ? record.outputType || 'final' : record.outcome).slice(0, 14).padEnd(15),
      formatInt(record.promptChars).padStart(8),
      formatInt(record.estimatedPromptTokens).padStart(9),
      formatInt(record.conversationChars).padStart(8),
      formatInt(record.toolSchemaChars).padStart(8),
      formatInt(record.toolResultChars).padStart(8),
      formatInt(record.toolCount).padStart(6),
      `${record.dailyUsed ?? '?'}/${record.dailyLimit ?? '?'}`.padStart(7)
    );
  }
  const summary = summarizeCostRecords(records);
  console.log('');
  console.log(`Requests: ${summary.count} (${Object.entries(summary.byOutcome).map(([key, value]) => `${key}=${value}`).join(', ')})`);
  console.log(`Estimated prompt tokens: total ${formatInt(summary.totalEstimatedTokens)}, avg ${formatInt(summary.avgEstimatedTokens)} per request`);
  console.log(`Prompt chars: avg ${formatInt(summary.avgPromptChars)}, max ${formatInt(summary.maxPromptChars)}`);
  console.log(`Forwarded tools: avg ${summary.avgToolCount}, max ${summary.maxToolCount}`);
  console.log(`Output types: ${Object.entries(summary.byOutputType).map(([key, value]) => `${key}=${value}`).join(', ') || 'unknown'}`);
  console.log('Estimates are local approximations only; Hyperagent does not report authoritative token usage.');
}

async function runExplainPrompt(args) {
  const verbose = args.includes('--verbose') || args.includes('-v');
  const records = buildCostRecords(await loadAuditEntries());
  const record = records.at(-1);
  if (!record) {
    console.log('No dispatched bridge requests recorded yet.');
    return;
  }
  console.log(`Last dispatched request: ${record.requestId}`);
  console.log(`Timestamp: ${record.timestamp}`);
  console.log(`Model: ${record.model ?? '(unknown)'}   Outcome: ${record.outcome}   Output: ${record.outputType ?? 'n/a'}`);
  console.log('');
  console.log('Relay prompt section breakdown (local estimate):');
  console.log(`  relay instructions   ${formatInt(record.relayInstructionChars)} chars`);
  console.log(`  conversation         ${formatInt(record.conversationChars)} chars (tool results inside: ${formatInt(record.toolResultChars)})`);
  console.log(`  client tool schemas  ${formatInt(record.toolSchemaChars)} chars`);
  console.log(`  payload JSON total   ${formatInt(record.payloadChars)} chars`);
  console.log(`  prompt total         ${formatInt(record.promptChars)} chars ≈ ${formatInt(record.estimatedPromptTokens)} estimated tokens (ceil(chars / 4))`);
  console.log('');
  console.log(`Retention limits in effect: maxInputChars=${record.maxInputChars ?? '?'} maxTurnChars=${record.maxTurnChars ?? '?'} maxConversationTurns=${record.maxConversationTurns ?? '?'} maxForwardedTools=${record.maxForwardedTools ?? '?'}`);
  console.log(`Retained turns: ${record.retainedTurns ?? '?'}   Forwarded tools: ${record.toolCount}   Daily budget at reservation: ${record.dailyUsed ?? '?'}/${record.dailyLimit ?? '?'}`);
  if (!verbose) {
    console.log('Run with --verbose to show captured prompt excerpts when debugPromptExcerpts is enabled.');
    return;
  }
  const excerptEntries = await loadPromptExcerpts(record.requestId);
  if (!excerptEntries.length) {
    console.log('No excerpts captured for this request. Set "debugPromptExcerpts": true in config.json before dispatching.');
    return;
  }
  console.log('');
  for (const entry of excerptEntries.slice(-1)) {
    if (entry.relayInstructionsExcerpt) console.log(`Relay instructions excerpt: ${entry.relayInstructionsExcerpt}`);
    if (entry.conversationExcerpt) console.log(`Conversation excerpt: ${entry.conversationExcerpt}`);
    if (entry.toolSchemaExcerpt) console.log(`Tool schema excerpt: ${entry.toolSchemaExcerpt}`);
  }
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
      await printModels(config);
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
      const costMode = args.includes('--cost');
      const countArg = args.find(value => /^\d+$/.test(value));
      const count = Math.min(100, Math.max(1, Number(countArg || 12)));
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
        const costParts = !costMode || item.event !== 'request_reserved' ? [] : [
          item.estimatedPromptTokens != null ? `~tokens=${item.estimatedPromptTokens}` : '',
          item.conversationChars != null ? `conv=${item.conversationChars}` : '',
          item.toolSchemaChars != null ? `schema=${item.toolSchemaChars}` : '',
          item.toolResultChars != null ? `result=${item.toolResultChars}` : ''
        ];
        console.log([
          item.at,
          item.event,
          item.requestId || '',
          item.model || '',
          item.agentRef || '',
          item.threadRef || '',
          item.reservationRef || '',
          item.outputType || '',
          item.promptChars ? `promptChars=${item.promptChars}` : '',
          ...costParts,
          item.dailyUsed ? `daily=${item.dailyUsed}/${item.dailyLimit}` : '',
          item.errorCode || ''
        ].filter(Boolean).join('  '));
      }
      if (costMode) console.log('Token figures are local estimates (ceil(chars / 4)), not authoritative usage.');
      break;
    }
    case 'cost-report':
      await runCostReport(args);
      break;
    case 'explain-prompt':
      await runExplainPrompt(args);
      break;
    case 'budget': {
      if (args[0] === '--safe') {
        config.maxRequestsPerDay = SAFE_MAX_REQUESTS_PER_DAY;
        await saveConfig(config);
        console.log(`Restored safe daily request cap: ${SAFE_MAX_REQUESTS_PER_DAY}.`);
      } else if (args[0] === '--set') {
        const requested = Number(args[1]);
        if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100) {
          throw new Error('Usage: hacb budget --set <integer from 1 to 100>');
        }
        config.maxRequestsPerDay = requested;
        await saveConfig(config);
        console.log(`Set custom daily request cap: ${requested}. The safe default is ${SAFE_MAX_REQUESTS_PER_DAY}.`);
      } else if (args.length) {
        throw new Error('Usage: hacb budget [--safe | --set <count>]');
      }
      const budget = await getDailyBudgetStatus(config);
      console.log(`${budget.day}  ${budget.used}/${budget.limit} slots used  ${budget.remaining} remaining (${budget.committed} committed, ${budget.reserved} reserved)`);
      console.log('Each Codex tool loop can consume multiple Hyperagent requests. Raise the cap only after reviewing credits.');
      break;
    }
    case 'task': {
      const subcommand = args[0] || 'status';
      if (subcommand === 'start') {
        const name = args[1];
        if (!name) throw new Error('Usage: hacb task start <name>');
        const task = await startTask(name, {
          maxRequestsPerTask: config.maxRequestsPerTask,
          maxPromptCharsPerTask: config.maxPromptCharsPerTask,
          warnAtPromptCharsPerTask: config.warnAtPromptCharsPerTask
        });
        console.log(`Started task '${task.name}'. Budget: ${task.limits.maxRequestsPerTask} requests, ${task.limits.maxPromptCharsPerTask} prompt chars.`);
      } else if (subcommand === 'stop') {
        const stopped = await stopTask();
        console.log(stopped ? `Stopped task '${stopped.name}' (${stopped.requestCount} requests, ${stopped.promptChars} prompt chars).` : 'No active task.');
      } else if (subcommand === 'status') {
        const task = await getActiveTask();
        if (!task) {
          console.log('No active task. Start one with: hacb task start <name>');
        } else {
          console.log(`Active task '${task.name}' (started ${task.startedAt})`);
          console.log(`Requests: ${task.requestCount}/${(task.limits || {}).maxRequestsPerTask ?? '?'}   Prompt chars: ${task.promptChars}/${(task.limits || {}).maxPromptCharsPerTask ?? '?'}`);
        }
      } else {
        throw new Error('Usage: hacb task [start <name> | status | stop]');
      }
      break;
    }
    case 'setup': {
      const installed = await installCommand();
      console.log(`Installed command: ${installed.launcher}`);
      const skill = await installSkill();
      console.log(`Installed Codex skill: ${skill.target}`);
      await login(config, { launchBrowser: !args.includes('--no-browser') });
      const profile = await installCodexProfile(config);
      console.log(`Wrote Codex profile: ${profile.profile}`);
      await startBackground(config);
      console.log(`Ready. Start Codex with: codex --profile hyperagent`);
      break;
    }
    case 'serve': {
      const bridge = new BridgeServer(config);
      await bridge.start();
      await atomicWriteText(pidPath(), `${process.pid}\n`, 0o600);
      console.log(`Hyperagent Codex Bridge listening on ${bridgeUrl(config, '/v1')}`);
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
        ? `RUNNING ${bridgeUrl(config, '/v1')}`
        : `STOPPED (state: ${stateDir()})`);
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case 'doctor':
      await runDoctor(config);
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
