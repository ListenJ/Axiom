/**
 * DRE 约束自动注入测试 — 实践手册 → LLM 输入约束词
 */
import { describe, it, expect } from "bun:test";
import {
  findPracticeEntries,
  PRACTICE_ENTRIES,
} from "../src/dre/practice-manual.js";
import {
  buildConstraintWords,
  constraintWordsFor,
  injectConstraints,
  autoInjectDreConstraints,
  buildMessagesWithConstraints,
  practiceManualStats,
} from "../src/dre/constraint-injection.js";

describe("practice-manual", () => {
  it("条目齐全（含平台与视觉场景）", () => {
    const stats = practiceManualStats();
    expect(stats.total).toBeGreaterThanOrEqual(7);
    const ids = PRACTICE_ENTRIES.map((e) => e.id);
    expect(ids).toContain("practice/sqlite-busy");
    expect(ids).toContain("practice/platform-command");
    expect(ids).toContain("practice/no-vision-model");
  });

  it("按关键词命中（大小写不敏感）", () => {
    expect(findPracticeEntries("遇到了 SQLITE_BUSY database is locked").map((e) => e.id)).toContain("practice/sqlite-busy");
    expect(findPracticeEntries("在 Linux 上 xdg-open 打开").map((e) => e.id)).toContain("practice/platform-command");
    expect(findPracticeEntries("普通文本").length).toBe(0);
  });
});

describe("constraint-injection", () => {
  it("生成可追溯约束词块", () => {
    const { words, entries } = constraintWordsFor("页面截图失败，没有视觉模型");
    expect(entries.length).toBeGreaterThan(0);
    expect(words).toContain("[DRE 约束注入");
    expect(words).toContain("practice/no-vision-model");
  });

  it("注入到现有 system 消息", () => {
    const messages = [
      { role: "system" as const, content: "你是一个助手。" },
      { role: "user" as const, content: "遇到 SQLITE_BUSY 怎么办" },
    ];
    const out = injectConstraints(messages as never, buildConstraintWords(findPracticeEntries("SQLITE_BUSY")));
    expect(out[0].content).toContain("[DRE 约束注入");
    expect(out.length).toBe(2);
  });

  it("无 system 消息时前置新建 system", () => {
    const out = injectConstraints([{ role: "user" as const, content: "hi" }], "[DRE 约束注入] x");
    expect(out[0].role).toBe("system");
    expect(out[1].role).toBe("user");
  });

  it("autoInjectDreConstraints：命中→注入；未命中→不变；重复调用幂等", () => {
    const hit = autoInjectDreConstraints([{ role: "user", content: "SQLite 报 database is locked，怎么处理？" }]);
    expect(hit.changed).toBe(true);
    expect(hit.injected).toContain("practice/sqlite-busy");
    expect(hit.messages.some((m) => m.content.includes("[DRE 约束注入"))).toBe(true);

    const miss = autoInjectDreConstraints([{ role: "user", content: "帮我写一段快速排序" }]);
    expect(miss.changed).toBe(false);
    expect(miss.injected).toEqual([]);

    const again = autoInjectDreConstraints(hit.messages);
    expect(again.changed).toBe(false);
    expect(again.injected).toEqual([]);
  });

  it("buildMessagesWithConstraints 返回注入后的消息", () => {
    const { messages, injected } = buildMessagesWithConstraints("linux 上怎么用 xdg-open 打开浏览器");
    expect(injected).toContain("practice/platform-command");
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("xdg-open");
  });
});

describe("constraint-injection — 误触发防护（关键词收紧）", () => {
  it("普通业务文本不注入无关约束", () => {
    const cases = [
      "帮我用 API 写一个登录接口",
      "用 LLM 总结这段对话",
      "在 Windows 上安装软件",
      "把代码部署到 Linux 服务器",
      "这个模型延迟有点高",
      "帮我截个图看看",
      "网络请求超时了，请重试",
    ];
    for (const text of cases) {
      const r = autoInjectDreConstraints([{ role: "user", content: text }]);
      expect(r.changed).toBe(false);
      expect(r.injected).toEqual([]);
    }
  });

  it("真正的实践手册场景仍命中", () => {
    const r = autoInjectDreConstraints([{ role: "user", content: "单元测试访问 github.com 超时" }]);
    expect(r.changed).toBe(true);
    expect(r.injected).toContain("practice/network-test-timeout");
  });
});
