/**
 * 文档↔代码一致性门（D 系列）
 *
 * 目的：把"确定性推理"口径变成可机器判定的命题，使口径无法被静默写坏或静默绕过。
 * 覆盖：D1 禁语（含 src/tests 的 .ts）+ 全部 markdown 文本完整（BOM/CR/C0） / D2 权威唯一 / D3 文档引用不死（反引号路径 +
 *       markdown 本地链接） / D4 禁手抄行数 /
 *       D5 非确定组件登记 ↔ 代码默认值 / D6 登记表 ↔ 文档表 / D7 decision 存量棘轮 /
 *       D8 文档列出的 MCP 领域文件 ↔ 实际注册点 / D9 禁 file:line 手抄锚点
 *
 * 边界（诚实声明）：本门只覆盖可机器判定命题。散文论述不受保护 —— 因此规范文档中
 * 不得写入定量指标与绝对断言，只允许指向本门与 config/nondeterminism.json 的指针。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(repoRoot, rel));

interface RegistryEntry {
  id: string;
  name: string;
  role: string;
  switch: string | null;
  switchFile: string;
  codeFile: string;
  default: string;
  defaultVia: "readString-default" | "isEdgeEnabled" | "presence";
}
interface Registry {
  ratchet: { maxDecisionRoles: number; targetDecisionRoles: number };
  defaults: Record<string, { file: string; value: string }>;
  entries: RegistryEntry[];
}

const registry: Registry = JSON.parse(read("config/nondeterminism.json"));

// ─── 口径扫描范围 ────────────────────────────────────────────────────────────
const BANNED = [
  "零向量", "零概率", "零 embedding", "零embedding",
  "不使用任何 ML", "不使用任何模型", "不使用任何 ML 模型",
];

// 历史结论件按名字显式豁免（评审/审计/评估/操作日志保留原话作为证据）；
// 带日期的**策略件**（如 BROWSER-AGENT-STRATEGY-2026-08-09.md）不豁免，仍在口径范围内。
const HISTORY = /(^|\/)(operations-log|CHANGELOG)\.md$|REVIEW|AUDIT|ASSESSMENT|EVALUATION/;

function mdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(full));
    else if (e.name.endsWith(".md")) out.push(path.relative(repoRoot, full));
  }
  return out;
}

function caliberDocs(): string[] {
  // docs/superpowers/ 下是设计与实施记录（引用问题原话作为证据），与历史结论件同样豁免口径扫描。
  return mdFiles("docs").filter((f) => !f.startsWith("docs/superpowers/"));
}

// 规范件 = 口径文档去掉历史结论件，再加 README。D3/D4 的保护范围即此集合。
// AGENTS.md 不入 D3：其 `docs/services.md` 是有意的墓碑（规则 11 记录"已移出的敏感文件"），
// 引用一个"必须不存在"的路径正是该句的语义，机器门不应把警告改成沉默。
function specDocs(): string[] {
  return caliberDocs()
    .filter((f) => !HISTORY.test(path.basename(f)))
    .concat(exists("README.md") ? ["README.md"] : []);
}

function caliberScope(): string[] {
  const docs = caliberDocs().filter((f) => !HISTORY.test(path.basename(f)));
  const ts = walkTs("src").concat(walkTs("tests"));
  // 本门自身逐字写出禁语清单，扫描自己必然自锁 —— 排除（理由见文件头边界声明）。
  const self = "tests/doc-contract.test.ts";
  return ["README.md", "AGENTS.md", ...docs, ...ts].filter((f) => exists(f) && f !== self);
}

function walkTs(dir: string): string[] {
  if (!fs.existsSync(path.join(repoRoot, dir))) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    if (e.name === "_archive" || e.name === "node_modules") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(rel));
    else if (rel.endsWith(".ts") && !rel.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

// ─── D1 禁语：绝对化断言不得回流到规范件与源码注释 ────────────────────────────
describe("D1 口径禁语", () => {
  it("BANNED 短语在口径范围内 0 命中", () => {
    const hits: string[] = [];
    for (const rel of caliberScope()) {
      const lines = read(rel).split("\n");
      lines.forEach((line, i) => {
        const hit = BANNED.find((phrase) => line.includes(phrase));
        if (hit) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("vault 生成件（openclaw-memory 笔记）同样不含禁语", () => {
    const hits: string[] = [];
    for (const rel of mdFiles("openclaw-memory")) {
      read(rel).split("\n").forEach((line, i) => {
        if (BANNED.some((phrase) => line.includes(phrase))) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("全部 markdown 文档文本完整：无 BOM / 无 CR / 无 C0（TAB 仅允许行首缩进）", () => {
    // 实测依据：同一写入路径把单字母替换成它的转义控制符，静默吃掉标识符首字母 ——
    // README.md: "research"→CR+"esearch"、"tool_use"→TAB+"ool_use"，一个 ``` 围栏被压成单反引号；
    // docs/operations-log.md: 39 处（"frontend"→FF+"rontend"、"bunx"→BS+"unx"、"tests"→TAB+"ests"、
    // 一处 commit hash 首字母变 NUL，使整个文件被 grep 判为二进制）。
    // 这类损伤读 diff 看不出来，且会让"按字面串比对文档与代码"的门产生假阴性 —— 故历史件也在完整性范围内。
    const offenders: string[] = [];
    const scanned = mdFiles("docs").concat(exists("README.md") ? ["README.md"] : []);
    for (const rel of scanned) {
      const buf = fs.readFileSync(path.join(repoRoot, rel));
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) offenders.push(`${rel}: BOM`);
      buf.toString("utf8").split("\n").forEach((line, i) => {
        if (line.includes("\r")) offenders.push(`${rel}:${i + 1}: CR`);
        [...line].forEach((ch, col) => {
          const code = ch.charCodeAt(0);
          if (code < 32 && !(ch === "\t" && col === 0)) {
            offenders.push(`${rel}:${i + 1}: 控制字符 0x${code.toString(16)}`);
          }
        });
      });
    }
    expect(offenders).toEqual([]);
    // 覆盖面自证：范围被悄悄收窄时本条先红
    expect(scanned.length).toBeGreaterThan(20);
  });
});

// ─── D2 权威唯一：多源复制是文档失真的结构根因 ────────────────────────────────
describe("D2 权威文档唯一", () => {
  it("自称式「唯一权威」命中 ≤ 1 且落在 AXIOM-ARCHITECTURE.md", () => {
    const selfClaims: string[] = [];
    for (const rel of caliberDocs().concat(["README.md"])) {
      if (!exists(rel) || HISTORY.test(path.basename(rel))) continue;
      read(rel).split("\n").forEach((line, i) => {
        if (!line.includes("唯一权威")) return;
        const isForward = /已合并到|已迁移到|指向|见 |参见/.test(line) || /AXIOM-ARCHITECTURE\.md/.test(line);
        if (!isForward) selfClaims.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
    }
    expect(selfClaims.length).toBeLessThanOrEqual(1);
    if (selfClaims.length === 1) expect(selfClaims[0].startsWith("docs/AXIOM-ARCHITECTURE.md")).toBeTrue();
  });
});

// ─── D3 死引用：文档点名的源文件必须存在 ─────────────────────────────────────
describe("D3 文档引用存活", () => {
  // 只匹配"目录前缀 + 文件名 + 扩展名"的完整路径；尖括号占位符（tests/mcp-<name>.test.ts）不入选。
  const PATH_REF = /`((?:src|tests|config|frontend|scripts|docs)\/[\w./@-]+\.(?:ts|tsx|sql|ya?ml|json|md|rs|toml|html))`/g;
  const LOCAL_LINK = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
  it("规范件反引号中的仓库路径 100% 存在", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const rel of specDocs()) {
      const text = read(rel);
      for (const m of text.matchAll(PATH_REF)) {
        checked++;
        const target = m[1].replace(/^\.\//, "");
        if (!exists(target)) {
          const line = text.slice(0, m.index).split("\n").length;
          missing.push(`${rel}:${line} → ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(200); // 覆盖面自证：低于此说明扫描范围被悄悄收窄
  });

  it("规范件 markdown 本地链接目标 100% 存在", () => {
    // 反引号路径与 markdown 链接是两类指针：前者描述、后者可点击，坏指针同样误导读者。
    const missing: string[] = [];
    let checked = 0;
    for (const rel of specDocs()) {
      const text = read(rel);
      for (const m of text.matchAll(LOCAL_LINK)) {
        const raw = m[1];
        if (/^(https?:|mailto:|data:|\/\/)/.test(raw)) continue;
        checked++;
        const target = path.normalize(path.join(path.dirname(rel), raw.replace(/^\.\//, "")));
        if (!exists(target)) {
          const line = text.slice(0, m.index).split("\n").length;
          missing.push(`${rel}:${line} → ${raw}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });
});

// ─── D4 禁手抄行数：写进文档的定量指标必然漂移（实测偏差 0–70%）──────────────
describe("D4 禁止手抄行数", () => {
  const LINE_COUNT_ROW = /^\|\s*`?[\w./@-]+\.(?:ts|tsx|sql|rs|go|py)`?\s*\|\s*~?\d{2,5}\s*\|/;
  // 路径不在首列的表（如 README「模块 | 文件 | 行数 | 功能」）同样必须命中，否则门形同虚设。
  const LINE_COUNT_CELL = /`[\w./@-]+\.(?:ts|tsx|sql|rs|go|py)`\s*\|\s*~?\d{2,5}\s*\|/;
  const SCANNED = specDocs();
  it("文档表格中不存在 `文件 | 行数` 形态的行", () => {
    const offenders: string[] = [];
    for (const rel of SCANNED) {
      read(rel).split("\n").forEach((line, i) => {
        const t = line.trim();
        if (LINE_COUNT_ROW.test(t) || LINE_COUNT_CELL.test(t)) offenders.push(`${rel}:${i + 1}: ${t.slice(0, 70)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("文档正文中不存在 `` `文件` (N 行) `` 形态的内联行数", () => {
    // 实测依据：AXIOM-ARCHITECTURE.md 原有 16 处内联行数，其中 7 处偏差 >5%（最大 52%）、1 处指向已删文件。
    const INLINE = /`[\w./@-]+\.(?:ts|tsx|sql|rs|go|py)`\s*[（(]\s*\d+\s*行\s*[)）]/;
    const offenders: string[] = [];
    for (const rel of SCANNED) {
      read(rel).split("\n").forEach((line, i) => {
        if (INLINE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 70)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ─── D5 登记表 ↔ 代码：开关与默认值不可偷改 ──────────────────────────────────
describe("D5 非确定组件登记与代码一致", () => {
  it("每条登记的 switch/defaultVia 在代码中可验证", () => {
    const problems: string[] = [];
    for (const e of registry.entries) {
      if (!exists(e.switchFile)) { problems.push(`${e.id}: switchFile 不存在 ${e.switchFile}`); continue; }
      const src = read(e.switchFile);
      if (e.defaultVia === "readString-default") {
        if (!e.switch) problems.push(`${e.id}: readString-default 需要 switch`);
        else if (!new RegExp(`readString\\(\\s*"${e.switch}"\\s*,\\s*"${e.default}"\\s*\\)`).test(src)) {
          problems.push(`${e.id}: ${e.switchFile} 未找到 readString("${e.switch}", "${e.default}")`);
        }
      } else if (e.defaultVia === "isEdgeEnabled") {
        if (!src.includes(`isEdgeEnabled("${e.switch}")`)) {
          problems.push(`${e.id}: ${e.switchFile} 未找到 isEdgeEnabled("${e.switch}")`);
        }
        if (e.default !== registry.defaults.isEdgeEnabled.value) {
          problems.push(`${e.id}: 默认值 ${e.default} 与 helper 实际 ${registry.defaults.isEdgeEnabled.value} 不一致`);
        }
      } else if (e.defaultVia === "presence") {
        if (e.switch && !src.includes(`"${e.switch}"`)) {
          problems.push(`${e.id}: ${e.switchFile} 中找不到开关名 ${e.switch}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("isEdgeEnabled 默认开启这一事实被登记锁定", () => {
    const helper = registry.defaults.isEdgeEnabled;
    // 通用 helper：默认值写在 readString(flag, "1") —— 未设置即视为开启
    expect(read(helper.file)).toMatch(/readString\(flag,\s*"1"\)/);
    expect(helper.value).toBe("1");
  });
});

// ─── D6 登记表 ↔ 文档表 ──────────────────────────────────────────────────────
describe("D6 权威文档的非确定清单与登记表逐行一致", () => {
  it("docs/AXIOM-ARCHITECTURE.md 的清单行数与 id/role/switch/default 全等", () => {
    const text = read("docs/AXIOM-ARCHITECTURE.md");
    const m = text.match(/<!-- BEGIN:nondeterminism-registry -->([\s\S]*?)<!-- END:nondeterminism-registry -->/);
    expect(m).not.toBeNull();
    const rows = m![1].split("\n").filter((l) => l.trim().startsWith("|")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    const body = rows.filter((r) => r[0] && !/^id$/i.test(r[0]) && !/^[-: ]+$/.test(r[0] ?? ""));
    expect(body.length).toBe(registry.entries.length);
    for (const e of registry.entries) {
      const row = body.find((r) => r[0] === e.id);
      expect(row).toBeDefined();
      expect(row![1]).toBe(e.name);
      expect(row![2]).toBe(e.role);
      expect(row![3]).toBe(e.switch ?? "—");
      expect(row![4]).toBe(e.default);
    }
  });
});

// ─── D7 decision 存量棘轮 ────────────────────────────────────────────────────
describe("D7 概率层不得承担决策（棘轮）", () => {
  it("role=decision 条目数 == 登记预算（只允许下调，禁止上调）", () => {
    const decisions = registry.entries.filter((e) => e.role === "decision").map((e) => e.id);
    expect(decisions.length).toBe(registry.ratchet.maxDecisionRoles);
    expect(registry.ratchet.maxDecisionRoles).toBeGreaterThanOrEqual(registry.ratchet.targetDecisionRoles);
  });

  it("代码中不存在未登记的非确定决策符号", () => {
    // 决策型符号所在文件必须出现在登记表（switchFile/codeFile）中，否则需先登记再合并。
    const declared = new Set(registry.entries.flatMap((e) => [e.switchFile, (e as never as { codeFile?: string }).codeFile ?? ""]));
    const watch = ["cosineSimilarity", "isNearDuplicateWithEdge", "rewriteKnowledgeQueryWithEdge", "judgeKnowledgeQualityWithEdge"];
    const unregistered: string[] = [];
    for (const rel of walkTs("src")) {
      const text = read(rel);
      if (watch.some((sym) => text.includes(sym)) && !declared.has(rel)) unregistered.push(rel);
    }
    expect(unregistered).toEqual([]);
  });
});

// ─── D8 工具领域文件集合相等：文档列出的注册点必须与实际一致 ───────────────────
describe("D8 MCP 领域文件清单与实际一致", () => {
  it("AXIOM-ARCHITECTURE.md §3.0 列出的领域文件 == src/mcp/server/*-tools.ts 实际集合", () => {
    const actual = fs
      .readdirSync(path.join(repoRoot, "src/mcp/server"))
      .filter((n) => n.endsWith("-tools.ts"))
      .map((n) => `src/mcp/server/${n}`)
      .sort();
    const text = read("docs/AXIOM-ARCHITECTURE.md");
    const section = text.slice(text.indexOf("### 3.0"), text.indexOf("### 3.1"));
    expect(section.length).toBeGreaterThan(0);
    const listed = [...section.matchAll(/`(src\/mcp\/server\/[\w-]+-tools\.ts)`/g)].map((m) => m[1]);
    expect([...new Set(listed)].sort()).toEqual(actual);
  });
});

// ─── D9 禁手抄行号锚点：`path.ts:123` 是最容易腐烂也最难发现的文档形态 ──────────
describe("D9 禁止 file:line 手抄锚点", () => {
  // 实测依据：docs/COMPREHENSIVE-GUIDE.md 的 87 处锚点中 35 处指向错误行（偏移 +106~+215 行），
  // 1 处区间越界（引用 `server.ts:387-461` 而文件仅 437 行）；D3 只验文件存在，抓不到行号失真。
  const ANCHOR = /[\w./@-]+\.(?:ts|tsx|js|jsx|md|json|rs|sql|ya?ml|toml|py|go):\d+(?:-\d+)?/g;
  it("规范件中不存在 `path.ext:NN` 形态的行号锚点", () => {
    const offenders: string[] = [];
    for (const rel of specDocs()) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          const m = ANCHOR.exec(line);
          ANCHOR.lastIndex = 0;
          if (m) offenders.push(`${rel}:${i + 1}: ${m[0]} :: ${line.trim().slice(0, 60)}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("锚点禁令不得被门自身绕过（自检：模式确实匹配被禁形态）", () => {
    ANCHOR.lastIndex = 0;
    expect(ANCHOR.test("see `src/main.ts:442-449`")).toBeTrue();
    ANCHOR.lastIndex = 0;
    expect(ANCHOR.test("`src/main.ts` 的 `Bun.serve()`")).toBeFalse();
  });
});

// ─── D10 能力声明登记表由代码重生成，禁止手抄 ────────────────────────────────
describe("D10 能力声明登记表与代码同源", () => {
  const DOC = "docs/security/tool-capability-declarations.md";

  it("登记表存在（SECURITY-MEASURES 有指向它的链接，缺件即死链）", () => {
    expect(exists(DOC)).toBe(true);
  });

  it("登记表与 `scripts/gen-capability-declarations.mjs` 的重生成结果逐字一致", async () => {
    const { collectToolDeclarations, renderDeclarationsDoc } = await import(
      "../src/testing/tool-declarations.js"
    );
    const regenerated = renderDeclarationsDoc(collectToolDeclarations(repoRoot));
    expect(read(DOC)).toBe(regenerated);
  });

  it("抽取器覆盖到生产注册点（正向对照，防零命中假绿）", async () => {
    const { collectToolDeclarations, renderDeclarationsDoc } = await import(
      "../src/testing/tool-declarations.js"
    );
    type Row = ReturnType<typeof collectToolDeclarations>[number];
    const rows = collectToolDeclarations(repoRoot);
    const source = rows.filter((r: Row) => !r.bundle && r.nameKind === "literal");
    const byName = new Map(source.map((r: Row) => [r.name, r]));
    // 已知站点逐个回代：能力与目标声明都必须出现在表里
    expect(byName.get("terminal_exec")?.capability).toContain("proc.exec");
    expect(byName.get("terminal_exec")?.payloadFieldsText).toBe('proc.exec→["command"]');
    expect(byName.get("snapshot_create")?.payloadFieldsText).toBe("proc.exec→fixed");
    expect(byName.get("fs_read")?.capability ?? byName.get("fs_write")?.capability).toContain("fs.read");
    expect(source.length).toBeGreaterThan(150);
    // 打包产物被扫到、但不混进逐条表：它自带一份注册器副本，不在本表口径内
    expect(rows.some((r: Row) => r.bundle)).toBeTrue();
    const rendered = renderDeclarationsDoc(rows);
    expect(rendered).toContain("## 打包产物内的注册面");
    expect(rendered).not.toContain("## plugins/dre-dsh/backend/server.js");
    // 手写插件（逐行走 add()）必须在表内，否则上面的排除就是"顺手把 plugins 全删了"
    expect(rendered).toContain("## plugins/git-workflow-enhanced/index.js");
  });
});
