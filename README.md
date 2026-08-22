# Hyperagent Codex Bridge

A local OAuth bridge that exposes your named Hyperagent agents as a Codex custom model provider. Codex keeps its local coding tools while the reasoning runs happen inside Hyperagent. That should consume Hyperagent credits instead of Codex subscription quota; the verification step below confirms the billing path on your account.

## Straight answer

- **Native first-party Hyperagent provider in Codex:** not currently available. Hyperagent does not publicly expose a raw `/v1/responses` inference API.
- **Working supported path:** yes. This bridge uses Hyperagent's documented OAuth MCP API, then translates between Codex Responses and Hyperagent agent threads.
- **Multiple Hyperagent models:** create one named Hyperagent agent per model you want. Each reachable agent appears as a Codex model such as `hyperagent/sol-coder` or `hyperagent/fable-coder`.

No private browser tokens or undocumented Hyperagent endpoints are used.

> [!IMPORTANT]
> Upgrade from v0.4.0 immediately. That release forwarded too much Codex App context and had no local request ceiling, which could consume credits quickly. v0.4.1 strips injected context, defaults to low effort, blocks recursive multi-agent tools, and enforces a persistent daily request cap.

## Architecture

```text
Codex CLI / App
  -> http://127.0.0.1:47831/v1/responses
  -> Hyperagent OAuth MCP (https://hyperagent.com/api/mcp)
  -> named Hyperagent agent
  -> Hyperagent model + credits
```

The bridge maps Codex function/custom-tool calls back to Codex, so shell commands, patches, file reads, and approvals remain local to Codex.

## Public Responses contract

The v0.5.0 adapter's intentionally narrow public contract is executable and source-controlled:

- [`docs/adr/0001-public-responses-contract.md`](docs/adr/0001-public-responses-contract.md) defines auth, agent selection, errors, identifiers, idempotency, cancellation, usage, billing, and ownership boundaries;
- [`spec/openapi.json`](spec/openapi.json) is the OpenAPI 3.1 description for `POST /v1/responses`;
- [`docs/contracts/responses-sse.md`](docs/contracts/responses-sse.md) defines the exact SSE event-order state machine; and
- [`test/conformance/`](test/conformance/) runs the public HTTP surface against fake upstreams without credentials, models, or credits.

This is a Responses compatibility profile, not the complete OpenAI Responses API and not a native Hyperagent inference API. In particular, SSE is framed by this adapter after a Hyperagent thread completes; usage is omitted because it is not reported; idempotency is bounded, durable, and local rather than provider-backed; and disconnecting stops local polling but does not claim to cancel native Hyperagent work.

## Proof of work

The bridge is validated by an automated suite plus real Codex 0.144.6:

- OAuth discovery, PKCE, refresh-token rotation, and MCP session handling;
- Codex Responses SSE compatibility;
- a real Codex CLI custom-provider request;
- a complete Hyperagent reasoning -> Codex local shell -> tool result -> Hyperagent final-answer round trip;
- reversible Codex App Mode from the main config without `--profile`;
- local bearer authentication, rollback, and sanitized routing audit receipts;
- secret scan and archive integrity checks.

The public proof target is `hacb audit`: each successful turn produces model and hashed agent/thread references without storing prompts, answers, credentials, or raw private identifiers.

The v0.5.0 evidence set is source-controlled in [`docs/PROOF_PACKAGE_2026-07-23.md`](docs/PROOF_PACKAGE_2026-07-23.md). Release notes and the publication-ready article are in [`docs/RELEASE_NOTES_0.5.0.md`](docs/RELEASE_NOTES_0.5.0.md) and [`docs/X_ARTICLE_2026-07-23.md`](docs/X_ARTICLE_2026-07-23.md).

## Public release

- Source: <https://github.com/clutchpbcfo/hyperagent-codex-bridge>
- v0.4.1 ZIP: <https://pub.hyperagent.com/api/published/pbf01KY113X74_6VET28JJ1EW8HQ3Y/hyperagent-codex-bridge-0.4.1.zip>
- SHA-256: <https://pub.hyperagent.com/api/published/pbf01KY113X7F_N3C8P93EZF3ZAEG7/hyperagent-codex-bridge-0.4.1.sha256>

## Requirements

- Node.js 20 or newer
- Current Codex CLI or Codex Desktop
- A Hyperagent account with credits
- At least one **named Hyperagent agent** configured with the model you want to use

