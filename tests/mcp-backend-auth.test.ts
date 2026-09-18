/**
 * Task 4 / 审计 B1（2026-08-29）：dre-backend / kb-backend HTTP 后端零鉴权修复
 *
 * 证据：src/mcp/dre-backend.ts:35-43、src/mcp/kb-backend.ts:54-62 的 Bun.serve fetch
 * 直接进入 transport.handleRequest，无任何鉴权（MCP_HOST/DRE_MCP_HOST=0.0.0.0 时全裸）。
 * 修复契约：与 src/mcp/server.ts:439-447 同一 checkApiKey 语义 ——
 *   - isLocalAddress(requestIP) 判定回环，回环豁免 token（写方法仍受 Origin 白名单约束）
 *   - 远程必须 x-api-key（AXIOM_AUTH_TOKEN 未配置时 fail-closed 全拒）
 *
 * 行为测试不可直调：两文件为副作用入口脚本（顶层 await + Bun.serve 启动 + 内核初始化），
 * 无法在进程内直调 handler；故以静态断言锁定接线（对齐 read-tool-fence 等静态断言惯例），
 * checkApiKey 本身的行为语义由 tests/auth-check.test.ts 与 tests/auth-rebinding.test.ts 覆盖。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const dreSrc = readFileSync(path.join(import.meta.dir, "../src/mcp/dre-backend.ts"), "utf-8");
const kbSrc = readFileSync(path.join(import.meta.dir, "../src/mcp/kb-backend.ts"), "utf-8");

/** 锁定 checkApiKey 接线 + 先鉴权后 handleRequest + 401 fail-closed */
function assertWired(src: string, label: string): void {
  expect(src, `${label}: 缺 checkApiKey import`).toMatch(
    /import\s*\{[^}]*checkApiKey[^}]*\}\s*from\s*"\.\.\/utils\/auth-check\.js"/,
  );
  expect(src, `${label}: 缺 isLocalAddress import`).toMatch(/isLocalAddress/);
  const authIdx = src.indexOf("checkApiKey(req");
  expect(authIdx, `${label}: 未调用 checkApiKey(req, isLocalAddress(...), apiKey)`).toBeGreaterThan(-1);
  expect(src.slice(Math.max(0, authIdx - 120), authIdx + 80), `${label}: 未用 requestIP 判定回环`).toMatch(
    /requestIP/,
  );
  const handleIdx = src.indexOf("handleRequest");
  expect(handleIdx, `${label}: 缺 handleRequest`).toBeGreaterThan(-1);
  expect(
    handleIdx > authIdx,
    `${label}: 鉴权必须先于 transport.handleRequest`,
  ).toBe(true);
  expect(src, `${label}: 缺 401 拒绝响应`).toMatch(/status: 401/);
  expect(src, `${label}: 未读 AXIOM_AUTH_TOKEN（fail-closed 依据）`).toMatch(
    /readString\("AXIOM_AUTH_TOKEN"\)/,
  );
}

describe("[T4-①] dre-backend / kb-backend HTTP 鉴权接线（审计 B1）", () => {
  it("dre-backend 接入 checkApiKey（先鉴权后 handleRequest，401 fail-closed）", () => {
    assertWired(dreSrc, "dre-backend");
  });

  it("kb-backend 接入 checkApiKey（先鉴权后 handleRequest，401 fail-closed）", () => {
    assertWired(kbSrc, "kb-backend");
  });

  it("两 backend 均保持默认仅回环绑定（0.0.0.0 暴露面注释在案）", () => {
    expect(dreSrc).toMatch(/readString\("DRE_MCP_HOST",\s*"127\.0\.0\.1"\)/);
    expect(kbSrc).toMatch(/readString\("KB_MCP_HOST",\s*"127\.0\.0\.1"\)/);
    // 暴露面说明：HOST 改 0.0.0.0 时远程请求需 x-api-key，注释必须写明
    expect(dreSrc).toMatch(/0\.0\.0\.0/);
    expect(kbSrc).toMatch(/0\.0\.0\.0/);
  });
});
