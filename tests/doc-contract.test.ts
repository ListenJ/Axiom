/**
 * 文档↔代码一致性门（D 系列）
 *
 * 目的：把"确定性推理"口径变成可机器判定的命题，使口径无法被静默写坏或静默绕过。
 * 覆盖：D1 禁语（含 src/tests 的 .ts）+ 全部 markdown 文本完整（BOM/CR/C0） / D2 权威唯一 / D3 文档引用不死（反引号路径 +
 *       markdown 本地链接） / D4 禁手抄行数 /
 *       D5 非确定组件登记 ↔ 代码默认值 / D6 登记表 ↔ 文档表 / D7 decision 存量棘轮 /
 *       D8 文档列出的 MCP 领域文件 ↔ 实际注册点 / D9 禁 file:line 手抄锚点 /
 *       D11 仓库级"无 PG"否定句必须限定范围并点名披露 native 例外 /
 *       D12 规范面（含 AGENTS.md 与 .env.example）不得出现内网地址明文
 *
 * 边界（诚实声明）：本门只覆盖可机器判定命题。散文论述不受保护 —— 因此规范文档中
 * 不得写入定量指标与绝对断言，只允许指向本门与 config/nondeterminism.json 的指针。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";

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
  "零向量", "零概率", "零 embedding", "零embedding", // doc-caliber:quote
  "不使用任何 ML", "不使用任何模型", "不使用任何 ML 模型", // doc-caliber:quote
];

// 门自身必须把禁语清单作为数据写出来，逐字引用不可避免；解决办法不是豁免整个文件
// （那等于本门对自己免检 —— 改坏门自己再没有任何门看着），而是行级引用哨兵：
// 只有带哨兵的那一行跳过禁语判定，同文件其余行照常扫。
const QUOTE_SENTINEL = "doc-caliber:quote";

function bannedHitOn(line: string): string | null {
  if (line.includes(QUOTE_SENTINEL)) return null;
  return BANNED.find((phrase) => line.includes(phrase)) ?? null;
}


// 历史结论件按名字显式豁免（评审/审计/评估/操作日志保留原话作为证据）；
// 带日期的**策略件**（如 BROWSER-AGENT-STRATEGY-2026-08-09.md）不豁免，仍在口径范围内。
// 必须对**相对路径**做大小写无关的名词匹配：仓库里的证据件命名是小写带日期
// （`docs/review-2026-08-18-project-wide-audit.md`、`docs/reviews/…`），且操作日志按月拆成
// `docs/operations-log/2026-07.md` —— 旧写法拿 basename 去配 `(^|/)operations-log\.md$`，
// 斜杠永远匹配不上，于是这些证据件全被当成规范件扫（R5 实测：D3 的 89 条里 55 条、
// D4 的 52 条里 41 条、D9 的 493 条里 301 条都出自这类文件）。
// 词边界用 `[\/._-]` 而非 `\b`：`preview` 不得被当成 `review` 蒙进豁免面。
const HISTORY =
  /(^|[\/._-])(?:operations-log|changelog)(?=$|[\/._-])|(^|[\/._-])(?:reviews?|audits?|assessments?|evaluations?|eval)(?=$|[\/._-])/i;

function mdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    // 统一成正斜杠相对路径再返回：所有排除式（HISTORY 的分隔符字符类、
    // `startsWith("docs/superpowers/")`、登记表里的 switchFile）都按 POSIX 写，
    // Windows 上返回反斜杠会让它们**全部匹配不上** ⇒ 豁免面静默失效、
    // 证据件被当规范件扫，本门在该平台上从此说不出话（只能靠人工比对红名单）。
    if (e.isDirectory()) out.push(...mdFiles(full));
    else if (e.name.endsWith(".md")) out.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
  }
  return out;
}

/**
 * 只存在于工作区的本地目录：仓库一致性门不得扫它们 —— 那既不是任何提交能修好的红，
 * 也会让同一份门在不同机器上给出不同答案。两条都实测过：gitignore 命中且 `git ls-files` 为 0。
 * 防滥用靠 D0 的"在册面不塌方"下界：往这里堆真规范件来躲门，spec.length 会跌破下限并先报警。
 */
const LOCAL_ONLY_DOC_DIRS = ["docs/archive/", "docs/reports/"];
const isLocalOnlyDoc = (f: string): boolean => LOCAL_ONLY_DOC_DIRS.some((p) => f.startsWith(p));

function caliberDocs(): string[] {
  // docs/superpowers/ 下是设计与实施记录（引用问题原话作为证据），与历史结论件同样豁免口径扫描。
  return mdFiles("docs").filter((f) => !f.startsWith("docs/superpowers/") && !isLocalOnlyDoc(f));
}

// 规范件 = 口径文档去掉历史结论件，再加 README。D3/D4 的保护范围即此集合。
// AGENTS.md 不入 D3：其 `docs/services.md` 是有意的墓碑（规则 11 记录"已移出的敏感文件"），
// 引用一个"必须不存在"的路径正是该句的语义，机器门不应把警告改成沉默。
function specDocs(): string[] {
  return caliberDocs()
    .filter((f) => !HISTORY.test(f))
    .concat(exists("README.md") ? ["README.md"] : []);
}

function caliberScope(): string[] {
  const docs = caliberDocs().filter((f) => !HISTORY.test(f));
  const ts = walkTs("src").concat(walkTs("tests"));
  // 本门自身也在扫描面内：逐字引用禁语的两行由行级哨兵放行（见 QUOTE_SENTINEL 与 D1 的在册条），
  // 不再整文件豁免 —— 文件级豁免会让"改坏本门"这件事脱离所有门的视野。
  return ["README.md", "AGENTS.md", ...docs, ...ts].filter((f) => exists(f));
}

