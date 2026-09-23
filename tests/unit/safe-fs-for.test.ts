/**
 * ADR-007 C-1：`safeFsFor` 薄工厂。
 *
 * 工厂的契约只有一条：**它是转发，不是判定**。
 *   - 不新增任何路径解析/比较逻辑（由 tests 的结构断言锁住）；
 *   - 根必须位于沙箱之内（safe-fs 的 effectiveRoots 只接受收窄值），
 *     否则构造期即抛 ConfigError —— 既不放行也不静默拒绝写入。
 * 判定结论必须与直接调 authorizePath 逐条相同（用同一批语料对照）。
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { safeFsFor, SafeFsRootConfigError } from "../../src/utils/safe-fs-for.js";
import { authorizePath, CapabilityDeniedError } from "../../src/utils/safe-fs.js";

const cwd = process.cwd();
const corpus = [
  "notes/ok.txt",
  "data/skill-quality.json",
  ".env",
  path.join(cwd, ".git", "config"),
  path.join(cwd, "data", "agent.db"),
  path.join(cwd, ".ssh", "id_rsa"),
  "../outside.txt",
  process.platform === "win32" ? "C:/Windows/System32/cmd.exe" : "/etc/passwd",
];

describe("safeFsFor —— 结论与 authorizePath 逐条相同", () => {
  const bound = safeFsFor({ roots: [path.join(cwd, "data")], capability: "fs.write", label: "skill-quality" });
  for (const target of corpus) {
    it(`${target.slice(0, 48)} 两侧一致`, () => {
      const verdict = (fn: () => unknown) => {
        try {
          fn();
          return "ALLOW";
        } catch (e) {
          if (e instanceof CapabilityDeniedError || e instanceof SafeFsRootConfigError) return "DENY";
          return `ERR:${(e as Error).name}`;
        }
      };
      expect(verdict(() => bound.assertAllowed(target))).toBe(
        verdict(() => authorizePath(target, "fs.write", { roots: [path.join(cwd, "data")] })),
      );
    });
  }
});

describe("safeFsFor —— 根与拒绝语义", () => {
  it("沙箱内的根：允许其内路径", () => {
    const bound = safeFsFor({ roots: [path.join(cwd, "data")], capability: "fs.write", label: "t" });
    // 注意语义：相对 target 由 safe-fs 相对**沙箱根(cwd)**解析，不是相对绑定的 root。
    // 绑定根只定义"允许区"，不改变入参基准 ⇒ 写点传绝对路径或相对 cwd 的路径均可。
    expect(() => bound.assertAllowed("data/model-output/x.json")).not.toThrow();
    expect(() => bound.assertAllowed(path.join(cwd, "data", "model-output", "x.json"))).not.toThrow();
  });

  it("超出该根的合法路径被拒（工厂按绑定的 roots 收窄，不放宽）", () => {
    const bound = safeFsFor({ roots: [path.join(cwd, "data")], capability: "fs.write", label: "t" });
    expect(() => bound.assertAllowed("notes/ok.txt")).toThrow(CapabilityDeniedError);
  });

  it("根本身越界 ⇒ 构造期抛 SafeFsRootConfigError（不静默放行、不静默拒写）", () => {
    expect(() =>
      safeFsFor({ roots: [process.platform === "win32" ? "C:/Windows" : "/etc"], capability: "fs.write", label: "t" }),
    ).toThrow(SafeFsRootConfigError);
  });

  it("消息带 label，便于上层日志定位是哪一处写点配错", () => {
    try {
      safeFsFor({ roots: [process.platform === "win32" ? "C:/Windows" : "/etc"], capability: "fs.write", label: "vault-manager" });
      expect.unreachable("应当抛出");
    } catch (e) {
      expect((e as Error).message).toContain("vault-manager");
    }
  });

  it("结构契约：工厂源码内不得出现任何自己的路径判定原语", () => {
    const src = fs.readFileSync("src/utils/safe-fs-for.ts", "utf8");
    for (const forbidden of ["realpathSync", "startsWith(\"..\")", "path.relative", "path.isAbsolute", "lstat"]) {
      expect(src).not.toContain(forbidden);
    }
    // 唯一允许的形态：转调 safe-fs 的判定
    expect(src).toMatch(/from "\.\/safe-fs/);
  });
});
