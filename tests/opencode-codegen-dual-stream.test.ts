import { describe, expect, test } from "bun:test";
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

const unixTest = process.platform === "win32" ? test.skip : test;

describe("CodegenExecutor dual-stream drain", () => {
  unixTest("does not deadlock when stderr fills before stdout closes", async () => {
    const state = fakeState(1);
    const executor = new CodegenExecutor(
      new Map([["fake-model", state]]),
      process.cwd(),
      () => "fake-model",
      (opts) => spawn({
        ...opts,
        cmd: ["bash", "-c", "head -c 8388608 /dev/zero >&2; printf done"],
      }),
    );

    const started = Date.now();
    const result = await executor.callOpenCode("dual stream", "fake-model", 2000);
    expect(result.content).toContain("done");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(state.sem.active).toBe(0);
  }, 6000);
});
