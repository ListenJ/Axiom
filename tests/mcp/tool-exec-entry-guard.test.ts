/**
 * R2-A 并列执行入口必须过同一守卫（S3 / I1、I2 的接线侧）
 *
 * 实测缺陷：工具面除了经 `ToolRegistry.add()` 注册（handler 被守卫包裹）之外，还存在
 * 两条**直接调用 `tool.handler(args)`** 的并列入口 ——
 *   - `src/routes/chat.ts` 的 `buildChatToolConfig().executeTool`（原生 function-calling）
 *   - `src/mcp/server/skill-tools.ts` 的 `runSkillTool`（被 chat 与 openai-compat 当作 executeTool）
 * 于是 HardFloor、双层复核、I4 序列复核、强制审批在这两条路径上全部不存在。
 * 本文件锁三件事：注册表提供唯一派发接缝；skill 直调路径确实被锚点规则拦下；
 * 源码里不再出现绕过接缝的 `*.handler(` 直调。
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ToolRegistry } from "../../src/mcp/tool-registry.js";
import { runSkillTool } from "../../src/mcp/server/skill-tools.js";

function surface(name: string, capability: readonly string[], onRun: () => void) {
  return {
    name,
    description: "probe",
    capability,
    inputSchema: {},
    handler: async () => {
      onRun();
      return { ok: true };
    },
  };
}

describe("R2-A1 注册表派发接缝（ToolRegistry.execute）", () => {
  test("execute 走 add() 装好的守卫：守卫拒绝则处理体不执行", async () => {
    const registry = new ToolRegistry({
      guard: async () => {
        throw new Error("[TestGuard] blocked");
      },
    });
    let executed = false;
    registry.add(surface("probe_write", ["fs.write"], () => (executed = true)) as never);

    await expect(registry.execute("probe_write", { path: "a.txt" })).rejects.toThrow(/TestGuard/);
    expect(executed).toBe(false);
  });

  test("execute 未知工具名直接抛错（不静默返回 undefined）", async () => {
    const registry = new ToolRegistry({ guard: async () => {} });
    await expect(registry.execute("nope", {})).rejects.toThrow(/Unknown tool/);
  });
});

describe("R2-A2 skill 直调路径不得绕过守卫", () => {
  test("runSkillTool 用锚点路径创建 skill 被拒且不落盘", async () => {
    // 期望：派发经过 defaultToolGuard 的 HardFloor —— `.env` 是执行锚点，连读都拒，写更拒
    await expect(
      runSkillTool("skill_create", {
        filePath: ".env",
        name: "escalation-probe",
        description: "R2-A 回归探针",
      }),
    ).rejects.toThrow(/HardFloor|anchor|锚点|sensitive|敏感/i);
    expect(existsSync(join("skills", ".env"))).toBe(false);
  });
});

describe("R2-A3 静态门：并列入口不得复发", () => {
  test("src 内不存在绕过注册表的工具面 handler 直调", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) out.push(...walk(abs));
        else if (/\.(ts|js)$/.test(name)) out.push(abs);
      }
      return out;
    };
    for (const rel of [...walk("src/routes"), ...walk("src/services"), ...walk("src/mcp/server")]) {
      const lines = readFileSync(rel, "utf-8").split("\n");
      lines.forEach((line, i) => {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*")) return;
        // 工具面对象上的 handler 直调（registry 内部的包裹调用不算：它只出现在 tool-registry.ts）
        if (/\b[a-zA-Z_$][\w$]*\.handler\s*\(/.test(code)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
