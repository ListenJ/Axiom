/**
 * 终端浮层 + 右侧工具台（摘要 / Git 修改）e2e（实操验证）
 *
 * 断言：
 *   1. 画布工具栏"打开终端"按钮点击后终端浮层出现，Ctrl+` 快捷键可开合
 *   2. 画布工具栏"打开摘要"按钮唤出右侧工具台：Git 状态（分支）与系统统计可见
 *   3. 右栏工具轨"Git"面板：/api/git/diff 聚合后的文件数与增删行可见
 */
import { test, expect, Page } from "@playwright/test";
import { injectAuth } from "./helpers";

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

async function mockTerminal(page: Page) {
  await page.route("**/terminal/session", (route) =>
    route.fulfill({ json: { sessionId: "e2e-pty-1" } })
  );
  await page.route("**/terminal/session/e2e-pty-1/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: 'data: "hello from pty\\n"\n\n',
    })
  );
  await page.route("**/terminal/session/e2e-pty-1/input", (route) =>
    route.fulfill({ json: { ok: true } })
  );
  await page.route("**/terminal/session/e2e-pty-1", (route) =>
    route.fulfill({ json: { ok: true } })
  );
}

async function mockGit(page: Page, changes: string[]) {
  await page.route("**/api/git/status", (route) =>
    route.fulfill({
      json: {
        success: true,
        branch: "master",
        modified: changes,
        clean: changes.length === 0,
      },
    })
  );
  await page.route("**/api/git/diff", (route) =>
    route.fulfill({
      json: {
        success: true,
        files: changes.map((p) => ({ path: p, status: "modified", additions: 3, deletions: 1 })),
      },
    })
  );
  await page.route("**/api/stats", (route) =>
    route.fulfill({ json: { activeTasks: 2, agents: 3, completed: 10, tokensUsed: 123456 } })
  );
}

test("终端浮层：画布工具栏按钮打开/关闭", async ({ page }) => {
  await mockTerminal(page);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await page.getByLabel("打开终端").waitFor({ timeout: 10000 });
  await page.getByLabel("打开终端").click();
  const panel = page.getByRole("region", { name: "终端" });
  await expect(panel).toBeVisible();
  await page.getByLabel("关闭终端").click();
  await expect(panel).not.toBeVisible();
});

test("终端浮层：Ctrl+` 快捷键开合", async ({ page }) => {
  await mockTerminal(page);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await page.getByLabel("打开终端").waitFor({ timeout: 10000 }); // 确保 React 挂载
  await page.keyboard.press("Control+`");
  await expect(page.getByRole("region", { name: "终端" })).toBeVisible();
  await page.keyboard.press("Control+`");
  await expect(page.getByRole("region", { name: "终端" })).not.toBeVisible();
});

test("终端浮层：输入命令并发送到交互会话", async ({ page }) => {
  await mockTerminal(page);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await page.getByLabel("打开终端").waitFor({ timeout: 10000 }); // 确保 React 挂载
  await page.keyboard.press("Control+`");
  const panel = page.getByRole("region", { name: "终端" });
  await expect(panel).toBeVisible();
  const sent: string[] = [];
  page.on("request", (req) => {
    if (!req.url().includes("/terminal/session/e2e-pty-1/input")) return;
    const body = JSON.parse(req.postData() ?? "{}");
    if (typeof body.data === "string") sent.push(body.data);
  });
  await page.locator(".xterm").click();
  await page.keyboard.type("echo hello");
  await page.keyboard.press("Enter");
  // xterm onData 按字符触发：输入会拆成多个 POST，逐键转发是交互终端的正确语义，
  // 因此断言“按序收到的全部输入拼接后等于整条命令 + 回车”。
  await expect.poll(() => sent.join(""), { timeout: 10000 }).toBe("echo hello\r");
});

test("右侧工具台：摘要按钮唤出并显示环境信息（分支/变更/Token）", async ({ page }) => {
  await mockGit(page, ["src/main.ts"]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await page.getByLabel("打开摘要").waitFor({ timeout: 10000 });
  await page.getByLabel("打开摘要").click();
  const bar = page.getByRole("complementary", { name: "右侧工具台" });
  await expect(bar).toBeVisible();
  await expect(bar.getByText("环境信息")).toBeVisible();
  await expect(bar.getByText("master")).toBeVisible();
  await expect(bar.getByText("+3", { exact: true })).toBeVisible();
  await expect(bar.getByText("-1", { exact: true })).toBeVisible();
  await expect(bar.getByText("123.5K")).toBeVisible(); // formatTokens(123456) → 123.5K
});

test("右侧工具台：Git 面板显示修改统计与增删行", async ({ page }) => {
  await page.route("**/api/git/diff", (route) =>
    route.fulfill({
      json: {
        success: true,
        files: [{ path: "src/main.ts", status: "modified", additions: 3, deletions: 1 }],
      },
    })
  );
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  // 右栏默认收起：先经「打开摘要」唤起（与其它用例一致）
  await page.getByLabel("打开摘要").click();
  const bar = page.getByRole("complementary", { name: "右侧工具台" });
  await bar.waitFor({ timeout: 10000 });
  await bar.getByLabel("Git", { exact: true }).click();
  await expect(bar.getByText("Git 修改")).toBeVisible();
  await expect(bar.getByText("+3", { exact: true })).toBeVisible();
  await expect(bar.getByText("-1", { exact: true })).toBeVisible();
  await expect(bar.getByText("src/main.ts")).toBeVisible();
});