function walkTs(dir: string): string[] {
  if (!fs.existsSync(path.join(repoRoot, dir))) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    if (e.name === "_archive" || e.name === "node_modules") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(rel));
    else if (rel.endsWith(".ts") && !rel.endsWith(".d.ts")) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

// 非确定符号的「代码引用点」识别：以 TS 语法树的 Identifier 节点为准。
// 注释是 trivia、字符串/模板串是 literal，都不产生 Identifier；而定义名、import/export 绑定、
// 调用（含 `this.sym(...)`）与裸别名引用都会。子串匹配（`text.includes(sym)`）会把
// 「本文件不使用 cosineSimilarity」这句口径当成使用点 —— D7 自检锁住两侧形态，防判据被改宽。
function codeIdentifierRefs(source: string, syms: readonly string[]): string[] {
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const want = new Set(syms);
  const hits = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && want.has(node.text)) hits.add(node.text);
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return [...hits];
}

// ─── D0 扫描范围自证：豁免面放宽会让红安静消失，所以先把两面钉住 ──────────────
// HISTORY 决定 D1/D2/D3/D4/D9 扫哪些文档。它若被写宽，后果不是"门变松"而是"门不再说话"，
// 这类改动必须由一条不依赖它的门看着：规范件必须在册、证据件必须豁免、两侧数量都不得漂移。
describe("D0 口径扫描范围自证", () => {
  // 规范件：改代码时必须同步的口径文档，被误豁免即门失效
  const MUST_BE_IN_SCOPE = [
    "docs/SECURITY-MEASURES.md", "docs/AXIOM-ARCHITECTURE.md", "docs/ARCHITECTURE.md",
    "docs/PROJECT-GUIDE.md", "docs/LIMITATIONS.md", "docs/CONFIGURATION.md",
    "docs/COMPREHENSIVE-GUIDE.md", "docs/MCP_TOOLS_GUIDE.md", "docs/USER-MANUAL.md",
    "docs/PHILOSOPHY.md", "docs/security/tool-capability-declarations.md", "README.md",
  ];
  // 证据件：评审/审计/评估/按月操作日志，保留问题原话作证据，不得被口径规则改写
  const MUST_BE_EXEMPT = [
    "docs/operations-log.md", "docs/operations-log/2026-07.md", "docs/operations-log/2026-08.md",
    "docs/reviews/2026-08-28-independent-full-audit.md", "docs/review-2026-08-19-dre-plugin-lightweight.md",
    "docs/code-review-2026-08-17.md", "docs/audit-verification-log.md",
    "docs/knowledge/agent-decision-chain-assessment-2026-08-29.md",
  ];

  it("规范件全在扫描面内，证据件全豁免", () => {
    for (const rel of MUST_BE_IN_SCOPE) expect(HISTORY.test(rel), `规范件被误豁免: ${rel}`).toBeFalse();
    for (const rel of MUST_BE_EXEMPT) expect(HISTORY.test(rel), `证据件未被豁免: ${rel}`).toBeTrue();
  });

  it("在册面不塌方、豁免面不扩张", () => {
    const spec = specDocs();
    const exempted = caliberDocs().filter((f) => HISTORY.test(f));
    // 上限只留 4 个余量：再往下豁免就得逐件点名并说明理由，不能靠把正则写宽。
    // 50→55（2026-09-25，逐件点名）：本轮新增证据件
    //   docs/reviews/2026-09-25-auto-audit-chain-report.md（全自动审计链首轮报告）
    //   docs/reviews/2026-09-25-skeleton-architecture-tree.md（骨架架构树 + Laya 砍除决策轮）
    //   docs/research/system-one-decision-model-skills-2026-09-25.md（Jev→Laya 调研，规则 10.3 知识件）
    //   docs/reviews/2026-09-25-memory-tree.md / -memory-knowledge-unification.md（记忆与统一性审计）
    //   docs/reviews/2026-09-25-audit-round2.md / -round3.md / -round4.md（轮 2-4 深审）
    // 均为证据/评审性质：保留问题原话与实测读数，不得被口径规则改写。
    // 55→58（2026-09-26，逐件点名）：ku 线归一（knowledge-unify-2026-09-17）并入 4 件评审/盘点证据件：
    //   docs/reviews/2026-09-17-independent-full-audit.md（ku 线独立全量审计）
    //   docs/reviews/2026-09-18-audit-claims-verification.md（ku 线审计主张核验）
    //   docs/reviews/2026-09-19-shared-mutable-state-inventory.md（ku 线共享可变状态盘点）
    //   docs/reviews/2026-09-20-env-sensitive-assertions-inventory.md（ku 线 env 敏感断言盘点）
    // 均为证据/盘点性质：保留问题原话与实测读数，不得被口径规则改写。
    // 58→59（2026-09-28）：docs/reviews/2026-09-28-laya-ts-consolidation-evidence.md
    // （Laya 开发流程接入与退役任务的冒烟/门禁证据，证据性质同上）。
    // 59→60（2026-10-02）：docs/reviews/2026-10-02-step9-10-operator-runbook.md
    // （Step 9 systemd / Step 10 runtime-go 的逐命令运维手册；保留系统命令原文，属操作证据性质）。
    // 60→61（2026-10-02）：docs/reviews/2026-10-02-ocr-full-coverage.md
    // （OCR 全仓 src 扫描覆盖率 + 13 条 high triage，证据性质）。
    // 61→62（2026-10-03）：docs/reviews/2026-10-03-remove-multi-machine.md
    // （多机互联内容退役清理计划/证据；含即将归档的路径清单，豁免 D1/D3）。
    // 62→63（2026-10-04）：docs/reviews/2026-10-04-single-machine-concurrency-baseline.md
    // （单机 Go 并发 before 基线；bench/loadgen 原始读数，证据性质）。
    // 63→64（2026-10-06）：docs/reviews/2026-10-06-step12b-test-threshold-parallelization.md
    // （Step 12b 阈值双口径与并行化验证证据；含命令日志摘要与门禁读数，证据性质）。
    // 64→65（2026-10-06）：docs/reviews/2026-10-06-p2-3-edge-risk-default-review.md
    // （EDGE_RISK_MONITOR 默认关闭复核；含开关决策、测试矩阵与风险边界，证据性质）。
    // 65→66（2026-10-06）：docs/reviews/2026-10-06-p2-4-codeindex-db-split-review.md
    // （codeindex 独立 DB 迁移评估；含数据快照、方案比较与 ADR 前置条件，证据性质）。
    // 66→67（2026-10-12）：docs/reviews/2026-10-12-audit-round7.md
    // （规则 13 轮 7 全量审计报告；覆盖率账本/确定性专项/门禁实测读数，证据性质）。
    // 67→68（2026-10-13）：docs/reviews/2026-10-13-audit-round8.md
    // （轮 8 自审报告；9 findings 处置 + 零回归验证，证据性质）。
    expect(spec.length).toBeGreaterThanOrEqual(60);
    expect(exempted.length).toBeLessThanOrEqual(68);
    expect(spec.concat(exempted).sort()).toEqual([...new Set(spec.concat(exempted))].sort());
  }, 30_000); // I/O 密集：遍历 docs/ 全树 + caliberDocs，全量负载下需 >15s

  it("`preview` 一类名字不得被当成 review 蒙进豁免面", () => {
    // 名字豁免的固有极限：只有以路径分段出现的证据件名词才算数（`preview` 不是 review），
    // 但 `docs/my-evaluation-guide.md` 这种"名字像证据件的规范件"仍会被吞 —— 所以豁免面
    // 有上方那条数量上限兜着，新增豁免必须被看见。
    for (const probe of ["docs/preview.md", "docs/ui-preview-notes.md", "docs/SAMPLES.md"]) {
      expect(HISTORY.test(probe), probe).toBeFalse();
    }
    expect(HISTORY.test("docs/agent-eval-baseline-2026-09-05.md")).toBeTrue();
  });
});

