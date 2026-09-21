import { z } from "zod";
import type { ToolRegistry } from "../tool-registry.js";
import { SceneRouter, DEFAULT_SCENES } from "../scene-router.js";

/**
 * 场景路由工具（懒加载推荐面）—— 自 server.ts 拆出，沿用本目录 "一个领域一个 register*" 的既有形状。
 *
 * 两个工具都是纯查询：读内存里的场景表，不触碰任何特权资源，故声明 internal。
 * SceneRouter 与场景表随工具一起搬过来，server.ts 只负责在装配期调用一次。
 */
export function registerSceneTools(registry: ToolRegistry): void {
  const sceneRouter = new SceneRouter(registry);
  sceneRouter.addScenes(DEFAULT_SCENES);

  registry.add({
    name: "scene_suggest_tools",
    capability: ["internal"],
    description: "根据输入文本推荐工具子集 (降低 context token 消耗)",
    inputSchema: {
      input: z.string().describe("用户输入或任务描述"),
    },
    handler: async (args) => {
      const input = args.input as string;
      const scene = sceneRouter.match(input);
      if (!scene) {
        return {
          matched: false,
          suggestion: "core",
          tools: ["fs_read", "fs_list", "git_status", "terminal_info"],
          message: "未匹配到特定场景，使用核心工具集",
        };
      }
      return {
        matched: true,
        sceneId: scene.id,
        sceneName: scene.name,
        description: scene.description,
        tools: scene.tools,
        parallel: scene.parallel,
      };
    },
  });

  registry.add({
    name: "scene_list",
    capability: ["internal"],
    description: "列出所有可用场景及其工具集",
    inputSchema: {},
    handler: async () => {
      return sceneRouter.listScenes();
    },
  });
}
