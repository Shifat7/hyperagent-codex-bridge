# Proof of work

> Current v0.5.0 candidate evidence is in `V0.5.0_PROOF.md`. This document preserves the original v0.4.0 live route and v0.4.1 remediation history for auditability.

## Claim

Hyperagent Codex Bridge lets Codex CLI and Codex App use named Hyperagent agents as model backends. Hyperagent handles reasoning and credit accounting. Codex retains the local filesystem, shell, patches, tests, sandbox, and approval system.

## What was verified

On July 20, 2026, the bridge was exercised end to end on macOS with Codex CLI 0.144.6:

1. Hyperagent OAuth completed through the documented MCP authorization flow.
2. Codex loaded `hyperagent/codex-relay-sol` through the custom Responses provider.
3. A plain reasoning request returned through Hyperagent.
4. Hyperagent selected Codex's local shell tool.
5. Codex executed `pwd` locally.
6. The shell result returned to Hyperagent.
7. Hyperagent produced the final answer.
8. Hyperagent credits visibly changed while Codex subscription quota did not.
9. Codex App Mode displayed `Custom` and `Hyperagent Credits` for a new desktop chat.

## Automated coverage

The repository test suite covers:

- strong local bearer-token generation and protected state files;
- OAuth protected-resource and authorization-server discovery;
- issuer/origin binding;
- PKCE and refresh-token rotation;
- MCP initialization, sessions, JSON responses, and SSE tool results;
- agent discovery and stable model slug generation;
- Codex model catalog generation;
- Responses streaming and non-streaming output;
- function/custom-tool mapping;
- a real Codex CLI provider run;
- a real Codex local shell-tool round trip;
- reversible App Mode activation and rollback;
- main-config Codex execution without a profile flag;
- sanitized audit receipts.

Run:

```bash
npm test
```

For the real Codex binary tests:

```bash
CODEX_BIN="$(command -v codex)" npm test
```

## Runtime proof

After a controlled turn:

```bash
hacb audit 12
```

A successful request produces a sequence like:

```text
request  hyperagent/codex-relay-sol
thread_created  hyperagent/codex-relay-sol  <hyperagent-thread-id>
completed  hyperagent/codex-relay-sol  <hyperagent-thread-id>  final
```

The audit file never stores prompts, outputs, OAuth tokens, refresh tokens, or the local bridge bearer token.

## Security design

- Documented Hyperagent OAuth MCP API only.
- OAuth authorization code flow with PKCE and CSRF state.
- Authorization-server issuer/origin validation.
- Least-privilege thread scopes.
- Loopback-only Responses endpoint.
- Independent random bearer token for local bridge requests.
- OAuth and local secrets stored outside the repository.
- POSIX permission hardening where available.
- Main Codex config backed up before App Mode changes.
- Reversible `app-on` / `app-off` workflow.
- Secret-free public source and checksum-published archives.

## Cost incident and remediation

The live v0.4.0 trial revealed unacceptable credit consumption. Root cause analysis found that each Codex App turn could forward tens of thousands of characters of injected app, skills, environment, and AGENTS context into a high-effort Hyperagent run. Codex tool loops create multiple sampling requests per user turn, multiplying the cost. v0.4.0 also lacked a local daily ceiling.

v0.4.1 remediates this with context stripping, bounded recent history, low-effort defaults, a six-request persistent daily cap, prompt/tool ceilings, multi-agent blocking, and budget visibility. Production use also requires a hard per-run budget on the relay agent itself.

## Honest limitations

- Hyperagent does not yet publish a raw first-party Responses inference endpoint; this adapter uses supported agent threads over MCP.
- Each model requires a dedicated named Hyperagent relay agent.
- Each Codex sampling request creates a Hyperagent thread, adding latency.
- Hyperagent MCP does not stream model tokens; the bridge sends keepalives and returns completed output.
- Image input is text-first in the current release.
- Codex Desktop may label the model `Custom` because its provider-aware picker is incomplete.
- An official Hyperagent Responses gateway should replace this adapter when available.
