const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const e2eDir = path.join(__dirname, '..', 'e2e');
const BACKEND_URL = process.env.AXIOM_BACKEND_URL || 'http://127.0.0.1:18790';
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
  const e2eDir = path.join(__dirname, '..', 'e2e');
  if (!fs.existsSync(e2eDir)) {
    console.error(`E2E directory not found: ${e2eDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(e2eDir).filter((f) => f.endsWith('.spec.ts')).sort();
  // 本地可用 E2E_SPEC 过滤；CI 不设置则跑全套
  const filter = process.env.E2E_SPEC;
  const selected = filter ? files.filter((f) => f.includes(filter)) : files;
  if (selected.length === 0) {
    console.error(`No E2E spec matches E2E_SPEC=${filter}`);
    process.exit(1);
  }

  // 后端生命周期管理：健康检查通过则复用；否则自动拉起并在结束时关闭
  let child = null;
  if (!(await healthOk())) {
    console.log('[e2e] Backend not reachable, starting `bun run src/main.ts` ...');
    child = spawn('bun', ['run', 'src/main.ts'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AXIOM_AUTH_TOKEN: AUTH_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
    child.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d));
    if (!(await waitHealth(120000))) {
      console.error('[e2e] Backend failed to start within 120s');
      try { child.kill(); } catch (e) {}
      process.exit(1);
    }
    console.log('[e2e] Backend ready.');
  }

  let failed = 0;
  for (const file of selected) {
    console.log(`\n>>> Testing ${file}`);
    try {
      const binName = process.platform === 'win32' ? 'playwright.exe' : 'playwright';
      const bin = path.join(__dirname, '..', 'node_modules', '.bin', binName);
      const relPath = 'e2e/' + file;
      execSync(
        `"${bin}" test "${relPath}" --project=chromium --workers=1 --timeout=30000 --reporter=line`,
        { stdio: 'inherit', cwd: path.join(__dirname, '..') },
      );
    } catch (e) {
      failed++;
      console.error(`FAILED: ${file}`);
    }
  }

  if (child) {
    try { child.kill(); } catch (e) {}
  }
  if (failed > 0) {
    console.error(`\n${failed} test file(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll E2E tests passed!');
})();
