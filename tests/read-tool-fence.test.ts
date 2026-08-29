/**
 * P0-1 read/write 工具路径围栏测试（审计 N-H1，2026-08-29）
 *
 * 语义对齐 src/mcp/tools/filesystem.ts isPathSafe 守卫：
 *   - cwd 限制（越界拒绝）
 *   - 沙箱内敏感区域拒绝（.env / .git / 运行时数据库）
 *   - symlink realpath 校验
 * 红线：cwd 内合法文件（含 vault 回退）读取不受影响
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

const LEGAL_DIR = ".tmp-tool-fence";
const LEGAL_FILE = `${LEGAL_DIR}/legal.txt`;
const ESCAPE_TMP = nodePath.join(os.tmpdir(), "fence-escape-probe.txt");

afterAll(async () => {
  await rm(LEGAL_DIR, { recursive: true, force: true });
  await rm(ESCAPE_TMP, { force: true });
});

describe("[P0-1] readTool 路径围栏", () => {
  it("读 cwd 内 .env 被拒（错误含敏感语义，内容不外泄）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-env-read");
    await expect(
      readTool.execute({ payload: { source: "file", path: ".env" }, context: ctx }),
    ).rejects.toThrow(/denied area|sensitive|blocked|密钥/i);
  });

  it("读 cwd 内 .env.* 变体被拒", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-env-variant");
    await expect(
      readTool.execute({ payload: { source: "file", path: ".env.local" }, context: ctx }),
    ).rejects.toThrow(/denied area|sensitive|blocked|密钥/i);
  });

  it("读 cwd 外相对路径（../ 穿越）被拒（path outside workspace 语义）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-traversal");
    await expect(
      readTool.execute({ payload: { source: "file", path: "../../etc/passwd" }, context: ctx }),
    ).rejects.toThrow(/escapes working directory|outside|denied/i);
  });

  it("读 cwd 内合法临时文件通过（红线：合法读不误伤）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    await mkdir(LEGAL_DIR, { recursive: true });
    await writeFile(LEGAL_FILE, "legal-content-marker", "utf-8");
    const ctx = createToolContext("fence-legal-read");
    const result = await readTool.execute({
      payload: { source: "file", path: LEGAL_FILE },
      context: ctx,
    });
    expect(result.data.content).toContain("legal-content-marker");
  });

  it("cwd 内 vault 回退读不被围栏误伤（红线）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-vault-read");
    ctx.localStore.set("vaultManager", {
      readNote: (p: string) => ({ content: `vault-note:${p}`, frontmatter: {} }),
    });
    const result = await readTool.execute({
      payload: { source: "file", path: "axiom-memory/fence-nonexistent-note.md" },
      context: ctx,
    });
    expect(result.data.content).toContain("vault-note:");
  });
});

describe("[P0-1] writeTool 路径围栏", () => {
  it("写 cwd 外绝对路径被拒（不落盘）", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-escape-write");
    await expect(
      writeTool.execute({
        payload: { target: "file", path: ESCAPE_TMP, content: "should-not-exist" },
        context: ctx,
      }),
    ).rejects.toThrow(/escapes working directory|outside|denied/i);
  });

  it("写 cwd 内合法路径通过（红线：合法写不误伤）", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-legal-write");
    const result = await writeTool.execute({
      payload: { target: "file", path: `${LEGAL_DIR}/written.txt`, content: "ok" },
      context: ctx,
    });
    expect(result.data.bytesWritten).toBe(2);
  });
});

describe("[P0-1] permissions 敏感路径拦截纳入 read", () => {
  it("read .env 被拦（连读都拒）", async () => {
    const { checkFilePermission } = await import("../src/utils/permissions.js");
    const check = checkFilePermission(".env", "read");
    expect(check.allowed).toBeFalse();
    expect(check.reason).toMatch(/sensitive|敏感/i);
  });

  it("read 合法路径不受影响", async () => {
    const { checkFilePermission } = await import("../src/utils/permissions.js");
    expect(checkFilePermission("src/app.ts", "read").allowed).toBeTrue();
    expect(checkFilePermission("data/notes.md", "read").allowed).toBeTrue();
  });

  it("write/delete 敏感路径拦截保持不变（回归）", async () => {
    const { checkFilePermission } = await import("../src/utils/permissions.js");
    expect(checkFilePermission(".env", "write").allowed).toBeFalse();
    expect(checkFilePermission(".ssh/id_rsa", "delete").allowed).toBeFalse();
  });
});