For reliable Codex tool use, make each model-specific agent a dedicated relay agent. Use the included `RELAY_AGENT_PROMPT.md` as its system prompt, disable the relay agent's Hyperagent tools, and pin its model in Hyperagent. Codex owns the local shell, files, patches, and approvals; the relay agent only selects those client tools by returning JSON. Clone that agent configuration once per model family you want in Codex.

## Install and connect

Platform guides: `MACOS_QUICKSTART.md` and `WINDOWS_QUICKSTART.md`. New users should start with `docs/NEW_USER_ONBOARDING.md`. Public validation details live in `docs/PROOF_OF_WORK.md`; an article-ready narrative is in `docs/HYPERAGENT_ARTICLE_SECTION.md`.

From a clone or extracted release:

```bash
npm install -g .
hacb setup
```

That flow works on macOS, Windows, and Linux. It:

1. installs the `hacb` command and bundled Codex skill;
2. opens Hyperagent's official OAuth consent flow;
3. discovers reachable named relay agents;
4. writes a separate Codex CLI profile and model catalog;
5. starts the authenticated loopback bridge on `127.0.0.1:47831`.

The skill is installed under `${CODEX_HOME:-~/.codex}/skills/hyperagent-codex-bridge` and can be invoked as `$hyperagent-codex-bridge` or browsed with `/skills`.

Start Codex with Hyperagent credits:

```bash
codex --profile hyperagent
```

## Add a stable model alias

List reachable models and agent IDs:

```bash
hacb models
```

Add a short alias:

```bash
hacb alias sol-coder <agent-id>
hacb profile hyperagent/sol-coder
```

You can also pass an exact agent name instead of its ID if the name is unique.

## Verify

```bash
hacb doctor
hacb status
curl http://127.0.0.1:47831/health
curl http://127.0.0.1:47831/ready
codex --profile hyperagent
```

In Codex, send a small test such as: `Reply with exactly: hyperagent route works.` Then compare your Hyperagent credit/usage view before and after the run. The response includes an `X-Hyperagent-Thread-Id` header and response metadata so the run can be traced to its Hyperagent thread.

## Codex App Mode

The Codex desktop app does not currently expose CLI profiles as first-class provider choices. v0.4.1 includes a reversible App Mode that makes the Hyperagent bridge the default in the main Codex config so **new app chats** use Hyperagent credits:

```bash
hacb app-on hyperagent/codex-relay-sol
```

Fully quit and reopen the Codex app, then start a new chat. App Mode creates a protected backup before changing defaults.

Return new chats to normal OpenAI/Codex subscription defaults while preserving the bridge provider for old chat resume:

```bash
hacb app-off
```

Check the current state and recent sanitized routing receipts:

```bash
hacb app-status
hacb audit 12
```

The audit log records timestamps, public model identifiers, hashed agent/thread/reservation references, and completion type, but never prompts, outputs, tokens, or raw private identifiers. It is the proof that a Codex App turn traversed the bridge.

Every HTTP response includes a server-generated `X-Request-Id`. Responses requests also include `X-Usage-Source: unavailable`: Hyperagent's documented MCP thread tools do not currently return authoritative token counts, so the bridge omits the Responses `usage` object instead of fabricating zeros.

`X-Request-Id` identifies one local HTTP attempt and never trusts a client-supplied value. A durable idempotency replay receives a new header request ID, while the replayed response body retains the originating dispatch ID in `metadata.request_id`.

Callers may send an `Idempotency-Key` header. Identical completed requests replay without another Hyperagent thread, including after a bridge restart; changed request bodies conflict, and in-progress or indeterminate outcomes fail closed. Idempotency records are stored in the private machine-state directory, can contain replayable response output, and expire after 24 hours. They are never written to the sanitized audit log or repository.

Do not remove the `hyperagent_credits` provider block while desktop chats created under it still exist; Codex persists the provider id with each chat.

## Direct MCP access, without provider emulation

