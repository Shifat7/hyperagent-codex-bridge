import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const name = `hyperagent-codex-bridge-${pkg.version}`;
const dist = join(root, 'dist');
const stagingRoot = await mkdtemp(join(tmpdir(), 'hacb-release-'));
const staging = join(stagingRoot, name);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function normalizeTimes(path, time) {
  const info = await stat(path);
  if (info.isDirectory()) {
    const children = await readdir(path);
    for (const child of children.sort()) await normalizeTimes(join(path, child), time);
  }
  await utimes(path, time, time).catch(() => {});
}

try {
  run(process.execPath, ['scripts/verify-release.mjs']);
  await mkdir(staging, { recursive: true });
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean)
    .filter(file => !file.startsWith('dist/'));
  const epoch = new Date('2026-01-01T00:00:00.000Z');
  for (const file of files) {
    const source = join(root, file);
    const target = join(staging, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
    await utimes(target, epoch, epoch).catch(() => {});
  }
  await normalizeTimes(staging, epoch);
  await mkdir(dist, { recursive: true });
  const archive = join(dist, `${name}.zip`);
  await rm(archive, { force: true });
  run('zip', ['-X', '-q', '-r', archive, name], { cwd: stagingRoot });
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  const checksum = join(dist, `${name}.sha256`);
  await writeFile(checksum, `${digest}  ${basename(archive)}\n`, 'utf8');
  console.log(JSON.stringify({ version: pkg.version, archive, sha256: digest, checksum }, null, 2));
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
