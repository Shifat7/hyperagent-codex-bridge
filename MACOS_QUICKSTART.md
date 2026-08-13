# macOS quickstart for Codex CLI

This is the validated path. Codex Desktop still has upstream custom-provider/profile bugs, so start with Codex CLI on the Mac. The bridge does not modify your main `~/.codex/config.toml` or your existing ChatGPT/Codex login.

## 1. Prepare one Hyperagent relay agent

In Hyperagent, create or configure a named agent:

- Name: `Codex Relay Sol` (or any clear name)
- Model: the Hyperagent model you want, for example GPT 5.6 Sol
- System prompt: paste the contents of `RELAY_AGENT_PROMPT.md`
- Hyperagent tools: **off**
- Integrations: **off**

Codex owns your Mac files, shell, patches, tests, and approvals. The Hyperagent relay only reasons and returns JSON tool selections.

Create one relay agent per model you want later, such as Sol, Fable, Kimi, or DeepSeek.

## 2. Unpack the bridge

Double-click `hyperagent-codex-bridge-0.2.1.zip` in Finder. Then open Terminal and run:

```bash
cd ~/Downloads/hyperagent-codex-bridge
node --version
codex --version
```

Node must be 20 or newer. If Node is missing or older and you use Homebrew:

```bash
brew install node
```

If the Codex CLI is missing:

```bash
npm install -g @openai/codex@latest
```

## 3. Install and authorize

From the unzipped bridge folder:

```bash
node src/cli.mjs setup
```

What happens:

1. A browser opens to Hyperagent's official OAuth consent page.
2. Sign in to the same Hyperagent account that holds your credits.
3. Approve the requested thread access.
4. Return to Terminal.
5. The script discovers your named agents, writes the separate `hyperagent` Codex profile, and starts the local bridge.

The OAuth callback uses `127.0.0.1:47832`. The model bridge uses `127.0.0.1:47831`.

If Terminal says `hacb` is not found after setup, run:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## 4. Verify every layer

```bash
hacb doctor
hacb status
hacb models
hacb budget
```

Expected:

- Node.js: PASS
- Local bridge bearer token: PASS
- Hyperagent OAuth: PASS
- Reachable named agents: at least 1
- Local bridge: PASS
- Codex profile: PASS

`hacb models` prints the exact model IDs Codex can use. A relay named `Codex Relay Sol` normally appears as:

```text
hyperagent/codex-relay-sol
```

If you want that model as the profile default:

```bash
hacb profile hyperagent/codex-relay-sol
```

## 5. Launch Codex through Hyperagent credits

Move to any repo you want to work in, then run:

```bash
cd /path/to/your/repo
codex --profile hyperagent
```

On startup, confirm the header shows:

```text
provider: hyperagent_credits
model: hyperagent/...
```

If the model is wrong, exit Codex and run:

```bash
hacb models
hacb profile <exact-model-id>
codex --profile hyperagent
```

## 6. Run two smoke tests

First, test the reasoning path:

```text
Reply with exactly: hyperagent route works.
```

Second, test the local Codex tool loop:

```text
Run pwd, then tell me the directory it returned.
```

The second test proves the full loop:

```text
Codex -> Hyperagent relay -> JSON tool call -> local Mac shell -> tool result -> Hyperagent relay -> final answer
```

## 7. Prove the billing route

Before the smoke test, note the credit/usage figure in Hyperagent's User menu under Billing. After the test, refresh it and confirm the Hyperagent usage changed while your Codex subscription quota did not.

The bridge response also carries a Hyperagent thread ID. You can find the corresponding run in Hyperagent Threads for an audit trail.

## 8. Use it in the Codex Mac app

Do not enable App Mode on v0.4.0. Require v0.5.0+, `hacb budget` with remaining capacity, and a relay agent configured for low effort with a hard per-run USD cap. Run `hacb demo` before spending credits.

The app does not currently expose CLI profiles in its normal provider picker. Enable the bridge as the main-config default for new app chats:

```bash
hacb app-on hyperagent/codex-relay-sol
```

Fully quit the Codex app with `Cmd+Q`, reopen it, and start a new chat. The app may label the model `Custom`; the effective provider is still `hyperagent_credits`.

When you want normal OpenAI/Codex subscription defaults again:

```bash
hacb app-off
```

This restores the original defaults but keeps the `hyperagent_credits` provider definition so app chats created through the bridge can still resume.

Check the state and prove which app turns used the bridge:

```bash
hacb app-status
hacb audit 12
```

The audit receipt includes model and Hyperagent thread IDs but never stores prompts, answers, or OAuth tokens.

## 9. Daily use

```bash
hacb start
cd /path/to/repo
codex --profile hyperagent
```

The bridge usually remains running after setup. Check with:

```bash
hacb status
```

After adding or changing Hyperagent relay agents:

```bash
hacb profile
hacb models
```

## 10. Troubleshooting

Bridge stopped:

```bash
hacb start
hacb status
```

See live errors:

```bash
hacb serve
```

See background errors:

```bash
tail -f ~/.hyperagent-codex-bridge/bridge.log
```

OAuth expired or revoked:

```bash
hacb login
hacb profile
```

Codex Desktop does not show the model:

- This is an upstream Codex Desktop limitation for custom providers and profiles.
- Do not edit Codex's SQLite database or patch the app bundle.
- Use `codex --profile hyperagent` in Terminal; that path is tested against Codex CLI 0.144.6.

## 11. Stop or remove

```bash
hacb stop
hacb uninstall-profile
hacb logout
```

Then revoke the OAuth connection at:

<https://hyperagent.com/settings/mcp-access>
