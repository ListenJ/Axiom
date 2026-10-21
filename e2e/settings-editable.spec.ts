import { test, expect, type Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 设置页「可编辑面板」E2E（2026-10-22）
 *
 * 背景：`search` / `security` 两个分区此前只有只读说明卡，而后端已有写接口
 * （GET/POST `/settings/web-search`、`/settings/approver`）。本轮由不同供应商模型的
 * 子代理实现了两个编辑器组件，Lead 接线并验收：
 *   - SearchSettingsSection   → h3「网络搜索」、引擎 checkbox（aria-label `引擎 <label>`）、
 *                               SearXNG 开关、数值项（返回条数/单引擎超时/缓存 TTL 等）
 *   - ApproverSettingsSection → h3「高危操作审批模型」、combobox aria-label="审批模型"、
 *                               当前值 data-testid="approver-current-model"
 *
 * 网络纪律：只读断言（GET）。**不点击保存**——保存会写 config/web-search.yaml 与 .env，
 * 属破坏性操作；保存路径由两个组件的单元测试用 mock 覆盖（10 tests）。
 * 若编辑器被移除/接错分区/GET 契约漂移，这里会失败。
 */
test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

async function gotoSettings(page: Page): Promise<void> {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "设置", level: 1 }),
  ).toBeVisible({ timeout: 10000 });
}

/** 展开指定分区（Collapsible 触发器带 aria-expanded，标题在按钮内） */
async function openSection(page: Page, title: string): Promise<void> {
  const trigger = page
    .locator("button[aria-expanded]")
    .filter({ hasText: title })
    .first();
  await expect(trigger).toBeVisible({ timeout: 10000 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

test("搜索分区是可编辑面板：引擎开关 + SearXNG + 聚合数值项，且加载到当前值", async ({ page }) => {
  await gotoSettings(page);
  await openSection(page, "搜索");

  // 编辑器标题（只读卡时代是「搜索引擎池」说明卡，没有这块可交互表单）
  await expect(page.getByRole("heading", { name: "网络搜索", level: 3 })).toBeVisible({
    timeout: 10000,
  });

  // 引擎开关：GET /settings/web-search 的 engines 列表逐个渲染 checkbox
  const engineToggles = page.getByRole("checkbox", { name: /^引擎 / });
  await expect(engineToggles.first()).toBeVisible({ timeout: 10000 });
  expect(await engineToggles.count()).toBeGreaterThan(0);

  // SearXNG 自建开关
  await expect(
    page.getByRole("checkbox", { name: "启用 SearXNG（自建）" }),
  ).toBeVisible();

  // 聚合数值项（GET 返回后应带出当前值，而不是空）
  const maxResults = page.getByLabel("返回条数", { exact: true });
  await expect(maxResults).toBeVisible({ timeout: 10000 });
  await expect(maxResults).not.toHaveValue("");

  // 保存按钮存在但本用例不点击（写盘操作仅由单测 mock 覆盖）
  await expect(page.getByRole("button", { name: "保存" })).toBeVisible();
});

test("安全分区是可编辑面板：审批模型下拉 + 当前值", async ({ page }) => {
  await gotoSettings(page);
  await openSection(page, "安全");

  await expect(
    page.getByRole("heading", { name: "高危操作审批模型", level: 3 }),
  ).toBeVisible({ timeout: 10000 });

  const select = page.getByRole("combobox", { name: "审批模型" });
  await expect(select).toBeVisible({ timeout: 10000 });

  // 「自动选择」是展示项（后端 POST 拒绝空 model），编辑器必须把它列出来；
  // 其余 option 来自 GET 的 configuredModels（候选为空时也可只有自动项）。
  await expect(
    select.getByRole("option", { name: /自动选择/ }),
  ).toHaveCount(1);

  // 当前生效模型/来源的可观测输出
  await expect(page.getByTestId("approver-current-model")).toBeVisible();
});
