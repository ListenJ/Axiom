import { test, expect, Page } from "@playwright/test";
import { injectAuth } from "./helpers";

/**
 * 设置页（/settings）E2E —— 2026-10-22 按「Agent 工作区」前端重写。
 *
 * 旧规格（无 name 的 radiogroup 断言、桌面通知 toast、面板透明度 fill 等）随
 * 2026-10 前端重构过时（见 _obsolete-ui-suite.ts）；本规格按当前实现逐条核对，
 * 断言全部锚定以下源码事实：
 *
 *  - pages/Settings.tsx：PageHeader title="设置"（h1）；SETTING_SECTIONS 8 个分区用
 *    Collapsible 渲染（appearance defaultOpen=true，其余 false）；主题 radio 组
 *    aria-label="主题切换"，三个按钮 aria-label 依次为「系统主题」「深色主题」
 *    「浅色主题」；搜索框 aria-label="搜索设置项"。
 *  - components/settings/SettingsSearch.tsx：输入防抖 250ms → POST /settings/search
 *    → 结果渲染 role="listbox" aria-label="设置搜索结果"（li[role=option]，含
 *    section 徽标）；无命中时 role="status" 提示；选中后清空查询并回调 onSelect。
 *  - 后端 routes/settings.ts + core/settings-search.ts：embedding consent 默认 ask
 *    ⇒ createConsentedEmbedder 返回 null ⇒ 纯本地关键词评分，零外部网络请求；
 *    前端另有 clientKeywordSearch 兜底（同样 slice 0..8）。两条路径上限都是 8 条。
 *    搜索「桌面通知」：label 精确子串 +1.2、bigram 全命中 +0.7、同义词表命中 +0.5
 *    ⇒ 必入结果（阈值 0.25）；乱串查询全目录零命中 ⇒ status 兜底。
 *  - state/useApp.ts：setTheme 写 localStorage['axiom:theme']；hooks/useTheme.ts
 *    把解析结果写 documentElement[data-theme]。
 *  - components/ui/Collapsible.tsx：触发按钮 aria-expanded + aria-controls 指向
 *    role="region" 面板；折叠时面板卸载（AnimatePresence）。
 *  - state/useChatPrefs.ts：showThinking 持久化到 localStorage
 *    ['axiom:chat:showThinking']（默认 false）。
 *
 * 网络纪律：不向任何外部引擎提交真实搜索——搜索用例只打本地 /settings/search
 * （未授权 consent 时关键词路径零外部请求），断言结果条数、分区联动与本地状态。
 */

test.beforeEach(async ({ page }) => {
  await injectAuth(page);
});

const STORAGE_THEME = "axiom:theme";

/** 等设置页首屏就绪：PageHeader h1「设置」出现（Settings.tsx 渲染完成） */
async function gotoSettings(page: Page): Promise<void> {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "设置", level: 1 })
  ).toBeVisible({ timeout: 10000 });
}

test("设置页渲染标题与外观分区（默认展开）", async ({ page }) => {
  await gotoSettings(page);

  // 外观分区 defaultOpen=true（settings-data.ts）⇒ 主题切换 radio 组已在 DOM
  const themeGroup = page.getByRole("radiogroup", { name: "主题切换" });
  await expect(themeGroup).toBeVisible();
  const radios = themeGroup.getByRole("radio");
  await expect(radios).toHaveCount(3);
  for (const state of ["系统主题", "深色主题", "浅色主题"]) {
    await expect(themeGroup.getByRole("radio", { name: state })).toBeVisible();
  }
  // 空 localStorage 时 readInitialTheme() 默认 dark ⇒ 深色处于选中态
  await expect(
    themeGroup.getByRole("radio", { name: "深色主题" })
  ).toHaveAttribute("aria-checked", "true");
});

