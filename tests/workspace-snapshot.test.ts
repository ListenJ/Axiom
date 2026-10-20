/**
 * 快照还原的锚点防线（S3 / P1 / L1）
 *
 * snapshot_revert 的落点来自 `git ls-tree`，是外部可控输入：若快照树里有一条
 * `.env` / `.github/workflows/*.yml` / `data/*.db`，还原即把它们写回工作区 ——
 * 这正是"写下下一次执行的内容"这一跳。断言：普通文件恢复，锚点文件一律拒写。
 */
import { describe, test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { canInitGitRepo } from "./helpers/env-probe";

const GIT_CFG = ["-c", "user.email=axiom@local", "-c", "user.name=Axiom"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...GIT_CFG, ...args], { cwd, encoding: "utf-8", stdio: "pipe" });
}

describe.skipIf(!canInitGitRepo())("snapshot_revert 不得写回执行锚点（skip：本机 git 无法创建仓库，E1 环境能力缺失）", () => {
  test("普通文件恢复，.env / CI 工作流拒写", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "axiom-snap-"));
    const snapshotDir = path.join(sandbox, ".axiom", "snapshots");
    mkdirSync(snapshotDir, { recursive: true });

    git(snapshotDir, ["init", "-q"]);
    writeFileSync(path.join(snapshotDir, "restored.txt"), "hello");
    writeFileSync(path.join(snapshotDir, ".env"), "AXIOM_SECRET=leaked\n");
    mkdirSync(path.join(snapshotDir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      path.join(snapshotDir, ".github", "workflows", "ci.yml"),
      "name: pwn\non: [push]\njobs: { x: { runs-on: ubuntu-latest } }\n",
    );
    git(snapshotDir, ["add", "-A", "-f"]);
    git(snapshotDir, ["commit", "-q", "-m", "snapshot with anchors"]);
    const snapshotId = git(snapshotDir, ["rev-parse", "HEAD"]).trim();

    const saved = process.cwd();
    process.chdir(sandbox);
    try {
      const { revertSnapshot } = await import("../src/mcp/tools/workspace-snapshot.js");
      const result = await revertSnapshot(snapshotId);

      expect(existsSync(path.join(sandbox, "restored.txt"))).toBe(true);
      expect(readFileSync(path.join(sandbox, "restored.txt"), "utf-8")).toBe("hello");
      // 锚点文件必须缺席：还原不得成为写锚点的旁路
      expect(existsSync(path.join(sandbox, ".env"))).toBe(false);
      expect(existsSync(path.join(sandbox, ".github", "workflows", "ci.yml"))).toBe(false);
      // 锚点拒写按整改 D5 的契约上报（任一文件未落盘即 success:false，并把落点聚合进 errors），
      // 不静默吞掉 —— 调用方必须看得见"这个快照里有还原不了的文件"。
      expect(result.success).toBe(false);
      expect(result.errors).toEqual([".env", ".github/workflows/ci.yml"]);
    } finally {
      process.chdir(saved);
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);

  test("快照采集不把锚点文件复制进快照树（凭据不被二次落地）", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "axiom-snap2-"));
    // ensureSnapshotRepo 不负责建目录，生产上 .axiom 由启动流程准备；测试按同一前置条件准备
    const snapRoot = path.join(sandbox, ".axiom", "snapshots");
    mkdirSync(snapRoot, { recursive: true });
    // getWorkspaceFiles 依赖 `git ls-files`，工作区必须是仓库（否则恒返回空清单）
    git(sandbox, ["init", "-q"]);
    writeFileSync(path.join(sandbox, "package.json"), '{"name":"x"}\n');
    writeFileSync(path.join(sandbox, ".env"), "AXIOM_SECRET=leaked\n");
    mkdirSync(path.join(sandbox, "data"), { recursive: true });
    writeFileSync(path.join(sandbox, "data", "agent.db"), "binary-ish\n");

    const saved = process.cwd();
    process.chdir(sandbox);
    try {
      const { createSnapshot } = await import("../src/mcp/tools/workspace-snapshot.js");
      const result = await createSnapshot("collect");
      expect(result.success).toBe(true);
      expect(existsSync(path.join(snapRoot, "package.json"))).toBe(true);
      expect(existsSync(path.join(snapRoot, ".env"))).toBe(false);
      expect(existsSync(path.join(snapRoot, "data", "agent.db"))).toBe(false);
    } finally {
      process.chdir(saved);
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
