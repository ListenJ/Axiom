/**
 * 口径契约注册表 —— 项目术语的规范定义与禁改口径（A-0 首刀）
 *
 * 动机：模型（以及后续的 agent）在"对齐口径"与"指令遵循"上会产生信息偏差——
 * 同一术语被静默换义、被泛化、被降格为风格偏好。本模块把术语从散文里抽出，
 * 变成一张可被门禁逐条判定的表：每个术语有唯一 canonical、规范 definition、
 * 别名 aliases、以及"禁止被曲解成什么" forbiddenRedefinitions，并带溯源锚
 * evidence（必须逐字出现在 owner 文件中）。
 *
 * 双源不变式（对标 src/utils/security-defaults.ts 的写法）：
 * 本模块的 CALIBER_ENTRIES 是运行时注入侧的表；config/caliber.json 是对外的
 * 声明侧。两者必须逐字段相等，且每条 owner 存在、evidence 引文与 canonical
 * 术语确实出现在 owner 中 —— 由 tests/caliber-contract.test.ts 锁死，防止
 * 术语被静默改写或凭空捏造。
 *
 * 诚实边界：门禁只证明"术语与定义锚在权威源中真实存在、两侧表未漂移"，
 * 不证明 definition 是权威原文的逐字完美转述。
 */

/** 术语所属域，与 config/caliber.json 的 domains 一致 */
export const CALIBER_DOMAINS = ["process", "determinism", "dre", "data", "architecture"] as const;

export type CaliberDomain = (typeof CALIBER_DOMAINS)[number];

export interface CaliberEntry {
  /** 稳定编号（CAL-NN），只增不改 */
  id: string;
  /** 规范术语（唯一） */
  canonical: string;
  /** 英文名/常见写法（可为空串） */
  en: string;
  /** 所属域 */
  domain: CaliberDomain;
  /** 规范定义（唯一权威短式） */
  definition: string;
  /** 允许的别名（不得与其它术语的 canonical/alias 冲突） */
  aliases: string[];
  /** 禁止的曲解口径（至少一条；描述"不得被理解成什么"） */
  forbiddenRedefinitions: string[];
  /** 溯源锚：定义所在的权威文件（相对仓库根） */
  owner: string;
  /** 必须逐字出现在 owner 文件中的引文（≥1 条） */
  evidence: string[];
}

/** 注入开关名（默认关闭 —— 见 glossaryEnabled） */
export const CALIBER_GLOSSARY_ENV = "AXIOM_CALIBER_GLOSSARY";

/** 注入段的起止标记（供调用方与门禁做锚点匹配） */
export const CALIBER_GLOSSARY_MARKER = "=== 口径契约 (CALIBER CONTRACT) ===";
export const CALIBER_GLOSSARY_END = "=== END CALIBER CONTRACT ===";

/** 口径唯一机器来源的相对路径（注入段里对外声明用） */
export const CALIBER_SOURCE_PATH = "config/caliber.json";

