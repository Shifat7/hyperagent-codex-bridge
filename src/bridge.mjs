import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendAudit,
  appendGatewayLog,
  appendPromptExcerpt,
  claimIdempotency,
  commitDailyRequestBudget,
  commitTaskToolLoop,
  deleteIdempotency,
  getDailyBudgetStatus,
  markDailyRequestBudgetDispatching,
  reconcileDailyRequestBudget,
  reconcileIdempotency,
  releaseDailyRequestBudget,
  reserveDailyRequestBudget,
  reserveTaskRequest,
  updateIdempotency,
  VERSION
} from './config.mjs';
import { HyperagentClient } from './hyperagent.mjs';
import { loadCheckpoint } from './checkpoint.mjs';
import {
  buildAgentModels,
  buildRelayPromptWithMetrics,
  extractClientTools,
  modelInfo,
  nonStreamingResponse,
  parseRelayOutput,
  pickAgentRoute,
  resolveAgent,
  responseIds,
  sseEvents
} from './protocol.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PUBLIC_ERRORS = Object.freeze({
  ambiguous_agent_slug: 'The reachable agent catalog cannot be selected safely.',
  ambiguous_model_alias: 'The configured model aliases cannot be selected safely.',
  budget_exhausted: 'The local daily request budget is exhausted.',
  task_budget_exhausted: 'This local Hyperagent task budget is exhausted. Start a new task or raise maxRequestsPerTask.',
  budget_lock_unavailable: 'The local daily request budget is temporarily unavailable.',
  budget_reservation_invalid: 'The local daily request reservation is unavailable.',
  client_disconnected: 'The client disconnected and local polling stopped.',
  duplicate_agent_identifier: 'The reachable agent catalog cannot be selected safely.',
  duplicate_agent_name: 'The reachable agent catalog contains duplicate names.',
  idempotency_conflict: 'The Idempotency-Key was already used with a different request body.',
  idempotency_in_progress: 'The idempotent request is still in progress.',
  idempotency_indeterminate: 'The idempotent request has an indeterminate upstream outcome.',
  idempotency_lock_unavailable: 'Local idempotency state is temporarily unavailable.',
  idempotency_state_invalid: 'Local idempotency state is unavailable.',
  invalid_agent_catalog: 'The reachable agent catalog cannot be selected safely.',
  invalid_idempotency_key: 'Idempotency-Key must contain 1 through 255 visible ASCII characters.',
  invalid_model_alias: 'A configured model alias is invalid or unavailable.',
  invalid_request: 'The request is invalid.',
  model_required: 'The model field is required.',
  prompt_too_large: 'The sanitized relay prompt is too large.',
  request_too_large: 'The request body is too large.',
  upstream_timeout: 'The upstream request timed out before a safe result was available.',
  unknown_model: 'Unknown model identifier. Choose an exact identifier returned by the models endpoint.',
  unauthorized: 'Missing or invalid local bridge bearer token.'
});

function json(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(body);
}

function apiError(response, status, message, code = 'bridge_error', headers = {}) {
  json(response, status, {
    error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code }
  }, headers);
}

function requestId() {
  return `req_${randomUUID().replaceAll('-', '')}`;
}

function errorCode(error) {
  if (typeof error?.code === 'string' && PUBLIC_ERRORS[error.code]) return error.code;
  if (error?.name === 'AbortError') return 'client_disconnected';
  if (error?.status === 429) return 'budget_exhausted';
  if (error?.status === 413) return 'request_too_large';
  if (error?.status === 400) return 'invalid_request';
  return 'hyperagent_bridge_error';
}

function abortError() {
  return Object.assign(new Error('Client disconnected; local Hyperagent polling was cancelled.'), {
    status: 499,
    code: 'client_disconnected'
  });
}

function publicErrorMessage(error) {
  const code = errorCode(error);
  if (PUBLIC_ERRORS[code]) return PUBLIC_ERRORS[code];
  return 'Hyperagent gateway request failed. Use X-Request-Id to inspect the local structured logs.';
}

