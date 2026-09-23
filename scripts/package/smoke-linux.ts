/**
 * 打包产物运行时冒烟：把 deb / rpm / AppImage 各自装进干净容器，真启动服务器，
 * 轮询 GET /health 直到 200，并校验响应体里 status:"ok"。
 *
 *   bun run smoke:linux
 *   bun run smoke:linux -- --only=rpm
 *
 * 为什么不能只信 `test -s <产物>`：实测撞到两类"包存在但装不上/字段是空的"假绿 ——
 *   1) rpm 的 %files 写成 `/usr` 会声明 /usr、/usr/bin、/usr/share 的所有权，
 *      与 filesystem 包冲突，`rpm -ivh` 直接拒绝安装；而 `rpm -qpl` 的文件清单看着完全正常。
 *   2) deb 的 control 里 ` Depends: ...` 带缩进，会被 deb822 当作 Description 的续行吞掉，
 *      产出的包 Depends 字段为空（dpkg-deb -f 查出来是空串）。
 * 两者都只有"装上 + 跑起来"才暴露，所以这里既装包，也断言包元数据。
 *
 * 容器内要 curl（deb 走 apt、rpm 走 dnf 现场装），因此这一步需要外网；
 * AppImage 用 --appimage-extract 后跑解包出的 AppRun —— 非特权容器里没有 FUSE，
 * 直接执行 .AppImage 会因缺 fusermount 失败，解包路径同样能验证 AppRun 接线。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const OUT = path.join(REPO, "dist", "pkg");
const DOCKER = process.platform === "win32" ? "docker.exe" : "docker";
const HEALTH_URL = "http://127.0.0.1:18789/health";
/** 每次 poll 2s，45 次 = 90s；实测冷启动约 4s 即 200，留的是容器调度的余量。 */
const POLLS = 45;
const CASE_TIMEOUT_MS = 10 * 60 * 1000;