// ⚠️ 本表由 config/caliber.json 生成，门禁强制两者逐字段相等；改一处必须同步改另一处。
export const CALIBER_ENTRIES: readonly CaliberEntry[] = [
  {
    "id": "CAL-01",
    "canonical": "口径",
    "en": "Caliber",
    "domain": "process",
    "definition": "对某事物『算不算数、是否成立、如何判定』的规范陈述。本仓要求口径可机器判定：落在 tests/ 的门禁与 config/*.json 登记表里；散文论述不受门禁保护，因此规范文档中不得写入定量指标与绝对断言。",
    "aliases": ["规范陈述"],
    "forbiddenRedefinitions": ["把口径当成措辞或风格偏好，而不是可判定的命题", "在散文中手抄定量指标或绝对断言，并称其为口径"],
    "owner": "config/nondeterminism.json",
    "evidence": ["文档口径的唯一机器来源"]
  },
  {
    "id": "CAL-02",
    "canonical": "确定性内核域",
    "en": "Deterministic Core",
    "domain": "determinism",
    "definition": "承担决策的域：检索命中与排序、记忆读写路由、准入与去重、query 归一化、图遍历、约束求解、规则推理。不变式：同输入 + 同版本规则 ⇒ 同输出，可解释、可审计、可回放。",
    "aliases": ["确定性核心域", "Deterministic Core"],
    "forbiddenRedefinitions": ["把 LLM 判断或概率输出归入确定性内核域", "把『确定性内核域』曲解为『全系统不含任何非确定代码』（概率层可存在，只是不承担决策权）"],
    "owner": "docs/superpowers/specs/2026-09-21-determinism-caliber-and-doc-contract-design.md",
    "evidence": ["确定性内核域（Deterministic Core）"]
  },
  {
    "id": "CAL-03",
    "canonical": "显式概率域",
    "en": "Declared Probabilistic Layer",
    "domain": "determinism",
    "definition": "承担生成与建议的域：LLM 摘要/结构化补全、Thompson 模型路由、共形置信度信号、边缘模型判断。允许存在，但不承担决策权。",
    "aliases": ["Declared Probabilistic Layer", "概率层"],
    "forbiddenRedefinitions": ["让概率域承担准入、安全或检索排序等决策", "把概率域说成『纯装饰』而省略其输出必须携带 provenance"],
    "owner": "docs/superpowers/specs/2026-09-21-determinism-caliber-and-doc-contract-design.md",
    "evidence": ["显式概率域（Declared Probabilistic Layer）"]
  },
  {
    "id": "CAL-04",
    "canonical": "provenance",
    "en": "Output Provenance",
    "domain": "determinism",
    "definition": "非确定路径产出的结果必须携带的留痕：标记该结果走了概率层（如 mode / engine / advisory 字段），使响应可判定『这一条是否经由非确定路径』。",
    "aliases": ["输出留痕", "溯源标记"],
    "forbiddenRedefinitions": ["把 provenance 仅当作日志而省略在返回载荷中", "在缺少 provenance 的情况下让概率层输出影响决策"],
    "owner": "docs/superpowers/specs/2026-09-21-determinism-caliber-and-doc-contract-design.md",
    "evidence": ["输出处处留痕"]
  },
  {
    "id": "CAL-05",
    "canonical": "传动轴",
    "en": "MetaCognitiveLoop",
    "domain": "dre",
    "definition": "MetaCognitiveLoop：在 DRE 五个孤立子系统（Synapse / Reasoning / Knowledge / Prediction / Action）之间架设的闭环反馈连线（产出端 → 安全门 → 消费端），用于闭合四个断点。不修改任何已有接口，纯连线。",
    "aliases": ["MetaCognitiveLoop", "认知反馈环"],
    "forbiddenRedefinitions": ["把传动轴理解为新增子系统或重写已有子系统（它是纯连线）", "绕过安全门直接连线产出端与消费端"],
    "owner": "src/dre/runtime/meta-cognitive-loop.ts",
    "evidence": ["认知反馈环传动轴", "不修改任何已有接口——纯连线"]
  },
  {
    "id": "CAL-06",
    "canonical": "断点",
    "en": "Breakpoint",
    "domain": "dre",
    "definition": "传动轴要闭合的四处因果断裂：A 意识流 lessons → 规则引擎 learn（跨轮次）；B 突触 suggest → 认知管道 Step 2 知识注入（同轮次）；C 心智模型 predict → Step 5 行动咨询（同轮次）；D 反思 issues → 管道参数微调（跨轮次）。",
    "aliases": ["四断点"],
    "forbiddenRedefinitions": ["把『断点』理解为调试断点（debugger breakpoint）"],
    "owner": "src/dre/runtime/meta-cognitive-loop.ts",
    "evidence": ["闭合四个断点"]
  },
  {
    "id": "CAL-07",
    "canonical": "降级链",
    "en": "Degradation Chain",
    "domain": "dre",
    "definition": "主路径不可用（如远端 LLM 失败）时，按预定义顺序逐级回退到更保守的确定性实现（如 runWithLLM 的 4 级：L1 确定性 → …）。降级必须确定性、可解释，不得由概率层决定。",
    "aliases": ["fallback chain", "多级降级"],
    "forbiddenRedefinitions": ["把降级链当成随机重试", "让降级决策本身依赖 LLM 判断"],
    "owner": "docs/AXIOM-ARCHITECTURE.md",
    "evidence": ["4 级降级链"]
  },
  {
    "id": "CAL-08",
    "canonical": "影子模式",
    "en": "Shadow Mode",
    "domain": "dre",
    "definition": "SafetyGate 的渐进启用机制：前 N 次动作只记录不生效（shadowModeCount，如 A 路径默认 50、D 路径默认 100），用真实数据验证安全性后再逐步放行。",
    "aliases": ["shadow mode", "影子退场"],
    "forbiddenRedefinitions": ["把影子模式当成完全关闭（它仍在记录）", "把影子模式当成已经生效"],
    "owner": "src/dre/runtime/meta-cognitive-loop.ts",
    "evidence": ["前 N 次只记录不生效", "置信度阈值 + 限流 + 影子模式 + 预算 + 去重"]
  },
  {
    "id": "CAL-09",
    "canonical": "共形预测",
    "en": "Conformal Prediction",
    "domain": "determinism",
    "definition": "归纳式共形预测（Inductive Conformal Prediction）：对陈述定义非一致性度量 s = 1 − max_evidence_score，经校准集得分位数与 p 值，输出 HallucinationVerdict。属置信度信号，不单独承担决策权。",
    "aliases": ["Inductive Conformal Prediction", "共形置信度"],
    "forbiddenRedefinitions": ["把未校准的共形 p 值当作可直接阻断的判定（未经校准的 p 值不具决策效力）"],
    "owner": "docs/AXIOM-ARCHITECTURE.md",
    "evidence": ["归纳式共形预测（Inductive Conformal Prediction）"]
  },
  {
    "id": "CAL-10",
    "canonical": "Persona",
    "en": "Persona",
    "domain": "architecture",
    "definition": "ADR-005：Persona 不是独立 Agent 实例，而是 Runtime 的配置上下文（约束 + 心智模型 + 能力）；可堆叠与组合（push/pop），切换比创建 Agent 轻量（无状态迁移开销）。",
    "aliases": ["角色配置"],
    "forbiddenRedefinitions": ["把 Persona 当成有独立状态与生命周期的 Agent 实例"],
    "owner": "docs/AXIOM-ARCHITECTURE.md",
    "evidence": ["ADR-005: Persona 非 Agent"]
  },
  {
    "id": "CAL-11",
    "canonical": "Atom",
    "en": "Atom",
    "domain": "data",
    "definition": "核心数据抽象：一切皆 Atom（31 种类型）；由 DataUnifier 保证 Atom 始终与 KnowledgeNode 一起原子创建。",
    "aliases": [],
    "forbiddenRedefinitions": ["绕过 DataUnifier 直接单写 Atom（会破坏与 KnowledgeNode 的原子性）"],
    "owner": "docs/AXIOM-ARCHITECTURE.md",
    "evidence": ["一切皆 Atom", "31 种类型"]
  },
  {
    "id": "CAL-12",
    "canonical": "DataUnifier",
    "en": "DataUnifier",
    "domain": "data",
    "definition": "ADR-003 统一数据入口：所有数据经 DataUnifier 写入与查询，替代 VFS + KnowledgeStore + AtomEngine 三个独立入口，保证写一致与原子性。",
    "aliases": ["统一数据入口"],
    "forbiddenRedefinitions": ["新增绕过 DataUnifier 的第四个数据入口"],
    "owner": "docs/AXIOM-ARCHITECTURE.md",
    "evidence": ["ADR-003: 统一数据入口 (DataUnifier)"]
  },
  {
    "id": "CAL-13",
    "canonical": "KAL",
    "en": "Knowledge Access Layer",
    "domain": "data",
    "definition": "统一知识访问层（Knowledge Access Layer）：对 KnowledgeNode/Atom 的统一确定性查询入口；src/eval/kal-determinism.ts 以同一查询跑 N 次逐字节比对来证明其确定性。",
    "aliases": ["Knowledge Access Layer", "统一知识访问层"],
    "forbiddenRedefinitions": ["把 KAL 查询当作可容忍结果序漂移（其确定性由检索确定性门禁要求）"],
    "owner": "src/kal/knowledge-access-layer.ts",
    "evidence": ["统一知识访问层 (Knowledge Access Layer)"]
  },
  {
    "id": "CAL-14",
    "canonical": "DRE",
    "en": "Deterministic Reasoning Engine",
    "domain": "architecture",
    "definition": "Deterministic Reasoning Engine：Axiom 的确定性推理引擎，位于 src/dre/（约 14 个子模块），核心原则为确定性、可追溯、可回放、可审计、防幻觉；DREngine（src/dre/engine.ts）为引擎主入口。",
    "aliases": ["确定性推理引擎", "DREngine"],
    "forbiddenRedefinitions": ["把 DRE 当成非确定性的生成式引擎"],
    "owner": "docs/DRE-ARCHITECTURE.md",
    "evidence": ["DRE 是 Axiom 的确定性推理引擎"]
  },
  {
    "id": "CAL-15",
    "canonical": "任务契约",
    "en": "Task Contract",
    "domain": "process",
    "definition": "AGENTS.md 规则 0.4 的最小计划格式：任务 / 验收标准 / 改动清单（文件级）/ 不做项 / 验证命令 / 风险·回滚。T1 可内联，T2 开工前必须明确，T3 必须落盘为计划文档。",
    "aliases": ["任务契约（Plan）", "Task Contract"],
    "forbiddenRedefinitions": ["计划未冻结即动工", "施工中扩大改动手而不回写契约"],
    "owner": "AGENTS.md",
    "evidence": ["统一任务契约"]
  },
  {
    "id": "CAL-16",
    "canonical": "完成证据",
    "en": "Definition of Done",
    "domain": "process",
    "definition": "AGENTS.md 规则 0.5（DoD）：diff 与冻结清单一致、验证命令与关键输出/退出码、规则 5 的 ops log 条目、commit hash 与推送目标、偏差与未决项。缺任一项不得声称完成。",
    "aliases": ["DoD", "Definition of Done"],
    "forbiddenRedefinitions": ["用『应该可以/大概通过』替代验证证据"],
    "owner": "AGENTS.md",
    "evidence": ["统一完成证据（DoD）"]
  },
  {
    "id": "CAL-17",
    "canonical": "门禁",
    "en": "Machine Gate",
    "domain": "process",
    "definition": "把口径变成可机器判定的命题、在本地/CI 可重复执行并会因违规变红的检查（tests/ 下的文档契约门、架构完整性门、env 模板完整性门等）。",
    "aliases": ["machine gate", "机器门"],
    "forbiddenRedefinitions": ["用人工比对替代可执行门禁", "豁免整个文件使门对自己免检"],
    "owner": "AGENTS.md",
    "evidence": ["任务分级与施工门禁"]
  }
];

