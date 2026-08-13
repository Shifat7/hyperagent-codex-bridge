# Hyperagent Codex Bridge command reference

## Command matrix

| Goal | Command |
| --- | --- |
| First setup | `hacb setup` |
| Verify installation | `hacb doctor` |
| List relay models | `hacb models` |
| Discover all candidate agents | `hacb models --all` |
| Start bridge | `hacb start` |
| Stop bridge | `hacb stop` |
| Foreground debugging | `hacb serve` |
| Bridge health | `hacb status` |
| Refresh OAuth | `hacb login` |
| Remove local OAuth tokens | `hacb logout` |
| Generate CLI profile | `hacb profile [model-id]` |
| Add alias | `hacb alias <slug> <agent-id>` |
| Enable Codex App Mode | `hacb app-on [model-id]` |
| Restore normal app defaults | `hacb app-off` |
| Check App Mode | `hacb app-status` |
| Show routing receipts | `hacb audit [count]` |
| Publishable latency receipt | `hacb receipt [count]` |
| No-credit real-Codex proof | `hacb demo` |
| Controlled paid route proof | `hacb demo --live --confirm-spend` |
| Remove generated CLI profile | `hacb uninstall-profile` |

## Private state

Do not commit, publish, or sync:

- `~/.hyperagent-codex-bridge/state.json`
- `~/.hyperagent-codex-bridge/config.json`
- `~/.hyperagent-codex-bridge/audit.jsonl`
- `~/.codex/hyperagent.config.toml`
- `~/.codex/config.toml.hacb-app-backup*`
- `~/.codex/auth.json`

The repository itself contains no credentials. OAuth and local bearer tokens are generated per machine.

## Migrate to a second machine

1. Install Node.js 20+ and Codex CLI.
2. Clone the public repository.
3. Run `npm install -g .`.
4. Run `hacb setup` and complete OAuth on that machine.
5. Run `hacb models` and select the intended relay model.
6. Use `codex --profile hyperagent` for CLI or `hacb app-on <model-id>` for the app.
7. Run one controlled request and verify with `hacb audit 12`.
8. Confirm Hyperagent credit usage before production work.

Do not copy `state.json` or any token-bearing file between machines. Each machine gets its own OAuth grant and local bridge secret.

## Proof-of-work release checklist

A public release should include:

- public source repository;
- MIT license;
- tagged semantic version;
- SHA-256 checksums;
- automated test output;
- real Codex CLI provider test;
- real Codex local-tool round-trip test;
- Codex App Mode test through main config;
- screenshot showing `Hyperagent Credits` and `Custom` in the app;
- sanitized `hacb audit` receipt with model and Hyperagent thread ID;
- architecture diagram;
- explicit limitations and rollback commands;
- security statement explaining PKCE, issuer binding, least-privilege scopes, loopback-only HTTP, local bearer auth, and secret-free repository policy.

## Article framing

Lead with the problem: subscription-bound coding clients have excellent local tool harnesses but limited provider choice.

Then show the separation of concerns:

```text
Codex UI and local tools
        |
        v
Loopback Responses adapter
        |
        v
Hyperagent OAuth MCP
        |
        v
Named Hyperagent relay agent and selected model
```

The key proof is not a model name in a picker. It is the complete tool loop:

```text
Codex request
-> Hyperagent reasoning
-> JSON tool call
-> local Codex shell or patch
-> tool result
-> Hyperagent final answer
-> audited Hyperagent thread and credit usage
```