test("主题单选切换为浅色：data-theme 与 localStorage 同步", async ({ page }) => {
  await gotoSettings(page);

  await page
    .getByRole("radiogroup", { name: "主题切换" })
    .getByRole("radio", { name: "浅色主题" })
    .click();
  // useApp.setTheme + useTheme 钩子：DOM 属性与持久化键一起翻转
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), STORAGE_THEME))
    .toBe("light");
  // 单选语义：切换后深色不再处于选中态
  await expect(
    page
      .getByRole("radiogroup", { name: "主题切换" })
      .getByRole("radio", { name: "深色主题" })
  ).toHaveAttribute("aria-checked", "false");
});

test("搜索设置项：本地过滤收窄、联动展开高亮、无命中兜底", async ({ page }) => {
  await gotoSettings(page);

  const searchBox = page.getByLabel("搜索设置项");
  await searchBox.fill("桌面通知");

  // 防抖 250ms 后渲染结果列表（SettingsSearch.tsx role="listbox"）
  const options = page
    .getByRole("listbox", { name: "设置搜索结果" })
    .getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 5000 });
  // 「桌面通知」label 精确命中必在列表中（评分 2.4 ≥ 阈值 0.25），且恰一条
  const hit = options.filter({ hasText: "桌面通知" });
  await expect(hit).toHaveCount(1);
  // 结果带所属分区徽标（getSectionMeta('behavior').label）
  await expect(hit).toContainText("对话与行为");
  // 过滤收窄：结果数在后端/兜底两条路径的公共上限 8 以内，非全目录罗列
  const count = await options.count();
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThanOrEqual(8);

  // 选中结果 → 展开所属分区（behavior 默认折叠）+ 高亮该设置项
  await hit.click();
  const behaviorTrigger = page.getByRole("button", { name: "对话与行为" });
  await expect(behaviorTrigger).toHaveAttribute("aria-expanded", "true");
  // 高亮通过 ring-2 样式类落在设置项卡片上（ToggleRow highlight，首行即桌面通知）
  await expect(
    page
      .getByRole("region", { name: "对话与行为" })
      .locator("div.stagger > div")
      .first()
  ).toHaveClass(/ring-2/);
  // 选中后清空查询与结果（SettingsSearch.pick）
  await expect(
    page.getByRole("listbox", { name: "设置搜索结果" })
  ).toBeHidden();

  // 乱串查询：全目录零命中 ⇒ role=status 未找到提示，结果列表不出现
  await searchBox.fill("zzqq不存在的设置项");
  await expect(
    page.getByRole("status").filter({ hasText: "未找到相关设置项" })
  ).toBeVisible({ timeout: 5000 });
  await expect(
    page.getByRole("listbox", { name: "设置搜索结果" })
  ).toBeHidden();
});

test("Collapsible 分区展开渲染内容（对话与行为默认折叠）", async ({ page }) => {
  await gotoSettings(page);

  const behaviorTrigger = page.getByRole("button", { name: "对话与行为" });
  // settings-data.ts：behavior defaultOpen=false ⇒ 初始折叠，面板不在 DOM
  await expect(behaviorTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("region", { name: "对话与行为" })
  ).toBeHidden();

  await behaviorTrigger.click();
  // 展开：region 挂载，且包含该分区真实设置项（ToggleRow 标题）
  const behaviorPanel = page.getByRole("region", { name: "对话与行为" });
  await expect(behaviorPanel).toBeVisible();
  await expect(
    behaviorPanel.getByText("桌面通知", { exact: true })
  ).toBeVisible();

  // 再折叠：面板卸载
  await behaviorTrigger.click();
  await expect(behaviorPanel).toBeHidden();
});

test("对话偏好开关：showThinking 持久化到 localStorage", async ({ page }) => {
  await gotoSettings(page);

  // 展开对话与行为分区
  await page.getByRole("button", { name: "对话与行为" }).click();
  const behaviorPanel = page.getByRole("region", { name: "对话与行为" });

  // 默认关闭（useChatPrefs readBool fallback=false，测试上下文全新 profile）
  const toggle = behaviorPanel.getByRole("switch", {
    name: "切换 显示思考过程",
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  await toggle.click();
  // aria 状态 + zustand 持久化键同步翻转
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("axiom:chat:showThinking"))
    )
    .toBe("true");
});
