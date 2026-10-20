/**
 * R2-B skill 文件写入的执行点强制（S3 / I2）
 *
 * `saveSkillFile` 原先是裸 `fs.mkdirSync` + `fs.writeFileSync`（`src/skills/skill-loader.ts`），
 * 目标只被 `resolveSkillPath` 的字符串 `path.relative` 约束。该判定不看 realpath：
 * skill 目录里放一条指向执行锚点的符号链接，写入就落到锚点上 —— 与 S-3 已断言过的
 * 「字符串前缀判定会被骗过」是同一形态。本文件证明执行点本身会拒（不依赖调用期守卫）。
 */
import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { saveSkillFile, createSkillFileBoilerplate } from "../../src/skills/skill-loader.js";

/**
 * E1 平台能力缺失（设计稿 §3）：Windows 默认（非开发者模式）进程没有
 * `SeCreateSymbolicLinkPrivilege`，`symlinkSync` 恒 EPERM —— POSIX 符号链接语义在
 * Windows 上原理上不可满足，不是被测代码的缺陷。
 *
 * 处置分两种，都不隐藏信号：
 *   - 夹具按平台门控建链（Linux 上仍强制建，失败即红，不降级为 catch 忽略）；
 *   - 只有**依赖该链接**的那条用例 `skipIf` 跳过（标题带理由、报告可见）。
 * 另外两条用例的断言（绝对路径被拒 / 沙箱内正常文件可写）不依赖链接，Windows 上照跑。
 */
const NO_SYMLINK = process.platform === "win32";

/** 造一个沙箱：skill 目录 + 一个 CI 工作流锚点文件，并让 skill 目录里的 .yml 指向该锚点 */
function makeSandbox(): { root: string; anchor: string } {
  const root = path.join(tmpdir(), `axiom-skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(path.join(root, "skills"), { recursive: true });
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  const anchor = path.join(root, ".github", "workflows", "ci.yml");
  writeFileSync(anchor, ANCHOR_ORIGINAL, "utf-8");
  if (!NO_SYMLINK) symlinkSync(anchor, path.join(root, "skills", "escape.yml"));
  return { root, anchor };
}

const ANCHOR_ORIGINAL = "name: original\non: [push]\n";

/** 拒绝可能以同步 throw 或异步 rejection 呈现，两者都要捕获，否则红信号是类型假象而非真实症状 */
async function attemptSave(filePath: string): Promise<string | null> {
  try {
    await saveSkillFile(filePath, createSkillFileBoilerplate({ name: "pwn", description: "d" }));
    return null;
  } catch (err) {
    return (err as Error).message ?? String(err);
  }
}

async function inSandbox<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(saved);
    rmSync(root, { recursive: true, force: true });
  }
}

describe("R2-B saveSkillFile 在执行点拒绝锚点写入", () => {
  test.skipIf(NO_SYMLINK)("经 skill 目录内的符号链接写执行锚点：锚点内容不变（skip：Windows 无符号链接权限）", async () => {
    const { root, anchor } = makeSandbox();
    await inSandbox(root, async () => {
      const reason = await attemptSave("skills/escape.yml");
      expect(readFileSync(anchor, "utf-8")).toBe(ANCHOR_ORIGINAL);
      expect(reason).not.toBeNull();
      expect(reason).toMatch(/denied:|anchor|锚点|workflows/i);
    });
  });

  test("沙箱外绝对路径同样被拒（不靠调用方的白名单字符串判定）", async () => {
    const { root } = makeSandbox();
    const outside = path.join(tmpdir(), `axiom-outside-${Date.now()}.yml`);
    await inSandbox(root, async () => {
      const reason = await attemptSave(outside);
      expect(existsSync(outside)).toBe(false);
      expect(reason).toMatch(/denied:/);
    });
    rmSync(outside, { force: true });
  });

  test("沙箱内普通 skill 文件可写（红线：不误伤正常路径）", async () => {
    const { root } = makeSandbox();
    await inSandbox(root, async () => {
      const reason = await attemptSave("skills/new.yml");
      expect(reason).toBeNull();
      expect(existsSync(path.join(root, "skills", "new.yml"))).toBe(true);
    });
  });
});
