/**
 * Q3/A5 端到端断言的**进程隔离外壳**（真正的用例在 usage-category.case.ts）。
 *
 * 原因：case 文件在加载期 `mock.module` 掉 `provider-caller` / `proxy-fetch`，
 * Bun 先加载后执行 ⇒ 同进程会污染其它用例。
 * 断言点（防恒真）：子进程必须 0 fail 且 pass ≥ 1。
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const CASE = path.join(import.meta.dir, "usage-category.case.ts");

/** 子进程预算（原值保留）：嵌套 bun 冷启动 + 加载 router 模块图实测 6–22s，勿收紧。 */
const CHILD_TIMEOUT_MS = 180_000;
/** 用例预算必须**严格大于**子进程预算，理由见下方 it() 前的注释。 */
const CASE_TIMEOUT_MS = CHILD_TIMEOUT_MS + 30_000;

describe("Q3/A5 端到端（子进程隔离）", () => {
  // ⚠️ 第三参数（用例超时）与 spawnSync 的 timeout **都不能删**。机理：
  // 1. 裸跑 `bun test` 的用例默认超时是 5000ms —— bunfig.toml 里的 `[test] timeout`
  //    在 bun 1.4.3 不被识别（只有 CLI `--timeout` 生效），所以默认值真的会落到 5s。
  // 2. 本用例体内是**嵌套 bun 进程**：冷启动 + 加载模块图实测 6–22s（Windows，负载敏感），
  //    远超 5s，故默认超时下必红。
  // 3. 若用例超时先于子进程结束：bun 把子进程当 dangling process 杀掉 → 子进程 stdout
  //    被截断 → 拿不到 "N pass / N fail" 汇总行 → fail 解析成 -1 → 失败信息变成误导性的
  //    「断言失败 Expected 0, Received -1」，而不是「超时」。
  // 4. 故用例预算必须 > spawnSync 预算：让子进程自己先超时收场，留下可解析的输出。
  it("隔离进程内 chat/tool/embeddings 都写入了带 category 的记录", () => {
    const res = spawnSync("bun", ["test", CASE], {
      encoding: "utf8",
      cwd: path.resolve(import.meta.dir, "../.."),
      timeout: CHILD_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: "test" },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const pass = Number(out.match(/(\d+)\s+pass/)?.[1] ?? "0");
    const fail = Number(out.match(/(\d+)\s+fail/)?.[1] ?? "-1");
    if (fail !== 0 || pass === 0) console.error(out);
    expect(fail).toBe(0);
    expect(pass).toBeGreaterThanOrEqual(1);
  }, CASE_TIMEOUT_MS);
});
