import { randomUUID } from 'node:crypto';

export const OPENROUTER_SYSTEM_PROMPT = `
You are the reasoning backend for a local Codex coding session. Codex owns files, shell, patches, tests, and approvals.
Return exactly one JSON object with no Markdown fence and no extra prose.
Shapes:
{"type":"final","text":"..."}
{"type":"function_call","name":"exact tool name","arguments":{...}}
{"type":"custom_tool_call","name":"exact tool name","input":"raw input"}
Never invent a tool name. Call only one client tool per response. Prefer tools over claiming you already inspected local files.
`;

export function openRouterSystemPromptChars() {
  return OPENROUTER_SYSTEM_PROMPT.length;
}

export function openRouterApiKey(config) {
  const fromConfig = typeof config?.openrouterApiKey === 'string' ? config.openrouterApiKey.trim() : '';
  if (fromConfig) return fromConfig;
  const fromEnv = typeof process.env.OPENROUTER_API_KEY === 'string' ? process.env.OPENROUTER_API_KEY.trim() : '';
  return fromEnv || null;
}

export class OpenRouterClient {
  constructor(config, { fetchImpl } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl || ((url, options) => fetch(url, options));
    this.pending = new Map();
  }

  async listAgents() {
    const model = String(this.config.openrouterModel || '').trim();
    return [{
      id: 'openrouter-default',
      name: 'OpenRouter',
      description: `OpenRouter upstream relay (${model || 'unconfigured model'})`,
      model: model || null
    }];
  }

  async createThread(agentId, message) {
    const threadId = `or_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    this.pending.set(threadId, { agentId, message });
    return threadId;
  }

  async waitForThread(threadId, { signal } = {}) {
    const entry = this.pending.get(threadId);
    if (!entry) {
      throw Object.assign(new Error(`Unknown OpenRouter thread: ${threadId}`), {
        status: 404, code: 'upstream_error', dispatchState: 'not_dispatched'
      });
    }
    const apiKey = openRouterApiKey(this.config);
    if (!apiKey) {
      throw Object.assign(
        new Error('OpenRouter upstream selected but no API key is available. Set OPENROUTER_API_KEY or openrouterApiKey in config.'),
        { status: 503, code: 'upstream_not_configured', dispatchState: 'not_dispatched' }
      );
    }
    const base = String(this.config.openrouterBaseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const timeoutMs = Math.max(1, Number(this.config.runTimeoutMs || 300000));
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason || Object.assign(new Error('Request aborted.'), { code: 'client_disconnected' }));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(Object.assign(new Error(`OpenRouter request exceeded the ${Math.round(timeoutMs / 60000)} minute timeout.`), { code: 'upstream_timeout' }));
      }
    }, timeoutMs);
    timer.unref?.();
    if (controller.signal.aborted) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      throw controller.signal.reason || Object.assign(new Error('Request aborted.'), { code: 'client_disconnected' });
    }
    try {
      const response = await this.fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://github.com/Shifat7/hyperagent-codex-bridge',
          'x-title': 'Hyperagent Codex Bridge'
        },
        body: JSON.stringify({
          model: this.config.openrouterModel,
          messages: [
            { role: 'system', content: OPENROUTER_SYSTEM_PROMPT },
            { role: 'user', content: entry.message }
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          stream: false
        }),
        signal: controller.signal
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const detail = typeof data?.error === 'string' ? data.error : JSON.stringify(data).slice(0, 400);
        throw Object.assign(new Error(`OpenRouter chat completions failed with status ${response.status}: ${detail}`), {
          status: response.status >= 500 ? 502 : response.status,
          code: 'upstream_error'
        });
      }
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error(`OpenRouter reply contained no assistant content: ${JSON.stringify(data).slice(0, 800)}`), {
          status: 502, code: 'upstream_error'
        });
      }
      this.pending.delete(threadId);
      return { text, thread: data, status: 'completed' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async close() {
    this.pending.clear();
  }
}
