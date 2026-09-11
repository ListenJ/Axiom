const { execFileSync, spawn } = require('child_process');
const http = require('http');

/**
 * T2.3 像素门禁 runner（CI 与本地共用同一入口）
 *
 * 职责（与 scripts/run-e2e.cjs 同款后端生命周期管理，不改存量）：
 *   1. 健康检查 :18789，不可达则拉起 `bun run src/main.ts`，结束时关闭；
 *   2. execFileSync 直调 playwright，跑 playwright.snapshot.config.mjs 矩阵；
 *   3. 透传 CLI 参数（如 --project=chromium --grep=...），exit code 即门禁结果。
 *
 * 分级（ADR-002 + 校准期判断，见 .github/workflows/visual-snapshot.yml 头注）：
 *   - 阻断级：node scripts/run-visual-gate.cjs --project=chromium --grep="视觉基线 /(chat|sessions|search)$"
 *   - 周报级：node scripts/run-visual-gate.cjs（全矩阵，调用方 continue-on-error）
 */
const BACKEND_URL = process.env.AXIOM_BACKEND_URL || 'http://127.0.0.1:18789';
const AUTH_TOKEN = process.env.AXIOM_AUTH_TOKEN || 'your-secure-random-token-at-least-16-chars';

function healthOk() {
  return new Promise((resolve) => {
    const req = http.get(BACKEND_URL + '/health', (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function waitHealth(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await healthOk()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

(async () => {
  let child = null;
  if (!(await healthOk())) {
    console.log('[visual-gate] Backend not reachable, starting `bun run src/main.ts` ...');
    child = spawn('bun', ['run', 'src/main.ts'], {
      cwd: require('path').join(__dirname, '..'),
      env: { ...process.env, AXIOM_AUTH_TOKEN: AUTH_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
    child.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d));
    if (!(await waitHealth(120000))) {
      console.error('[visual-gate] Backend failed to start within 120s');
      try { child.kill(); } catch (e) {}
      process.exit(1);
    }
    console.log('[visual-gate] Backend ready.');
  }

  const binName = process.platform === 'win32' ? 'playwright.exe' : 'playwright';
  const bin = require('path').join(__dirname, '..', 'node_modules', '.bin', binName);
  let code = 0;
  try {
    execFileSync(bin, ['test', '-c', 'playwright.snapshot.config.mjs', '--reporter=line', ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: require('path').join(__dirname, '..'),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
  }

  if (child) {
    try { child.kill(); } catch (e) {}
  }
  process.exit(code);
})();
