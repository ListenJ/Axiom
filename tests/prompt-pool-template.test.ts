/**
 * prompt-pool 动态后缀模板替换对齐测试（审计 B2-M1）。
 *
 * 背景：assemblePrompt 的替换 pattern 曾与 dynamicSuffixTemplate 实际文本失配
 * （模板含 "## Context" 行，pattern 不含），替换永不命中 → 残留占位符垃圾进 system prompt，
 * orchestrator/component-bootstrap 等消费方的动态上下文静默丢失。
 *
 * Contract:
 *   - 传 context/user_input 后渲染输出包含其值，且不含任何 Handlebars 残留；
 *   - context/user_input 缺省时对应区块整体消失；
 *   - examples 提供时渲染条目、缺省时区块消失；
 *   - 消费方路径（orchestrator / component-bootstrap 调用形状）同样无残留。
 */
import { describe, test, expect } from "bun:test";
import { UserAgentPromptPool } from "../src/agents/prompt-pool.js";

const RESIDUE_PATTERNS = [
  "{{#if",
  "{{/if}}",
  "{{#each",
  "{{/each}}",
  "{{context}}",
  "{{user_input}}",
  "{{task_description}}",
  "{{this.input}}",
  "{{this.output}}",
] as const;

function expectNoResidue(text: string) {
  for (const pattern of RESIDUE_PATTERNS) {
    expect(text).not.toContain(pattern);
  }
}

describe("prompt-pool dynamic suffix rendering", () => {
  test("context + user_input 提供时渲染其值且无占位符残留", () => {
    const pool = new UserAgentPromptPool();
    const prompt = pool.acquire("main_coding", {
      task_description: "Implement login feature",
      context: "Auth spec v2: OAuth2 + PKCE",
      user_input: "Please follow existing conventions",
    });

    expect(prompt.systemPrompt).toContain("Implement login feature");
    expect(prompt.systemPrompt).toContain("## Context");
    expect(prompt.systemPrompt).toContain("Auth spec v2: OAuth2 + PKCE");
    expect(prompt.systemPrompt).toContain("## User Input");
    expect(prompt.systemPrompt).toContain("Please follow existing conventions");
    expectNoResidue(prompt.systemPrompt);
    expectNoResidue(prompt.dynamicSuffix);
  });

  test("context/user_input/examples 缺省时对应区块整体消失且无残留", () => {
    const pool = new UserAgentPromptPool();
    const prompt = pool.acquire("research", { task_description: "Deep research only" });

    expect(prompt.systemPrompt).toContain("Deep research only");
    expect(prompt.systemPrompt).not.toContain("## Context");
    expect(prompt.systemPrompt).not.toContain("## User Input");
    expect(prompt.systemPrompt).not.toContain("## Examples");
    expectNoResidue(prompt.systemPrompt);
  });

  test("消费方路径（orchestrator/component-bootstrap 调用形状：JSON.stringify 或 undefined）无残留", () => {
    const pool = new UserAgentPromptPool();
    const taskWithContext = { description: "Refactor module", context: { files: ["a.ts"], depth: 2 } };
    const withCtx = pool.acquire("general_chat", {
      task_description: taskWithContext.description,
      context: taskWithContext.context ? JSON.stringify(taskWithContext.context) : undefined,
    });
    expect(withCtx.systemPrompt).toContain(JSON.stringify(taskWithContext.context));
    expectNoResidue(withCtx.systemPrompt);

    const taskNoContext: { description: string; context?: Record<string, unknown> } = { description: "Plain task" };
    const noCtx = pool.acquire("general_chat", {
      task_description: taskNoContext.description,
      context: taskNoContext.context ? JSON.stringify(taskNoContext.context) : undefined,
    });
    expect(noCtx.systemPrompt).not.toContain("## Context");
    expectNoResidue(noCtx.systemPrompt);
  });

  test("examples 提供时渲染条目、缺省时区块消失", () => {
    const pool = new UserAgentPromptPool();
    const withExamples = pool.acquire("tool_use", {
      task_description: "Translate text",
      examples: [{ input: "hello", output: "bonjour" }],
    });
    expect(withExamples.systemPrompt).toContain("## Examples");
    expect(withExamples.systemPrompt).toContain("Input: hello");
    expect(withExamples.systemPrompt).toContain("Output: bonjour");
    expectNoResidue(withExamples.systemPrompt);

    const noExamples = pool.acquire("tool_use", { task_description: "Translate text" });
    expect(noExamples.systemPrompt).not.toContain("## Examples");
    expectNoResidue(noExamples.systemPrompt);
  });
});
