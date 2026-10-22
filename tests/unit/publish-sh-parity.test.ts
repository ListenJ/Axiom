/**
 * P3.3：publish.sh 与 publish.ps1 对等性（发布可靠性）
 *
 * 背景（交接包 P3.3 + 读码差集）：`scripts/release/publish.sh` 与 `publish.ps1` 同源（同一份
 * 剔除清单、同一 commit-tree 快进模型），但 sh 侧缺两处可靠性步骤：
 *   1. 推送**之前**的发布面自检（verify-publish-surface.mjs）——2026-10-20 事故：发布面剔除
 *      `data/` 后服务自检 critical、E2E 必失败，内部测试发现不了；
 *   2. 推送后复核的**有界重试**——ssh 瞬时失败会让 ls-remote 返回空，单次判断会把已成功的
 *      推送误报为失败。
 *
 * 本文件确保 sh/ps1 不再单边漂移：自检必须先于推送、失败即中止；重试有界且两类错误可区分；
 * 有 bash 时再做 shell 语法检查（Windows 无 bash 则跳过，不伪造通过）。
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dir, "../..");
const SH = path.join(REPO, "scripts/release/publish.sh");
const PS1 = path.join(REPO, "scripts/release/publish.ps1");
const sh = fs.readFileSync(SH, "utf8");

describe("P3.3 publish.sh / publish.ps1 对等性", () => {
  test("发布面自检在推送之前执行，失败即中止（不得推送未自检的发布树）", () => {
    const verifyIdx = sh.indexOf("verify-publish-surface.mjs");
    const pushIdx = sh.indexOf('git push "$REMOTE"');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeLessThan(pushIdx);
    expect(sh).toContain("发布面自检未通过（见上方输出），已中止推送");
  });

  test("推送后复核有界重试，且区分「读取失败（空）」与「读到但不相等」", () => {
    expect(sh).toContain("for attempt in 1 2 3; do");
    expect(sh).toContain("ls-remote 复核未拿到预期结果");
    expect(sh).toContain("推送后校验失败：ls-remote 连续 3 次未返回远端发布头");
    expect(sh).toContain("推送后校验不一致：远端");
    // ps1 同源守卫：若未来只改一边，此断言把漂移变红
    const ps1 = fs.readFileSync(PS1, "utf8");
    expect(ps1).toContain("verify-publish-surface.mjs");
    expect(ps1).toContain("$attempt -le 3");
  });

  test("bash 语法检查（无可用 bash 环境则显式跳过，不伪造通过）", () => {
    const bash = findPosixBash();
    if (!bash) {
      console.log("[skip] 未找到可用 POSIX bash（Windows 的 WSL bash.exe 不算）：跳过 shell 语法检查");
      return;
    }
    const res = spawnSync(bash, ["-n", SH], { encoding: "utf8", timeout: 30_000 });
    expect(res.status, (res.stderr ?? "").slice(0, 2000)).toBe(0);
  }, 30_000);
});

/**
 * 找可用的 POSIX bash：Windows 上 `System32\\bash.exe` 是 WSL 入口（对 Windows 路径行为不可控，
 * 且曾在本仓库环境挂起），因此显式优先项目自带 MinGit / Git for Windows 的 bash；找不到则跳过。
 */
function findPosixBash(): string | null {
  const explicit = process.env.AXIOM_BASH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.platform !== "win32") return "bash";
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [
    path.join(home, ".axiom/tools/mingit/usr/bin/bash.exe"),
    path.join(home, ".axiom/tools/mingit/bin/bash.exe"),
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
