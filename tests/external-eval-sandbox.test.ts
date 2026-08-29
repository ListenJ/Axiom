/**
 * 审计 P1-3（2026-08-29）：external 评测的 LLM 生成代码必须经沙箱执行。
 * 证据：docs/reviews/2026-08-29-joint-verification-audit.md §4 B2-M3——
 * 原 src/agent-evals/external.ts runPython 将模型生成的 Python 落盘后以当前用户
 * 权限直接执行（timeout 20s），可访问文件系统/网络。spec §2 P1-3 选定修复：
 * 经 SandboxProvider（默认 docker-sandbox）执行；沙箱不可用 → 结果标注 skipped，
 * 绝不回退宿主直跑；20s 超时语义保持；脚本须落在沙箱挂载目录内。
 *
 * 本测试不依赖真实 docker：一律注入 fake SandboxProvider（与 curlFetch spawnImpl /
 * external-benchmarks pythonCmd 注入缝同模式），保持秒级、确定性。
 */
import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadExternalTasks } from "../src/agent-evals/external.js";
import type { SandboxOptions, SandboxProvider, SandboxResult } from "../src/sandbox/types.js";

const SOURCE = fs.readFileSync(path.resolve(import.meta.dir, "../src/agent-evals/external.ts"), "utf8");

describe("[P1-3] external 评测沙箱执行", () => {
  test("静态断言：external.ts 无直接子进程执行路径，执行统一走沙箱提供者", () => {
    expect(SOURCE).not.toContain("node:child_process");
    expect(SOURCE).not.toContain("Bun.spawn");
    expect(SOURCE).not.toContain("spawn(");
    expect(SOURCE).toContain("sandbox.execute");
    expect(SOURCE).toContain("available()");
  });

  test("沙箱不可用 → verify 结果标注 skipped，且绝不触发子进程执行", async () => {
    let executed = 0;
    const unavailable: SandboxProvider = {
      name: "fake-unavailable",
      available: () => false,
      execute: async (_opts: SandboxOptions): Promise<SandboxResult> => {
        executed++;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
      },
    };
    const [task] = loadExternalTasks("human-eval", { limit: 1, sandbox: unavailable });
    const result = await task.verify("```python\nprint(1)\n```");
    expect(result.passed).toBe(false);
    expect(result.reason ?? "").toContain("skipped");
    expect(executed).toBe(0);
  });

  test("沙箱可用 → 脚本写入挂载目录（.tmp/external-eval-runs）内并经沙箱执行，保持 20s 超时与禁网", async () => {
    const calls: SandboxOptions[] = [];
    const sandbox: SandboxProvider = {
      name: "fake-recording",
      available: () => true,
      execute: async (opts) => {
        calls.push(opts);
        const cwd = opts.cwd ?? "";
        const scripts = fs.readdirSync(cwd).filter((f) => f.endsWith(".py"));
        expect(scripts.length).toBe(1);
        expect(fs.readFileSync(path.join(cwd, scripts[0]), "utf8")).toContain("print(1)");
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      },
    };
    const [task] = loadExternalTasks("human-eval", { limit: 1, sandbox });
    const result = await task.verify("```python\nprint(1)\n```");
    expect(result.passed).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].timeoutMs).toBe(20_000);
    expect(calls[0].networkAccess).toBe(false);
    expect(calls[0].command).toContain(".py");
    // 挂载适配：脚本目录必须在项目内 .tmp/external-eval-runs 下（docker-sandbox 挂载
    // 白名单会拒绝 os.tmpdir 的宿主用户目录首段，且容器内经 /workspace 相对引用脚本）
    const resolvedCwd = path.resolve(calls[0].cwd ?? "");
    expect(resolvedCwd.startsWith(path.resolve(process.cwd(), ".tmp", "external-eval-runs"))).toBe(true);
  });
});
