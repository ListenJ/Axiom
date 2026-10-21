/**
 * git push 写路径 force 布尔语义收紧回归（规则 9 强推护栏）
 *
 * 症状：此前 `POST /api/git/push` 把 body.force 原样透传，gitPush 用 truthy 判定
 * 决定是否附加 `--force-with-lease` → `{"force":"false"}`（JSON 字符串）同样 truthy，
 * 强推被非布尔值打开。
 *
 * 本文件测两环，均不打真实 git：
 *   1) 路由接缝：mock `src/mcp/tools/git.js` 捕获 gitPush 实参，断言只有布尔 true
 *      被当作 force（"false"/1 → 非 true），其余字段原样透传；
 *   2) 工具接缝：静态守卫 gitPush 内部判定为 `=== true`（truthy 形式不得回到源码，
 *      同 tests/unit/knowledge-query-determinism.test.ts 的静态断言口径）。
 *
 * mock 纪律：Bun 的 mock.module 是进程级原地改写（跨文件泄漏）⇒ 任何 mock 之前
 * 先逐属性快照真实现，afterAll 回灌；消费者用 mock 之后的动态 import 取得。
 */
import { describe, it, expect, afterAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// 快照必须在任何 mock.module 之前求值（namespace 对象本身会被原地改写）。
import * as realGitModule from "../../src/mcp/tools/git.js";
import type { RouteContext } from "../../src/routes/types.js";

const REPO = join(import.meta.dir, "..", "..");
const GIT_TOOL_MODULE = join(REPO, "src", "mcp", "tools", "git.js");
const REAL_GIT_EXPORTS = { ...realGitModule };

type CapturedPushOptions = { remote?: string; branch?: string; force?: unknown };
const captured: CapturedPushOptions[] = [];

mock.module(GIT_TOOL_MODULE, () => ({
  ...REAL_GIT_EXPORTS,
  gitPush: async (_repoPath: string, options?: CapturedPushOptions) => {
    captured.push(options ?? {});
    return { success: true, remote: options?.remote, branch: options?.branch };
  },
}));

// mock 之后再取路由模块，确保路由拿到的是被改写后的 gitPush。
const { handleGitRoutes } = await import(join(REPO, "src", "routes", "git.js"));

/** 最小 fake RouteContext（同 tests/unit/terminal-auth-fix.test.ts 口径） */
function makeCtx(pathname: string, body: Record<string, unknown>): RouteContext {
  const req = new Request("https://example.com" + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    url: new URL(req.url),
    req,
    vault: null,
    db: {} as never,
    pipeline: {} as never,
    healthMonitor: {} as never,
    fileWatcher: null,
    startupTime: Date.now(),
    baseHeaders: {},
    jsonResponse: (data: unknown, status = 200, extra?: Record<string, string>) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...(extra ?? {}) },
      }),
  } as unknown as RouteContext;
}

/** 取最近一次 gitPush 实参 */
function lastPush(): CapturedPushOptions {
  const opts = captured.at(-1);
  expect(opts).toBeDefined();
  return opts!;
}

// 二层 token 未配置时路由守卫 fail-open；显式清场以保证与宿主环境无关。
const origSecond = process.env.AXIOM_SECOND_FACTOR_TOKEN;
delete process.env.AXIOM_SECOND_FACTOR_TOKEN;

async function pushForceToGit(force: unknown): Promise<CapturedPushOptions> {
  captured.length = 0;
  const res = await handleGitRoutes(
    makeCtx("/api/git/push", { remote: "internal", branch: "codex/x", force }),
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return lastPush();
}

describe("POST /api/git/push 的 force 只认真布尔 true", () => {
  it('{"force":"false"} 字符串不得被当作 force', async () => {
    const opts = await pushForceToGit("false");
    // 归一后必须是 false（旧实现原样透传 "false" → gitPush truthy 判定开强推）
    expect(opts.force).toBe(false);
  });

  it("{force:1} 数字不得被当作 force", async () => {
    const opts = await pushForceToGit(1);
    expect(opts.force).toBe(false);
  });

  it("路由把 force 归一为布尔后透传，其余字段不变", async () => {
    const trueOpts = await pushForceToGit(true);
    expect(trueOpts.force).toBe(true);
    expect(typeof (await pushForceToGit("false")).force).toBe("boolean");
    expect(trueOpts.remote).toBe("internal");
    expect(trueOpts.branch).toBe("codex/x");
  });
});

describe("gitPush 内部判定（静态守卫）", () => {
  const src = readFileSync(join(REPO, "src", "mcp", "tools", "git.ts"), "utf-8");

  it("force 走 === true，truthy 判定不得回潮", () => {
    expect(src).toContain('options?.force === true ? " --force-with-lease"');
    expect(src).not.toMatch(/options\?\.force\s*\?\s*"/);
  });
});

afterAll(() => {
  if (origSecond === undefined) delete process.env.AXIOM_SECOND_FACTOR_TOKEN;
  else process.env.AXIOM_SECOND_FACTOR_TOKEN = origSecond;
  // 回灌真实现，防止 fake gitPush 泄漏到同进程后续测试文件。
  mock.module(GIT_TOOL_MODULE, () => REAL_GIT_EXPORTS);
});
