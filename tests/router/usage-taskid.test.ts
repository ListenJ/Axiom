/**
 * A4 端到端断言的**进程隔离外壳**（真正的用例在 usage-taskid.case.ts）。
 *
 * 原因：case 文件在加载期 `mock.module` 掉 `provider-caller`，Bun 先加载后执行 ⇒
 * 同进程会污染其它用例（本仓库既有教训，见 tests/agent-evals/chat-capture-session.test.ts）。
 * 断言点（防恒真）：子进程必须 0 fail 且 pass ≥ 1。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const CASE = path.join(import.meta.dir, "usage-taskid.case.ts");

describe("A4 端到端（子进程隔离）", () => {
  it("隔离进程内 trackCall 确实写入了带 taskId 的记录", () => {
    const res = spawnSync("bun", ["test", CASE], {
      encoding: "utf8",
      cwd: path.resolve(import.meta.dir, "../.."),
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const pass = Number(out.match(/(\d+)\s+pass/)?.[1] ?? "0");
    const fail = Number(out.match(/(\d+)\s+fail/)?.[1] ?? "-1");
    if (fail !== 0 || pass === 0) console.error(out);
    expect(fail).toBe(0);
    expect(pass).toBeGreaterThanOrEqual(1);
  });
});
