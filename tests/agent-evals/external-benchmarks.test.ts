/**
 * 外部审核测试集适配层测试（src/agent-evals/external.ts）
 *
 * 覆盖：
 * - H1 解析稳定性：loadExternalTasks 对 HumanEval / MBPP JSONL 的解析与任务结构
 * - H2 verify 判定：经注入的宿主执行 fake 沙箱（审计 P1-3 起执行统一走沙箱提供者），
 *   exit 0 → pass，exit 非 0 → fail，解释器缺失 → 确定性 fail
 * - extractPythonCode 纯函数（代码块 / 无标注代码块 / 纯文本）
 *
 * 设计：不依赖真实 Python（本机/CI 均可运行）；P1-3 后执行缝为 SandboxProvider，
 * 此处 fake 解析 external.ts 构造的 POSIX 单引号命令并回宿主 spawn（仅测试 fake，
 * 参数不含单引号，逐字还原 token），与 curlFetch spawnImpl 的测试注入模式一致。
 */
import { describe, test, expect } from "bun:test";
import path from "node:path";
import { loadExternalTasks, extractPythonCode } from "../../src/agent-evals/external.js";
import type { SandboxOptions, SandboxProvider, SandboxResult } from "../../src/sandbox/types.js";

const FIXTURES = path.resolve(import.meta.dir, "fixtures");
const FAKE_PASS = [process.execPath, path.join(FIXTURES, "fake-python-pass.mjs")];
const FAKE_FAIL = [process.execPath, path.join(FIXTURES, "fake-python-fail.mjs")];

/** 宿主执行 fake 沙箱：解析沙箱命令字符串并回宿主 spawn（仅测试用）。 */
function makeHostSandbox(): SandboxProvider {
  return {
    name: "fake-host",
    available: () => true,
    execute: async (opts: SandboxOptions): Promise<SandboxResult> => {
      const start = Date.now();
      const tokens = [...(opts.command.matchAll(/'([^']*)'/g))].map((m) => m[1]);
      try {
        const proc = Bun.spawn(tokens, { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { exitCode, stdout, stderr, durationMs: Date.now() - start };
      } catch (err) {
        return { exitCode: -1, stdout: "", stderr: "", durationMs: Date.now() - start, error: (err as Error).message };
      }
    },
  };
}

const hostSandbox = makeHostSandbox();

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

  test("S4 元数据一致性：HumanEval 任务带非空 expectedBehavior", () => {
    const tasks = loadExternalTasks("human-eval", { limit: 3 });
    for (const t of tasks) {
      expect(typeof t.expectedBehavior).toBe("string");
      expect(t.expectedBehavior!.length).toBeGreaterThan(0);
      expect(t.expectedBehavior).toContain("Python");
      expect(t.expectedBehavior).toContain("exit 0");
    }
  });

  test("S4 元数据一致性：MBPP 任务带非空 expectedBehavior", () => {
    const tasks = loadExternalTasks("mbpp", { limit: 3 });
    for (const t of tasks) {
      expect(typeof t.expectedBehavior).toBe("string");
      expect(t.expectedBehavior!.length).toBeGreaterThan(0);
      expect(t.expectedBehavior).toContain("test_list");
    }
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

describe("verify 判定（H2，fake 沙箱宿主执行注入，不依赖真实 Python / docker）", () => {
  test("解释器 exit 0 → passed:true", async () => {
    const [task] = loadExternalTasks("human-eval", { limit: 1, pythonCmd: FAKE_PASS, sandbox: hostSandbox });
    const result = await task.verify("```python\npass\n```");
    expect(result.passed).toBe(true);
  });

  test("解释器 exit 非 0 → passed:false 且 reason 可读", async () => {
    const [task] = loadExternalTasks("mbpp", { limit: 1, pythonCmd: FAKE_FAIL, sandbox: hostSandbox });
    const result = await task.verify("```python\npass\n```");
    expect(result.passed).toBe(false);
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });

  test("不存在的解释器 → passed:false（确定性失败路径）", async () => {
    const [task] = loadExternalTasks("human-eval", { limit: 1, pythonCmd: ["definitely-not-a-real-python-binary-xyz"], sandbox: hostSandbox });
    const result = await task.verify("pass");
    expect(result.passed).toBe(false);
    expect((result.reason ?? "").length).toBeGreaterThan(0);
  });
});
