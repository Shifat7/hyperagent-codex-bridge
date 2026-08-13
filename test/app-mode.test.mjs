import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateAppMode, appBackupPath, appModeStatus, deactivateAppMode, mainConfigPath } from '../src/app-mode.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const agents = [
  { id: 'agent-sol-123456', name: 'Codex Relay Sol', description: 'Sol relay', model: 'openai/gpt-5.6-sol' }
];

test('App Mode safely activates, is idempotent, and restores original defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hacb-app-mode-'));
  const oldHacb = process.env.HACB_HOME;
  const oldCodex = process.env.CODEX_HOME;
  process.env.HACB_HOME = join(root, 'state');
  process.env.CODEX_HOME = join(root, 'codex');
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    localApiToken: 'app-mode-local-token-12345678901234567890',
    aliases: { 'hyperagent/codex-relay-sol': agents[0].id }
  };
  const original = [
    'model = "gpt-5.5"',
    'model_provider = "openai"',
    'approval_policy = "on-request"',
    '',
    '[model_providers.other_gateway]',
    'name = "Other"',
    'base_url = "https://example.com/v1"',
    'wire_api = "responses"',
    ''
  ].join('\n');

  try {
    await mkdir(process.env.CODEX_HOME, { recursive: true });
    await writeFile(mainConfigPath(), original, { mode: 0o600 });
    const active = await activateAppMode(config, { model: 'hyperagent/codex-relay-sol', agents });
    assert.equal(active.selected, 'hyperagent/codex-relay-sol');
    assert.equal(await readFile(appBackupPath(), 'utf8'), original);

    let text = await readFile(mainConfigPath(), 'utf8');
    assert.match(text, /^# BEGIN Hyperagent Codex Bridge app mode/m);
    assert.match(text, /^model = "hyperagent\/codex-relay-sol"/m);
    assert.match(text, /^model_provider = "hyperagent_credits"/m);
    assert.match(text, /approval_policy = "on-request"/);
    assert.match(text, /\[model_providers\.other_gateway\]/);
    assert.equal((text.match(/\[model_providers\.hyperagent_credits\]/g) || []).length, 1);
    assert.equal((await appModeStatus(config)).active, true);

    await activateAppMode(config, { agents });
    text = await readFile(mainConfigPath(), 'utf8');
    assert.equal((text.match(/BEGIN Hyperagent Codex Bridge app mode/g) || []).length, 1);
    assert.equal((text.match(/\[model_providers\.hyperagent_credits\]/g) || []).length, 1);

    await deactivateAppMode(config);
    text = await readFile(mainConfigPath(), 'utf8');
    assert.doesNotMatch(text, /BEGIN Hyperagent Codex Bridge app mode/);
    assert.match(text, /^model = "gpt-5.5"/m);
    assert.match(text, /^model_provider = "openai"/m);
    assert.match(text, /approval_policy = "on-request"/);
    assert.match(text, /\[model_providers\.other_gateway\]/);
    assert.equal((text.match(/\[model_providers\.hyperagent_credits\]/g) || []).length, 1);
    const status = await appModeStatus(config);
    assert.equal(status.active, false);
    assert.equal(status.providerConfigured, true);
    if (process.platform !== 'win32') assert.equal((await stat(mainConfigPath())).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (oldHacb === undefined) delete process.env.HACB_HOME;
    else process.env.HACB_HOME = oldHacb;
    if (oldCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodex;
  }
});