Codex can also call Hyperagent agents as tools without this bridge. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.hyperagent]
url = "https://hyperagent.com/api/mcp"
auth = "oauth"
```

Then run:

```bash
codex mcp login hyperagent
```

That route is officially supported, but Hyperagent agents appear as MCP tools, not as entries in Codex's model provider.

## Operations

```bash
hacb start
hacb stop
hacb status
hacb models
hacb profile
hacb logout
```

`hacb serve` runs in the foreground and is best for debugging. Background startup errors are written to `~/.hyperagent-codex-bridge/bridge.log`.

Structured request logs are written to `~/.hyperagent-codex-bridge/gateway.jsonl`. They contain request IDs, route/status/timing fields, and sanitized error codes—never authorization headers, prompts, model output, OAuth tokens, or local bearer tokens. `/health` is a process-liveness probe. `/ready` additionally requires a reachable cached/recent agent listing and remaining local request budget.

For Linux service and loopback-only container operation, see `docs/SELF_HOSTING.md`. The gateway refuses non-loopback binds; do not expose it through a public listener or reverse proxy.

## Rollback

```bash
hacb stop
hacb uninstall-profile
hacb logout
```

Then revoke the OAuth connection at:

<https://hyperagent.com/settings/mcp-access>

CLI mode leaves `~/.codex/config.toml` defaults untouched and uses `~/.codex/hyperagent.config.toml`. App Mode intentionally updates the main config after creating `config.toml.hacb-app-backup`; `hacb app-off` restores the original defaults while retaining the bridge provider for chat resume.

## Cost controls

v0.4.1 fails closed by default:

- low reasoning effort;
- six Hyperagent sampling requests per UTC day;
- 24,000 retained conversation characters;
- 6,000 characters per retained turn;
- eight retained turns;
- 32 forwarded client tools;
- 70,000-character final prompt ceiling;
- multi-agent delegation tools blocked;
- client-requested effort escalation ignored unless explicitly enabled.

Check the local ceiling before work:

```bash
hacb budget
hacb audit 12
```

A Codex tool loop consumes at least two Hyperagent requests. Raising `maxRequestsPerDay`, input limits, or reasoning effort is an explicit operator decision, not an automatic behavior.

### Cost observability

Every dispatched request records a local prompt-size estimate in the audit log: total chars, estimated tokens (`ceil(chars / 4)` — an approximation, not authoritative usage), and a section breakdown (relay instructions, conversation, tool results inside the conversation, client tool schemas). Retention limits and forwarded tool counts are recorded alongside.

```bash
hacb cost-report --last 20   # per-request table plus totals/averages
hacb explain-prompt          # where the last relay prompt's characters went
hacb audit --cost 20         # receipts with estimated token columns
```

Reports contain counts and section sizes only — never prompt text. To inspect bounded local excerpts of what was actually sent, set `"debugPromptExcerpts": true` in `~/.hyperagent-codex-bridge/config.json` before dispatching; excerpts are then written to the private state directory with mode `0600`, and `hacb explain-prompt --verbose` shows them for the matching request. Leave this off unless debugging; it stores fragments of your prompts locally.

Budget state is reserved durably before provider dispatch, committed immediately before a `create_thread` attempt, and released only when the request is known not to have been dispatched. A disconnect after dispatch remains committed because the documented Hyperagent MCP surface cannot prove that the remote attempt stopped.

These controls do not replace the Hyperagent agent-level budget. Configure each relay agent with low effort and a hard per-run USD cap before production use.

### Smart tool shortlisting

Every turn is classified locally (`final_answer_only`, `read_or_search`, `edit_code`, `run_command`, `debug_failure`, `unknown`) and only the tool categories that task type needs are forwarded to Hyperagent. Tool schemas are minimised to argument names, types, and required lists; descriptions are capped at 160 characters. Exact tool names are never invented or renamed, conversations that already used tools keep them, and unknown turns keep the full inventory.

```json
{
  "enableSmartToolSelection": true,
  "forwardFullToolSchemas": false,
  "maxToolDescriptionChars": 160
}
```

Set `"enableSmartToolSelection": false` (and optionally `"forwardFullToolSchemas": true`) to restore unconditional forwarding.

Measured locally with a synthetic 32-tool Codex toolbox and the request "Run the test suite.":

```text
Before: 32 tools forwarded, 10,431 tool-schema chars
After:   4 tools forwarded,  1,127 tool-schema chars
```

Risks: a mis-classified first turn can omit a specialised MCP tool for that turn; the relay then returns plain text naming the missing tool instead of executing it, and you can disable the feature or rephrase the request.


### Relay prompt minimisation

The bridge's per-request relay prompt is now short and mechanical; static behaviour lives in your Hyperagent relay agent's system prompt (see [`RELAY_AGENT_PROMPT.md`](RELAY_AGENT_PROMPT.md)). The bridge keeps only what survives imperfect agent setup: the forwarded tool list, the four JSON shapes, and the never-invent-names / one-JSON-object rules.

Measured locally on a trivial one-turn request with one tool:

```text
Before: 1,978 prompt chars
After:  1,370 prompt chars (-31%)
```

The saving applies to every sampling request of every tool loop. Recommended relay-agent setup is unchanged: use `RELAY_AGENT_PROMPT.md` as the system prompt, disable the agent's own Hyperagent tools, pin its model, and keep reasoning effort low.

### Tool result reducer

Tool outputs sent back to Hyperagent are compressed before they enter the conversation: ANSI codes and progress-bar noise are stripped, successful command output keeps its last 20 meaningful lines, failed runs keep the first error block (assertion diffs, file paths with line/column) plus the last 80 lines, and grep-style output is capped at 5 matches per file with an explicit remainder note. Reduced outputs carry a `[tool output reduced by Hyperagent Codex Bridge: N lines -> M]` marker. User prose and assistant turns are never reduced.

```json
{
  "enableToolResultReducer": true,
  "maxSuccessfulCommandLines": 20,
  "maxFailedCommandLines": 80,
  "maxSearchMatchesPerFile": 5
}
```

Measured locally on a synthetic 184-line failing `npm test` log:

```text
Before: 6,339 chars (184 lines)
After:    204 chars (6 lines) — error block and assertion diff retained
```


### Durable checkpoint memory

Instead of re-sending long chat history every turn, the bridge injects a bounded local checkpoint (4,000 chars default) from `.hacb/` in your project directory before recent conversation turns. Missing files are ignored; path traversal in configured names is rejected; `"enableCheckpointMemory": false` disables it entirely. `.hacb/` is gitignored by default.

Let Codex maintain these files through its normal file tools — no Hyperagent calls are spent summarising:

```md
# Codex State

