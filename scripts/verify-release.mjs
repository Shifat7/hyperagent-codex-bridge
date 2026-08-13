import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
  return result.stdout.trim();
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(resolve(root, '.codex-plugin/plugin.json'), 'utf8'));
const configText = await readFile(resolve(root, 'src/config.mjs'), 'utf8');
if (pkg.version !== plugin.version || !configText.includes(`VERSION = '${pkg.version}'`)) {
  throw new Error('Version mismatch between package.json, plugin manifest, and src/config.mjs.');
}

const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean);
const forbiddenNames = /(^|\/)(state\.json|audit\.jsonl|auth\.json|config\.toml\.hacb-app-backup[^/]*|hyperagent\.config\.toml)$/;
const forbiddenFiles = files.filter(file => forbiddenNames.test(file));
if (forbiddenFiles.length) throw new Error(`Private machine-state files are tracked: ${forbiddenFiles.join(', ')}`);

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/
];
for (const file of files) {
  let text;
  try { text = await readFile(resolve(root, file), 'utf8'); } catch { continue; }
  if (secretPatterns.some(pattern => pattern.test(text))) throw new Error(`Potential secret detected in ${file}.`);
  const undocumented = [...text.matchAll(/https:\/\/hyperagent\.com\/api\/[A-Za-z0-9_./?=&-]+/g)]
    .map(match => match[0])
    .filter(url => !url.startsWith('https://hyperagent.com/api/mcp'));
  if (undocumented.length) throw new Error(`Undocumented Hyperagent API URL in ${file}.`);
}

run('git', ['diff', '--check']);
const codex = spawnSync(process.env.CODEX_BIN || 'codex', ['--version'], { cwd: root, encoding: 'utf8' });
const env = codex.status === 0 ? { ...process.env, CODEX_BIN: process.env.CODEX_BIN || 'codex' } : process.env;
const testOutput = run(process.execPath, ['--test'], { env });
const match = testOutput.match(/# tests (\d+)[\s\S]*# pass (\d+)[\s\S]*# fail (\d+)[\s\S]*# skipped (\d+)/);
const receipt = {
  schema: 'hacb.release-verification.v1',
  version: pkg.version,
  node: process.version,
  codex: codex.status === 0 ? `${codex.stdout}${codex.stderr}`.trim() : 'not available',
  filesScanned: files.length,
  privateStateTracked: false,
  undocumentedHyperagentRoutes: false,
  tests: match ? { total: Number(match[1]), passed: Number(match[2]), failed: Number(match[3]), skipped: Number(match[4]) } : { outputParsed: false },
  gitDiffCheck: 'passed'
};
console.log(JSON.stringify(receipt, null, 2));
