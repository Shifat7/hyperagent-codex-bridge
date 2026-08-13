import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { appendAudit, consumeDailyRequestBudget, VERSION } from './config.mjs';
import { HyperagentClient } from './hyperagent.mjs';
import {
  buildAgentModels,
  buildRelayPrompt,
  extractClientTools,
  modelInfo,
  nonStreamingResponse,
  parseRelayOutput,
  resolveAgent,
  responseIds,
  sseEvents
} from './protocol.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

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

function errorCode(error) {
  if (typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code)) return error.code;
  if (error?.name === 'AbortError' || error?.message === 'Request aborted.') return 'request_aborted';
  if (/timeout/i.test(String(error?.message || ''))) return 'hyperagent_timeout';
  return 'hyperagent_bridge_error';
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
  constructor(config, { clientFactory, auditWriter, budgetGuard } = {}) {
    this.config = config;
    this.server = null;
    this.agentCache = { at: 0, agents: [] };
    this.clientFactory = clientFactory || (() => new HyperagentClient(this.config));
    this.auditWriter = auditWriter || appendAudit;
    this.budgetGuard = budgetGuard || consumeDailyRequestBudget;
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

  async handleResponses(request, response) {
    const requestId = `hacb_${randomUUID().replace(/-/g, '')}`;
    const startedAt = Date.now();
    const body = await readJson(request);
    if (!body.model) throw Object.assign(new Error('The model field is required.'), { status: 400 });
    const agents = await this.getAgents();
    let agent;
    try {
      agent = resolveAgent(body.model, agents, this.config);
    } catch (error) {
      error.status = 400;
      throw error;
    }
    const budget = await this.budgetGuard(this.config);
    const tools = extractClientTools(body, this.config);
    const prompt = buildRelayPrompt(body, agent, this.config, tools);
    if (prompt.length > Math.max(10000, Number(this.config.maxPromptChars || 70000))) {
      throw Object.assign(new Error(`Sanitized relay prompt is still too large (${prompt.length} chars). Start a new Codex chat or reduce attached context.`), { status: 413 });
    }
    const ids = responseIds();
    const client = this.clientFactory();
    const abort = new AbortController();
    request.on('aborted', () => abort.abort());
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });

    let threadId;
    let keepalive;
    const streaming = body.stream !== false;
    await this.auditWriter({
      event: 'request',
      requestId,
      version: VERSION,
      transport: 'oauth_mcp_threads',
      model: body.model,
      agentId: agent.id,
      agentName: agent.name,
      streaming,
      requestChars: JSON.stringify(body).length,
      promptChars: prompt.length,
      toolCount: tools.length,
      dailyUsed: budget.used,
      dailyLimit: budget.limit,
      costMeasurement: 'unavailable_from_supported_mcp'
    });
    try {
      const createStartedAt = Date.now();
      threadId = await client.createThread(agent.id, prompt);
      await this.auditWriter({ event: 'thread_created', requestId, model: body.model, agentId: agent.id, threadId, createThreadMs: Date.now() - createStartedAt });
      if (streaming) {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-hyperagent-thread-id': threadId,
          'x-hacb-request-id': requestId,
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
            metadata: { hyperagent_thread_id: threadId }
          }
        });
        keepalive = setInterval(() => response.write(': hyperagent-running\n\n'), 12_000);
        keepalive.unref?.();
      }

      const waitStartedAt = Date.now();
      const result = await client.waitForThread(threadId, { signal: abort.signal });
      const waitForThreadMs = Date.now() - waitStartedAt;
      const parseStartedAt = Date.now();
      const output = parseRelayOutput(result.text, tools, { strict: this.config.strictRelayProtocol !== false });
      await this.auditWriter({
        event: 'completed',
        requestId,
        model: body.model,
        agentId: agent.id,
        threadId,
        outputType: output.type,
        waitForThreadMs,
        parseMs: Date.now() - parseStartedAt,
        totalMs: Date.now() - startedAt
      });
      if (streaming) {
        for (const event of sseEvents(output, ids, { model: body.model, threadId }).slice(1)) writeSse(response, event);
        response.end();
      } else {
        json(response, 200, nonStreamingResponse(output, ids, { model: body.model, threadId }), {
          'x-hyperagent-thread-id': threadId,
          'x-hacb-request-id': requestId
        });
      }
    } catch (error) {
      const code = errorCode(error);
      await this.auditWriter({
        event: 'failed',
        requestId,
        model: body.model,
        agentId: agent.id,
        threadId: threadId || null,
        errorCode: code,
        totalMs: Date.now() - startedAt
      });
      if (streaming && response.headersSent) {
        writeSse(response, {
          type: 'response.failed',
          response: {
            id: ids.responseId,
            status: 'failed',
            model: body.model,
            output: [],
            error: { message: error.message, type: 'server_error', code },
            metadata: { hyperagent_thread_id: threadId || null }
          }
        });
        response.end();
      } else {
        error.code = code;
        throw error;
      }
    } finally {
      if (keepalive) clearInterval(keepalive);
      await client.close();
    }
  }

  async route(request, response) {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
      json(response, 200, { ok: true, service: 'hyperagent-codex-bridge', version: VERSION });
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
      await this.handleResponses(request, response);
      return;
    }
    apiError(response, 404, `Unknown route ${request.method} ${url.pathname}`, 'not_found');
  }

  async start() {
    if (this.server) return this;
    this.server = createServer((request, response) => {
      this.route(request, response).catch(error => {
        if (response.headersSent) {
          response.end();
          return;
        }
        apiError(response, error.status || 500, error.message || String(error), errorCode(error));
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
