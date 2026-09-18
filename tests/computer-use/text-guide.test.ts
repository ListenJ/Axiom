/**
 * 文本引导（Text Guide）测试 — 无视觉模型场景
 */
import { describe, it, expect } from "bun:test";
import { buildTextGuide, elementsToMarkdown, suggestActions } from "../../src/computer-use/text-guide.js";
import type { InteractiveElement } from "../../src/crawl/lightpanda-client.js";

const els: InteractiveElement[] = [
  { index: 0, tag: "button", text: "登录", role: "button", x: 10, y: 20, width: 80, height: 32, centerX: 50, centerY: 36, visible: true, attrs: { id: "login-btn" } },
  { index: 1, tag: "input", text: "请输入用户名", role: "input", x: 10, y: 60, width: 200, height: 36, centerX: 110, centerY: 78, visible: true, attrs: { placeholder: "请输入用户名" } },
  { index: 2, tag: "a", text: "忘记密码", role: "link", x: 10, y: 100, width: 60, height: 20, centerX: 40, centerY: 110, visible: true, attrs: { href: "/forgot" } },
];

describe("buildTextGuide", () => {
  it("生成包含任务/元素表/建议操作/验证步骤的 Markdown 引导", () => {
    const guide = buildTextGuide("用户需要登录系统", els);
    expect(guide.elementCount).toBe(3);
    expect(guide.markdown).toContain("## 任务");
    expect(guide.markdown).toContain("登录");
    expect(guide.markdown).toContain("| Index | Tag | Role | Text | Center (x,y) |");
    expect(guide.markdown).toContain("| 0 | button | button | 登录 | (50,36) | 80×32 |");
    expect(guide.markdown).toContain("## 建议操作");
    expect(guide.markdown).toContain("## 验证");
    expect(guide.markdown).toContain("browser_locate");
    expect(guide.markdown).toContain("browser_launch");
  });

  it("无元素时优雅降级", () => {
    const guide = buildTextGuide("任意任务", []);
    expect(guide.elementCount).toBe(0);
    expect(guide.markdown).toContain("未检测到可交互元素");
    expect(guide.suggestedActions.length).toBe(0);
  });
});

describe("suggestActions", () => {
  it("命中与任务相关的元素并建议点击 + 输入", () => {
    const actions = suggestActions("点击登录按钮登录系统", els);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    const click = actions.find((a) => a.type === "click");
    expect(click?.elementIndex).toBe(0); // 命中"登录" → button #0
    const type = actions.find((a) => a.type === "type");
    expect(type?.elementIndex).toBe(1); // input #1
  });
});

describe("elementsToMarkdown", () => {
  it("渲染表格并处理竖线转义", () => {
    const withPipe: InteractiveElement = { ...els[0], text: "A|B" };
    const md = elementsToMarkdown([withPipe], 10);
    expect(md).toContain("A\\|B");
  });
});
