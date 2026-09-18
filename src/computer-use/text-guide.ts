/**
 * 文本引导（Text Guide）— 无视觉模型时的前端视觉场景适配
 *
 * 需求 3：用户没有视觉模型时，不丢给用户一句"配置视觉模型"，而是
 * 基于 CDP 提取的可交互元素（精确坐标）生成**结构化的文字引导**：
 *   1. 任务重述
 *   2. 页面可交互元素表（index/类型/文本/中心坐标/尺寸）→ 精确定位
 *   3. 建议操作序列（click/type/keypress，引用 elementIndex）
 *   4. 人工/无头浏览器验证步骤
 *
 * 全部纯函数、可测试、零网络。定位精度由 CDP 的 getBoundingClientRect 保证。
 */

import type { InteractiveElement } from "../crawl/lightpanda-client.js";

export interface TextGuideOptions {
  /** 元素表最多展示条数（默认 50） */
  maxElements?: number;
}

export interface SuggestedAction {
  type: "click" | "type" | "keypress";
  elementIndex?: number;
  text?: string;
  keys?: string[];
  description: string;
}

export interface TextGuideResult {
  task: string;
  elementCount: number;
  /** Markdown 引导正文（可直接展示给用户 / 插入 LLM 上下文） */
  markdown: string;
  elements: InteractiveElement[];
  suggestedActions: SuggestedAction[];
}

/** 把元素渲染为 Markdown 表格（纯函数） */
export function elementsToMarkdown(elements: InteractiveElement[], max = 50): string {
  if (elements.length === 0) return "_（未检测到可交互元素）_";
  const lines = ["| Index | Tag | Role | Text | Center (x,y) | Size (w×h) |", "|-------|-----|------|------|--------------|------------|"];
  for (const el of elements.slice(0, max)) {
    const text = el.text.replace(/\|/g, "\\|").slice(0, 40) || "-";
    lines.push(`| ${el.index} | ${el.tag} | ${el.role} | ${text} | (${el.centerX},${el.centerY}) | ${el.width}×${el.height} |`);
  }
  if (elements.length > max) lines.push(`| … 还有 ${elements.length - max} 个元素 |`);
  return lines.join("\n");
}

/** 根据任务关键词建议首批操作（纯函数、启发式） */
export function suggestActions(task: string, elements: InteractiveElement[]): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const t = task.toLowerCase();
  // 找到候选"目标元素"：文本/role 与任务关键词重叠
  const target = elements.find((el) => {
    const hay = `${el.text} ${el.role} ${el.tag} ${Object.values(el.attrs).join(" ")}`.toLowerCase();
    return t.split(/\s+/).some((w) => w.length >= 2 && hay.includes(w));
  });
  if (target) {
    actions.push({ type: "click", elementIndex: target.index, description: `点击与任务相关的元素 #${target.index}（${target.text.slice(0, 30)}）` });
  } else if (elements.length > 0) {
    actions.push({ type: "click", elementIndex: elements[0].index, description: `点击首个可交互元素 #${elements[0].index}` });
  }
  // 有输入框则建议输入
  const input = elements.find((el) => el.tag === "input" || el.tag === "textarea" || el.role === "input");
  if (input) {
    actions.push({ type: "type", elementIndex: input.index, text: "", description: `在输入框 #${input.index} 中输入内容` });
  }
  return actions;
}

/** 生成完整文本引导（纯函数、可测试） */
export function buildTextGuide(task: string, elements: InteractiveElement[], opts: TextGuideOptions = {}): TextGuideResult {
  const max = opts.maxElements ?? 50;
  const markdown = [
    `## 任务`,
    task,
    ``,
    `## 页面可交互元素（${elements.length} 个，坐标为 CDP 实测）`,
    ``,
    elementsToMarkdown(elements, max),
    ``,
    `## 建议操作`,
    ...(suggestActions(task, elements).map((a, i) => `${i + 1}. ${a.description}（type=${a.type}${a.elementIndex !== undefined ? `, elementIndex=${a.elementIndex}` : ""}）`)),
    ``,
    `## 验证`,
    `- 使用无头浏览器定位：调用 browser_locate（url + 关键词）可拿到精确边界框。`,
    `- 若需真实浏览器：调用 browser_launch（url）在用户默认浏览器中打开，再按上方元素表核对。`,
  ].join("\n");

  return {
    task,
    elementCount: elements.length,
    markdown,
    elements,
    suggestedActions: suggestActions(task, elements),
  };
}
