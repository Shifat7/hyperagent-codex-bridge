import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const APP_NAME = 'hyperagent-codex-bridge';
export const VERSION = '0.5.0';
export const DEFAULT_MCP_URL = 'https://hyperagent.com/api/mcp';
export const DEFAULT_ISSUER = 'https://hyperagent.com';
export const DEFAULT_BRIDGE_PORT = 47831;
export const DEFAULT_CALLBACK_PORT = 47832;

export function stateDir() {
  return resolve(process.env.HACB_HOME || join(homedir(), '.hyperagent-codex-bridge'));
}

export function statePath() {
  return join(stateDir(), 'state.json');
}

export function configPath() {
  return join(stateDir(), 'config.json');
}

export function modelCatalogPath() {
  return join(stateDir(), 'models.json');
}

export function pidPath() {
  return join(stateDir(), 'bridge.pid');
}

export function logPath() {
  return join(stateDir(), 'bridge.log');
}

export function auditPath() {
  return join(stateDir(), 'audit.jsonl');
}

export function usagePath() {
  return join(stateDir(), 'usage.json');
}

export const DEFAULT_CONFIG = Object.freeze({
  mcpUrl: DEFAULT_MCP_URL,
  issuer: DEFAULT_ISSUER,
  bridgeHost: '127.0.0.1',
  bridgePort: DEFAULT_BRIDGE_PORT,
  callbackHost: '127.0.0.1',
  callbackPort: DEFAULT_CALLBACK_PORT,
  scopes: [
    'threads:read',
    'threads:write',
    'offline_access'
  ],
  pollIntervalMs: 1500,
  runTimeoutMs: 30 * 60 * 1000,
  aliases: {},
  defaultAgentId: null,
  exposeAllAgents: false,
  codexProviderId: 'hyperagent_credits',
  localApiToken: null,
  defaultReasoningEffort: 'low',
  allowClientReasoningEffort: false,
  maxRequestsPerDay: 6,
  maxInputChars: 24000,
  maxTurnChars: 6000,
  maxConversationTurns: 8,
  maxForwardedTools: 32,
  maxPromptChars: 70000,
  blockMultiAgentTools: true,
  strictRelayProtocol: true
});

export async function ensureStateDir() {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await chmod(stateDir(), 0o700).catch(() => {});
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`Could not read ${path}: ${error.message}`);
  }
}

export async function loadState() {
  await ensureStateDir();
  return readJson(statePath(), { oauth: {}, mcp: {} });
}

export async function loadConfig() {
  await ensureStateDir();
  const user = await readJson(configPath(), {});
  if (typeof user.localApiToken !== 'string' || user.localApiToken.length < 32) {
    user.localApiToken = randomBytes(32).toString('base64url');
    await atomicWriteJson(configPath(), user, 0o600);
  }
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...user,
    scopes: Array.isArray(user.scopes) ? user.scopes : [...DEFAULT_CONFIG.scopes],
    aliases: user.aliases && typeof user.aliases === 'object' ? user.aliases : {}
  };
}

export async function saveConfig(config) {
  await atomicWriteJson(configPath(), config, 0o600);
}

export async function saveState(state) {
  await atomicWriteJson(statePath(), state, 0o600);
}

export async function atomicWriteJson(path, value, mode = 0o600) {
  await ensureStateDir();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
  await chmod(path, mode).catch(() => {});
}

export async function atomicWriteText(path, value, mode = 0o600) {
  await ensureStateDir();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, value, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
  await chmod(path, mode).catch(() => {});
}

export async function appendAudit(event) {
  await ensureStateDir();
  const path = auditPath();
  const entry = { at: new Date().toISOString(), ...event };
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

let budgetQueue = Promise.resolve();

export function consumeDailyRequestBudget(config) {
  const run = budgetQueue.then(async () => {
    const limit = Math.max(1, Number(config.maxRequestsPerDay || 6));
    const current = await readJson(usagePath(), { day: utcDay(), used: 0 });
    if (current.day !== utcDay()) {
      current.day = utcDay();
      current.used = 0;
    }
    if (current.used >= limit) {
      throw Object.assign(new Error(`Daily Hyperagent request cap reached (${current.used}/${limit}). Raise maxRequestsPerDay explicitly only after reviewing credit usage.`), { status: 429 });
    }
    current.used += 1;
    await atomicWriteJson(usagePath(), current, 0o600);
    return { day: current.day, used: current.used, limit, remaining: limit - current.used };
  });
  budgetQueue = run.catch(() => {});
  return run;
}

export async function getDailyBudgetStatus(config) {
  const limit = Math.max(1, Number(config.maxRequestsPerDay || 6));
  const current = await readJson(usagePath(), { day: utcDay(), used: 0 });
  const used = current.day === utcDay() ? Number(current.used || 0) : 0;
  return { day: utcDay(), used, limit, remaining: Math.max(0, limit - used) };
}
