/**
 * 发布树静态核验 —— 新鲜度 / PE 位数 / CHECKSUMS 覆盖。
 *
 * 存在理由（2026-09-24 实测）：`dist/bun/windows/x64/` 里 `axiom-cli.exe` 与 `axiom-mcp.exe`
 * 是 2026-08-08 的产物，而同一目录下的 `axiom-server.exe` 是 09-23 的；`CHECKSUMS.txt`
 * 把三份一起列出、逐字可对 ⇒ "产物在清单上"与"产物是当前代码编出来的"是两件事。
 * 这条不查，发布说明里的"已构建"就只是关于文件名的事实，不是关于代码版本的事实。
 *
 * 用法：
 *   bun run scripts/build/verify-artifacts.ts            # 三项静态检查
 *   bun run scripts/build/verify-artifacts.ts --hash     # 另外逐字节校 sha256（读全盘，慢）
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const DIST = path.join(repoRoot, "dist");
const wantHash = process.argv.includes("--hash");

function newestSourceCommitUnix(forPath: string): number {
  const r = spawnSync("git", ["log", "-1", "--format=%ct", "--", forPath], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`git 不可用或该路径无提交：${forPath} —— ${r.stderr || r.stdout}`);
  return Number(r.stdout.trim());
}

/**
 * 每个产物家族按"真正产出它的那棵树"计新鲜度。
 * 一视同仁地拿 src/ 去比会把 runtime-go/ 的 8 份 Go 产物永远判红 —— 它们不读 src/，
 * 一条会误报的门很快就会被下一个人当噪声忽略。
 */
const FAMILY_SOURCE: Record<string, string> = { bun: "src/", pkg: "src/", go: "runtime-go/" };

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 交付物 = dist 下这三族的文件；构建中间产物（dist/src、dist/tests、dist/main.js）不在内。 */
function deliverables(): string[] {
  return ["bun", "go", "pkg"]
    .flatMap((sub) => walk(path.join(DIST, sub)))
    .filter((p) => fs.statSync(p).size > 0);
}

// ── ① 新鲜度 ────────────────────────────────────────────────────────────────
const baseline = new Map<string, number>();
const stale: { rel: string; ageH: string }[] = [];
for (const f of deliverables()) {
  if (path.basename(f) === "CHECKSUMS.txt") continue;
  const rel = path.relative(DIST, f).replace(/\\/g, "/");
  const srcOf = FAMILY_SOURCE[rel.split("/")[0]];
  if (!srcOf) continue;
  if (!baseline.has(srcOf)) baseline.set(srcOf, newestSourceCommitUnix(srcOf));
  const at = baseline.get(srcOf)!;
  const m = fs.statSync(f).mtimeMs / 1000;
  if (m < at) stale.push({ rel, ageH: ((at - m) / 3600).toFixed(1) });
}

// ── ② PE 位数 ───────────────────────────────────────────────────────────────
const PE_EXPECT: Record<string, { machine: number; magic: number; label: string }> = {
  "windows/x64": { machine: 0x8664, magic: 0x20b, label: "PE32+" },
  "windows/386": { machine: 0x14c, magic: 0x10b, label: "PE32" },
};
const peBad: string[] = [];
for (const f of deliverables()) {
  const rel = path.relative(DIST, f).replace(/\\/g, "/");
  const key = rel.startsWith("go/") ? rel.slice(3).replace(/\/[^/]+\.exe$/, "") : rel.replace(/^bun\//, "").replace(/\/[^/]+\.exe$/, "");
  const expect = PE_EXPECT[key];
  if (!expect || !rel.endsWith(".exe")) continue;
  const fd = fs.openSync(f, "r");
  const buf = Buffer.alloc(1024);
  fs.readSync(fd, buf, 0, 1024, 0);
  fs.closeSync(fd);
  const lfa = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(lfa) !== 0x00004550) { peBad.push(`${rel}: 不是 PE（无 "PE\\0\\0" 签名）`); continue; }
  const machine = buf.readUInt16LE(lfa + 4);
  const magic = buf.readUInt16LE(lfa + 24);
  if (machine !== expect.machine || magic !== expect.magic) {
    peBad.push(`${rel}: 期望 ${expect.label}(0x${expect.machine.toString(16)}/0x${expect.magic.toString(16)})，实得 0x${machine.toString(16)}/0x${magic.toString(16)}`);
  }
}

// ── ③ CHECKSUMS 覆盖 ────────────────────────────────────────────────────────
const sumsPath = path.join(DIST, "CHECKSUMS.txt");
const listed = new Map<string, string>();
if (fs.existsSync(sumsPath)) {
  for (const line of fs.readFileSync(sumsPath, "utf8").split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (m) listed.set(m[2].replace(/^\.\//, "").replace(/\\/g, "/"), m[1]);
  }
}
const present = deliverables().map((f) => path.relative(DIST, f).replace(/\\/g, "/"));
const untracked = present.filter((rel) => !listed.has(rel));
const phantom = [...listed.keys()].filter((rel) => !fs.existsSync(path.join(DIST, rel)));

const hashMismatch: string[] = [];
if (wantHash) {
  for (const [rel, want] of listed) {
    const abs = path.join(DIST, rel);
    if (!fs.existsSync(abs)) continue;
    const got = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    if (got !== want) hashMismatch.push(`${rel}: 清单 ${want.slice(0, 12)}… 实得 ${got.slice(0, 12)}…`);
  }
}

// ── 结论 ────────────────────────────────────────────────────────────────────
const fail: string[] = [];
if (stale.length) fail.push(`过期产物 ${stale.length} 份（各家族基线：${[...baseline].map(([k, v]) => `${k}=${new Date(v * 1000).toISOString()}`).join(" ")}）：\n  ${stale.slice(0, 12).map((s) => `${s.rel} 落后 ${s.ageH}h`).join("\n  ")}`);
if (peBad.length) fail.push(`PE 位数与路径声称不符 ${peBad.length} 份：\n  ${peBad.join("\n  ")}`);
if (untracked.length) fail.push(`未列入 CHECKSUMS 的产物 ${untracked.length} 份：\n  ${untracked.join("\n  ")}`);
if (phantom.length) fail.push(`CHECKSUMS 里指向不存在文件的条目 ${phantom.length} 份：\n  ${phantom.join("\n  ")}`);
if (hashMismatch.length) fail.push(`sha256 不匹配 ${hashMismatch.length} 份：\n  ${hashMismatch.join("\n  ")}`);

console.log(`[verify-artifacts] 交付物 ${present.length} 份；CHECKSUMS 列 ${listed.size} 条；${wantHash ? "已逐字节校 sha256" : "未校 sha256（--hash 开启）"}`);
if (!fail.length) {
  console.log("[verify-artifacts] OK —— 全部产物不早于 src/ 最新提交，PE 位数与路径一致，清单与磁盘双向一致");
  process.exit(0);
}
console.error(`[verify-artifacts] FAIL ${fail.length} 项：\n- ${fail.join("\n- ")}`);
process.exit(1);
