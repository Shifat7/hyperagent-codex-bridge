# Hyperagent Codex Bridge v0.5.0

Proof, safety, and first-run release.

## Why this is a major release

v0.4.1 bounded cost, but its proof and relay semantics were not strong enough. v0.5.0 turns the bridge into a reproducible product demonstration: a no-credit real-Codex demo, fail-closed typed tool actions, request-level latency receipts, pinned model routing, comprehensive doctor checks, portable CI, and a release verifier.

## New

- `hacb demo`: real Codex CLI, real local shell-tool round trip, deterministic relay fixture, zero Hyperagent credits.
- `hacb demo --live --confirm-spend`: controlled paid route that requires budget headroom and verifies `function_call → final` receipts.
- `hacb doctor --json`: machine-readable security, OAuth, route, budget, bridge, and Codex-profile checks.
- `hacb receipt [count] [--json]`: publishable request/latency receipts with hashed thread IDs by default.
- `hacb models --all --json`: explicit candidate discovery; normal model listing shows pinned routes.
- Request correlation IDs and timing fields for thread creation, polling, parsing, and total latency.
- Linux/macOS/Windows CI on Node 20 and 22 plus a real Codex 0.144.6 macOS job.
- Release verification and deterministic ZIP/checksum build scripts.

## Safety and correctness

- Strict relay JSON parsing with balanced-object extraction.
- Typed action validation for final, function, custom-tool, and tool-search actions.
- JSON Schema subset validation for function arguments.
- Invented tools, malformed arguments, unsupported shapes, and plain prose fail with typed errors.
- Failed audit receipts record error codes, never raw model output.
- Unknown model routes no longer fall back silently.
- New installations expose pinned aliases only; unrelated named agents remain hidden.
- Live demos require `--confirm-spend` and at least two remaining daily requests.

## Preserved trust boundary

- Documented `https://hyperagent.com/api/mcp` only.
- OAuth authorization code + PKCE, state validation, issuer binding, and least-privilege thread scopes.
- HTTP remains bound to `127.0.0.1` with independent local bearer authentication.
- No prompts, answers, OAuth tokens, refresh tokens, local bearer tokens, or Codex authentication in public receipts or artifacts.
- App Mode remains backed up and reversible.

## Honest limitations

- One Hyperagent thread per Codex sampling request.
- MCP polling rather than true model-token streaming.
- No machine-readable per-request Hyperagent cost through the supported MCP result.
- Relay quality still depends on the selected model; v0.5.0 detects protocol failure but cannot make a weak model reason better.
- Windows receives automated source parity; physical Windows Codex App UI proof remains outstanding.
