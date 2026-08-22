import { spawn } from 'node:child_process';

const DEFAULT_SPAWN_IMPL = (command, options) => spawn(command, { shell: true, ...options });

export async function runLocalPreprocessor(config = {}, payload = {}, { spawnImpl = DEFAULT_SPAWN_IMPL } = {}) {
  if (!config.enableLocalPreprocessor || !config.localPreprocessorCommand) {
    return { action: 'allow', skipped: true };
  }
  const failureMode = config.localPreprocessorFailureMode === 'fail_closed' ? 'fail_closed' : 'fallback';
  const timeoutMs = Math.max(50, Number(config.localPreprocessorTimeoutMs) || 3000);
  const outcome = await new Promise(resolve => {
    let settled = false;
    const settle = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawnImpl(String(config.localPreprocessorCommand), { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    let stdout = '';
    child.stdout?.on?.('data', chunk => { stdout += chunk; });
    child.on?.('error', () => settle({ ok: false, reason: 'spawn_error' }));
    child.on?.('close', exitCode => {
      if (Number(exitCode) !== 0) {
        settle({ ok: false, reason: 'non_zero_exit' });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed && parsed.action === 'reject') {
          settle({ ok: true, action: 'reject', reason: String(parsed.reason || 'rejected').slice(0, 200) });
        } else {
          settle({ ok: true, action: 'allow' });
        }
      } catch {
        settle({ ok: false, reason: 'invalid_output' });
      }
    });
    child.stdin?.write?.(JSON.stringify(payload));
    child.stdin?.end?.();
  });
  if (outcome.ok) return { action: outcome.action, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  if (failureMode === 'fail_closed') {
    throw Object.assign(new Error(`The local preprocessor failed closed (${outcome.reason}).`), {
      status: 503,
      code: 'preprocessor_failed'
    });
  }
  return { action: 'allow', fallback: true, reason: outcome.reason };
}
