/**
 * workspace-snapshot 回归测试
 *  - P1-T5：snapshotId 白名单校验（仅 HEAD 或 6-64 位十六进制）。
 *  - 整改 D5（2026-08-25）：restore 二进制保真（Buffer 写盘逐字节相等）+
 *    部分失败聚合（任一文件失败 → success:false + errors 含失败路径）。
 */

import { describe, test, expect, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertValidSnapshotId,
  revertSnapshot,
} from "../../src/mcp/tools/workspace-snapshot.js";

describe("assertValidSnapshotId（P1-T5）", () => {
  test("合法值放行：HEAD 与十六进制哈希", () => {
    expect(() => assertValidSnapshotId("HEAD")).not.toThrow();
    expect(() => assertValidSnapshotId("abc123def4567890")).not.toThrow();
    expect(() => assertValidSnapshotId("ABCDEF")).not.toThrow();
  });
  test("非法值拒绝：git 选项、shell 元字符、过短/非法字符", () => {
    expect(() => assertValidSnapshotId("--output=/tmp/x")).toThrow();
    expect(() => assertValidSnapshotId("main;rm -rf /")).toThrow();
    expect(() => assertValidSnapshotId("abc")).toThrow(); // <6 位
    expect(() => assertValidSnapshotId("../../etc")).toThrow();
    expect(() => assertValidSnapshotId("")).toThrow();
  });
});

// ── 整改 D5：restore 二进制保真 + 部分失败聚合 ─────────────────────────

const ORIGINAL_CWD = process.cwd();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
}

/** 在临时目录构造 .axiom/snapshots 快照仓库并提交给定文件，返回 (workspaceDir, shortHash) */
function makeSnapshotRepo(files: Record<string, Buffer | string>): { ws: string; hash: string } {
  const ws = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wsnap-d5-")), "ws");
  const snap = path.join(ws, ".axiom", "snapshots");
  fs.mkdirSync(snap, { recursive: true });
  git(snap, ["init"]);
  git(snap, ["config", "user.email", "axiom@local"]);
  git(snap, ["config", "user.name", "Axiom"]);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(snap, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(snap, ["add", "-A"]);
  git(snap, ["commit", "-m", "fixture", "--allow-empty"]);
  return { ws, hash: git(snap, ["rev-parse", "--short", "HEAD"]).trim() };
}

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("revertSnapshot 二进制保真（整改 D5）", () => {
  test(
    "含 0xFF/0x00 等二进制字节的文件 restore 后逐字节相等",
    async () => {
      const binary = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x41, 0x0a, 0x00, 0xd8, 0x3c, 0xff]);
      const { ws, hash } = makeSnapshotRepo({ "bin.dat": binary });
      process.chdir(ws);

      const result = await revertSnapshot(hash);
      expect(result.success).toBe(true);

      const restored = fs.readFileSync(path.join(ws, "bin.dat"));
      expect(restored.length).toBe(binary.length);
      expect(Buffer.compare(restored, binary)).toBe(0);
    },
    30000
  );
});

describe("revertSnapshot 部分失败聚合（整改 D5）", () => {
  test(
    "两文件其一写入失败 → success:false 且 errors 含失败路径；另一文件仍恢复",
    async () => {
      const { ws, hash } = makeSnapshotRepo({
        "a.txt": "hello",
        "sub/blocked.txt": "blocked-content",
      });
      // 预置同名目录使 writeFile 必然失败（EISDIR/EEXIST）
      fs.mkdirSync(path.join(ws, "sub", "blocked.txt"), { recursive: true });
      process.chdir(ws);

      const result = await revertSnapshot(hash);
      expect(result.success).toBe(false);
      expect(Array.isArray(result.errors)).toBe(true);
      expect((result.errors ?? []).some((p) => p.includes("blocked.txt"))).toBe(true);
      // 未失败的文件照常恢复
      expect(fs.readFileSync(path.join(ws, "a.txt"), "utf-8")).toBe("hello");
    },
    30000
  );
});
