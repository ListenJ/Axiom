/**
 * P0-4（N-H4）skill-promoter 幂等回归测试。
 *
 * 契约（docs/reviews/2026-08-29-joint-verification-audit.md N-H4）：
 *   - 同一 (intent, agentName) 模式重复 promote → registry 与磁盘 JSON 各仅 1 条；
 *   - 存量 id 带时间后缀（auto-<slug>-xxxx），幂等检查必须按
 *     `id === auto-<slug> || id.startsWith("auto-<slug>-")` 精确前缀匹配；
 *   - slug 前缀歧义：slug "foo" 与 "foobar" 互不误判已存在
 *     （naive startsWith(`auto-${slug}`) 会把 auto-foobar-* 误判为 foo 已存在）。
 */
import { describe, beforeEach, afterEach, test, expect } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  setPromptEngineerForTest,
  setSkillRegistryForTest,
  type PromptEngineerSubset,
  type SkillRegistrySubset,
} from "../src/agents/consciousness/shims.js";
import {
  SkillPromoter,
  DEFAULT_PROMOTER_CONFIG,
} from "../src/agents/consciousness/skill-promoter.js";
import type { PatternCandidate } from "../src/agents/consciousness/types.js";
import type { SkillDefinition } from "../src/skills/types.js";

function memRegistry(): SkillRegistrySubset & { items: SkillDefinition[] } {
  const items: SkillDefinition[] = [];
  return {
    items,
    register: (s: SkillDefinition) => {
      items.push(s);
    },
    list: (): SkillDefinition[] => [...items],
    match: () => null,
    execute: async () => ({
      content: "",
      skillId: "fake",
      model: "fake-model",
      provider: "local",
      latencyMs: 0,
    }),
    reload: () => {},
  } as any;
}

function fakeEngineer(): PromptEngineerSubset {
  return {
    generateSkillWithHermes: async () => {
      // 保证两次 promote 落在不同毫秒（注册 id 的时间后缀不同），消除红阶段偶发同 id。
      await new Promise((r) => setTimeout(r, 2));
      return {
        id: "draft",
        name: "Fake Skill",
        description: "fake description",
        triggers: ["fake"],
        promptTemplate: "fake template",
        requiredTools: [],
        outputFormat: "text",
        version: "1.0",
      };
    },
  };
}

function candidate(intent: string, agentName: string): PatternCandidate {
  return {
    key: `${intent}|${agentName}`,
    intent,
    agentName,
    count: 5,
    windowMs: 3_600_000,
    sampleInputs: ["sample input text"],
  };
}

describe("SkillPromoter idempotency (P0-4)", () => {
  let tmpDir: string;
  let registry: ReturnType<typeof memRegistry>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promoter-idem-"));
    registry = memRegistry();
    setSkillRegistryForTest(registry as any);
    setPromptEngineerForTest(fakeEngineer() as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setSkillRegistryForTest(null);
    setPromptEngineerForTest(null);
  });

  function newPromoter(): SkillPromoter {
    return new SkillPromoter({
      ...DEFAULT_PROMOTER_CONFIG,
      skillDirRel: path.join(tmpDir, "skills"),
    });
  }

  function diskJsonFiles(): string[] {
    const dir = path.join(tmpDir, "skills");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  }

  test("两次 promote 同一模式 → registry 与磁盘 JSON 各仅 1 条", async () => {
    const promoter = newPromoter();
    const cand = candidate("coding", "coder");

    const id1 = await promoter.promote(cand);
    const id2 = await promoter.promote(cand);

    expect(id1).toMatch(/^auto-coding-coder(-|$)/);
    expect(id2).toBeNull(); // 第二次必须被幂等跳过
    expect(registry.items).toHaveLength(1); // registry 无重复注册
    expect(diskJsonFiles()).toHaveLength(1); // 磁盘无重复持久化
  });

  test("slug 前缀歧义：foobar 先注册不误判 foo 已存在", async () => {
    const promoter = newPromoter();

    await promoter.promote(candidate("foobar", ""));
    const fooId = await promoter.promote(candidate("foo", ""));

    expect(fooId).not.toBeNull(); // naive startsWith(`auto-foo`) 会误判跳过
    expect(registry.items).toHaveLength(2);
    expect(diskJsonFiles()).toHaveLength(2);
  });

  test("slug 前缀歧义：foo 先注册不误判 foobar 已存在", async () => {
    const promoter = newPromoter();

    await promoter.promote(candidate("foo", ""));
    const foobarId = await promoter.promote(candidate("foobar", ""));

    expect(foobarId).not.toBeNull();
    expect(registry.items).toHaveLength(2);
    expect(diskJsonFiles()).toHaveLength(2);
  });
});
