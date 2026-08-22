import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const APP_NAME = 'hyperagent-codex-bridge';
export const VERSION = '0.4.2';
export const CONFIG_SCHEMA_VERSION = 2;
export const SAFE_MAX_REQUESTS_PER_DAY = 6;
export const DEFAULT_MCP_URL = 'https://hyperagent.com/api/mcp';
export const DEFAULT_ISSUER = 'https://hyperagent.com';
export const DEFAULT_BRIDGE_PORT = 47831;
export const DEFAULT_CALLBACK_PORT = 47832;

export function bridgeUrl(config, path = '') {
  const host = String(config.bridgeHost || '127.0.0.1');
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authority}:${config.bridgePort}${path}`;
}

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

export function gatewayLogPath() {
  return join(stateDir(), 'gateway.jsonl');
}

function usageLockPath() {
  return join(stateDir(), 'usage.lock');
}

export function idempotencyPath() {
  return join(stateDir(), 'idempotency.json');
}

function idempotencyLockPath() {
  return join(stateDir(), 'idempotency.lock');
}

export const DEFAULT_CONFIG = Object.freeze({
  configVersion: CONFIG_SCHEMA_VERSION,
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
  mcpRequestTimeoutMs: 30 * 1000,
  createThreadTimeoutMs: 45 * 1000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  idempotencyMaxEntries: 256,
  idempotencyInProgressStaleMs: 30 * 1000,
  aliases: {},
  defaultAgentId: null,
  exposeAllAgents: true,
  codexProviderId: 'hyperagent_credits',
  localApiToken: null,
  defaultReasoningEffort: 'low',
  allowClientReasoningEffort: false,
  maxRequestsPerDay: SAFE_MAX_REQUESTS_PER_DAY,
  maxInputChars: 24000,
  maxTurnChars: 6000,
  maxConversationTurns: 8,
  maxForwardedTools: 32,
  maxPromptChars: 70000,
  blockMultiAgentTools: true,
  enableMultiToolCalls: false,
  maxToolCallsPerResponse: 3
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
  const source = await readJson(configPath(), {});
  const user = source && typeof source === 'object' && !Array.isArray(source) ? { ...source } : {};
  let changed = false;
  const version = Number.isSafeInteger(user.configVersion) ? user.configVersion : 0;
  if (version < CONFIG_SCHEMA_VERSION) {
    const legacyLimit = user.maxRequestsPerDay;
    if (!Number.isSafeInteger(legacyLimit) || legacyLimit < 1 || legacyLimit > SAFE_MAX_REQUESTS_PER_DAY) {
      user.maxRequestsPerDay = SAFE_MAX_REQUESTS_PER_DAY;
    }
    user.configVersion = CONFIG_SCHEMA_VERSION;
    changed = true;
  }
  if (typeof user.localApiToken !== 'string' || user.localApiToken.length < 32) {
    user.localApiToken = randomBytes(32).toString('base64url');
    changed = true;
  }
  if (changed) await atomicWriteJson(configPath(), user, 0o600);
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
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await chmod(tmp, mode).catch(() => {});
    await rename(tmp, path);
    await chmod(path, mode).catch(() => {});
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function atomicWriteText(path, value, mode = 0o600) {
  await ensureStateDir();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, value, { mode });
    await chmod(tmp, mode).catch(() => {});
    await rename(tmp, path);
    await chmod(path, mode).catch(() => {});
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function appendAudit(event) {
  await ensureStateDir();
  const path = auditPath();
  const entry = { at: new Date().toISOString(), ...event };
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function appendGatewayLog(event) {
  await ensureStateDir();
  const path = gatewayLogPath();
  const entry = { at: new Date().toISOString(), ...event };
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

let budgetQueue = Promise.resolve();
let idempotencyQueue = Promise.resolve();

function dailyLimit(config) {
  const value = config?.maxRequestsPerDay;
  if (!Number.isSafeInteger(value) || value < 1) return SAFE_MAX_REQUESTS_PER_DAY;
  return Math.min(value, 100);
}

async function withFileLock(path, label, callback) {
  await ensureStateDir();
  const deadline = Date.now() + 5000;
  const owner = `${process.pid} ${randomUUID()}\n`;
  let handle;
  while (!handle) {
    try {
      const candidate = await open(path, 'wx', 0o600);
      try {
        await candidate.writeFile(owner);
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
    } catch (error) {
      // Node 20 on Windows can surface a sharing violation as EPERM while
      // another process owns the exclusive-create lock file. Treat it as
      // contention and let the normal bounded, fail-closed loop decide.
      if (error?.code !== 'EEXIST' && !(process.platform === 'win32' && error?.code === 'EPERM')) {
        throw error;
      }
      const observed = await Promise.all([
        stat(path),
        readFile(path, 'utf8')
      ]).then(([info, contents]) => ({
        age: Date.now() - info.mtimeMs,
        contents,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
        size: info.size
      })).catch(() => null);
      const ownerPid = Number.parseInt(observed?.contents.trim().split(/\s+/, 1)[0] || '', 10);
      const validOwnerPid = Number.isSafeInteger(ownerPid) && ownerPid > 0;
      if (
        observed &&
        observed.age > 30_000 &&
        (!validOwnerPid || !processIsAlive(ownerPid))
      ) {
        const current = await Promise.all([
          stat(path),
          readFile(path, 'utf8')
        ]).then(([info, contents]) => ({
          contents,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
          size: info.size
        })).catch(() => null);
        if (
          current &&
          current.contents === observed.contents &&
          current.ino === observed.ino &&
          current.mtimeMs === observed.mtimeMs &&
          current.size === observed.size
        ) {
          await unlink(path).catch(() => {});
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Could not acquire the ${label} lock.`), { status: 503, code: `${label}_lock_unavailable` });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === owner) await unlink(path).catch(() => {});
  }
}


