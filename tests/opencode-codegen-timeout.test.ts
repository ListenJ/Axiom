/**
 * P0-5（N-H5）codegen 超时回归测试。
 *
 * 契约（docs/reviews/2026-08-29-joint-verification-audit.md N-H5）：
 *   - 挂起子进程 + 短 timeoutMs → callOpenCode 在超时后以含 "timeout" 的错误 reject
 *     （修复前 abort 无消费方，stdout reader 永不返回 → 永久挂起）；
 *   - 超时不泄漏并发信号量：permits=1 时，紧随其后的正常调用必须成功（不被饿死），
 *     且信号量恰好释放一次（active 回到 0）。
 *
 * 注入方式：构造器第 4 参 spawnProc（默认 Bun spawn，行为中性接缝），
 * 将硬编码的 opencode 命令替换为受控的挂起 / 快速返回命令。
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "bun";
import { RateLimitedSemaphore } from "../src/utils/concurrency/rate-limited-semaphore.js";
import { CodegenExecutor } from "../src/agents/opencode-tools/codegen.js";
import type { ModelRuntimeState } from "../src/agents/opencode-tools/types.js";

function fakeState(permits = 1): ModelRuntimeState {
  return {
    sem: new RateLimitedSemaphore({ permits }),
    consecutiveFailures: 0,
    circuitOpen: false,
    circuitOpenUntil: 0,
    totalCalls: 0,
    totalFailures: 0,
    droppedStarts: 0,
    latencyHistory: [],
  };
}

const HANG_CMD = ["powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 15"];
const FAST_CMD = ["cmd", "/c", "echo opencode-fake-output"];

describe("CodegenExecutor.callOpenCode timeout (P0-5)", () => {
  test("挂起进程超时 reject（含 timeout）且信号量恰好释放，后续调用不被饿死", async () => {
    // permits=1：一旦超时路径泄漏许可，第二次 tryAcquire 必失败（直接可观测）。
    const state = fakeState(1);
    let cmd = HANG_CMD;
    const executor = new CodegenExecutor(
      new Map([["fake-model", state]]),
      process.cwd(),
      () => "fake-model",
      (opts) => spawn({ ...opts, cmd }),
    );

    const start = Date.now();
    let err: Error | undefined;
    try {
      await executor.callOpenCode("long running task", "fake-model", 500);
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeDefined();
    expect(err!.message).toContain("timeout");
    expect(Date.now() - start).toBeLessThan(3000); // 超时即断，而非挂满 15s
    expect(state.sem.active).toBe(0); // 信号量恰好释放一次

    // 信号量未被饿死：第二条快速命令正常返回
    cmd = FAST_CMD;
    const result = await executor.callOpenCode("quick task", "fake-model", 5000);
    expect(result.content).toContain("opencode-fake-output");
    expect(state.sem.active).toBe(0);
  }, 4000);
});
