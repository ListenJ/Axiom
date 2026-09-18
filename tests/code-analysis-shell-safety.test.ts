import { describe, test, expect } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getCodeActions,
  getDiagnostics,
  validateFilePathForCommand,
} from "../src/mcp/tools/code-analysis";

/**
 * N-H2（docs/reviews/2026-08-29-joint-verification-audit.md §4）：
 * code-analysis.ts 曾将 filePath 以模板串拼进 shell 命令（:501 未转义、:412 仅转义
 * 双引号——双引号内 $()/反引号仍被 shell 解释），经 shell:true 执行 → 命令注入。
 *
 * 修复（docs/superpowers/specs/2026-08-29-audit-hardening-design.md §1 P0-2）：
 * 1) 全部 executeCommand 调用改 args 数组通道（spawn(file, args) 免 shell）；
 * 2) filePath 先过 存在性 + 扩展名 + 无 shell 元字符 白名单校验，不合法直接返回错误。
 */
const SOURCE = readFileSync(
  join(import.meta.dir, "..", "src", "mcp", "tools", "code-analysis.ts"),
  "utf8",
);

describe("code-analysis N-H2 静态断言", () => {
  test("源码不含 shell: true", () => {
    expect(SOURCE.includes("shell: true")).toBe(false);
  });

  test("所有 executeCommand 调用均为 args 数组形态（无模板串拼接命令）", () => {
    const calls = SOURCE.match(/executeCommand\([^)]*\)/gs) ?? [];
    expect(calls.length).toBe(4); // 现存 4 处调用点：全项目 tsc / 单文件 tsc / 语言 linter / eslint code_actions
    for (const call of calls) {
      expect(call.includes("`")).toBe(false); // 禁止模板串拼命令
      expect(call).toMatch(/args\s*:/); // 必须经 args 数组通道（spawn 免 shell）
    }
  });

  test("源码不含引号转义补丁 replace(/\"/g, ...)（双引号内 $()/反引号仍被解释，属无效转义）", () => {
    expect(SOURCE.includes('replace(/"/g')).toBe(false);
  });
});

describe("code-analysis N-H2 filePath 白名单校验", () => {
  test("shell 元字符（| & ; < > ( ) $ 反引号 换行 引号）全部拒绝", () => {
    const evilPaths = [
      "a$(id).ts",
      "a`id`.ts",
      "a;b.ts",
      "a|b.ts",
      "a&b.ts",
      "a<b.ts",
      "a>b.ts",
      'a"b.ts',
      "a'b.ts",
      "a\nb.ts",
      "a\r\nb.ts",
      "a)b.ts",
      "a(b.ts",
    ];
    for (const evil of evilPaths) {
      expect(validateFilePathForCommand(evil)).toContain("metacharacters");
    }
  });

  test("合法存在的 .ts 文件通过（不误伤）", () => {
    const dir = join(process.cwd(), ".tmp");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "nh2-ok.ts");
    writeFileSync(f, "export const ok: number = 1;\n");
    expect(validateFilePathForCommand(f)).toBeNull();
  });

  test("不存在的文件拒绝（存在性校验）", () => {
    expect(
      validateFilePathForCommand(join(process.cwd(), ".tmp", "nh2-missing-xyz.ts")),
    ).toContain("not exist");
  });

  test("扩展名不在白名单拒绝（.md 非 LANG_MAP 成员）", () => {
    expect(validateFilePathForCommand("README.md")).toContain("extension");
  });
});

describe("code-analysis N-H2 行为：恶意 filePath 返回错误而非执行", () => {
  test("getCodeActions：filePath 含 $(...) 返回错误而非执行", async () => {
    const r = await getCodeActions("x$(calc).ts");
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  }, 30000);

  test("getDiagnostics：元字符 filePath 全部拒绝执行", async () => {
    for (const evil of ["a`id`.ts", "a|b.ts", "a;b.ts"]) {
      const r = await getDiagnostics(evil);
      expect(r.success).toBe(false);
      expect(r.error).toBeTruthy();
    }
  }, 60000);

  test("getDiagnostics：不存在的 .ts 文件拒绝（存在性校验）", async () => {
    const r = await getDiagnostics(join(process.cwd(), ".tmp", "nh2-missing-abc.ts"));
    expect(r.success).toBe(false);
    expect(r.error).toContain("not exist");
  }, 30000);

  test("getDiagnostics：.txt 扩展名拒绝（扩展名白名单）", async () => {
    const r = await getDiagnostics("notes.txt");
    expect(r.success).toBe(false);
    expect(r.error).toContain("extension");
  }, 30000);

  test("getCodeActions：合法 .ts 文件不因校验被误拒（照常走 lint 流程）", async () => {
    const dir = join(process.cwd(), ".tmp");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "nh2-actions-ok.ts");
    writeFileSync(f, "function greet(name) { return 'hi ' + name; }\n");
    const r = await getCodeActions(f);
    // 校验通过后进入 lint：无论 eslint 是否产出建议，都不得以校验错误失败
    expect(r.success).toBe(true);
  }, 30000);
});
