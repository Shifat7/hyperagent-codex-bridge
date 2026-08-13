# Windows / Ryzen quickstart

Use PowerShell. Do not copy OAuth or local token files from another computer; authorize the Ryzen machine independently.

## 1. Install prerequisites

```powershell
node --version
codex --version
```

Require Node.js 20+ and a current Codex CLI. If missing:

```powershell
winget install OpenJS.NodeJS.LTS
npm install -g @openai/codex@latest
```

Close and reopen PowerShell after installing Node.

## 2. Clone and install

```powershell
git clone https://github.com/clutchpbcfo/hyperagent-codex-bridge.git
cd hyperagent-codex-bridge
npm install -g .
hacb setup
```

Complete Hyperagent OAuth in the browser using the account whose credits should be charged.

`hacb setup` also installs the bundled Codex skill into `%USERPROFILE%\.codex\skills\hyperagent-codex-bridge`.

## 3. Verify

```powershell
hacb doctor
hacb models
hacb status
hacb budget
```

All checks must pass before use.

## 4. Codex CLI

```powershell
hacb profile hyperagent/codex-relay-sol
codex --profile hyperagent
```

Confirm the startup header reports provider `hyperagent_credits`.

## 5. Codex App

Do not enable App Mode on v0.4.0. Require v0.5.0+, remaining `hacb budget`, and a relay agent configured for low effort with a hard per-run USD cap. Run `hacb demo` before spending credits.

Fully exit the Codex App, then run:

```powershell
hacb app-on hyperagent/codex-relay-sol
hacb app-status
```

Reopen the app and start a new chat. The model control may show `Custom`; that is expected for a custom provider.

After one controlled request, prove routing:

```powershell
hacb audit 12
```

## 6. Return to normal Codex subscription defaults

```powershell
hacb app-off
hacb app-status
```

Exit and reopen the Codex App. Stopping the bridge is optional because an idle bridge consumes no model credits. If desired:

```powershell
hacb stop
```

## 7. Invoke the skill

Start a fresh Codex chat, then choose the skill in `/skills` or invoke:

```text
$hyperagent-codex-bridge
```

Use it for setup, model switching, App Mode, rollback, audit, migration, and troubleshooting.

## 8. Private state

Never publish or copy these between machines:

- `%USERPROFILE%\.hyperagent-codex-bridge\state.json`
- `%USERPROFILE%\.hyperagent-codex-bridge\config.json`
- `%USERPROFILE%\.codex\auth.json`
- `%USERPROFILE%\.codex\hyperagent.config.toml`

Each computer should have its own OAuth grant and local bearer token.
