/**
 * user-config-loader — 用户自配置模型/链接闭环测试。
 *
 * Contract:
 *   - data/model-config.json（前端 /models 写入）→ registerModel 注入 EXTENSIONS，findModelsForRole 立即生效；
 *   - config/model-router.yaml（角色分层路由表）→ 各角色模型注入；
 *   - enabled=false 跳过；非法 role 过滤；roles 缺省 general-chat；baseURL/apiKey 透传到 capability。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseModelConfigJson,
  parseModelRouterYaml,
  loadUserModels,
  resetUserModels,
} from "../../src/router/user-config-loader.js";
import { findModelsForRole, type ModelCapability } from "../../src/router/model-capability-registry.js";

const JSON_FIXTURE = JSON.stringify({
  models: [
    {
      id: "model_1",
      name: "我的 GLM",
      provider: "zhipu",
      model: "glm-4.7-flash",
      baseURL: "https://my.gateway.example/v1",
      apiKey: "sk-test-1234",
      roles: ["general-chat", "code-generation"],
      enabled: true,
    },
    {
      id: "model_2",
      name: "已禁用",
      provider: "openrouter",
      model: "x/y",
      enabled: false,
    },
    {
      id: "model_3",
      name: "无角色",
      provider: "deepseek",
      model: "deepseek-chat",
      enabled: true,
    },
  ],
});

const YAML_FIXTURE = `
general-chat:
  - provider: zhipu
    model: glm-4.7-flash
    priority: 0
    maxRetries: 2
    timeout: 60000
code-generation:
  - provider: kimi
    model: kimi-k2.6
    priority: 1
`;

describe("parseModelConfigJson", () => {
  test("parses models array and defaults roles", () => {
    const entries = parseModelConfigJson(JSON_FIXTURE);
    expect(entries).toHaveLength(3);
    expect(entries[0].roles).toEqual(["general-chat", "code-generation"]);
    expect(entries[0].baseURL).toBe("https://my.gateway.example/v1");
    expect(entries[0].apiKey).toBe("sk-test-1234");
    expect(entries[1].enabled).toBe(false);
    expect(entries[2].roles).toBeUndefined();
  });
});

describe("parseModelRouterYaml", () => {
  test("maps role keys to entries", () => {
    const entries = parseModelRouterYaml(YAML_FIXTURE);
    expect(entries).toHaveLength(2);
    expect(entries[0].roles).toEqual(["general-chat"]);
    expect(entries[0].provider).toBe("zhipu");
    expect(entries[0].priority).toBe(0);
    expect(entries[1].roles).toEqual(["code-generation"]);
    expect(entries[1].model).toBe("kimi-k2.6");
  });
});

describe("loadUserModels", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-user-models-"));
    resetUserModels();
  });

  test("registers json models into the capability registry", () => {
    const jsonPath = path.join(tmpDir, "model-config.json");
    fs.writeFileSync(jsonPath, JSON_FIXTURE, "utf8");
    const yamlPath = path.join(tmpDir, "empty.yaml");
    fs.writeFileSync(yamlPath, "", "utf8");

    const report = loadUserModels({ configPath: jsonPath, yamlPath });

    expect(report.registered).toBe(2); // model_3 无 roles → 默认 general-chat 也注册，共 model_1 + model_3
    expect(report.skipped).toBe(1);    // model_2 disabled
    const chat = findModelsForRole("general-chat");
    const userModel = chat.find((m: ModelCapability) => m.id.startsWith("user_model_1"));
    expect(userModel).toBeDefined();
    expect(userModel!.baseURL).toBe("https://my.gateway.example/v1");
    expect(userModel!.apiKey).toBe("sk-test-1234");
    expect(userModel!.roles).toContain("code-generation");
    const code = findModelsForRole("code-generation");
    expect(code.some((m: ModelCapability) => m.id.startsWith("user_model_1"))).toBe(true);
  });

  test("registers yaml role tables and tolerates missing files", () => {
    const yamlPath = path.join(tmpDir, "model-router.yaml");
    fs.writeFileSync(yamlPath, YAML_FIXTURE, "utf8");

    const report = loadUserModels({ yamlPath });
    expect(report.registered).toBe(2);
    const chat = findModelsForRole("general-chat");
    expect(chat.some((m: ModelCapability) => m.id.startsWith("user_"))).toBe(true);
    expect(chat.some((m: ModelCapability) => m.model === "glm-4.7-flash")).toBe(true);

    const empty = loadUserModels({ configPath: path.join(tmpDir, "nope.json"), yamlPath: path.join(tmpDir, "nope.yaml") });
    expect(empty.registered).toBe(0);
    expect(empty.errors.length).toBe(0);
  });
});