async function withUsageLock(callback) {
  return withFileLock(usageLockPath(), 'budget', callback);
}

async function withIdempotencyLock(callback) {
  return withFileLock(idempotencyLockPath(), 'idempotency', callback);
}

export async function consumeDailyRequestBudget(config) {
  const reservation = await reserveDailyRequestBudget(config);
  return commitDailyRequestBudget(reservation.id, config);
}

function normalizeUsage(current) {
  const day = utcDay();
  if (!current || current.day !== day) {
    return { version: 2, day, committed: 0, reservations: {} };
  }
  const reservations = current.reservations && typeof current.reservations === 'object'
    ? current.reservations
    : {};
  return {
    version: 2,
    day,
    committed: Math.max(0, Number(current.committed ?? current.used ?? 0) || 0),
    reservations
  };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function reservationAge(item) {
  const value = Date.parse(item?.updatedAt || item?.createdAt || '');
  return Number.isFinite(value) ? Date.now() - value : Number.POSITIVE_INFINITY;
}

function reconcileUsage(current, { staleMs = 30_000 } = {}) {
  let changed = false;
  for (const reservation of Object.values(current.reservations)) {
    if (!reservation || !['reserved', 'dispatching'].includes(reservation.state)) continue;
    const hasOwner = Number.isSafeInteger(reservation.ownerPid) && reservation.ownerPid > 0;
    if (processIsAlive(reservation.ownerPid) || (!hasOwner && reservationAge(reservation) < staleMs)) continue;
    if (reservation.state === 'dispatching') {
      reservation.state = 'committed';
      reservation.committedAt = new Date().toISOString();
      reservation.reconcileReason = 'indeterminate_dispatch_after_restart';
      current.committed += 1;
    } else {
      reservation.state = 'released';
      reservation.releasedAt = new Date().toISOString();
      reservation.reason = 'stale_pre_dispatch_after_restart';
    }
    changed = true;
  }
  return changed;
}

function usageSummary(current, limit) {
  const reserved = Object.values(current.reservations).filter(item => ['reserved', 'dispatching'].includes(item?.state)).length;
  const used = current.committed + reserved;
  return {
    day: current.day,
    used,
    committed: current.committed,
    reserved,
    limit,
    remaining: Math.max(0, limit - used)
  };
}

export function reserveDailyRequestBudget(config, { requestId = null } = {}) {
  const run = budgetQueue.then(() => withUsageLock(async () => {
    const limit = dailyLimit(config);
    const current = normalizeUsage(await readJson(usagePath(), { version: 2, day: utcDay(), committed: 0, reservations: {} }));
    const summary = usageSummary(current, limit);
    if (summary.used >= limit) {
      throw Object.assign(new Error(`Daily Hyperagent request cap reached (${summary.used}/${limit}). Raise maxRequestsPerDay explicitly only after reviewing credit usage.`), { status: 429, code: 'budget_exhausted' });
    }
    const id = `budget_${randomUUID().replaceAll('-', '')}`;
    current.reservations[id] = {
      state: 'reserved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ownerPid: process.pid,
      ...(requestId ? { requestId } : {})
    };
    await atomicWriteJson(usagePath(), current, 0o600);
    return { id, ...usageSummary(current, limit) };
  }));
  budgetQueue = run.catch(() => {});
  return run;
}

export function markDailyRequestBudgetDispatching(reservationId, config) {
  const run = budgetQueue.then(() => withUsageLock(async () => {
    const limit = dailyLimit(config);
    const current = normalizeUsage(await readJson(usagePath(), { version: 2, day: utcDay(), committed: 0, reservations: {} }));
    const reservation = current.reservations[reservationId];
    if (!reservation || reservation.state !== 'reserved') {
      throw Object.assign(new Error('Budget reservation is unavailable.'), { status: 503, code: 'budget_reservation_invalid' });
    }
    reservation.state = 'dispatching';
    reservation.updatedAt = new Date().toISOString();
    await atomicWriteJson(usagePath(), current, 0o600);
    return { id: reservationId, ...usageSummary(current, limit) };
  }));
  budgetQueue = run.catch(() => {});
  return run;
}

export function commitDailyRequestBudget(reservationId, config) {
  const run = budgetQueue.then(() => withUsageLock(async () => {
    const limit = dailyLimit(config);
    const current = normalizeUsage(await readJson(usagePath(), { version: 2, day: utcDay(), committed: 0, reservations: {} }));
    const reservation = current.reservations[reservationId];
    if (!reservation || !['reserved', 'dispatching'].includes(reservation.state)) {
      throw Object.assign(new Error('Budget reservation is unavailable.'), { status: 503, code: 'budget_reservation_invalid' });
    }
    reservation.state = 'committed';
    reservation.committedAt = new Date().toISOString();
    current.committed += 1;
    await atomicWriteJson(usagePath(), current, 0o600);
    return { id: reservationId, ...usageSummary(current, limit) };
  }));
  budgetQueue = run.catch(() => {});
  return run;
}

export function releaseDailyRequestBudget(reservationId, config, { reason = 'not_dispatched', provenPreDispatch = false } = {}) {
  const run = budgetQueue.then(() => withUsageLock(async () => {
    const limit = dailyLimit(config);
    const current = normalizeUsage(await readJson(usagePath(), { version: 2, day: utcDay(), committed: 0, reservations: {} }));
    const reservation = current.reservations[reservationId];
    if (reservation?.state === 'reserved' || (reservation?.state === 'dispatching' && provenPreDispatch)) {
      reservation.state = 'released';
      reservation.releasedAt = new Date().toISOString();
      reservation.reason = String(reason).slice(0, 80);
      await atomicWriteJson(usagePath(), current, 0o600);
    }
    return { id: reservationId, ...usageSummary(current, limit) };
  }));
  budgetQueue = run.catch(() => {});
  return run;
}

export async function getDailyBudgetStatus(config) {
  const limit = dailyLimit(config);
  const current = normalizeUsage(await readJson(usagePath(), { version: 2, day: utcDay(), committed: 0, reservations: {} }));
  return usageSummary(current, limit);
}

export function reconcileDailyRequestBudget(config, options = {}) {
  const run = budgetQueue.then(() => withUsageLock(async () => {
    const limit = dailyLimit(config);
    const current = normalizeUsage(await readJson(usagePath(), { version: 2, day: utcDay(), committed: 0, reservations: {} }));
    if (reconcileUsage(current, options)) await atomicWriteJson(usagePath(), current, 0o600);
    return usageSummary(current, limit);
  }));
  budgetQueue = run.catch(() => {});
  return run;
}

function normalizeIdempotency(value) {
  return {
    version: 1,
    records: value?.records && typeof value.records === 'object' && !Array.isArray(value.records)
      ? value.records
      : {}
  };
}

function idempotencyOptions(config) {
  return {
    ttlMs: Math.max(60_000, Number(config?.idempotencyTtlMs) || DEFAULT_CONFIG.idempotencyTtlMs),
    maxEntries: Math.max(1, Math.min(10_000, Number(config?.idempotencyMaxEntries) || DEFAULT_CONFIG.idempotencyMaxEntries))
  };
}

function pruneIdempotency(state, config) {
  const { ttlMs } = idempotencyOptions(config);
  const inProgressStaleMs = Math.max(1000, Number(config?.idempotencyInProgressStaleMs) || DEFAULT_CONFIG.idempotencyInProgressStaleMs);
  const now = Date.now();
  for (const [key, record] of Object.entries(state.records)) {
    const age = now - Date.parse(record?.updatedAt || record?.createdAt || '');
    if (!Number.isFinite(age) || age > ttlMs || (record?.state === 'in_progress' && age > inProgressStaleMs && !processIsAlive(record.ownerPid))) {
      delete state.records[key];
    }
  }
}

export function claimIdempotency(keyHash, fingerprint, requestId, config) {
  const run = idempotencyQueue.then(() => withIdempotencyLock(async () => {
    const state = normalizeIdempotency(await readJson(idempotencyPath(), { version: 1, records: {} }));
    pruneIdempotency(state, config);
    const existing = state.records[keyHash];
    if (existing) {
      await atomicWriteJson(idempotencyPath(), state, 0o600);
      return { claimed: false, record: structuredClone(existing) };
    }
    const { maxEntries } = idempotencyOptions(config);
    const entries = Object.entries(state.records).sort((a, b) =>
      Date.parse(a[1]?.updatedAt || '') - Date.parse(b[1]?.updatedAt || '')
    );
    while (entries.length >= maxEntries) {
      const [key] = entries.shift();
      delete state.records[key];
    }
    const record = {
      fingerprint,
      state: 'in_progress',
      requestId,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    state.records[keyHash] = record;
    await atomicWriteJson(idempotencyPath(), state, 0o600);
    return { claimed: true, record: structuredClone(record) };
  }));
  idempotencyQueue = run.catch(() => {});
  return run;
}

export function updateIdempotency(keyHash, requestId, patch, config) {
  const run = idempotencyQueue.then(() => withIdempotencyLock(async () => {
    const state = normalizeIdempotency(await readJson(idempotencyPath(), { version: 1, records: {} }));
    const record = state.records[keyHash];
    if (!record || record.requestId !== requestId) {
      throw Object.assign(new Error('Idempotency record is unavailable.'), { status: 503, code: 'idempotency_state_invalid' });
    }
    state.records[keyHash] = {
      ...record,
      ...structuredClone(patch),
      updatedAt: new Date().toISOString()
    };
    pruneIdempotency(state, config);
    await atomicWriteJson(idempotencyPath(), state, 0o600);
    return structuredClone(state.records[keyHash]);
  }));
  idempotencyQueue = run.catch(() => {});
  return run;
}

export function deleteIdempotency(keyHash, requestId) {
  const run = idempotencyQueue.then(() => withIdempotencyLock(async () => {
    const state = normalizeIdempotency(await readJson(idempotencyPath(), { version: 1, records: {} }));
    if (state.records[keyHash]?.requestId === requestId) {
      delete state.records[keyHash];
      await atomicWriteJson(idempotencyPath(), state, 0o600);
    }
  }));
  idempotencyQueue = run.catch(() => {});
  return run;
}

export function reconcileIdempotency(config) {
  const run = idempotencyQueue.then(() => withIdempotencyLock(async () => {
    const state = normalizeIdempotency(await readJson(idempotencyPath(), { version: 1, records: {} }));
    pruneIdempotency(state, config);
    await atomicWriteJson(idempotencyPath(), state, 0o600);
    return Object.keys(state.records).length;
  }));
  idempotencyQueue = run.catch(() => {});
  return run;
}
