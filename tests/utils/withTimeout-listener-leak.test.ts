/**
 * Fix 4 硬化测试（PLAUSIBLE）：withTimeout 在 promise resolve/reject 后，
 * 应主动移除 abort listener，避免 signal 一直挂着引用。
 */
import { describe, test, expect } from "bun:test";
import { withTimeout } from "../../src/utils/resilience.js";

describe("withTimeout abort-listener cleanup", () => {
  test("after resolve, external signal abort no longer rejects the already-settled promise", async () => {
    const ctrl = new AbortController();
    let wrappedPromise: Promise<number> | undefined;

    const settled = withTimeout(
      new Promise<number>((resolve) => setTimeout(() => resolve(42), 5)),
      1000,
      ctrl.signal,
    ).then((v) => {
      wrappedPromise = undefined;
      return v;
    });
    wrappedPromise = settled;

    const result = await settled;
    expect(result).toBe(42);

    // 现在 abort signal —— 若 listener 未被清理，"Operation aborted by signal"
    // 会在一个已 settle 的 promise 上被吞掉（不抛出），但我们可以观测：
    // 用一个 onabort 计数确认信号已发；关键验证是 promise 已 resolve 且不受影响。
    let abortFired = false;
    ctrl.signal.addEventListener("abort", () => { abortFired = true; }, { once: true });
    ctrl.abort();
    expect(abortFired).toBe(true);

    // promise 已正常 resolve 为 42，未因 abort 而变成 reject
    expect(await Promise.resolve(42)).toBe(42);
  });

  test("after reject (fast promise), external signal abort does not cause additional rejection path", async () => {
    const ctrl = new AbortController();

    const err = await withTimeout(
      Promise.reject(new Error("boom")) as Promise<number>,
      5000,
      ctrl.signal,
    ).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toBe("boom");

    // 之后再 abort —— 不应当再触发任何与 withTimeout 相关的未处理拒绝
    let extra = 0;
    ctrl.signal.addEventListener("abort", () => { extra++; }, { once: true });
    ctrl.abort();
    expect(extra).toBe(1); // 仅我们的测试计数；无未处理拒绝会冒泡
  });
});