// D1 完整性判据。TAB 只在**代码围栏之外**才算损伤：围栏内是真实源码缩进（Go/gofmt、Makefile
// 本就使用制表符），一律按"被吃掉的首字母"处理会逼文档撒谎。R5 实测的分界：
// docs/superpowers/plans/2026-08-25-audit-p0p1-remediation.md 的 ```go 块内 44 处行中制表符是合法代码；
// README.md 的 "| <TAB>ool_use"（补回 't' 即 tool_use）才是损伤。
function integrityOffenders(rel: string, txt: string, hasBom: boolean): string[] {
  const offenders: string[] = hasBom ? [`${rel}: BOM`] : [];
  let inFence = false;
  txt.split("\n").forEach((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence;
    if (line.includes("\r")) offenders.push(`${rel}:${i + 1}: CR`);
    [...line].forEach((ch, col) => {
      const code = ch.charCodeAt(0);
      // CR 由上一行的行级判据报出（含行号），此处再报一次会让 offender 数虚高一倍 —— R5 实测：
      // 6,277 处 CRLF 被计成 12,554 条，掩盖了"BOM 只有 13 个"这类真实分布。
      if (code < 32 && code !== 13 && !(ch === "\t" && (col === 0 || inFence))) {
        offenders.push(`${rel}:${i + 1}: 控制字符 0x${code.toString(16)}`);
      }
    });
  });
  return offenders;
}

