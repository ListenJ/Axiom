import { test, expect, Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 终端浮层 e2e（2026-10-22 按「Agent 工作区」前端重写）。
 *
 * 旧规格描述 /chat 画布工具栏「打开终端/打开摘要」按钮与右侧工具台，该 UI 已删除。
 * 重写后的链路与断言全部来自当前源码事实：
 *   - Layout.tsx:91-107  terminalOpen && <motion.div(fixed 底部浮层)><TerminalPanel/>；
 *     关闭路径 onClose={() => setTerminalOpen(false)}；
 *   - Header.tsx:118-150 nav[aria-label="系统菜单"] → HeaderMenu「视图」(button, aria-expanded,
 *     aria-haspopup="menu") → role=menuitem「打开终端」onSelect 调 useApp.setTerminalOpen(true)；
 *   - TerminalPanel.tsx:164-207  根节点 div role="region" aria-label="终端"；工具条含
 *     aria-label="清空终端" / "关闭终端" 按钮；xterm 挂在内部 div（class .xterm 由 xterm.js 生成）；
 *     状态文案 statusLabel：connecting「正在连接…」/ connected「交互终端 · 常驻会话」/ error「连接失败」；
 *   - pty-terminal.ts:87-92  打开浮层即 POST /terminal/session 创建会话 + SSE
 *     GET /terminal/session/:id/stream —— 本规格全程用 page.route mock 这两个端点，
 *     绝不触真实后端 PTY，也不执行任何命令；
 *   - useGlobalHotkeys.ts:64-69  Ctrl+` 全局开合（本规格只测菜单路径与关闭按钮，快捷键留待键盘规格）。
 *
 * 交互式 route mock 是 Playwright 内置网络桩，非真实外部网络；关闭/隐藏断言使用
 * AnimatePresence 卸载后元素 dettach 的自动等待，无固定 sleep。
 */

const PTY_SESSION_ID = "e2e-pty-1";

/** 桩住终端会话两端点：create 返回固定会话 id，stream 返回单条 SSE 后挂起（不产生命令回显）。 */
async function mockTerminalSession(page: Page): Promise<void> {
  await page.route("**/terminal/session", (route) =>
    route.fulfill({ json: { sessionId: PTY_SESSION_ID } })
  );
  await page.route(`**/terminal/session/${PTY_SESSION_ID}/stream`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      // 单条 data 块后连接保持打开（旧规格同款桩）：onChunk 收到 "hello from pty\n"
      body: 'data: "hello from pty\\n"\n\n',
    })
  );
  await page.route(`**/terminal/session/${PTY_SESSION_ID}/input`, (route) =>
    route.fulfill({ json: { ok: true } })
  );
  await page.route(`**/terminal/session/${PTY_SESSION_ID}`, (route) =>
    route.fulfill({ json: { ok: true } })
  );
}

/** 走真实外壳菜单：系统菜单 → 视图 → 打开终端。选择器依据 Header.tsx（见文件头注释）。 */
async function openTerminalViaMenu(page: Page): Promise<void> {
  const viewMenuButton = page
    .getByRole("navigation", { name: "系统菜单" })
    .getByRole("button", { name: "视图" });
  await viewMenuButton.click();
  await expect(viewMenuButton).toHaveAttribute("aria-expanded", "true");
  const openItem = page.getByRole("menuitem", { name: "打开终端" });
  await expect(openItem).toBeVisible();
  await openItem.click();
  // Header.tsx:63-65 menuitem onClick 先 setOpen(false) 再 onSelect()
  await expect(openItem).toBeHidden();
}

const terminalRegion = (page: Page) => page.getByRole("region", { name: "终端" });

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
  await mockTerminalSession(page);
  await page.goto("/agents", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("navigation", { name: "系统菜单" })).toBeVisible();
});

test.describe("终端浮层（系统菜单 -> 视图 -> 打开终端）", () => {
  test.describe.configure({ mode: "serial" });

  test("菜单打开终端：region[终端] 可见，头部含状态文案与 .xterm 容器", async ({ page }) => {
    await expect(terminalRegion(page)).toBeHidden(); // 关闭态：AnimatePresence 未挂载
    await openTerminalViaMenu(page);
    const region = terminalRegion(page);
    await expect(region).toBeVisible();
    // TerminalPanel.tsx:181-184 工具条：图标 + 「终端」 + statusLabel
    await expect(region.getByText("终端", { exact: true })).toBeVisible();
    // 会话创建成功（mock create+stream）→ connected 分支的 statusLabel（可证伪：
    // 桩了 create/stream，若链路断在 setTerminalOpen 或 PtyTerminal.start 则是「正在连接…」）
    await expect(region.getByText("交互终端 · 常驻会话")).toBeVisible();
    // xterm.js 在内部容器生成的终端画布（TerminalPanel.tsx:114 term.open(container)）
    await expect(region.locator(".xterm")).toBeVisible();
    // Layout.tsx:96 浮层覆盖式（非内嵌）贴底
    await expect
      .poll(async () => {
        const box = await region.boundingBox();
        return box === null ? -1 : Math.abs(box.y + box.height - page.viewportSize()!.height);
      })
      .toBeLessThanOrEqual(4);
  });

  test("关闭按钮隐藏浮层：POST /terminal/session/:id 关闭后端会话", async ({ page }) => {
    await openTerminalViaMenu(page);
    const region = terminalRegion(page);
    await expect(region).toBeVisible();
    await expect(region.getByText("交互终端 · 常驻会话")).toBeVisible();

    // PtyTerminal.dispose 会 close 会话：捕获对 DELETE 的请求作为清理证据
    const closeRequested = page.waitForRequest(
      (req) => req.method() !== "GET" && req.url().endsWith(`/terminal/session/${PTY_SESSION_ID}`),
      { timeout: 10_000 }
    );
    await region.getByLabel("关闭终端").click();
    await closeRequested;
    await expect(region).not.toBeVisible(); // Layout.tsx:101 exit 动画后卸载
  });

  test("清空按钮只作用于本地 xterm：不清空会话也不发真实命令", async ({ page }) => {
    await openTerminalViaMenu(page);
    const region = terminalRegion(page);
    await expect(region).toBeVisible();
    await expect(region.getByText("交互终端 · 常驻会话")).toBeVisible();

    // TerminalPanel.tsx:188 onClick 只调 termRef.current?.clear() —— 本地操作；
    // 若误触 input 端点，则 inputRequests 非零，断言可证伪。
    let inputRequests = 0;
    page.on("request", (req) => {
      if (req.url().includes(`/terminal/session/${PTY_SESSION_ID}/input`)) inputRequests += 1;
    });
    await region.getByLabel("清空终端").click();
    await expect(region.getByText("交互终端 · 常驻会话")).toBeVisible(); // 面板仍连接
    expect(inputRequests).toBe(0);
  });

  test("浮层不影响画布交互：关闭后可再次经菜单打开", async ({ page }) => {
    await openTerminalViaMenu(page);
    await expect(terminalRegion(page)).toBeVisible();
    await terminalRegion(page).getByLabel("关闭终端").click();
    await expect(terminalRegion(page)).not.toBeVisible();

    await openTerminalViaMenu(page);
    const region = terminalRegion(page);
    await expect(region).toBeVisible();
    await expect(region.getByText("交互终端 · 常驻会话")).toBeVisible();
    await expect(region.locator(".xterm")).toBeVisible();
  });
});