function privateRef(value, prefix) {
  if (!value) return null;
  return `${prefix}_${createHash('sha256').update(String(value)).digest('base64url').slice(0, 16)}`;
}

function loopbackHost(host) {
  return host === '127.0.0.1' || host === '::1';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('base64url');
}

function idempotencyKey(request) {
  const value = request.headers['idempotency-key'];
  if (value == null) return null;
  if (Array.isArray(value) || !/^[\x21-\x7e]{1,255}$/.test(value)) {
    throw Object.assign(new Error('Invalid Idempotency-Key.'), { status: 400, code: 'invalid_idempotency_key' });
  }
  return createHash('sha256').update(value).digest('base64url');
}

function authorized(request, config) {
  const header = String(request.headers.authorization || '');
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = String(config.localApiToken || '');
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function writeSse(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function modelsFor(agents, config) {
  const base = buildAgentModels(agents);
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const aliases = Object.entries(config.aliases || {})
    .filter(([, agentId]) => byId.has(agentId))
    .map(([slug, agentId], index) => ({
      agent: byId.get(agentId),
      slug,
      displayName: `${byId.get(agentId).name} · ${slug}`,
      priority: index + 1
    }));
  const visible = config.exposeAllAgents ? [...aliases, ...base] : aliases;
  const seen = new Set();
  return visible.filter(item => !seen.has(item.slug) && seen.add(item.slug));
}

function etagFor(value) {
  return `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 24)}"`;
}

export class BridgeServer {
  constructor(config, { clientFactory, auditWriter, logWriter, excerptWriter, checkpointLoader, budgetGuard, budgetManager, idempotencyManager } = {}) {
    this.config = config;
    this.server = null;
    this.agentCache = { at: 0, agents: [] };
    this.clientFactory = clientFactory || (() => new HyperagentClient(this.config));
    this.auditWriter = auditWriter || appendAudit;
    this.logWriter = logWriter || appendGatewayLog;
    this.excerptWriter = config.debugPromptExcerpts
      ? (excerptWriter || appendPromptExcerpt)
      : null;
    this.checkpointLoader = config.enableCheckpointMemory === false
      ? null
      : (checkpointLoader || loadCheckpoint);
    this.budgetManager = budgetManager || (budgetGuard
      ? {
          reserve: async configValue => ({ id: null, ...await budgetGuard(configValue) }),
          dispatch: async reservation => reservation,
          commit: async reservation => reservation,
          release: async reservation => reservation,
          status: getDailyBudgetStatus,
          reconcile: async configValue => getDailyBudgetStatus(configValue)
        }
      : {
          reserve: reserveDailyRequestBudget,
          dispatch: (reservation, configValue) => markDailyRequestBudgetDispatching(reservation.id, configValue),
          commit: (reservation, configValue) => commitDailyRequestBudget(reservation.id, configValue),
          release: (reservation, configValue, options) => releaseDailyRequestBudget(reservation.id, configValue, options),
          status: getDailyBudgetStatus,
          reconcile: reconcileDailyRequestBudget
        });
    if (!this.budgetManager.dispatch) this.budgetManager.dispatch = async reservation => reservation;
    this.idempotencyManager = idempotencyManager || {
      claim: claimIdempotency,
      update: updateIdempotency,
      delete: deleteIdempotency,
      reconcile: reconcileIdempotency
    };
  }

  async safeAudit(event) {
    await this.auditWriter(event);
  }

  async safeLog(event) {
    await this.logWriter(event).catch(() => {});
  }

  async getAgents({ fresh = false } = {}) {
    if (!fresh && this.agentCache.agents.length && Date.now() - this.agentCache.at < 60_000) {
      return this.agentCache.agents;
    }
    const client = this.clientFactory();
    try {
      const agents = await client.listAgents();
      if (!agents.length) throw new Error('Hyperagent returned no reachable agents. Create or share at least one named agent first.');
      this.agentCache = { at: Date.now(), agents };
      return agents;
    } finally {
      await client.close();
    }
  }

  async handleModels(request, response) {
    const agents = await this.getAgents();
    const models = modelsFor(agents, this.config).map(modelInfo);
    const tag = etagFor(models);
    if (request.headers['if-none-match'] === tag) {
      response.writeHead(304, { etag: tag, 'cache-control': 'private, max-age=60' });
      response.end();
      return;
    }
    json(response, 200, {
      models,
      object: 'list',
      data: models.map(model => ({ id: model.slug, object: 'model', owned_by: 'hyperagent' }))
    }, { etag: tag, 'cache-control': 'private, max-age=60' });
  }

  renderCompleted(response, result, { replayed = false, createdSent = false } = {}) {
    const headers = {
      'x-hyperagent-thread-id': result.threadId,
      'x-usage-source': 'unavailable',
      ...(replayed ? { 'x-idempotency-replayed': 'true' } : {})
    };
    if (result.streaming) {
      if (!response.headersSent) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
          ...headers
        });
      }
      const events = sseEvents(result.output, result.ids, {
        model: result.model,
        threadId: result.threadId,
        requestId: result.requestId
      });
      for (const event of createdSent ? events.slice(1) : events) writeSse(response, event);
      response.end();
      return;
    }
    json(response, 200, nonStreamingResponse(result.output, result.ids, {
      model: result.model,
      threadId: result.threadId,
      requestId: result.requestId
    }), headers);
  }

  async handleResponses(request, response, serverRequestId) {
    const body = await readJson(request);
    if (!body.model) throw Object.assign(new Error('The model field is required.'), { status: 400, code: 'model_required' });
    const keyHash = idempotencyKey(request);
    const fingerprint = requestFingerprint(body);
    const abort = new AbortController();
    const cancel = () => {
      if (!abort.signal.aborted) abort.abort(abortError());
    };
    const onResponseClose = () => {
      if (!response.writableEnded) cancel();
    };
    request.once('aborted', cancel);
    response.once('close', onResponseClose);
    let idempotencyClaimed = false;
    if (keyHash) {
      const claim = await this.idempotencyManager.claim(keyHash, fingerprint, serverRequestId, this.config);
      const previous = claim.claimed ? null : claim.record;
      idempotencyClaimed = claim.claimed;
      if (abort.signal.aborted || request.aborted || request.socket?.destroyed || response.destroyed) {
        if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId).catch(() => {});
        throw abort.signal.reason || abortError();
      }
      if (!previous) {
        // The durable claim belongs to this request.
      } else if (previous.fingerprint !== fingerprint) {
        throw Object.assign(new Error('Idempotency conflict.'), { status: 409, code: 'idempotency_conflict' });
      } else if (previous.state === 'completed') {
        await this.safeLog({ event: 'idempotency_replayed', requestId: serverRequestId, originalRequestId: previous.requestId });
        this.renderCompleted(response, previous.result, { replayed: true });
        return;
      } else {
        throw Object.assign(new Error('Idempotent request outcome is unavailable for replay.'), {
          status: 409,
          code: previous.state === 'in_progress' ? 'idempotency_in_progress' : 'idempotency_indeterminate',
          headers: { 'retry-after': '2' }
        });
      }
    }
    let agent;
    let reservation;
    let budget;
    let client;
    let threadId;
    let keepalive;
    let dispatched = false;
    let budgetCommitted = false;
    let agents;
    try {
      agents = await this.getAgents();
    } catch (error) {
      if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId);
      throw error;
    }
    try {
      agent = resolveAgent(body.model, agents, this.config);
    } catch (error) {
      if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId);
      throw error;
    }
    let tools;
    let prompt;
    let routeInfo = null;
    let breakdown;
    let excerpts;
    try {
      tools = extractClientTools(body, this.config);
    } catch (error) {
      if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId);
      throw error;
    }
    if (this.config.enableAgentRouting === true && this.config.agentRoutes && typeof this.config.agentRoutes === 'object') {
      const requestedRoute = pickAgentRoute(body, tools, this.config);
      const routeTarget = this.config.agentRoutes[requestedRoute.route];
      if (routeTarget && routeTarget !== body.model) {
        try {
          const routedAgent = resolveAgent(routeTarget, agents, this.config);
          if (routedAgent.id !== agent.id) {
            agent = routedAgent;
            routeInfo = { ...requestedRoute, routeTarget: String(routeTarget) };
          }
        } catch {
          await this.safeLog({ event: 'agent_route_fallback', requestId: serverRequestId, route: requestedRoute.route, routeTarget: String(routeTarget).slice(0, 80) });
        }
      }
    }
    const auditModel = body.model === agent.id ? privateRef(agent.id, 'agent') : body.model;
    try {
      const checkpoint = this.checkpointLoader ? await this.checkpointLoader(this.config) : null;
      ({ prompt, breakdown, excerpts } = buildRelayPromptWithMetrics(body, agent, this.config, tools, checkpoint?.text || null));
    } catch (error) {
      if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId);
      throw error;
    }
    if (prompt.length > Math.max(10000, Number(this.config.maxPromptChars || 70000))) {
      if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId);
      throw Object.assign(new Error(`Sanitized relay prompt is still too large (${prompt.length} chars). Start a new Codex chat or reduce attached context.`), { status: 413, code: 'prompt_too_large' });
    }
    const costMetrics = {
      estimatedPromptTokens: breakdown.estimatedTokens,
      usageSource: breakdown.usageSource,
      relayInstructionChars: breakdown.sections.relayInstructionChars,
      conversationChars: breakdown.sections.conversationChars,
      toolResultChars: breakdown.sections.toolResultChars,
      toolSchemaChars: breakdown.sections.toolSchemaChars,
      payloadChars: breakdown.sections.payloadChars,
      retainedTurns: breakdown.retainedTurns,
      maxInputChars: breakdown.limits.maxInputChars,
      maxTurnChars: breakdown.limits.maxTurnChars,
      maxConversationTurns: breakdown.limits.maxConversationTurns,
      maxForwardedTools: breakdown.limits.maxForwardedTools
    };
    if (this.excerptWriter && excerpts) {
      await this.excerptWriter({
        requestId: serverRequestId,
        estimatedTokens: breakdown.estimatedTokens,
        totalChars: breakdown.totalChars,
        ...excerpts
      }).catch(() => {});
    }
    const ids = responseIds();
    const streaming = body.stream !== false;
    try {
      if (abort.signal.aborted) throw abort.signal.reason;
      reservation = await this.budgetManager.reserve(this.config, { requestId: serverRequestId });
      let taskReservation = null;
      try {
        taskReservation = await reserveTaskRequest({ promptChars: prompt.length });
      } catch (taskError) {
        if (idempotencyClaimed) await this.idempotencyManager.delete(keyHash, serverRequestId).catch(() => {});
        await this.budgetManager.release(reservation, this.config, { reason: 'task_budget_exhausted', provenPreDispatch: true }).catch(() => {});
        throw Object.assign(taskError, { status: 429, code: 'task_budget_exhausted' });
      }
      await this.safeAudit({
        event: 'request_reserved',
        requestId: serverRequestId,
        model: auditModel,
        agentRef: privateRef(agent.id, 'agent'),
        streaming,
        promptChars: prompt.length,
        toolCount: tools.length,
        ...costMetrics,
        ...(routeInfo ? { route: routeInfo.route, routeReason: routeInfo.reason, routeTarget: routeInfo.routeTarget } : {}),
        dailyUsed: reservation.used ?? null,
        dailyLimit: reservation.limit ?? null,
        ...(taskReservation && !taskReservation.skipped
          ? {
              taskName: taskReservation.name,
              taskRequests: `${taskReservation.requestCount}/${taskReservation.requestLimit}`,
              taskPromptChars: `${taskReservation.promptChars}/${taskReservation.promptCharLimit}`
            }
          : {}),
        reservationRef: privateRef(reservation.id, 'reservation')
      });
      if (taskReservation?.warned) {
        await this.safeAudit({
          event: 'task_budget_warning',
          requestId: serverRequestId,
          taskName: taskReservation.name,
          taskPromptChars: `${taskReservation.promptChars}/${taskReservation.promptCharLimit}`
        }).catch(() => {});
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      client = this.clientFactory();
      if (abort.signal.aborted) throw abort.signal.reason;
      if (idempotencyClaimed) {
        await this.idempotencyManager.update(keyHash, serverRequestId, { state: 'indeterminate' }, this.config);
      }
      await this.budgetManager.dispatch(reservation, this.config);
      dispatched = true;
      threadId = await client.createThread(agent.id, prompt, {
        signal: abort.signal,
        timeoutMs: this.config.createThreadTimeoutMs
      });
      budget = await this.budgetManager.commit(reservation, this.config);
      budgetCommitted = true;
      await this.safeAudit({
        event: 'thread_created',
        requestId: serverRequestId,
        model: auditModel,
        agentRef: privateRef(agent.id, 'agent'),
        threadRef: privateRef(threadId, 'thread')
      });
      if (streaming) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-hyperagent-thread-id': threadId,
          'x-usage-source': 'unavailable',
          'x-content-type-options': 'nosniff'
        });
        response.flushHeaders?.();
        writeSse(response, {
          type: 'response.created',
          response: {
            id: ids.responseId,
            status: 'in_progress',
            model: body.model,
            output: [],
            metadata: { hyperagent_thread_id: threadId, request_id: serverRequestId, usage_source: 'unavailable' }
          }
        });
        keepalive = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write(': hyperagent-running\n\n');
        }, 12_000);
        keepalive.unref?.();
      }

      const result = await client.waitForThread(threadId, { signal: abort.signal });
      const output = parseRelayOutput(result.text, tools, this.config);
      const completed = { output, ids, model: body.model, threadId, requestId: serverRequestId, streaming };
      if (output.type === 'function_call') {
        await commitTaskToolLoop(this.config).catch(() => {});
      }
      await this.safeAudit({
        event: 'completed',
        requestId: serverRequestId,
        model: auditModel,
        agentRef: privateRef(agent.id, 'agent'),
        threadRef: privateRef(threadId, 'thread'),
        outputType: output.type,
        promptChars: prompt.length,
        ...costMetrics,
        dailyCommitted: budget.committed,
        dailyLimit: budget.limit,
        usageSource: 'unavailable'
      });
      if (idempotencyClaimed) {
        await this.idempotencyManager.update(keyHash, serverRequestId, {
          state: 'completed',
          result: completed
        }, this.config);
      }
      this.renderCompleted(response, completed, { createdSent: streaming });
    } catch (error) {
      const code = errorCode(error);
      const provenPreDispatch = error?.dispatchState === 'not_dispatched';
      if (provenPreDispatch) dispatched = false;
      if (reservation && (!dispatched || provenPreDispatch)) {
        await this.budgetManager.release(reservation, this.config, { reason: code, provenPreDispatch }).catch(() => {});
      } else if (reservation && dispatched && !budgetCommitted) {
        await this.budgetManager.commit(reservation, this.config).then(() => { budgetCommitted = true; }).catch(() => {});
      }
      if (idempotencyClaimed) {
        if (dispatched) {
          await this.idempotencyManager.update(keyHash, serverRequestId, {
            state: 'indeterminate',
            threadId: threadId || null
          }, this.config).catch(() => {});
        } else {
          await this.idempotencyManager.delete(keyHash, serverRequestId).catch(() => {});
        }
      }
      await this.safeAudit({
        event: code === 'client_disconnected' ? 'cancelled' : 'failed',
        requestId: serverRequestId,
        model: auditModel,
        agentRef: privateRef(agent.id, 'agent'),
        threadRef: privateRef(threadId, 'thread'),
        errorCode: code,
        dispatched,
        cancellationScope: code === 'client_disconnected' ? 'local_polling_only' : undefined
      }).catch(() => {});
      if (streaming && response.headersSent && !response.destroyed && !response.writableEnded) {
        writeSse(response, {
          type: 'response.failed',
          response: {
            id: ids.responseId,
            status: 'failed',
            model: body.model,
            output: [],
            error: { message: 'Hyperagent request failed. Use the request ID to inspect local gateway logs.', type: 'server_error', code },
            metadata: { hyperagent_thread_id: threadId || null, request_id: serverRequestId, usage_source: 'unavailable' }
          }
        });
        response.end();
      } else {
        throw error;
      }
    } finally {
      if (keepalive) clearInterval(keepalive);
      request.removeListener('aborted', cancel);
      response.removeListener('close', onResponseClose);
      if (client) await client.close().catch(() => this.safeLog({ event: 'client_close_failed', requestId: serverRequestId }));
    }
  }

  async handleReady(response) {
    try {
      const [agents, budget] = await Promise.all([
        this.getAgents(),
        this.budgetManager.status(this.config)
      ]);
      if (!agents.length || budget.remaining < 1) throw Object.assign(new Error('Gateway is not ready.'), { code: 'not_ready' });
      json(response, 200, { ready: true, service: 'hyperagent-codex-bridge', version: VERSION });
    } catch {
      json(response, 503, { ready: false, service: 'hyperagent-codex-bridge', version: VERSION });
    }
  }

  async route(request, response, serverRequestId) {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
      json(response, 200, { ok: true, service: 'hyperagent-codex-bridge', version: VERSION });
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/ready' || url.pathname === '/v1/ready')) {
      await this.handleReady(response);
      return;
    }
    if (!authorized(request, this.config)) {
      apiError(response, 401, 'Missing or invalid local bridge bearer token.', 'unauthorized', {
        'www-authenticate': 'Bearer realm="hyperagent-codex-bridge"'
      });
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
      await this.handleModels(request, response);
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/responses' || url.pathname === '/v1/responses')) {
      await this.handleResponses(request, response, serverRequestId);
      return;
    }
    apiError(response, 404, 'The requested local gateway route does not exist.', 'not_found');
  }

  async start() {
    if (this.server) return this;
    if (!loopbackHost(this.config.bridgeHost)) {
      throw new Error(`Refusing to bind the gateway to non-loopback host '${this.config.bridgeHost}'. Use 127.0.0.1 or ::1.`);
    }
    await Promise.all([
      this.budgetManager.reconcile ? this.budgetManager.reconcile(this.config) : this.budgetManager.status(this.config),
      this.idempotencyManager.reconcile(this.config)
    ]);
    this.server = createServer((request, response) => {
      const serverRequestId = requestId();
      const startedAt = Date.now();
      response.setHeader('x-request-id', serverRequestId);
      let logged = false;
      const logFinished = event => {
        if (logged) return;
        logged = true;
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        void this.safeLog({
          event,
          requestId: serverRequestId,
          method: request.method,
          path: url.pathname,
          status: response.statusCode,
          durationMs: Date.now() - startedAt
        });
      };
      response.once('finish', () => logFinished('http_request_completed'));
      response.once('close', () => {
        if (!response.writableEnded) logFinished('http_request_disconnected');
      });
      this.route(request, response, serverRequestId).catch(error => {
        const code = errorCode(error);
        void this.safeLog({ event: 'request_error', requestId: serverRequestId, errorCode: code });
        if (response.headersSent || response.destroyed) {
          if (!response.destroyed) response.end();
          return;
        }
        apiError(response, error.status || 500, publicErrorMessage(error), code, error.headers || {});
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.bridgePort, this.config.bridgeHost, resolve);
    });
    return this;
  }

  async close() {
    if (!this.server) return;
    await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}