// ─── D1 禁语：绝对化断言不得回流到规范件与源码注释 ────────────────────────────
describe("D1 口径禁语", () => {
  it("BANNED 短语在口径范围内 0 命中", () => {
    const hits: string[] = [];
    for (const rel of caliberScope()) {
      const lines = read(rel).split("\n");
      lines.forEach((line, i) => {
        const hit = bannedHitOn(line);
        if (hit) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("引用哨兵只豁免它所在的那一行（豁免不得变成免检文件）", () => {
    // 合法引用：把禁语当判据逐字写出的行
    expect(bannedHitOn('  "零向量", // doc-caliber:quote')).toBeNull();
    // 同一文件的其它行不获得豁免
    expect(bannedHitOn("本系统零向量。")).toBe("零向量"); // doc-caliber:quote
    // 已知极限：哨兵与真断言写在同一行时会一起放过 —— 由下方在册条逐文件盯着，
    // 新增引用行必须改这条断言，改动在 diff 里可见。
    expect(bannedHitOn("// doc-caliber:quote 这里偷偷写零概率")).toBeNull();
  });

  it("依赖哨兵的引用行全部在册，且本门自身在扫描面内", () => {
    const quoting = caliberScope().filter((rel) =>
      read(rel).split("\n").some((line) => line.includes(QUOTE_SENTINEL) && BANNED.some((p) => line.includes(p))),
    );
    expect(quoting.sort()).toEqual(["tests/doc-contract.test.ts", "tests/unit/docs-consistency.test.ts"]);
    // 文件级豁免已删除：本门被写坏时必须有门说话
    expect(caliberScope()).toContain("tests/doc-contract.test.ts");
  });

  it("vault 生成件（openclaw-memory 笔记）同样不含禁语", () => {
    // vault 笔记没有"引用禁语作判据"的正当场景，故这里不走 bannedHitOn，不吃哨兵豁免。
    const hits: string[] = [];
    for (const rel of mdFiles("openclaw-memory")) {
      read(rel).split("\n").forEach((line, i) => {
        if (BANNED.some((phrase) => line.includes(phrase))) hits.push(`${rel}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("全部 markdown 文档文本完整：无 BOM / 无 CR / 无 C0（正文 TAB 视同损伤，代码围栏内除外）", () => {
    // 实测依据：同一写入路径把单字母替换成它的转义控制符，静默吃掉标识符首字母 ——
    // README.md: "research"→CR+"esearch"、"tool_use"→TAB+"ool_use"，一个 ``` 围栏被压成单反引号；
    // docs/operations-log.md: 39 处（"frontend"→FF+"rontend"、"bunx"→BS+"unx"、"tests"→TAB+"ests"、
    // 一处 commit hash 首字母变 NUL，使整个文件被 grep 判为二进制）。
    // 这类损伤读 diff 看不出来，且会让"按字面串比对文档与代码"的门产生假阴性 —— 故历史件也在完整性范围内。
    const offenders: string[] = [];
    // 历史件与实施记录都在完整性范围内（上面注明的理由）；只摘掉 LOCAL_ONLY_DOC_DIRS ——
    // 那里是 gitignore 的本地落盘区，扫它只会让门的结果取决于本机盘上有什么。
    const scanned = mdFiles("docs").filter((f) => !isLocalOnlyDoc(f))
      .concat(exists("README.md") ? ["README.md"] : []);
    for (const rel of scanned) {
      const buf = fs.readFileSync(path.join(repoRoot, rel));
      offenders.push(...integrityOffenders(rel, buf.toString("utf8"), buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));
    }
    expect(offenders).toEqual([]);
    // 覆盖面自证：范围被悄悄收窄时本条先红
    expect(scanned.length).toBeGreaterThan(20);
  });

  it("围栏内 TAB 放行、正文 TAB 仍报（豁免不得把真损伤一起放过）", () => {
    // 正文 TAB 取真实形态：'t' 被吃掉，补回才是词（tool_use）
    expect(integrityOffenders("x.md", "title\n| tool_use | 工具调用 |\n", false)).toEqual([]);
    expect(integrityOffenders("x.md", "title\n| \tool_use | 工具调用 |\n", false)).toEqual([
      "x.md:2: 控制字符 0x9",
    ]);
    // 围栏内 gofmt 缩进：行中 TAB 不得报
    expect(integrityOffenders("x.md", "```go\n\treturn func(next http.Handler) {\n\t\tif !isWrite(r) {\n```\n", false)).toEqual([]);
    // 围栏不是免死金牌：块内 C0/CR 照样报
    expect(integrityOffenders("x.md", "```go\n\u0007ssertX()\n```\n", false)).toEqual(["x.md:2: 控制字符 0x7"]);
    expect(integrityOffenders("x.md", "```\rx\n```\n", false)).toEqual(["x.md:1: CR"]);
  });
});

// ─── D2 权威唯一：多源复制是文档失真的结构根因 ────────────────────────────────
describe("D2 权威文档唯一", () => {
  it("自称式「唯一权威」命中 ≤ 1 且落在 AXIOM-ARCHITECTURE.md", () => {
    const selfClaims: string[] = [];
    for (const rel of caliberDocs().concat(["README.md"])) {
      if (!exists(rel) || HISTORY.test(rel)) continue;
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
  // plugins 必须在集合内：插件是本仓库的正式交付面（plugins/dre-dsh 等），且本片把若干
  // "插件目录内简写路径"改写为完整路径 —— 若扫描面不认 plugins/，那次改写就等于把引用移出视野。
  const PATH_REF = /`((?:src|tests|config|frontend|scripts|docs|plugins)\/[\w./@-]+\.(?:ts|tsx|sql|ya?ml|json|md|rs|toml|html))`/g;
  const LOCAL_LINK = /\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g;

  // 行内代码里的 `[x](y)` 是代码文本而不是链接 —— markdown 不渲染它，把它当死链会逼文档改代码示例。
  // 实测：`registry.buildHttpHandlers()[name](args)`（AXIOM-ARCHITECTURE.md 的注入流程一节）被报成死链 "→ args"。
  // 覆写用等长空格，偏移不变 ⇒ 报出的行号仍指原文那一行。
  const stripInlineCode = (text: string): string => text.replace(/`[^`\n]*`/gu, (s) => " ".repeat(s.length));
  function localLinks(text: string): Array<{ raw: string; line: number }> {
    const scannable = stripInlineCode(text);
    const out: Array<{ raw: string; line: number }> = [];
    for (const m of scannable.matchAll(LOCAL_LINK)) {
      const raw = m[1];
      if (/^(https?:|mailto:|data:|\/\/)/.test(raw)) continue;
      out.push({ raw, line: scannable.slice(0, m.index).split("\n").length });
    }
    return out;
  }

  // tombstone 标记 `<!-- doc-caliber:absent: <逗号分隔的路径> -->`：声明"标记里点名的这些仓库路径已被删除"。
  // 它不是消音器而是**反向断言** —— 被点名的路径必须真的保持不存在，哪天它重新出现（或有人想用这个
  // 标记去藏一个活文件）照样报红。动机：`src/db/pg-client.ts` 的"已删除"是文档的正常内容，若 D3 无条件
  // 要求路径存在，就等于逼文档删掉"我们删过什么"。
  // 为什么标记必须自带路径名：首版按"整行"生效，实测一行里同时写有死路径（pg-client）与活路径
  // （pg-schema.sql / main.ts）时，整行豁免会把活文件一起放走 —— 墓碑成了免检区。
  const ABSENT_SENTINEL = "doc-caliber:absent";
  const ABSENT_MARK = /<!--\s*doc-caliber:absent:\s*([^>]*?)\s*-->/g;
  const absentTargets = (line: string): string[] =>
    [...line.matchAll(ABSENT_MARK)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
  function deadPathOffenders(rel: string, text: string): { problems: string[]; tombstoned: string[]; checked: number } {
    const problems: string[] = [];
    const tombstoned: string[] = [];
    let checked = 0;
    text.split("\n").forEach((line, i) => {
      const marked = absentTargets(line);
      const honoured = new Set<string>();
      for (const m of line.matchAll(PATH_REF)) {
        checked++;
        const target = m[1].replace(/^\.\//, "");
        const alive = exists(target);
        if (marked.includes(target)) {
          honoured.add(target);
          if (alive) problems.push(`${rel}:${i + 1}: tombstone 失效 → ${target} 仍存在`);
          else tombstoned.push(`${rel}:${i + 1} → ${target}`);
        } else if (!alive) problems.push(`${rel}:${i + 1} → ${target}`);
      }
      // 空转：标记点名的路径没出现在本行的反引号引用里 ⇒ 文档改过、墓碑忘了删（或写错了行）
      for (const claimed of marked) if (!honoured.has(claimed)) problems.push(`${rel}:${i + 1}: tombstone 空转 → 标记点名 ${claimed}，本行却无反引号引用`);
    });
    return { problems, tombstoned, checked };
  }

  it("规范件反引号中的仓库路径 100% 存在（或带 tombstone 且确实仍是删除态）", () => {
    const problems: string[] = [];
    const tombstoned: string[] = [];
    let checked = 0;
    for (const rel of specDocs()) {
      const r = deadPathOffenders(rel, read(rel));
      checked += r.checked;
      problems.push(...r.problems);
      tombstoned.push(...r.tombstoned);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(200); // 覆盖面自证：低于此说明扫描范围被悄悄收窄
    expect(tombstoned.length).toBeGreaterThan(0); // 通道自证：一条没人用的豁免通道等于没写
  });

  it("规范件 markdown 本地链接目标 100% 存在", () => {
    // 反引号路径与 markdown 链接是两类指针：前者描述、后者可点击，坏指针同样误导读者。
    const missing: string[] = [];
    let checked = 0;
    for (const rel of specDocs()) {
      const links = localLinks(read(rel));
      checked += links.length;
      for (const { raw, line } of links) {
        const target = path.normalize(path.join(path.dirname(rel), raw.replace(/^\.\//, "")));
        if (!exists(target)) missing.push(`${rel}:${line} → ${raw}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });

  it("行内代码内的方括号-圆括号形态不算链接（覆写不得把真链接一起抹掉）", () => {
    // 被抹掉的只能是代码文本：代码示例里的 `[name](args)` 不入选
    expect(localLinks("1. 建图：`registry.buildHttpHandlers()[name](args)` 直调")).toEqual([]);
    // 真链接必须照旧入选，且行号按原文计（覆写保长度的直接后果）
    expect(localLinks("标题\n见 [指南](./docs/x.md) 与 `code [a](b)`\n")).toEqual([{ raw: "./docs/x.md", line: 2 }]);
    // 外链继续排除
    expect(localLinks("[官网](https://example.com/a)")).toEqual([]);
  });

  it("tombstone 是反向断言不是消音器（自检：只豁免它点名的那个路径）", () => {
    // 未标记 + 路径不存在 ⇒ 照旧报死引用
    expect(deadPathOffenders("d.md", "见 `src/__no_such__.ts` 的说法\n").problems).toEqual(["d.md:1 → src/__no_such__.ts"]);
    // 标记点名 + 路径确实不存在 ⇒ 放行，且计入 tombstoned 清单
    const dead = deadPathOffenders("d.md", "`src/__no_such__.ts` 已删除 <!-- doc-caliber:absent: src/__no_such__.ts -->\n");
    expect(dead.problems).toEqual([]);
    expect(dead.tombstoned).toEqual(["d.md:1 → src/__no_such__.ts"]);
    // 点名一个**存在**的路径 ⇒ 必须报失效：豁免通道不得用来藏活文件
    expect(deadPathOffenders("d.md", "`tests/doc-contract.test.ts` 已删除 <!-- doc-caliber:absent: tests/doc-contract.test.ts -->\n").problems)
      .toEqual(["d.md:1: tombstone 失效 → tests/doc-contract.test.ts 仍存在"]);
    // 同行未被点名的路径不受影响 —— 这正是整行豁免版做不到的（实测：pg-client 与 pg-schema.sql 同行）
    const mixed = deadPathOffenders("d.md", "`src/__no_such__.ts` 已删，`tests/doc-contract.test.ts` 仍在 <!-- doc-caliber:absent: src/__no_such__.ts -->\n");
    expect(mixed.problems).toEqual([]);
    expect(mixed.tombstoned).toEqual(["d.md:1 → src/__no_such__.ts"]);
    expect(deadPathOffenders("d.md", "`src/__no_such__.ts` 已删，`src/__gone_too__.ts` 也已删 <!-- doc-caliber:absent: src/__no_such__.ts -->\n").problems)
      .toEqual(["d.md:1 → src/__gone_too__.ts"]);
    // 空转：标记点名的路径没出现在本行 ⇒ 墓碑是文档改版后遗留的，必须被清掉
    expect(deadPathOffenders("d.md", "这里没有任何路径 <!-- doc-caliber:absent: src/__no_such__.ts -->\n").problems)
      .toEqual(["d.md:1: tombstone 空转 → 标记点名 src/__no_such__.ts，本行却无反引号引用"]);
  });

  it("使用 tombstone 的文件全部在册（新增墓碑引用必须改这条）", () => {
    const files = specDocs().filter((rel) => read(rel).includes(ABSENT_SENTINEL)).sort();
    expect(files).toEqual([
      "docs/ARCHITECTURE.md",
      "docs/AXIOM-ARCHITECTURE.md",
      // BrowserPanel/工具台随 2026-09-25 Chat 页移除（右栏 panels.tsx），文内历史叙述按墓碑口径点名。
      "docs/BROWSER-AGENT-STRATEGY-2026-08-09.md",
      "docs/COMPREHENSIVE-GUIDE.md",
      // 2026-09-28 native 退役：LIMITATIONS 退役行、PROJECT-GUIDE 拓扑行、
      // TEST-STRATEGY 覆盖率行的 native-bridge 历史引用按墓碑口径点名。
      // （local-llm 于同日方向修正中恢复，其墓碑已撤；Laya 仅入开发流程不入运行时。）
      "docs/LIMITATIONS.md",
      "docs/PROJECT-GUIDE.md",
      "docs/TEST-STRATEGY-2026-08-21.md",
      // 2026-10-03 多机测试框架退役：ADR-008 引用的 PCDA 分布式调度器按墓碑口径点名。
      "docs/decisions/ADR-008-laya-decision-chain.md",
      // 2026-10-12 code-retrieval-router 退役（轮 7 审计死代码归档）：ADR-013 §6 在册表按墓碑口径点名。
      "docs/decisions/ADR-013-kernel-periphery-partition.md",
      "docs/functional-check-2026-08-16-sensenova.md",
      "docs/plans/2026-08-11-frontend-aesthetic-repair.md",
    ]);
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

  it("isEdgeEnabled 默认关闭这一事实被登记锁定（2026-09-26 归一：ku 线默认关闭策略胜出）", () => {
    const helper = registry.defaults.isEdgeEnabled;
    // 通用 helper：readString(flag) 不带默认值 —— 未设置即 "" → false（默认关闭）；
    // 仅显式授权（"1"/"true"/"yes" 等非零值）放行。旧行为 readString(flag, "1")（未设置即开启）已随归一废除，
    // 与 LIMITATIONS 边缘 LLM 条目、tests/unit/llm-default-off-policy.test.ts 一致。
    const src = read(helper.file);
    expect(src).toMatch(/const v = readString\(flag\)\.trim\(\)\.toLowerCase\(\)/);
    expect(src).toMatch(/return v !== "" && v !== "0" && v !== "false" && v !== "no"/);
    expect(helper.value).toBe("0");
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
    // 决策型符号的**代码引用点**所在文件必须出现在登记表（switchFile/codeFile）中，否则需先登记再合并。
    // 实测依据（R5-e）：判据初版是 `text.includes(sym)`，当时 7 个红点里有 6 个的符号只出现在文件头注释与
    // CLI 输出串中（"确定性检索为主，共享 cosineSimilarity 仅可选语义层"）—— 即在声明"本文件不用它"的句子里
    // 提到了它。把这 6 个文件登记成"非确定组件"等于往机器来源里写假事实，删掉这句口径又是丢掉真实信息，
    // 所以修的是引用形态识别（见 codeIdentifierRefs 与下一条自检），不是登记表面。
    const declared = new Set(registry.entries.flatMap((e) => [e.switchFile, (e as never as { codeFile?: string }).codeFile ?? ""]));
    const watch = ["cosineSimilarity", "isNearDuplicateWithEdge", "rewriteKnowledgeQueryWithEdge", "judgeKnowledgeQualityWithEdge"];
    const unregistered: string[] = [];
    for (const rel of walkTs("src")) {
      const text = read(rel);
      if (!watch.some((sym) => text.includes(sym))) continue; // 廉价子串预筛，命中者才进语法树
      if (codeIdentifierRefs(text, watch).length > 0 && !declared.has(rel)) unregistered.push(rel);
    }
    expect(unregistered).toEqual([]);
  });

  it("引用形态识别自检：注释与字符串不算使用点，定义/绑定/调用/别名算", () => {
    const SYM = "cosineSimilarity";
    const used = (src: string): boolean => codeIdentifierRefs(src, [SYM]).length > 0;
    // 误报面（判据初版在此全部判红，实测 7 红中的 6 红即此类）
    expect(used("/** 共享 cosineSimilarity 仅可选语义层 */\nexport const m = 1;\n")).toBe(false);
    expect(used("// cosineSimilarity 不在本文件使用\nexport const m = 1;\n")).toBe(false);
    expect(used("export const msg = (): void => console.log(`共享 cosineSimilarity 仅可选语义层`);\n")).toBe(false);
    // 漏报面（真实引用必须判红）
    expect(used("import { cosineSimilarity } from \"./math.js\";\n")).toBe(true);
    expect(used("export function cosineSimilarity(a: number[], b: number[]): number { return 0; }\n")).toBe(true);
    expect(used("const s = cosineSimilarity(a, b);\n")).toBe(true);
    expect(used("const s = this.cosineSimilarity(a, b);\n")).toBe(true);
    expect(used("export const alias = cosineSimilarity;\n")).toBe(true);
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
  const ANCHOR = /[\w./@-]+\.(?:ts|tsx|js|jsx|md|json|rs|sql|ya?ml|toml|py|go):\d+(?:-\d+)?(?!\.\d)(?![\d%])/g;
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
    // 覆盖率百分比不是行号锚点：实测 `ts:100% / 88.89%`、`ts:66.67% Funcs` 这类测得值被当成
    // 锚点报出（docs/test-reports/SUMMARY.md 一次报 5 条），判据若把"数字前缀"一律算锚点，
    // 就等于逼报告件删掉真实数据来换取绿灯。
    ANCHOR.lastIndex = 0;
    expect(ANCHOR.test("`src/utils/url-safety.ts:100% / 88.89%`")).toBeFalse();
    ANCHOR.lastIndex = 0;
    expect(ANCHOR.test("`src/dre/system-resource.ts:66.67% Funcs`")).toBeFalse();
    // 反向兜住：锚点后紧跟句号/逗号/中文，仍是锚点，不得成为逃出口
    ANCHOR.lastIndex = 0;
    expect(ANCHOR.test("见 `src/main.ts:12`。")).toBeTrue();
    ANCHOR.lastIndex = 0;
    expect(ANCHOR.test("源码：`src/dre/system-resource.ts:53,68`")).toBeTrue();
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

// ─── D11 仓库级 PG 否定句必须限定范围并披露例外 ───────────────────────────────
// 动因（F-1 实测）：`native/crates/cloud`（axiom-cloud 二进制，`native/Cargo.toml` 的
// `members = ["crates/*"]` 在工作区内，`package.json` 有 native:build:cloud，
// `src/native-bridge.ts` 按 edition 选这个 binary）接受 DATABASE_URL 并真的建了 PostgreSQL 池，
// 而文档当时写的是"本仓当前无 PG 入口 / 无 PG 驱动与入口"。一条过头的否定断言与一条过时的
// 肯定断言是同一种失真，且更难被发现 —— 所以范围限定与例外披露都要能被机器逼出来。
describe("D11 仓库级 PG 否定句需限定范围并披露例外", () => {
  // 仓库级主语的"无 PG"断言：TS 运行时的实话被说成了全仓的事实。
  const REPO_NEGATION = /(本仓当前无 PG|本仓无 PG|仓库内无 PG|全仓无 PG|无 PG 驱动与入口|无 PG 入口)/;
  // PG 语句执行面（tokio/deadpool-postgres 的方法名）；探针用的 pool.get() 不在其内。
  const PG_SQL_SITE = /\.(query|query_opt|query_raw|execute|simple_query)\s*[<(]/;
  const rsFiles = (dir: string): string[] => {
    if (!fs.existsSync(path.join(repoRoot, dir))) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...rsFiles(rel));
      else if (e.name.endsWith(".rs")) out.push(rel.replace(/\\/g, "/"));
    }
    return out;
  };

  it("规范件（含 README/AGENTS）内仓库级「无 PG」句 0 命中", () => {
    const scope = caliberDocs()
      .filter((f) => !HISTORY.test(f))
      .concat(exists("README.md") ? ["README.md"] : [], exists("AGENTS.md") ? ["AGENTS.md"] : []);
    const offenders: string[] = [];
    for (const rel of scope) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          if (REPO_NEGATION.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(offenders).toEqual([]);
    // 覆盖面自证：扫描面塌掉时本条先红，不允许靠"少扫几个文件"变绿
    expect(scope.length).toBeGreaterThan(50);
  });

  it("native 已整体退役（2026-09-28）：例外披露退场，LIMITATIONS 保留退役行", () => {
    // 原断言（native/crates/cloud PG 探针的例外点名披露）随 Rust 全退役删除：
    // native/ 不存在 ⇒ "TS 运行时无 PG 数据面"由例外披露转为事实全称，无需再点名。
    // 反向断言保留：哪天 native/ 或 PG 探针代码重新入树，这里必须先重新登记例外。
    expect(exists("native/crates")).toBe(false);
    const lines = read("docs/LIMITATIONS.md").split("\n");
    const retired = lines.filter((l) => l.includes("native 退役"));
    expect(retired.length).toBe(1);
    expect(retired[0]).toContain("Rust 面退役");
  });

  it("披露与代码同源（退役版）：仓库无 Rust/PG 探针面；任何复活先登记", () => {
    expect(rsFiles("native/crates").length).toBe(0);
    expect(exists("src/native-bridge.ts")).toBe(false);
  });

  it("判据自检：被禁形态真的会红、限定后的口径不误伤（门不得对自己免检）", () => {
    expect(REPO_NEGATION.test('- 不要试图"切换 PostgreSQL"：本仓当前无 PG 入口（PG 客户端已随 H-M1-03 删除）')).toBeTrue();
    expect(REPO_NEGATION.test("PG vector 当前不可启用（PG 客户端已随 H-M1-03 删除，无 PG 驱动与入口）")).toBeTrue();
    expect(REPO_NEGATION.test("SQLite 为唯一运行时数据库；H-M1-03 移除后无 PG 入口")).toBeTrue();
    // 限定面 + 已披露例外的口径不得命中
    expect(REPO_NEGATION.test("TS 运行时检索栈无 PG 路径（native 云端件另有存活探针池，见 `docs/LIMITATIONS.md` §2.3）")).toBeFalse();
    expect(REPO_NEGATION.test("PG vector 当前不可启用（H-M1-03 已删客户端，无启用路径）")).toBeFalse();
    // 镜像断言的正向对照：PG_SQL_SITE 必须真能抓到查询面，否则"零执行点"是正则写坏的假绿
    expect(PG_SQL_SITE.test('        let rows = client.query("SELECT 1", &[]).await?;')).toBeTrue();
    expect(PG_SQL_SITE.test("        pool.get().await // 仅取连接做存活探测")).toBeFalse();
  });
});

// ─── D12 规范面不得出现内网地址明文 ─────────────────────────────────────────
// 动因（F-2 实测）：AGENTS.md 规则 3 长期把仓库远端的 SSH/HTTP 完整地址与一个已退役服务器的
// 地址+账号抄进正文，规范件里另有 worker 的真实内网 IP 和可直接执行的 `ssh-copy-id git@…`。
// 本门 RED 时实测 11 件 / 22 行。地址本身即攻击面（拓扑 + 端口 + 账号名），且"以某台机器的地址
// 为准"的写法在服务器迁移后必然失真 —— R5-g 的 F-1 已经证明：靠人工记得回填是做不到的。
// 故把"规范面不出现内网地址"变成机器判定：远端取值指向本机 `git remote -v`，节点地址用 ${LAN_*} 占位。
// 自检语料一律用合成私网地址（192.168.99.x / 10.1.2.3），判据强度不变但不再把真实端点写回仓库。
describe("D12 规范面不得出现内网地址明文", () => {
  // RFC1918 私有段：10/8、172.16/12、192.168/16。四段完整匹配，故 "Node 10.0.0 以上" 不误伤。
  const RFC1918 = /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/;
  const LAN_ADDR = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/;

  // 规范面 = 规范件（含 README）+ AGENTS.md + .env.example（模板会被复制到真实部署，同样不得带地址）
  function lanScope(): string[] {
    const extra = ["AGENTS.md", ".env.example"].filter(exists);
    return specDocs().concat(extra.filter((f) => !specDocs().includes(f)));
  }

  it("规范面（含 README/AGENTS/.env.example）内网地址 0 命中", () => {
    const scope = lanScope();
    const offenders: string[] = [];
    for (const rel of scope) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          if (RFC1918.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
        });
    }
    expect(offenders).toEqual([]);
    // 覆盖面自证：扫描面塌掉时本条先红，不允许靠"少扫几个文件"变绿
    expect(scope.length).toBeGreaterThan(60);
    expect(scope).toContain("AGENTS.md");
    expect(scope).toContain(".env.example");
  });

  it("判据自检：私网形态真的会红、回环/公网/版本号不误伤（门不得对自己免检）", () => {
    // 三种真实出现过的形态（带端口的 SSH URL / user@host 裸址 / 表格单元），一律换成 192.168.99.x 合成值
    expect(RFC1918.test("ssh://git@192.168.99.10:2222/agent/example.git")).toBeTrue();
    expect(RFC1918.test("旧目标 ssh://svc@192.168.99.22/home/svc/example.git")).toBeTrue();
    expect(RFC1918.test("| PDF Worker | 192.168.99.11 | MinerU |")).toBeTrue();
    expect(RFC1918.test("http://10.1.2.3:3000")).toBeTrue();
    expect(RFC1918.test("代理 172.20.10.5")).toBeTrue();
    // 回环与监听通配是本仓正常口径，不得命中
    expect(RFC1918.test("默认监听 http://127.0.0.1:3000")).toBeFalse();
    expect(RFC1918.test("host = 0.0.0.0")).toBeFalse();
    // 公网 DNS 与版本号形态不得命中（四段完整匹配，三段地址不参与）
    expect(RFC1918.test("公共 DNS 114.114.114.114")).toBeFalse();
    expect(RFC1918.test("要求 Node 10.0.0 以上")).toBeFalse();
    // 阳性对照：在合成语料上 RFC1918 必须与"私网行"集合精确相等，且被更宽的 LAN_ADDR 覆盖。
    // 取仓库真实状态做对照会让本条在脱敏完成后失去判别力（恒为 0==0）。
    const corpus = [
      "ssh://git@192.168.99.10:2222/agent/example.git",
      "监听 http://127.0.0.1:3000",
      "worker 192.168.99.11 上跑 PDF",
      "公共 DNS 114.114.114.114",
      "proxy 10.3.4.5:7897",
      "要求 Node 10.0.0 以上",
    ];
    expect(corpus.filter((l) => RFC1918.test(l)).length).toBe(3);
    expect(corpus.map((_, i) => String(i)).filter((i) => RFC1918.test(corpus[Number(i)]))).toEqual(["0", "2", "4"]);
    expect(corpus.map((_, i) => String(i)).filter((i) => LAN_ADDR.test(corpus[Number(i)]))).toEqual([
      "0", "1", "2", "3", "4",
    ]);
  });
});
