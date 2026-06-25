/**
 * Scene Router Tests
 */

import { test, expect, describe } from "bun:test";
import { SceneRouter, DEFAULT_SCENES } from "../src/mcp/scene-router.js";
import { ToolRegistry } from "../src/mcp/tool-registry.js";

describe("SceneRouter", () => {
  const registry = new ToolRegistry();
  // 注册一些 mock 工具用于测试
  registry.add({
    name: "read_file",
    description: "Read file",
    inputSchema: {},
    handler: async (args) => ({ content: "mock content" }),
  });
  registry.add({
    name: "git_status",
    description: "Git status",
    inputSchema: {},
    handler: async (args) => ({ branch: "main" }),
  });

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
});
