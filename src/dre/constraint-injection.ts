/**
 * DRE 约束自动注入（Constraint Auto-Injection）
 *
 * 需求 4：LLM 遇到已知问题（来自实践手册错误记录）时，自动调用确定性推理
 * 引擎（关键词匹配 → 取约束词），把结果**插入输入的约束词**后传给 LLM。
 *
 * 流程：
 *   1. 扫描消息文本/角色 → findPracticeEntries 命中（纯确定性）；
 *   2. buildConstraintWords 生成约束块（含来源 id，可追溯）；
 *   3. injectConstraints 把约束块注入 system 消息（或追加到最近 user 消息）；
 *   4. autoInjectDreConstraints 返回改造后的消息，供调用方在 LLM 调用前使用。
 */

import { logger } from "../utils/logger.js";
import { findPracticeEntries, PRACTICE_ENTRIES, type PracticeEntry } from "./practice-manual.js";

/**
 * 本地最小消息结构（整改 D3，2026-08-25）：替代对 router/provider-caller
 * ChatMessage 的类型导入，解除 dre→router 依赖方向违规与循环导入。
 * 结构兼容：router ChatMessage 可直接赋值（多余字段保留）。
 */
export interface DreChatMessage {
  role: string;
  content: string;
}

export interface ConstraintInjectionResult<T extends DreChatMessage = DreChatMessage> {
  messages: T[];
  /** 实际注入的条目 id */
  injected: string[];
  /** 是否发生注入 */
  changed: boolean;
}

/** 由条目生成约束词块（可追溯来源 id） */
export function buildConstraintWords(entries: PracticeEntry[]): string {
  if (entries.length === 0) return "";
  const body = entries
    .map((e) => `- [${e.id}] ${e.constraint}`)
    .join("\n");
  return `\n[DRE 约束注入 — 来自确定性推理引擎实践手册]\n${body}\n[约束来源可追溯：${entries.map((e) => e.id).join(", ")}]\n`;
}

/** 从文本中提取约束块（关键词命中） */
export function constraintWordsFor(text: string): { words: string; entries: PracticeEntry[] } {
  const entries = findPracticeEntries(text);
  return { words: buildConstraintWords(entries), entries };
}

/** 把约束词注入消息：优先追加到现有 system 消息，否则新建 system 消息 */
export function injectConstraints(messages: DreChatMessage[], words: string): DreChatMessage[] {
  if (!words) return messages;
  const next = messages.map((m) => ({ ...m }));
  const sysIdx = next.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    next[sysIdx] = { ...next[sysIdx], content: `${next[sysIdx].content}\n${words}` };
  } else {
    next.unshift({ role: "system", content: words.trim() });
  }
  return next;
}

/**
 * 自动注入（LLM 调用前的接缝）：扫描消息文本 → 命中实践手册 → 注入约束词。
 * 幂等：已含 "[DRE 约束注入" 标记的消息不再重复注入。
 * 泛型：保留调用方消息元素类型（如 router ChatMessage）不降级。
 */
export function autoInjectDreConstraints<T extends DreChatMessage>(
  messages: T[],
  extraContext = "",
): ConstraintInjectionResult<T> {
  const text = [...messages.map((m) => m.content), extraContext].join("\n");
  if (text.includes("[DRE 约束注入")) {
    return { messages, injected: [], changed: false };
  }
  const { words, entries } = constraintWordsFor(text);
  if (!words) return { messages, injected: [], changed: false };
  const next = injectConstraints(messages, words) as T[];
  const injected = entries.map((e) => e.id);
  logger.info("[DRE] constraint injection", { injected, source: "practice-manual" });
  return { messages: next, injected, changed: true };
}

/** 便捷：对单段用户文本生成注入后的 system + user 消息（供测试/工具） */
export function buildMessagesWithConstraints(userText: string): { messages: DreChatMessage[]; injected: string[] } {
  const result = autoInjectDreConstraints([{ role: "user", content: userText }]);
  return { messages: result.messages, injected: result.injected };
}

/** 手册规模（供工具/诊断） */
export function practiceManualStats(): { total: number; keywords: number } {
  const keywords = PRACTICE_ENTRIES.reduce((acc, e) => acc + e.keywords.length, 0);
  return { total: PRACTICE_ENTRIES.length, keywords };
}
