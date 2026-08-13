---
name: hyperagent-codex-bridge
description: Install, configure, switch, audit, upgrade, or troubleshoot Hyperagent Codex Bridge on macOS, Windows, or Linux. Use when a user wants Codex CLI or Codex App to route reasoning through named Hyperagent agents and Hyperagent credits, add relay models, verify billing/routing, migrate the setup to another computer, restore normal Codex subscription defaults, or publish proof that the bridge works.
---

# Hyperagent Codex Bridge

Operate the supported OAuth bridge between Codex and Hyperagent. Hyperagent supplies the reasoning model and consumes Hyperagent credits. Codex keeps the local filesystem, shell, patches, tests, sandbox, and approval flow.

## Trust boundary

- Use only Hyperagent's documented OAuth MCP endpoint: `https://hyperagent.com/api/mcp`.
- Never request, print, copy, or commit OAuth access tokens, refresh tokens, Codex auth files, local bearer tokens, or generated config secrets.
- Never reverse-engineer browser sessions or call undocumented Hyperagent routes.
- Keep the bridge bound to `127.0.0.1`.
- Treat `~/.hyperagent-codex-bridge/` and generated Codex config files as private machine state.

## Preconditions

Verify:

```bash
node --version
codex --version
```

Require Node.js 20+ and a current Codex CLI. The validated release is Codex CLI 0.144.6.

A named Hyperagent relay agent is required for each desired model. Relay agents must:

- use `RELAY_AGENT_PROMPT.md` as their system prompt;
- have Hyperagent tools and integrations disabled;
- be pinned to one Hyperagent model;
- return only the JSON tool-selection protocol described by the relay prompt.

## Fresh machine setup

From a cloned or extracted bridge repository:

```bash
npm install -g .
hacb setup
```

Complete the browser OAuth consent with the Hyperagent account whose credits should be charged. Then verify:

```bash
hacb doctor
hacb models
hacb status
hacb demo
```

Do not proceed unless OAuth, reachable agents, local bridge, and Codex profile all pass.

## Codex CLI mode

Select a model and regenerate the profile:

```bash
hacb models
hacb profile hyperagent/codex-relay-sol
```

Start Codex:

```bash
hacb start
codex --profile hyperagent
```

Confirm the startup header shows provider `hyperagent_credits` and a `hyperagent/...` model.

## Codex App mode

Make Hyperagent the default for new Codex App chats:

```bash
hacb app-on hyperagent/codex-relay-sol
hacb app-status
```

Require all of the following before sending a prompt:

- App Mode says `ON`;
- provider is `hyperagent_credits`;
- model is the intended `hyperagent/...` slug;
- the Codex App model control displays `Custom` or the explicit Hyperagent slug.

Fully quit and reopen Codex App after changing App Mode.

Return new app chats to normal OpenAI/Codex subscription defaults:

```bash
hacb app-off
hacb app-status
```

Run `app-off` before stopping the bridge. App Mode preserves the `hyperagent_credits` provider definition so chats created under the bridge remain resumable.

## Add or switch relay agents

After creating another named Hyperagent relay agent:

```bash
hacb profile
hacb models
```

For a stable short alias:

```bash
hacb alias fable <exact-agent-id>
hacb profile hyperagent/fable
```

Never infer an agent ID. Read it from `hacb models`.

## Cost gate

Before any live work:

```bash
hacb budget
hacb app-status
```

Require v0.5.0+, low relay effort, a hard Hyperagent per-run USD cap, and remaining local daily budget. Never raise `maxRequestsPerDay`, context limits, forwarded-tool limits, or reasoning effort without the user's explicit approval after reviewing actual credit usage. Keep multi-agent tools blocked for relay sessions.

## Prove routing and billing

Run a controlled prompt, then inspect sanitized receipts:

```bash
hacb audit 12
hacb receipt 24
```

A successful turn records `request`, `thread_created`, and `completed` events with model and Hyperagent thread IDs. The audit log never stores prompts, answers, or tokens.

For billing proof, note Hyperagent credits before and after a controlled request. Confirm Hyperagent usage changes and Codex subscription quota does not.

Run the no-credit harness proof first with `hacb demo`. A paid controlled proof requires `hacb demo --live --confirm-spend`; do not bypass its budget check.

## Troubleshooting

Bridge state:

```bash
hacb status
hacb start
hacb serve
```

Background errors:

```bash
tail -f ~/.hyperagent-codex-bridge/bridge.log
```

OAuth refresh:

```bash
hacb login
hacb profile
```

App is still showing a normal OpenAI model:

1. Do not send a prompt.
2. Run `hacb app-status`.
3. Confirm `hacb` is version 0.5.0 or newer. v0.4.0 must not be used because it lacks cost caps and context stripping.
4. Fully quit the app with `Cmd+Q` on macOS or Exit on Windows.
5. Reopen and create a new chat.

Desktop custom-provider model pickers can show the bridge as `Custom`; this is expected. Do not patch the app bundle or edit Codex's SQLite state.

## Uninstall or revoke

```bash
hacb app-off
hacb stop
hacb uninstall-profile
hacb logout
```

Revoke OAuth access at `https://hyperagent.com/settings/mcp-access` when removing a machine.

## References

Read `references/COMMANDS.md` for the command matrix, state files, migration checklist, and proof-of-work release checklist.