function arg(flag: string, fallback = ""): string {
  const eq = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (eq) return eq.slice(flag.length + 3);
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** 容器内公共探测：后台进程已起 → 轮询 /health → 校验响应体 → 收尾 kill。 */
const PROBE_FN = `
probe() {
  pid="$1"
  i=0
  code=000
  while [ $i -lt ${POLLS} ]; do
    sleep 2; i=$((i+1))
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "FAIL: server 进程在第 $i 次轮询前已退出"
      tail -30 /tmp/server.log || true
      return 1
    fi
    code=$(curl -s -o /tmp/health.json -w '%{http_code}' ${HEALTH_URL} || echo 000)
    [ "$code" = "200" ] && break
  done
  echo "health_http_code=$code"
  if [ "$code" != "200" ]; then
    echo "FAIL: /health 未返回 200"
    tail -30 /tmp/server.log || true
    return 1
  fi
  if ! grep -q '"status":"ok"' /tmp/health.json; then
    echo "FAIL: /health 200 但响应体无 status:ok"
    head -c 300 /tmp/health.json; echo
    return 1
  fi
  head -c 240 /tmp/health.json; echo
  kill "$pid" 2>/dev/null || true
  echo "PROBE_OK=1"
}
`;

type Case = { key: string; image: string; artifactHint: string; script: string };

const CASES: Case[] = [
  {
    key: "deb",
    image: "debian:stable-slim",
    artifactHint: ".deb",
    script: `
set -euo pipefail
apt-get update -qq >/dev/null 2>&1
dpkg -l ca-certificates >/dev/null 2>&1 \\
  && echo "preexisting_ca_certificates=yes" || echo "preexisting_ca_certificates=no"
apt-get install -y -qq --no-install-recommends curl >/dev/null 2>&1
apt-get install -y -qq "/pkg/$PKG" >/dev/null 2>&1
dpkg -s axiom | grep -q '^Depends: ca-certificates' \\
  && echo "deb_depends_field=ok" || { echo "FAIL: control 的 Depends 未生效"; dpkg -s axiom; exit 1; }
test -x /usr/bin/axiom
mkdir -p /work && cd /work
/usr/bin/axiom >/tmp/server.log 2>&1 &
probe $!
`,
  },
  {
    key: "rpm",
    image: "fedora:latest",
    artifactHint: ".rpm",
    script: `
set -euo pipefail
dnf -q install -y curl >/dev/null 2>&1
rpm -ivh "/pkg/$PKG" >/dev/null
rpm -q axiom
# 锁死 %files 回归：包绝不认领 /usr、/usr/bin 这类 filesystem 包所有的目录
if rpm -ql axiom | grep -qxE '/usr|/usr/bin|/usr/share|/usr/share/applications|/usr/share/icons'; then
  echo "FAIL: rpm 声明了系统目录所有权"; rpm -ql axiom; exit 1
fi
echo "rpm_filelist=$(rpm -ql axiom | tr '\\n' ' ')"
mkdir -p /work && cd /work
/usr/bin/axiom >/tmp/server.log 2>&1 &
probe $!
`,
  },
  {
    key: "appimage",
    image: "debian:stable-slim",
    artifactHint: ".AppImage",
    script: `
set -euo pipefail
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null 2>&1
cp "/pkg/$PKG" /tmp/axiom.appimage
chmod +x /tmp/axiom.appimage
cd /tmp && ./axiom.appimage --appimage-extract >/dev/null 2>&1
test -x /tmp/squashfs-root/AppRun || { echo "FAIL: AppRun 缺执行位或不在 AppDir 根"; ls -la /tmp/squashfs-root; exit 1; }
test -f /tmp/squashfs-root/usr/bin/axiom || { echo "FAIL: AppRun 指向的 usr/bin/axiom 不存在"; exit 1; }
cd /tmp/squashfs-root
./AppRun >/tmp/server.log 2>&1 &
probe $!
`,
  },
];

function findArtifact(hint: string, version: string): string {
  const files = readdirSync(OUT).filter((f) => f.endsWith(hint));
  const preferred = files.find((f) => f.includes(version));
  const picked = preferred ?? files[0];
  if (!picked) return "";
  if (statSync(path.join(OUT, picked)).size < 1024) return "";
  return picked;
}

async function runCase(c: Case, pkg: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(
    [
      DOCKER, "run", "--rm",
      "-e", `PKG=${pkg}`,
      "-v", `${OUT}:/pkg:ro`,
      "--entrypoint", "", c.image,
      "bash", "-c", PROBE_FN + c.script,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const killer = setTimeout(() => {
    try { proc.kill(); } catch { /* 容器可能已自行退出 */ }
  }, CASE_TIMEOUT_MS);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(killer);
  const code = await proc.exited;
  const output = `${out}\n${err}`.trim();
  return { ok: code === 0 && output.includes("PROBE_OK=1"), output };
}

async function main(): Promise<number> {
  const version = arg("version", "4.0.0");
  const only = arg("only");
  if (!existsSync(OUT)) {
    console.error(`[smoke:linux] 找不到 ${OUT}，先跑 bun run package:linux`);
    return 1;
  }
  if (Bun.spawnSync([DOCKER, "info", "--format", "{{.ServerVersion}}"]).exitCode !== 0) {
    console.error("[smoke:linux] docker 不可用，无法起干净容器");
    return 1;
  }

  const selected = only ? CASES.filter((c) => c.key === only) : CASES;
  if (!selected.length) {
    console.error(`[smoke:linux] --only=${only} 无匹配，可选：${CASES.map((c) => c.key).join(", ")}`);
    return 1;
  }

  const results: string[] = [];
  let failed = 0;
  for (const c of selected) {
    const pkg = findArtifact(c.artifactHint, version);
    if (!pkg) {
      console.log(`[smoke:linux] ${c.key}: 产物缺失或为空（${c.artifactHint} / ${version}）`);
      results.push(`FAIL ${c.key}  产物缺失`);
      failed++;
      continue;
    }
    console.log(`[smoke:linux] ${c.key}: ${pkg} → ${c.image}`);
    const r = await runCase(c, pkg);
    const lines = r.output.split("\n").filter((l) => l.trim());
    const summary = lines.filter((l) =>
      /=/.test(l) || l.startsWith("FAIL") || l.includes("error") || l.includes("Error"),
    ).slice(-8);
    for (const l of summary) console.log(`    ${l}`);
    if (r.ok) results.push(`PASS ${c.key}  ${pkg}`);
    else {
      results.push(`FAIL ${c.key}  ${pkg}`);
      failed++;
      console.log(`    ── 完整输出尾部 ──\n${lines.slice(-20).map((l) => `    ${l}`).join("\n")}`);
    }
  }

  console.log("\n[smoke:linux] 结果：");
  for (const r of results) console.log("  " + r);
  if (failed) {
    console.error(`[smoke:linux] ${failed}/${selected.length} 个产物未通过`);
    return 1;
  }
  console.log(`[smoke:linux] ${selected.length}/${selected.length} 通过：装得上、起得来、/health 200`);
  return 0;
}

process.exit(await main());
