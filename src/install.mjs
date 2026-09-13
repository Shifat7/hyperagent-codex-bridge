import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUpstreamClient } from './bridge.mjs';
import { atomicWriteJson, atomicWriteText, bridgeUrl, ensureStateDir, modelCatalogPath } from './config.mjs';
import { buildAgentModels, modelInfo } from './protocol.mjs';

function tomlString(value) {
  return JSON.stringify(String(value));
}

function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function installDir() {
  return resolve(process.env.HACB_INSTALL_DIR || join(homedir(), '.local', 'share', 'hyperagent-codex-bridge'));
}

export function binDir() {
  return resolve(process.env.HACB_BIN_DIR || join(homedir(), '.local', 'bin'));
}

export function codexHome() {
  return resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
}

export function codexProfilePath() {
  return join(codexHome(), 'hyperagent.config.toml');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function backup(path) {
  if (!(await pathExists(path))) return null;
  const target = `${path}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(path, target);
  return target;
}

export async function installCommand() {
  const source = projectRoot();
  const target = installDir();
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copyFile(join(source, 'package.json'), join(target, 'package.json'));
  await cp(join(source, 'src'), join(target, 'src'), { recursive: true });
  if (await pathExists(join(source, 'skills'))) await cp(join(source, 'skills'), join(target, 'skills'), { recursive: true });
  if (await pathExists(join(source, '.codex-plugin'))) await cp(join(source, '.codex-plugin'), join(target, '.codex-plugin'), { recursive: true });
  if (await pathExists(join(source, 'docs'))) await cp(join(source, 'docs'), join(target, 'docs'), { recursive: true });
  if (await pathExists(join(source, 'README.md'))) await copyFile(join(source, 'README.md'), join(target, 'README.md'));
  if (await pathExists(join(source, 'MACOS_QUICKSTART.md'))) await copyFile(join(source, 'MACOS_QUICKSTART.md'), join(target, 'MACOS_QUICKSTART.md'));
  if (await pathExists(join(source, 'WINDOWS_QUICKSTART.md'))) await copyFile(join(source, 'WINDOWS_QUICKSTART.md'), join(target, 'WINDOWS_QUICKSTART.md'));
  if (await pathExists(join(source, 'RELAY_AGENT_PROMPT.md'))) await copyFile(join(source, 'RELAY_AGENT_PROMPT.md'), join(target, 'RELAY_AGENT_PROMPT.md'));
  if (await pathExists(join(source, 'LICENSE'))) await copyFile(join(source, 'LICENSE'), join(target, 'LICENSE'));

  await mkdir(binDir(), { recursive: true });
  const windows = process.platform === 'win32';
  const launcher = join(binDir(), windows ? 'hacb.cmd' : 'hacb');
  const entry = join(target, 'src', 'cli.mjs');
  const script = windows
    ? `@echo off\r\nnode "${entry}" %*\r\n`
    : `#!/bin/sh\nexec node ${JSON.stringify(entry)} "$@"\n`;
  await writeFile(launcher, script, { mode: windows ? 0o600 : 0o755 });
  if (!windows) await chmod(launcher, 0o755);
  return { target, launcher };
}

export async function installSkill() {
  const source = join(projectRoot(), 'skills', 'hyperagent-codex-bridge');
  if (!(await pathExists(join(source, 'SKILL.md')))) {
    throw new Error(`Bundled skill not found at ${source}. Reinstall the bridge from a complete release.`);
  }
  const skillsRoot = join(codexHome(), 'skills');
  const target = join(skillsRoot, 'hyperagent-codex-bridge');
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true });
  return { source, target };
}

export async function generateCatalog(config, agents = null) {
  let client;
  if (!agents) {
    client = createUpstreamClient(config);
    agents = await client.listAgents();
  }
  try {
    if (!agents.length) {
      throw new Error(config.upstream === 'openrouter'
        ? 'OpenRouter upstream is selected but no synthetic agent was exposed. Check openrouterModel and try again.'
        : 'No named Hyperagent agents are reachable. Create at least one agent before installing the Codex profile.');
    }
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const aliasModels = Object.entries(config.aliases || {})
      .filter(([, agentId]) => byId.has(agentId))
      .map(([slug, agentId], index) => ({
        agent: byId.get(agentId),
        slug,
        displayName: `${byId.get(agentId).name} · ${slug}`,
        priority: index + 1
      }));
    const allModels = config.exposeAllAgents ? buildAgentModels(agents) : [];
    const seen = new Set();
    const models = [...aliasModels, ...allModels]
      .filter(item => !seen.has(item.slug) && seen.add(item.slug))
      .map(modelInfo);
    if (!models.length) throw new Error('No model aliases are configured and exposeAllAgents is false.');
    await atomicWriteJson(modelCatalogPath(), { models }, 0o600);
    return { agents, models };
  } finally {
    await client?.close();
  }
}

export async function installCodexProfile(config, { defaultModel, agents = null } = {}) {
  await ensureStateDir();
  const { models } = await generateCatalog(config, agents);
  const selected = defaultModel && models.some(model => model.slug === defaultModel)
    ? defaultModel
    : models[0].slug;
  await mkdir(codexHome(), { recursive: true });
  const profile = codexProfilePath();
  const backupPath = await backup(profile);
  const baseUrl = bridgeUrl(config, '/v1');
  const text = [
    '# Generated by Hyperagent Codex Bridge. Use with: codex --profile hyperagent',
    `model = ${tomlString(selected)}`,
    `model_provider = ${tomlString(config.codexProviderId)}`,
    `model_catalog_json = ${tomlString(modelCatalogPath())}`,
    'model_reasoning_effort = "low"',
    '',
    `[model_providers.${config.codexProviderId}]`,
    'name = "Hyperagent Credits"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlString(config.localApiToken)}`,
    'supports_websockets = false',
    'request_max_retries = 1',
    'stream_max_retries = 1',
    `stream_idle_timeout_ms = ${Math.max(300000, config.runTimeoutMs)}`,
    ''
  ].join('\n');
  await atomicWriteText(profile, text, 0o600);
  return { profile, backupPath, selected, models };
}

export async function uninstallCodexProfile() {
  const profile = codexProfilePath();
  await rm(profile, { force: true });
  return { profile };
}
