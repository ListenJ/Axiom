/**
 * 路由级断言的**进程隔离外壳**。
 *
 * 真正的用例在 `chat-capture-session.case.ts`（名字刻意不是 *.test.ts）。原因：
 * 它必须在加载期 `mock.module` 掉 `agent-evals/real-usage.js` 才能拦截采集 payload，
 * 而 Bun 先加载全部测试文件再执行 ⇒ 同进程内会污染 real-usage 系测试。
 * 这里用 `spawnSync` 把它放进**独立进程**跑，只断言其退出码与汇总行。
 *
 * 断言点（防恒真）：子进程必须报告 `0 fail` 且 pass 数 > 0；
 * 若产物缺失/用例被删空，pass 数会为 0 而失败。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const CASE = path.join(import.meta.dir, "chat-capture-session.case.ts");

function runCase() {
  const res = spawnSync("bun", ["test", CASE], {
    encoding: "utf8",
    cwd: path.resolve(import.meta.dir, "../.."),
    timeout: 120_000,
    env: { ...process.env, NODE_ENV: "test" },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const pass = Number(out.match(/(\d+)\s+pass/)?.[1] ?? "0");
  const fail = Number(out.match(/(\d+)\s+fail/)?.[1] ?? "-1");
  return { status: res.status, out, pass, fail };
}

describe("路由级断言（子进程隔离）", () => {
  it("隔离进程内 3 条路由断言全部通过", () => {
    const r = runCase();
    if (r.fail !== 0 || r.pass === 0) {
      // 把子进程输出带出来，否则失败时看不到原因
      console.error(r.out);
    }
    expect(r.fail).toBe(0);
    expect(r.pass).toBeGreaterThanOrEqual(3);
  });
});
