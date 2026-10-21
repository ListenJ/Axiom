const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const e2eDir = path.join(__dirname, '..', 'e2e');
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
  /** 结束后端：Linux/macOS 上必须**连进程组一起杀**（2026-10-21 修复）。
   *  原因：后端会再拉起若干子进程（npx 形式的 MCP server 等）。只 kill 直接子进程时，
   *  这些孙进程会变成孤儿并继续存活，GitHub Actions 会一直等待步骤进程树收尾
   *  → 表现为「E2E 步骤 10 分钟超时、但用例其实早就跑完了」。
   *  因此非 Windows 用 detached 启动（自成进程组），结束时 SIGKILL 整个组。 */
  const killBackend = () => {
    if (!child) return;
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, 'SIGKILL'); // 负 pid = 整个进程组
      } else {
        child.kill('SIGKILL');
      }
    } catch (e) {
      try { child.kill('SIGKILL'); } catch (e2) {}
    }
    child = null;
  };
  if (!(await healthOk())) {
    console.log('[e2e] Backend not reachable, starting `bun run src/main.ts` ...');
    child = spawn('bun', ['run', 'src/main.ts'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, AXIOM_AUTH_TOKEN: AUTH_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
    child.stderr.on('data', (d) => process.stderr.write('[server-err] ' + d));
    if (!(await waitHealth(120000))) {
      console.error('[e2e] Backend failed to start within 120s');
      killBackend();
      process.exit(1);
    }
    console.log('[e2e] Backend ready.');
  }

  let failed = 0;
  for (const file of selected) {
    console.log(`\n>>> Testing ${file}`);
    // 逐文件计时（2026-10-20）：CI 上若某 spec 悬挂，可从日志直接看出是哪个文件/花了多久，
    // 而不是只看到整步超时（此前排查只能靠猜）。
    const startedAt = Date.now();
    try {
      const binName = process.platform === 'win32' ? 'playwright.exe' : 'playwright';
      const bin = path.join(__dirname, '..', 'node_modules', '.bin', binName);
      const relPath = 'e2e/' + file;
      execSync(
        `"${bin}" test "${relPath}" --project=chromium --workers=1 --timeout=30000 --reporter=line`,
        {
          stdio: 'inherit',
          cwd: path.join(__dirname, '..'),
          // 单文件硬超时（2026-10-20）：Playwright 的 --timeout 只约束**单个测试**，
          // 浏览器启动/teardown/hook 卡住时不受它约束。实测 GitHub runner 上该步骤曾 30+ 分钟
          // 无进展（run 39457724942），因此每个 spec 文件再加一层独立兜底：超时记失败、继续下一个，
          // 绝不允许整轮 E2E 无限期悬挂。
          timeout: 180000,
          killSignal: 'SIGKILL',
        },
      );
    } catch (e) {
      failed++;
      if (e && (e.killed || e.signal)) {
        console.error(`TIMEOUT: ${file}（超过单文件 180s 上限，已强制终止）`);
      } else {
        console.error(`FAILED: ${file}`);
      }
    } finally {
      console.log(`<<< ${file} 用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
  }

  killBackend();
  // 显式退出（2026-10-21）：即便回收了子进程组，事件循环里仍可能残留定时器/句柄
  // （健康探测的 http agent、子进程 pipe 等），显式 exit 才能保证 CI 步骤立即收尾。
  if (failed > 0) {
    console.error(`\n${failed} test file(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll E2E tests passed!');
  process.exit(0);
})();