## Current goal

## Files touched

## Decisions made

## Tests run

## Known issues

## Next exact step
```

Config:

```json
{
  "enableCheckpointMemory": true,
  "checkpointDir": ".hacb",
  "checkpointFiles": ["CODEX_STATE.md", "TASK_PLAN.md", "TEST_LOG.md", "DECISIONS.md"],
  "maxCheckpointChars": 4000
}
```

The pattern: Codex updates checkpoint files locally, the bridge injects them compactly, and old chat turns can then be dropped without losing durable context.

### Multi-tool-call support (experimental, off by default)

When enabled, the relay may request up to `maxToolCallsPerResponse` independent client tool calls in one JSON response; the bridge converts them into multiple Responses `function_call` output items so Codex executes them in one turn instead of one full Hyperagent round-trip per call.

```json
{
  "enableMultiToolCalls": true,
  "maxToolCallsPerResponse": 3
}
```

Fails safely: any unavailable tool name, or more than the maximum calls, degrades to a plain final answer naming the problem — never a partial execution. Disabled by default until proven stable across Codex builds.

### Cheap/strong agent routing (off by default)

Create multiple named Hyperagent agents (for example `cheap-coder`, `debugger`, `planner`, `strong-coder`) and route turns deterministically instead of paying strong-model prices for every step:

```json
{
  "enableAgentRouting": true,
  "agentRoutes": {
    "tool_selection": "hyperagent/cheap-coder",
    "final_answer": "hyperagent/cheap-coder",
    "debug_failure": "debugger",
    "large_refactor": "strong-coder",
    "planning": "planner"
  }
}
```

Route targets accept anything `resolveAgent` accepts (agent ID, exact name, or slug). Detection is deterministic (`debug_failure` → `large_refactor` → `planning` → `tool_selection` → `final_answer`) from the last user message plus forwarded tools. Unknown targets fall back to the requested model with an `agent_route_fallback` log, and selected routes plus reasons appear in the audit receipt. Off by default — no hidden model substitution unless you enable it.

### Per-task budgets

Daily caps bound a whole day; runaway agent loops happen per task. Start an explicit task before a coding session and every dispatched request counts against it:

```bash
hacb task start fix-auth-bug
hacb task status
hacb task stop
```

When the cap is hit, the bridge fails closed — Codex sees `This local Hyperagent task budget is exhausted. Start a new task or raise maxRequestsPerTask.` and no further Hyperagent threads are created for that task. Task budgets are durable across restarts, separate from (and never bypass) the daily budget, and requests without an active task are unaffected.

```json
{
  "maxRequestsPerTask": 8,
  "maxPromptCharsPerTask": 180000,
  "warnAtPromptCharsPerTask": 120000
}
```

A warning is recorded in the audit log when cumulative prompt chars cross `warnAtPromptCharsPerTask`.

### Request fingerprint cache

Codex retries identical requests after local hiccups without an `Idempotency-Key`; each retry previously created another Hyperagent thread and burned credits. The optional fingerprint cache stores completed successful responses by `sha256(canonical JSON body)` in the private state directory and replays them locally (header `X-Response-Cache-Replayed: true`) until the TTL expires.

```json
{
  "enableResponseCache": true,
  "responseCacheTtlMs": 1800000,
  "responseCacheMaxEntries": 128
}
```

Off by default because it changes replay semantics for un-keyed requests. Only completed successes are cached — never errors, cancellations, or in-progress outcomes — and an explicit `Idempotency-Key` always wins over the cache.

### Local preprocessor hook (off by default)

An optional local command can inspect sanitised request metadata before anything reaches Hyperagent. It receives JSON on stdin (`requestId`, `model`, `toolCount`, `inputChars` — never prompt content) and may answer `{"action":"reject","reason":"..."}` to block no-op requests locally.

```json
{
  "enableLocalPreprocessor": true,
  "localPreprocessorCommand": "/usr/local/bin/hacb-guard",
  "localPreprocessorTimeoutMs": 3000,
  "localPreprocessorFailureMode": "fallback"
}
```

The preprocessor can classify, estimate cost, or reject — it never writes code or replaces Hyperagent reasoning. Timeouts are enforced by killing the process; failures either fall back to allowing the request (`fallback`) or fail closed with HTTP 503 (`fail_closed`). Rejections return HTTP 400 with a generic message; reasons stay in local logs.

## Testing end-to-end against OpenRouter

Before wiring the bridge to a Hyperagent agent you can exercise the full local pipeline — Codex CLI → bridge → relay protocol → model — with any OpenRouter model:

```json
{
  "upstream": "openrouter",
  "openrouterModel": "openai/gpt-4o-mini"
}
```

Export `OPENROUTER_API_KEY` (or set `openrouterApiKey` in the config file; the environment variable is preferred so the key never touches disk). The bridge exposes one synthetic agent (`hyperagent/openrouter`) backed by `openrouterModel`; point your profile's `model` at that slug, or map friendlier names through `aliases`. Everything else is unchanged: the same minimised relay prompt goes out, the model must answer with the same compact JSON actions, and cost metrics, tool shortlisting, reducer, checkpoints, task budgets, caching, and routing all apply exactly as they do against Hyperagent. Switch back by removing `upstream` (defaults to `"hyperagent"`). Requests fail closed with HTTP 503 (`upstream_not_configured`) when the key is missing.

## Security

- The HTTP bridge binds only to `127.0.0.1` and requires a random local bearer token on every model and Responses request.
- The generated Codex profile stores that local-only bearer token with file mode `0600`; it is not a Hyperagent credential.
- OAuth uses PKCE, state validation, issuer/origin binding, dynamic client registration, refresh tokens, and only `threads:read`, `threads:write`, and `offline_access` scopes.
- Hyperagent OAuth tokens are stored in `~/.hyperagent-codex-bridge/state.json` with mode `0600`; the directory uses mode `0700` where the OS supports POSIX permissions.
- Never publish or sync the state directory or generated Codex profile.
- Revoke access from Hyperagent settings if the machine is lost.

## Current limitations

1. **Named agents are the model boundary.** A Hyperagent agent's model is fixed in its agent configuration. Create one agent per desired model.
2. **One Hyperagent thread per Codex sampling request.** This is more latent than a raw inference API, but it preserves supported OAuth and credit accounting.
3. **No true token streaming from Hyperagent MCP.** The bridge sends SSE keepalives, then returns the completed Hyperagent response.
4. **Text-first input.** Image URLs are described to the Hyperagent agent, not uploaded automatically.
5. **Codex Desktop model picker bug.** Current Codex Desktop builds may label custom provider models as `Custom` or hide them. The CLI/profile still sends the configured model ID correctly. Use `hacb profile <model-id>` or `codex --profile hyperagent -m <model-id>` when the picker is unreliable.
6. **Tool-call quality depends on the selected agent.** Its prompt should emphasize exact JSON tool selection and local Codex tool use. The bridge falls back to plain final text if the agent does not follow the relay schema.
7. **This is an adapter, not a Hyperagent product feature.** A future official Hyperagent Responses gateway would be faster and should replace this bridge.
8. **No provider-reported usage or remote cancellation.** Token usage is omitted, and disconnect cancellation stops only local polling after dispatch. Hyperagent platform support is required for authoritative usage/cost data, remote thread cancellation, and reconciliation of ambiguous `create_thread` outcomes.

## Sources

- Hyperagent MCP: <https://hyperagent.com/docs/reference/mcp-server>
- Codex custom providers: <https://developers.openai.com/codex/config-advanced>
- Codex MCP OAuth: <https://developers.openai.com/codex/mcp>
- Codex model picker limitation: <https://github.com/openai/codex/issues/19694>
