import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const DEFAULT_READER = path => readFile(path, 'utf8');

function isSafeRelativeName(name) {
  const value = String(name || '');
  return Boolean(value)
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
    && !value.includes('\0');
}

export async function loadCheckpoint(config = {}, reader = DEFAULT_READER) {
  if (!config.enableCheckpointMemory) return { text: '', files: [] };
  const dir = resolve(process.cwd(), String(config.checkpointDir || '.hacb'));
  const names = (Array.isArray(config.checkpointFiles) ? config.checkpointFiles : [])
    .filter(isSafeRelativeName);
  const maxChars = Math.max(0, Number(config.maxCheckpointChars || 4000));
  const sections = [];
  const loaded = [];
  let used = 0;
  for (const name of names) {
    const path = join(dir, name);
    let content;
    try {
      content = await reader(path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      continue;
    }
    const label = `## ${name}\n`;
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    const marker = '\n[checkpoint truncated by Hyperagent Codex Bridge]';
    const budgeted = Math.max(0, remaining - marker.length);
    const body = content.length > remaining
      ? `${content.slice(0, budgeted)}${marker}`
      : content;
    sections.push(`${label}${body}`);
    loaded.push(name);
    used += `${label}${body}`.length + 1;
  }
  return { text: sections.join('\n'), files: loaded };
}
