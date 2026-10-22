/**
 * Scene Router Tests
 */

import { test, expect, describe } from "bun:test";
import { SceneRouter, DEFAULT_SCENES } from "../src/mcp/scene-router.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";

describe("SceneRouter", () => {
  const registry = new ToolRegistry();
  // 注册所有场景需要的 mock 工具（P2.1：名字必须与 DEFAULT_SCENES 引用的一致 ——
  // 旧夹具写的是 read_file，而 file_read 场景实际调用 fs_read；新预检会把"声明了但没注册"
  // 的场景判为 unavailable 并拒绝执行，夹具漂移不再能被"Tool not found 也算 executed"掩盖）
  const mockHandlers: Array<{ name: string }> = [
    { name: "fs_read" }, { name: "git_status" },
    { name: "constraint_check" }, { name: "constraint_list" }, { name: "constraint_stats" }, { name: "constraint_select_best" },
    { name: "mental_model_list" }, { name: "mental_model_match" }, { name: "mental_model_predict" },
    { name: "reasoning_build" }, { name: "reasoning_detect_gaps" }, { name: "reasoning_fill_gap" }, { name: "reasoning_result" },
    { name: "actor_list" }, { name: "actor_send" },
    { name: "procedure_parse" },
  ];
  for (const { name } of mockHandlers) {
    registry.add({
      name,
      description: `Mock ${name}`,
      capability: ["internal"],
      inputSchema: {},
      handler: async (args) => ({ mock: true, name }),
    });
  }

  const router = new SceneRouter(registry);
  router.addScenes(DEFAULT_SCENES);

  test("should match git scene", () => {
    const scene = router.match("查看 git 状态");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("git_ops");
  });

  test("should match file read scene", () => {
    const scene = router.match("读取文件 app.js");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("file_read");
  });

  test("should match code analysis scene", () => {
    const scene = router.match("分析这段代码");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("code_analysis");
  });

  test("should return null for unknown input", () => {
    const scene = router.match("hello world");
    expect(scene).toBeNull();
  });

  test("should list all scenes", () => {
    const scenes = router.listScenes();
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.some((s) => s.id === "git_ops")).toBe(true);
  });

  test("should execute scene and return results", async () => {
    const result = await router.execute("读取文件 test.txt");
    expect(result.sceneId).toBe("file_read");
    expect(result.executed.length).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test("should handle unknown input gracefully", async () => {
    const result = await router.execute("random text");
    expect(result.sceneId).toBe("none");
    expect(result.executed.length).toBe(0);
  });

  // === v2.9.2 认知场景测试 ===

  test("should match constraint scene", () => {
    const scene = router.match("检查约束条件");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("constraint_ops");
    expect(scene?.tools).toContain("constraint_check");
  });

  test("should match mental model scene", () => {
    const scene = router.match("心智模型模式匹配");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("mental_model_ops");
    expect(scene?.tools).toContain("mental_model_list");
  });

  test("should match reasoning scene", () => {
    const scene = router.match("空洞检测"); // "推理" also matches dre_ops
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("reasoning_ops");
    expect(scene?.tools).toContain("reasoning_build");
  });

  test("should match actor scene", () => {
    const scene = router.match("发送 actor 消息");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("actor_ops");
    expect(scene?.tools).toContain("actor_send");
  });

  test("should match procedure scene", () => {
    const scene = router.match("解析流程步骤");
    expect(scene).not.toBeNull();
    expect(scene?.id).toBe("procedure_ops");
    expect(scene?.tools).toContain("procedure_parse");
  });

  test("should list all 23 scenes", () => {
    const scenes = router.listScenes();
    const sceneIds = scenes.map((s) => s.id);
    expect(sceneIds).toContain("constraint_ops");
    expect(sceneIds).toContain("mental_model_ops");
    expect(sceneIds).toContain("reasoning_ops");
    expect(sceneIds).toContain("actor_ops");
    expect(sceneIds).toContain("procedure_ops");
    expect(sceneIds).toContain("cognitive_loop");
    expect(sceneIds).toContain("task_graph");
    expect(sceneIds).toContain("git_ops");
    expect(sceneIds).toContain("code_analysis");
    expect(scenes.length).toBeGreaterThanOrEqual(23);
  });
});
