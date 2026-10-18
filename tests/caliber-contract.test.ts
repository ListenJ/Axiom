/**
 * 口径契约门（C 系列）—— 术语口径可机器判定的一致性检查
 *
 * 目的（对齐口径/指令遵循信息偏差）：把"项目术语是什么、不许被曲解成什么"从
 * 散文里抽成一张可判定的表，使任一术语无法被静默换义——换义会让本门变红。
 * 覆盖：
 *   C1 结构自洽：id/canonical 唯一、domain 在册、每条至少一条禁改口径与一条 evidence；
 *   C2 双源一致：运行时表（src/semantic/caliber-registry.ts）== 声明表（config/caliber.json）；
 *   C3 溯源锚：每条 owner 文件存在，且 canonical 术语与每条 evidence 引文逐字出现在 owner 中；
 *   C4 注入段：formatGlossaryBlock 确定性、覆盖每个 canonical 恰好一次；
 *   C5 开关：默认关闭（未设置 = 空注入 = 零行为变更）；
 *   C6 注入 seam：bootstrap.toSystemPrompt 默认不含注入段、开关开启才含。
 *
 * 诚实边界（与 tests/doc-contract.test.ts 同族）：本门只证明"术语与定义锚在权威源中
 * 真实存在、两侧表未漂移、默认不注入"，**不**证明 definition 是权威原文的逐字完美
 * 转述（那是散文，不受机器门保护）。故 caliber.json 的 definition 只作规范短式，
 * 权威定义仍以 owner 文件为准。
 *
 * 反空转自检（C3）：门自身必须能因违规变红——用一条被篡改的 evidence 断言
 * groundingProblems 非空，证明本门不是恒绿空转。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import {
  CALIBER_ENTRIES,
  CALIBER_DOMAINS,
  CALIBER_GLOSSARY_ENV,
  CALIBER_GLOSSARY_MARKER,
  CALIBER_GLOSSARY_END,
  CALIBER_SOURCE_PATH,
  glossaryEnabled,
  formatGlossaryBlock,
  renderCaliberSection,
  type CaliberEntry,
  type CaliberDomain,
} from "../src/semantic/caliber-registry.js";
import { AgentBootstrap } from "../src/memory/bootstrap.js";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(repoRoot, rel));

interface CaliberRegistry {
  version: string;
  domains: string[];
  entries: CaliberEntry[];
}
const declared: CaliberRegistry = JSON.parse(read(CALIBER_SOURCE_PATH));

// ─── C3 溯源锚判定（抽成函数，供反空转自检复用）────────────────────────────────
function groundingProblems(
  entries: readonly CaliberEntry[],
  readFn: (rel: string) => string,
  existsFn: (rel: string) => boolean,
): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    if (!existsFn(e.owner)) {
      problems.push(`${e.id}: owner 不存在 ${e.owner}`);
      continue;
    }
    const text = readFn(e.owner);
    if (!text.includes(e.canonical)) {
      problems.push(`${e.id}: owner ${e.owner} 中未出现术语『${e.canonical}』`);
    }
    for (const quote of e.evidence) {
      if (!text.includes(quote)) {
        problems.push(`${e.id}: evidence 引文未逐字出现在 ${e.owner}：『${quote}』`);
      }
    }
  }
  return problems;
}

// ─── C1 结构自洽 ──────────────────────────────────────────────────────────────
describe("C1 口径契约结构自洽", () => {
  it("声明的 domains 与运行时 CALIBER_DOMAINS 完全一致", () => {
    expect(declared.domains).toEqual([...CALIBER_DOMAINS]);
  });

  it("id 与 canonical 各自唯一", () => {
    const ids = CALIBER_ENTRIES.map((e) => e.id);
    const canonicals = CALIBER_ENTRIES.map((e) => e.canonical);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it("domain 在册、definition 非空、每条至少一条禁改口径与一条 evidence", () => {
    const problems: string[] = [];
    for (const e of CALIBER_ENTRIES) {
      if (!CALIBER_DOMAINS.includes(e.domain as CaliberDomain)) {
        problems.push(`${e.id}: domain 不在册 ${e.domain}`);
      }
      if (!e.definition.trim()) problems.push(`${e.id}: definition 为空`);
      if (e.forbiddenRedefinitions.length < 1) problems.push(`${e.id}: 缺少 forbiddenRedefinitions`);
      if (e.evidence.length < 1) problems.push(`${e.id}: 缺少 evidence`);
    }
    expect(problems).toEqual([]);
  });

  it("别名不得与其它术语的 canonical 或 alias 冲突", () => {
    const canonicalSet = new Set(CALIBER_ENTRIES.map((e) => e.canonical));
    const seen = new Map<string, string>(); // token -> 首次出现的 entry id
    const problems: string[] = [];
    for (const e of CALIBER_ENTRIES) {
      for (const token of [e.canonical, ...e.aliases]) {
        const prev = seen.get(token);
        if (prev && prev !== e.id) problems.push(`'${token}' 被 ${prev} 与 ${e.id} 同时占用`);
        else seen.set(token, e.id);
        if (e.aliases.includes(token) && canonicalSet.has(token) && token !== e.canonical) {
          problems.push(`${e.id}: 别名 '${token}' 是另一个术语的 canonical`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

// ─── C2 双源一致：运行时表 == 声明表 ──────────────────────────────────────────
describe("C2 运行时表与 config/caliber.json 逐字段一致", () => {
  it("条目数与顺序一致", () => {
    expect(CALIBER_ENTRIES.length).toBe(declared.entries.length);
  });

  it("每个字段两侧相等（改一处必须同步改另一处）", () => {
    const diffs: string[] = [];
    for (let i = 0; i < CALIBER_ENTRIES.length; i++) {
      const code = CALIBER_ENTRIES[i];
      const json = declared.entries[i];
      if (!json) {
        diffs.push(`${code.id}: 声明表缺少该条目`);
        continue;
      }
      for (const k of ["id", "canonical", "en", "domain", "definition", "owner"] as const) {
        if (code[k] !== json[k]) diffs.push(`${code.id}.${k}: code=${JSON.stringify(code[k])} json=${JSON.stringify(json[k])}`);
      }
      for (const k of ["aliases", "forbiddenRedefinitions", "evidence"] as const) {
        if (JSON.stringify(code[k]) !== JSON.stringify(json[k])) {
          diffs.push(`${code.id}.${k}: 两侧不一致`);
        }
      }
    }
    expect(diffs).toEqual([]);
  });
});

// ─── C3 溯源锚：术语与定义必须真实存在于权威源 ────────────────────────────────
describe("C3 每条口径都有真实溯源锚", () => {
  it("owner 存在，且 canonical 术语与每条 evidence 引文逐字出现在 owner 中", () => {
    expect(groundingProblems(CALIBER_ENTRIES, read, exists)).toEqual([]);
  });

  it("反空转自检：篡改一条 evidence 后本判据必须变红（证明门非恒绿空转）", () => {
    const tampered: CaliberEntry[] = CALIBER_ENTRIES.map((e) =>
      e.id === CALIBER_ENTRIES[0].id ? { ...e, evidence: ["本仓库中绝不存在的捏造引文__NOPE__"] } : e,
    );
    expect(groundingProblems(tampered, read, exists).length).toBeGreaterThan(0);
  });

  it("反空转自检：owner 指向不存在的文件必须变红", () => {
    const tampered: CaliberEntry[] = CALIBER_ENTRIES.map((e) =>
      e.id === CALIBER_ENTRIES[0].id ? { ...e, owner: "docs/__does_not_exist__.md" } : e,
    );
    expect(groundingProblems(tampered, read, exists).length).toBeGreaterThan(0);
  });
});

// ─── C4 注入段 ────────────────────────────────────────────────────────────────
describe("C4 注入段确定性且完整", () => {
  it("以标记起止包裹，且每个 canonical 作为条目头恰好出现一次", () => {
    const block = formatGlossaryBlock();
    expect(block.startsWith(CALIBER_GLOSSARY_MARKER)).toBe(true);
    expect(block.endsWith(CALIBER_GLOSSARY_END)).toBe(true);
    expect(block).toContain(CALIBER_SOURCE_PATH);
    const lines = block.split("\n");
    for (const e of CALIBER_ENTRIES) {
      // 条目头形态：`- {canonical} / {en} [domain]：…` 或 `- {canonical} [domain]：…`。
      // 不能用子串计数：canonical『口径』会出现在每个条目的『禁改口径』标签里。
      const hits = lines.filter((l) => l.startsWith(`- ${e.canonical} /`) || l.startsWith(`- ${e.canonical} [`));
      expect(hits.length, `${e.id} 条目头出现 ${hits.length} 次`).toBe(1);
    }
  });

  it("确定性：同输入两次渲染逐字相同", () => {
    expect(formatGlossaryBlock()).toBe(formatGlossaryBlock());
  });

  it("禁改口径全文进入注入段（使曲解口径对被注入方可见）", () => {
    const block = formatGlossaryBlock();
    for (const e of CALIBER_ENTRIES) {
      for (const bad of e.forbiddenRedefinitions) {
        expect(block).toContain(bad);
      }
    }
  });
});

// ─── C5 开关默认关闭 ──────────────────────────────────────────────────────────
describe("C5 注入开关默认关闭（零行为变更）", () => {
  it("未设置 / 空值 / 无法识别一律关闭", () => {
    expect(glossaryEnabled({})).toBe(false);
    expect(glossaryEnabled({ [CALIBER_GLOSSARY_ENV]: "" })).toBe(false);
    expect(glossaryEnabled({ [CALIBER_GLOSSARY_ENV]: "maybe" })).toBe(false);
    expect(glossaryEnabled({ [CALIBER_GLOSSARY_ENV]: "0" })).toBe(false);
  });

  it("仅 1/true/yes（大小写不敏感）开启", () => {
    expect(glossaryEnabled({ [CALIBER_GLOSSARY_ENV]: "1" })).toBe(true);
    expect(glossaryEnabled({ [CALIBER_GLOSSARY_ENV]: "TRUE" })).toBe(true);
    expect(glossaryEnabled({ [CALIBER_GLOSSARY_ENV]: " yes " })).toBe(true);
  });

  it("关闭时注入段为空串", () => {
    expect(renderCaliberSection({})).toBe("");
    expect(renderCaliberSection({ [CALIBER_GLOSSARY_ENV]: "0" })).toBe("");
  });
});

// ─── C6 注入 seam：默认不动 bootstrap 输出 ────────────────────────────────────
describe("C6 bootstrap 注入 seam 默认零行为变更", () => {
  const ctx = {
    personality: "",
    userPreferences: "",
    identity: "",
    dailyLog: "",
    relevantMemories: [],
    systemStatus: { version: "test", vaultNotes: 0, availableModels: [], lastBoot: "test" },
    bootTime: "test",
  };
  const proto = AgentBootstrap.prototype as unknown as { toSystemPrompt(ctx: unknown): string };

  it("bootstrap.ts 确实接线到 renderCaliberSection（seam 不可被静默移除）", () => {
    const src = read("src/memory/bootstrap.ts");
    expect(src).toContain("renderCaliberSection");
    expect(src).toContain('from "../semantic/caliber-registry.js"');
  });

  it("开关关闭时输出不含注入段；开启时含——即默认逐字不变", () => {
    const original = process.env[CALIBER_GLOSSARY_ENV];
    try {
      delete process.env[CALIBER_GLOSSARY_ENV];
      const off = proto.toSystemPrompt.call({}, ctx);
      expect(off).not.toContain(CALIBER_GLOSSARY_MARKER);
      expect(off).not.toContain(CALIBER_SOURCE_PATH);

      process.env[CALIBER_GLOSSARY_ENV] = "1";
      const on = proto.toSystemPrompt.call({}, ctx);
      expect(on).toContain(CALIBER_GLOSSARY_MARKER);
      // 开启后 = 关闭输出基础上插入注入段；去掉注入段后应与关闭版一致
      const stripped = on.replace(`${formatGlossaryBlock()}\n\n`, "");
      expect(stripped).toBe(off);
    } finally {
      if (original === undefined) delete process.env[CALIBER_GLOSSARY_ENV];
      else process.env[CALIBER_GLOSSARY_ENV] = original;
    }
  });
});