/**
 * 注入开关（默认关闭）。未设置 / 空值 / 无法识别一律关闭。
 *
 * 为什么默认关：A-0 是零行为变更切片——默认不注入，运行时输出与改动前逐字一致；
 * 显式设 AXIOM_CALIBER_GLOSSARY=1/true/yes 才把口径契约注入 system prompt。
 * 采用与 src/utils/security-defaults.ts 同款的"整表传入"写法（避免 src/ 直读 process.env.X）。
 */
export function glossaryEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env[CALIBER_GLOSSARY_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * 把口径契约渲染为可注入的文本块（确定性：按 id 升序，同输入同输出）。
 */
export function formatGlossaryBlock(
  entries: readonly CaliberEntry[] = CALIBER_ENTRIES,
): string {
  const lines: string[] = [];
  lines.push(CALIBER_GLOSSARY_MARKER);
  lines.push(
    `以下为项目术语的规范定义，唯一机器来源：${CALIBER_SOURCE_PATH}。禁止自行改写或曲解；与其它叙述冲突时以本契约为准。`,
  );
  const ordered = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  for (const e of ordered) {
    const head = e.en ? `${e.canonical} / ${e.en}` : e.canonical;
    lines.push(`- ${head} [${e.domain}]：${e.definition}`);
    if (e.forbiddenRedefinitions.length > 0) {
      lines.push(`  禁改口径：${e.forbiddenRedefinitions.join("；")}`);
    }
  }
  lines.push(CALIBER_GLOSSARY_END);
  return lines.join("\n");
}

/**
 * 开关开启时返回注入段文本，否则返回空串（调用方据此决定是否追加，保证默认零行为变更）。
 */
export function renderCaliberSection(
  env: Record<string, string | undefined> = process.env,
): string {
  if (!glossaryEnabled(env)) return "";
  return formatGlossaryBlock();
}
