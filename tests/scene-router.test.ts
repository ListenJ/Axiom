/**
 * Scene Router Tests
 */

import { test, expect, describe } from "bun:test";
import { SceneRouter, DEFAULT_SCENES } from "../src/mcp/scene-router.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";

describe("SceneRouter", () => {
  const registry = new ToolRegistry();
  // 注册所有场景需要的 mock 工具
  const mockHandlers: Array<{ name: string }> = [
    { name: "read_file" }, { name: "git_status" },
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
