/**
 * 外部审核测试集适配层测试（src/agent-evals/external.ts）
 *
 * 覆盖：
 * - H1 解析稳定性：loadExternalTasks 对 HumanEval / MBPP JSONL 的解析与任务结构
 * - H2 verify 判定：注入假 Python 解释器（Node/Bun 脚本），exit 0 → pass，exit 非 0 → fail
 * - extractPythonCode 纯函数（代码块 / 无标注代码块 / 纯文本）
 *
 * 设计：不依赖真实 Python（本机/CI 均可运行）；pythonCmd 注入缝为 [命令, ...参数]，
 * 与 curlFetch spawnImpl / DataPipeline fetchImpl 的测试注入模式一致。
 */
import { describe, test, expect } from "bun:test";
import path from "node:path";
import { loadExternalTasks, extractPythonCode } from "../../src/agent-evals/external.js";

const FIXTURES = path.resolve(import.meta.dir, "fixtures");
const FAKE_PASS = [process.execPath, path.join(FIXTURES, "fake-python-pass.mjs")];
const FAKE_FAIL = [process.execPath, path.join(FIXTURES, "fake-python-fail.mjs")];

describe("loadExternalTasks 解析稳定性（H1）", () => {
  test("HumanEval limit=3 生成符合 AgentTask 契约的任务", () => {
    const tasks = loadExternalTasks("human-eval", { limit: 3 });
    expect(tasks.length).toBe(3);
    for (const t of tasks) {
      expect(t.id.startsWith("HE-")).toBe(true);
      expect(t.family).toBe("coding");
      expect(t.split).toBe("held-out");
      expect(typeof t.verify).toBe("function");
      expect(t.prompt.length).toBeGreaterThan(0);
      expect(t.maxTokens).toBeGreaterThan(0);
    }
  });

  test("MBPP limit=3 生成符合 AgentTask 契约的任务", () => {
    const tasks = loadExternalTasks("mbpp", { limit: 3 });
    expect(tasks.length).toBe(3);
    for (const t of tasks) {
      expect(t.id.startsWith("MBPP-")).toBe(true);
      expect(t.family).toBe("coding");
      expect(t.split).toBe("held-out");
      expect(typeof t.verify).toBe("function");
      expect(t.prompt.length).toBeGreaterThan(0);
    }
  });

  test("limit 缺省时加载全部（超过 limit 数量）", () => {
    const all = loadExternalTasks("human-eval");
    expect(all.length).toBeGreaterThan(3);
  });

  test("MBPP 的 verify 可消费 test_list（结构完整）", () => {
    const tasks = loadExternalTasks("mbpp", { limit: 1, pythonCmd: FAKE_PASS });
    expect(tasks.length).toBe(1);
    expect(tasks[0].prompt).not.toContain("test_list");
  });
});

describe("extractPythonCode", () => {
  test("提取 python 标注代码块", () => {
    const out = extractPythonCode("先说明\n```python\nprint(1)\n```\n结束");
    expect(out).toBe("print(1)");
  });

  test("提取无语言标注代码块", () => {
    const out = extractPythonCode("```\ndef f():\n    return 1\n```");
    expect(out).toBe("def f():\n    return 1");
  });

  test("无代码块时返回全文（trim）", () => {
    expect(extractPythonCode("  x = 1  ")).toBe("x = 1");
  });
});

describe("verify 判定（H2，假解释器注入，不依赖真实 Python）", () => {
  test("解释器 exit 0 → passed:true", async () => {
    const [task] = loadExternalTasks("human-eval", { limit: 1, pythonCmd: FAKE_PASS });
    const result = await task.verify("```python\npass\n```");
    expect(result.passed).toBe(true);
  });

  test("解释器 exit 非 0 → passed:false 且 reason 可读", async () => {
    const [task] = loadExternalTasks("mbpp", { limit: 1, pythonCmd: FAKE_FAIL });
    const result = await task.verify("```python\npass\n```");
    expect(result.passed).toBe(false);
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });

  test("不存在的解释器 → passed:false（确定性失败路径）", async () => {
    const [task] = loadExternalTasks("human-eval", { limit: 1, pythonCmd: ["definitely-not-a-real-python-binary-xyz"] });
    const result = await task.verify("pass");
    expect(result.passed).toBe(false);
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });
});
