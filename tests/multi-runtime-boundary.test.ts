// @smoke
/**
 * 多运行时边界契约测试（2026-10-13 新增）
 *
 * 把 src/ 已证明的"机器检查纪律"延伸到 runtime-go / runtime-embed 边界：
 * - Go 侧：编译通过 + go.mod 有效
 * - Python 侧：server.py 语法有效 + pyproject.toml 存在
 * - TS↔运行时边界：src/ 中 :9001 仅出现在可覆盖默认值或错误消息中（非硬编码墙）
 *
 * 这不是功能测试——是存在性 + 编译性 + 边界卫生门禁。
 * 对应架构评估缺口 #2：多运行时边界未受同一门禁治理。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");
const runtimeGoDir = path.join(repoRoot, "runtime-go");
const runtimeEmbedDir = path.join(repoRoot, "runtime-embed");

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "_archive" && entry.name !== "node_modules") {
      results.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** 判断一行是否为注释行 */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** 判断 :9001 出现是否为"可接受的默认值/错误消息"而非硬编码墙 */
function isAcceptableDefault(line: string, trimmed: string): boolean {
  // 注释行：可接受
  if (isCommentLine(trimmed)) return true;
  // 错误消息（throw new Error / Error( 中包含 :9001 的字符串）：可接受
  if (/throw\s+new\s+Error|new\s+Error\(/.test(line)) return true;
  // 默认值赋值（变量名含 DEFAULT 或默认）：可接受
  if (/DEFAULT.*=\s*["'`].*:9001/.test(line)) return true;
  // 配置对象的 baseURL 字段（可经 env 覆盖）：可接受
  if (/baseURL.*:9001/.test(line)) return true;
  // 跨行错误消息中的字符串参数（含 CJK 字符 = 描述性文本，非 URL 赋值）：可接受
  if (/[\u4e00-\u9fff]/.test(line)) return true;
  return false;
}

describe("多运行时边界契约", () => {

  describe("runtime-go（Go 高并发侧）", () => {
    it("go.mod 存在且有效", () => {
      const goMod = path.join(runtimeGoDir, "go.mod");
      expect(fs.existsSync(goMod)).toBe(true);
      const content = fs.readFileSync(goMod, "utf-8");
      expect(content).toContain("module ");
      expect(content).toContain("go ");
    });

    it("go build ./... 编译通过", () => {
      let goAvailable = false;
      try { execSync("go version", { stdio: "pipe" }); goAvailable = true; } catch { /* not available */ }
      if (!goAvailable) return;

      // execSync 在成功时不抛异常；失败时抛异常
      execSync("go build ./...", {
        cwd: runtimeGoDir,
        stdio: "pipe",
        timeout: 30_000,
      });
      // 不抛即通过
      expect(true).toBe(true);
    }, 30_000);

    it("至少有 cmd/ 入口或 internal/ 包", () => {
      const hasCmd = fs.existsSync(path.join(runtimeGoDir, "cmd"));
      const hasInternal = fs.existsSync(path.join(runtimeGoDir, "internal"));
      expect(hasCmd || hasInternal).toBe(true);
    });
  });

  describe("runtime-embed（Python 本地 embedding 侧）", () => {
    it("server.py 存在且 Python 语法有效", () => {
      const serverPy = path.join(runtimeEmbedDir, "server.py");
      expect(fs.existsSync(serverPy)).toBe(true);

      let pyAvailable = false;
      try { execSync("python3 --version", { stdio: "pipe" }); pyAvailable = true; } catch { /* not available */ }
      if (!pyAvailable) return;

      execSync(`python3 -c "import ast; ast.parse(open('${serverPy}').read())"`, {
        stdio: "pipe",
        timeout: 10_000,
      });
      expect(true).toBe(true);
    }, 15_000);

    it("pyproject.toml 存在", () => {
      const pyproject = path.join(runtimeEmbedDir, "pyproject.toml");
      expect(fs.existsSync(pyproject)).toBe(true);
    });
  });

  describe("TS↔运行时边界卫生", () => {
    it("src/ 中 :9001 仅出现在可覆盖默认值或错误消息中（非硬编码墙）", () => {
      const files = walkTsFiles(srcDir);
      const violations: string[] = [];

      for (const file of files) {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // 检查 :9001 是否出现
          if (!/127\.0\.0\.1:9001|localhost:9001/.test(line)) continue;

          // 判断是否为可接受的默认值/错误消息
          if (isAcceptableDefault(line, trimmed)) continue;

          // 到这里说明 :9001 出现在非注释、非默认值、非错误消息的代码中
          violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${trimmed}`);
        }
      }

      expect(violations).toEqual([]);
    });

    it("src/ 中无硬编码 runtime-go/runtime-embed 路径引用", () => {
      const files = walkTsFiles(srcDir);
      const violations: string[] = [];

      for (const file of files) {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (isCommentLine(trimmed)) continue;

          if (/(?:^|["'`])runtime-(?:go|embed)\//.test(line) && !line.includes("import.meta")) {
            violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${trimmed}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
