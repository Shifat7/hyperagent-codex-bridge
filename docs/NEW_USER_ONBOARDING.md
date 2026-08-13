# New user onboarding guide

This guide is for someone who has never used Hyperagent Codex Bridge. It assumes you have a Hyperagent account and a Codex installation.

## What you need before starting

1. A Hyperagent account with credits. Sign up at hyperagent.com if you do not have one.
2. Codex CLI installed. Check with `codex --version`. Version 0.144.6 or newer is recommended. Install with `npm install -g @openai/codex@latest`.
3. Node.js 20 or newer. Check with `node --version`. Install from nodejs.org or via your package manager.
4. A terminal on macOS, Windows, or Linux.

## Create your relay agent in Hyperagent

Before installing the bridge, you need at least one named Hyperagent agent that will act as the reasoning backend. The bridge calls this agent by name, so it must exist first.

1. Go to Hyperagent and create a new agent.
2. Name it something clear, like `Codex Relay GLM` or `Codex Relay Sol`.
3. Set its model to the one you want to use from Codex, for example GLM 5.2 Fast, GPT 5.6 Sol, or Fable 5.
4. Set its system prompt to the contents of `RELAY_AGENT_PROMPT.md` from this repository. That prompt makes the agent return JSON tool selections instead of doing work itself.
5. Disable all Hyperagent tools and integrations on this agent. The relay agent should not have browser, code execution, or any other tools. It only reasons and returns JSON. Codex handles all local execution.
6. Set a hard per-run budget cap on the agent. Start with $0.25 or lower. This is your primary cost safety net.
7. Set the agent's reasoning effort to low for production use.

Create one relay agent per model you want available in Codex. Each agent appears as a separate model in the Codex picker.

## Install the bridge

```bash
git clone https://github.com/clutchpbcfo/hyperagent-codex-bridge.git
cd hyperagent-codex-bridge
npm install -g .
hacb setup
```

`hacb setup` will:

1. Install the `hacb` command.
2. Install the Codex skill so you can invoke `$hyperagent-codex-bridge` inside Codex.
3. Open a browser to Hyperagent's OAuth consent page. Sign in with the Hyperagent account whose credits you want to use.
4. Discover your named relay agents.
5. Write a Codex CLI profile and model catalog.
6. Start the local bridge on 127.0.0.1:47831.

## Verify

```bash
hacb doctor
hacb models
hacb budget
```

All checks must pass. `hacb models` will show the model IDs you can use in Codex. `hacb budget` shows your daily request cap, which defaults to six.

## Use it from Codex CLI

```bash
hacb start
codex --profile hyperagent
```

Send a small test:

```text
Reply with exactly: bridge works.
```

Then check what happened:

```bash
hacb audit 6
hacb budget
```

Compare your Hyperagent credits before and after. A single text-only turn should cost very little. A tool loop with local shell commands costs more because each round trip is a separate Hyperagent request.

## Use it from Codex App

App Mode changes the main Codex config so new app chats use Hyperagent by default. Use it carefully.

```bash
hacb app-on hyperagent/codex-relay-glm
hacb app-status
```

Fully quit and reopen the Codex app. Start a new chat. The model picker may show `Custom` because Codex Desktop does not fully support custom providers in its UI, but the backend will route through Hyperagent.

After a single test:

```bash
hacb audit 6
hacb budget
```

When you want normal Codex subscription defaults back:

```bash
hacb app-off
```

## Cost rules

- The bridge defaults to low reasoning effort and a six-request daily cap.
- Each Codex tool loop can use two or more Hyperagent requests.
- The relay agent should have a hard per-run USD budget cap set in Hyperagent.
- Never raise `maxRequestsPerDay`, context limits, or reasoning effort without checking actual credit usage first.
- Do not use v0.4.0. It lacks cost controls and can burn credits rapidly.

## Switch models

After creating another relay agent in Hyperagent:

```bash
hacb profile
hacb models
hacb profile hyperagent/codex-relay-glm
```

For a shorter alias:

```bash
hacb alias glm <exact-agent-id-from-hacb-models>
hacb profile hyperagent/glm
```

## Stop or uninstall

```bash
hacb app-off
hacb stop
hacb uninstall-profile
hacb logout
```

Revoke OAuth access at https://hyperagent.com/settings/mcp-access when removing a machine.

## Migrate to another computer

Do not copy token files between machines. Each computer gets its own OAuth grant.

1. Install Node.js 20+ and Codex CLI on the new machine.
2. Clone the repository and run `npm install -g .`.
3. Run `hacb setup` and complete OAuth on that machine.
4. Run `hacb models` and select your relay model.
5. Run one controlled test and check `hacb audit` and `hacb budget`.

## Troubleshooting

Bridge not running:

```bash
hacb start
hacb status
hacb serve
```

OAuth expired:

```bash
hacb login
hacb profile
```

App still showing OpenAI model:

1. Run `hacb app-status`.
2. Confirm version is 0.5.0 or newer and run `hacb demo` before a paid route.
3. Fully quit the app.
4. Reopen and start a new chat.

Background errors:

```bash
tail -f ~/.hyperagent-codex-bridge/bridge.log
```
