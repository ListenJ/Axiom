/**
 * R2-E 被拒调用的返回契约（S3：上层必须能识别"这次没执行"）
 *
 * `buildHttpHandlers` 是 MCP tools/call 之外的第二条派发面：`scene-router` 与认知管道的
 * `setToolExecutor` 都从它取 handler。守卫（HardFloor / 双层复核 / 强制审批）拒绝时抛错，
 * 而 catch 分支原先只回 `{error:true,message}` —— 只判 `result.success` 的调用方拿到
 * `undefined`，把"被拒"读成"成功"。本文件锁三件事：拒绝要带 `success:false`；
 * 场景执行结果里被拒的那一步不得记为成功；场景层的"高危"判定看声明的能力而不是工具名。
 */
import { describe, test, expect } from "bun:test";
import { ToolRegistry, type ToolDef } from "../../src/mcp/tool-registry.js";
import { SceneRouter } from "../../src/mcp/scene-router.js";

const denialGuard = async (toolName: string): Promise<void> => {
  throw new Error(`[HardFloor] denied by fixture (${toolName})`);
};

function registryWith(guard: (name: string, cap: readonly string[], args: Record<string, unknown>) => Promise<void>, defs: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry({ guard });
  for (const def of defs) registry.add(def);
  return registry;
}

const writeTool: ToolDef = {
  name: "fixture_write",
  capability: ["fs.write"],
  description: "fixture",
  inputSchema: {},
  handler: async () => ({ success: true, ran: true }),
};

describe("R2-E buildHttpHandlers 拒绝分支", () => {
  test("守卫拒绝 ⇒ 返回 success:false 且带拒绝原因，不向调用方抛出", async () => {
    const handlers = registryWith(denialGuard, [writeTool]).buildHttpHandlers();
    const out = (await handlers.fixture_write({ path: "src/a.ts" })) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/HardFloor/);
  });

  test("正常执行的成功结果不被改写（红线：不新增包装）", async () => {
    const handlers = registryWith(async () => {}, [writeTool]).buildHttpHandlers();
    const out = (await handlers.fixture_write({ path: "src/a.ts" })) as Record<string, unknown>;
    expect(out).toEqual({ success: true, ran: true });
  });
});

describe("R2-E 场景执行不得把被拒调用记为成功", () => {
  test("handler 返回 success:false ⇒ executed[] 该步为失败并带 error", async () => {
    const registry = registryWith(denialGuard, [writeTool]);
    const router = new SceneRouter(registry, { allowRiskyTools: true });
    router.addScene({
      id: "fixture-scene",
      name: "夹具场景",
      description: "fixture",
      match: ["go"],
      tools: ["fixture_write"],
    });
    const result = await router.execute("go");
    expect(result.executed).toHaveLength(1);
    expect(result.executed[0].success).toBe(false);
    expect(result.executed[0].error ?? "").toMatch(/HardFloor/);
  });
});

/**
 * 场景高危判定的依据：R1 把授权判定改成"按声明的能力"，但场景层仍留着一张
 * `RISKY_SCENE_TOOLS` 工具名表（terminal_exec / fs_write / fs_delete / fs_move）。
 * 改名或经 adaptTool 包装即脱离该表（L4/L9 同型），且这张表此前无任何用例覆盖。
 * 现按能力判定：场景是"关键词自动选工具并执行、无人工确认"，故只允许无副作用能力。
 */
describe("R2-E 场景高危判定按声明能力，不按工具名（封堵 L4/L9）", () => {
  const ran: string[] = [];

  const defs: ToolDef[] = [
    {
      name: "renamed_write_tool",
      capability: ["fs.write"],
      description: "改名后的写工具（旧名字表认不出）",
      inputSchema: {},
      handler: async () => {
        ran.push("renamed_write_tool");
        return { success: true };
      },
    },
    {
      name: "renamed_exec_tool",
      capability: ["proc.exec"],
      description: "改名后的执行工具",
      inputSchema: {},
      // S-8：命令类负载认不出形态，声明能力时必须一并说明目标入参（此处目标由实现固定）
      payloadFields: { "proc.exec": "fixed" },
      handler: async () => {
        ran.push("renamed_exec_tool");
        return { success: true };
      },
    },
    {
      name: "pure_read_tool",
      capability: ["fs.read"],
      description: "只读工具（无副作用，场景可自动执行）",
      inputSchema: {},
      handler: async () => {
        ran.push("pure_read_tool");
        return { success: true };
      },
    },
  ];

  function routerFor(...toolNames: string[]): SceneRouter {
    const registry = registryWith(async () => {}, defs);
    const router = new SceneRouter(registry);
    router.addScene({
      id: "fixture-cap",
      name: "能力判定夹具",
      description: "fixture",
      match: ["go"],
      tools: toolNames,
    });
    return router;
  }

  test("声明 fs.write 的新名字工具被场景拒绝且未触达实现", async () => {
    ran.length = 0;
    const result = await routerFor("renamed_write_tool").execute("go");
    expect(ran).toEqual([]);
    expect(result.executed[0].success).toBe(false);
    expect(result.executed[0].error ?? "").toMatch(/capability|能力|side-effect|副作用/i);
  });

  test("声明 proc.exec 的新名字工具同样被拒", async () => {
    ran.length = 0;
    const result = await routerFor("renamed_exec_tool").execute("go");
    expect(ran).toEqual([]);
    expect(result.executed[0].success).toBe(false);
  });

  test("只声明 fs.read 的工具仍可被场景自动执行（红线：不误伤无副作用路径）", async () => {
    ran.length = 0;
    const result = await routerFor("pure_read_tool").execute("go");
    expect(ran).toEqual(["pure_read_tool"]);
    expect(result.executed[0].success).toBe(true);
  });
});

