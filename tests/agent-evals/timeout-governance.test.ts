/**
 * 执行错误治理（清单②，基线文档结论#3）——请求超时可配置 + 默认上调。
 * 背景：66 任务重跑执行错误上升（zhipu 1→14、sensenova 9→19），sensenova p99≈129s
 * 超过原 fetch 90s / curl 120s 上限，长输出任务被传输超时截断为执行错误。
 * 默认上调 180s 覆盖 p99 长尾；AGENT_EVALS_TIMEOUT_MS 环境变量可配置。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_REQUEST_TIMEOUT_MS, resolveRequestTimeoutMs } from "../../src/agent-evals/runner.js";

const RUNNER_SRC = readFileSync(new URL("../../src/agent-evals/runner.ts", import.meta.url), "utf8");

describe("resolveRequestTimeoutMs（默认 180s 覆盖 p99≈129s 长尾）", () => {
  it("默认 180000（原 fetch 90s / curl 120s 均上调）", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(resolveRequestTimeoutMs({})).toBe(180_000);
  });

  it("AGENT_EVALS_TIMEOUT_MS 合法值生效", () => {
    expect(resolveRequestTimeoutMs({ AGENT_EVALS_TIMEOUT_MS: "240000" })).toBe(240_000);
  });

  it("非法值（非数字/0/负数）回退默认，绝不产出 0 或负超时", () => {
    expect(resolveRequestTimeoutMs({ AGENT_EVALS_TIMEOUT_MS: "abc" })).toBe(180_000);
    expect(resolveRequestTimeoutMs({ AGENT_EVALS_TIMEOUT_MS: "0" })).toBe(180_000);
    expect(resolveRequestTimeoutMs({ AGENT_EVALS_TIMEOUT_MS: "-5" })).toBe(180_000);
  });
});

describe("超时治理接线（静态断言：两条直连路径统一走 resolveRequestTimeoutMs）", () => {
  it("proxyFetch 路径 AbortSignal 使用 resolveRequestTimeoutMs（不再硬编码 90_000）", () => {
    expect(RUNNER_SRC).toMatch(/signal: AbortSignal\.timeout\(resolveRequestTimeoutMs\(\)\)/);
    expect(RUNNER_SRC).not.toMatch(/AbortSignal\.timeout\(90_000\)/);
  });

  it("curl 路径 -m 使用 resolveRequestTimeoutMs 换算秒（不再硬编码 120）", () => {
    expect(RUNNER_SRC).toMatch(/"-m", String\(Math\.round\(resolveRequestTimeoutMs\(\) \/ 1000\)\)/);
    expect(RUNNER_SRC).not.toMatch(/"-m", "120"/);
  });
});
