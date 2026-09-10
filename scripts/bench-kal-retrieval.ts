/**
 * P2-S6 W5/W8 重立项前置门禁 — 真实规模 KAL 检索基准：LIKE（现状） vs FTS5 trigram
 *
 * 规格：docs/superpowers/specs/2026-08-30-p2-closeout-design.md §S6
 *
 * 做什么：
 *   - 合成库（内存 SQLite，不入真实 data/）：10k / 50k / 100k 三档 kg_nodes，
 *     CJK+英文混合（随机中文词组合 + 英文句子），列结构对齐 src/kg/schema.ts 的 KG_SCHEMA_DDL。
 *   - 对照组：
 *     A = 现状 LIKE：逐字照抄 src/kal/knowledge-access-layer.ts queryKG 的 LIKE SQL
 *         （name/description/semantic 三列 `%q%`，ORDER BY importance DESC, id ASC，LIMIT）。
 *     B = FTS5 trigram：脚本内对 kg_nodes 建 fts5 trigram 虚拟表 + 同步触发器
 *         （S2 基建同款模式，镜像 src/memory/sqlite-memory.ts；非生产迁移），
 *         MATCH 词序规则镜像 KAL.sanitizeFTS5（词拆分、>=3 字符、`"词"*` OR 连接），
 *         并含 <3 字 CJK 短词的 LIKE 兜底腿（镜像 queryVault P1-S2 层2 生产模式）。
 *   - 查询集：精确词 / 语序改写 / 前缀 3 类 × 每类 20 查询（从实际生成内容采样，保证可复现）。
 *   - 计时：每查询预热 1 次后计时 3 次取中位数，p50/p95 跨 20 查询统计；同时记录召回行数（LIMIT 10，生产默认）。
 *   - 输出：docs/knowledge/kal-benchmark-2026-08-30.md（规模×方案×查询类型矩阵 + 结论行）。
 *     结论门禁：FTS p95 中位增益（2 规模 × 3 类型共 6 格的 p95 增益中位数）
 *     < 2x → "W5/W8 正式关闭（LIKE 现状保留）"；>= 2x → "立项排期"。
 *
 * 不做什么：
 *   - 不写真实 data/ 数据库（全程 :memory:）；
 *   - 不进 test:full（bench 非测试）；
 *   - 不生产迁移 FTS（B 组建表仅存在于脚本内内存库）。
 *
 * Usage:
 *   bun run scripts/bench-kal-retrieval.ts
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { KG_SCHEMA_DDL } from "../src/kg/schema.js";

// ──────────────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────────────

const SCALES = [10_000, 50_000, 100_000];
const QUERIES_PER_CLASS = 20;
const TIMED_RUNS = 3; // 每查询计时 3 次取中位数（预热 1 次在外）
const LIMIT = 10; // queryKG 生产默认 limit
const SEED = 42;
const REPORT_DATE = "2026-08-30";
const REPORT_PATH = path.resolve(import.meta.dir, `../docs/knowledge/kal-benchmark-${REPORT_DATE}.md`);

const scaleLabel = (v: number): string => (v >= 1000 ? `${v / 1000}k` : String(v));

const TYPE_POOL = ["function", "class", "concept", "entity", "method", "module"];
const TAG_POOL = ["core", "infra", "retrieval", "memory", "agent", "storage", "runtime", "eval"];

// 中文词池：多数 2 字词（真实中文查询主形态），含部分 3-4 字词（trigram 可覆盖）
const CJK_WORDS = [
  "数据", "模型", "缓存", "检索", "记忆", "代理", "调度", "会话", "存储", "索引",
  "查询", "路由", "网关", "凭证", "令牌", "配置", "监控", "告警", "指标", "追踪",
  "日志", "快照", "备份", "恢复", "迁移", "补丁", "版本", "分支", "提交", "合并",
  "测试", "断言", "夹具", "桩件", "仿真", "回归", "基线", "阈值", "预算", "配额",
  "限流", "重试", "降级", "熔断", "回滚", "幂等", "并发", "锁步", "队列", "缓冲",
  "管道", "解析", "编码", "解码", "压缩", "加密", "签名", "校验", "审计", "溯源",
  "图谱", "实体", "关系", "属性", "标签", "社区", "权重", "评分", "排名", "摘要",
  "嵌入", "向量", "相似", "聚类", "分类", "标注", "训练", "推断", "采样", "温度",
  "提示", "补全", "对话", "角色", "权限", "策略", "规则", "约束", "校准", "幻觉",
  "事实", "证据", "引用", "来源", "摘要", "大纲", "草稿", "评审", "发布", "归档",
  // 3-4 字词（trigram >=3 字符可覆盖）
  "数据库", "分布式", "机器学习", "神经网络", "知识图谱", "向量检索", "缓存策略",
  "微服务", "编译器", "操作系统", "一致性", "可用性", "分片键", "布隆过滤", "倒排索引",
];

// 英文词池（>=5 字符者可作前缀类采样源）
const EN_WORDS = [
  "database", "cache", "session", "storage", "pipeline", "scheduler", "memory",
  "context", "retrieval", "embedding", "tensor", "gradient", "compiler", "runtime",
  "network", "protocol", "queue", "worker", "stream", "parser", "tokenizer",
  "index", "query", "schema", "migration", "backup", "restore", "monitor",
  "alert", "metric", "trace", "config", "secret", "token", "auth", "gateway",
  "router", "dispatcher", "model", "agent", "planner", "critic", "verifier",
  "curator", "digest", "snapshot", "ledger", "journal", "buffer", "channel",
  "socket", "thread", "process", "kernel", "driver", "daemon", "service",
  "handler", "listener", "emitter", "reducer", "selector", "iterator", "generator",
  "wrapper", "adapter", "factory", "builder", "visitor", "observer", "strategy",
  "command", "template", "proxy", "facade", "bridge", "composite", "decorator",
  "knowledge", "graph", "entity", "relation", "weight", "ranking", "summary",
  "vector", "cluster", "classifier", "label", "inference", "sampling", "prompt",
  "completion", "dialogue", "policy", "constraint", "calibration", "hallucination",
  "evidence", "citation", "outline", "draft", "review", "publish", "archive",
];

// ──────────────────────────────────────────────────────────────────────────
// 可复现随机源（mulberry32，seed 固定 → 语料与查询集确定性）
// ──────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function pickInt(rng: () => number, minIncl: number, maxIncl: number): number {
  return minIncl + Math.floor(rng() * (maxIncl - minIncl + 1));
}

// ──────────────────────────────────────────────────────────────────────────
// 合成库构建（内存库，不入真实 data/）
// ──────────────────────────────────────────────────────────────────────────

/** 语料采样记录：查询集仅从这些"确认已写入语料"的 token 采样，保证 LIKE/FTS 均有真实命中面 */
interface CorpusTokens {
  cjkShort: string[]; // 2 字 CJK 词（trigram 无法覆盖，走兜底腿）
  cjkLong: string[]; // >=3 字 CJK 词
  enWords: string[]; // 英文词
  cjkRuns: string[]; // 连续中文串（>=4 字，供 3 字前缀采样）
}

/** B 组 FTS5 trigram 虚拟表 + 同步触发器（镜像 sqlite-memory.ts P1-S2 模式；脚本内内存库，非生产迁移） */
const KG_FTS_DDL = `
      CREATE VIRTUAL TABLE kg_nodes_fts USING fts5(
        name, description, semantic,
        tokenize='trigram'
      );
      CREATE TRIGGER kg_nodes_fts_ai AFTER INSERT ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
        VALUES (new.rowid, new.name, new.description, new.semantic);
      END;
      CREATE TRIGGER kg_nodes_fts_ad AFTER DELETE ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, description, semantic)
        VALUES('delete', old.rowid, old.name, old.description, old.semantic);
      END;
      CREATE TRIGGER kg_nodes_fts_au AFTER UPDATE ON kg_nodes BEGIN
        INSERT INTO kg_nodes_fts(kg_nodes_fts, rowid, name, description, semantic)
        VALUES('delete', old.rowid, old.name, old.description, old.semantic);
        INSERT INTO kg_nodes_fts(rowid, name, description, semantic)
        VALUES (new.rowid, new.name, new.description, new.semantic);
      END;
    `;

interface Corpus {
  tokens: CorpusTokens;
  buildMs: number;
}

function buildSyntheticDb(scale: number): { db: Database; corpus: Corpus } {
  const db = new Database(":memory:");
  db.exec(KG_SCHEMA_DDL);
  db.exec(KG_FTS_DDL);

  const rng = mulberry32(SEED + scale);
  const tokens: CorpusTokens = { cjkShort: [], cjkLong: [], enWords: [], cjkRuns: [] };
  const seen = {
    cjkShort: new Set<string>(),
    cjkLong: new Set<string>(),
    enWords: new Set<string>(),
    cjkRuns: new Set<string>(),
  };

  const track = (s: string, list: string[], set: Set<string>) => {
    if (!set.has(s)) {
      set.add(s);
      list.push(s);
    }
  };

  /** 生成一个连续中文串（2-4 个词直接拼接），登记其中每个词与整串 */
  const cjkRun = (): string => {
    const n = pickInt(rng, 2, 4);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = pick(rng, CJK_WORDS);
      parts.push(w);
      if (w.length < 3) track(w, tokens.cjkShort, seen.cjkShort);
      else track(w, tokens.cjkLong, seen.cjkLong);
    }
    const run = parts.join("");
    if (run.length >= 4) track(run, tokens.cjkRuns, seen.cjkRuns);
    return run;
  };

  /** 生成一个英文短语（2-4 个空格分隔词） */
  const enPhrase = (): string => {
    const n = pickInt(rng, 2, 4);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = pick(rng, EN_WORDS);
      parts.push(w);
      track(w, tokens.enWords, seen.enWords);
    }
    return parts.join(" ");
  };

  const segment = (): string => (rng() < 0.5 ? cjkRun() : enPhrase());

  const makeDescription = (): string => {
    const n = pickInt(rng, 4, 7);
    const segs: string[] = [];
    for (let i = 0; i < n; i++) segs.push(segment());
    return segs.join(" ") + "。";
  };

  const makeName = (i: number): string => {
    const mode = rng();
    if (mode < 0.4) {
      // 英式标识符：驼峰拼接两个词
      const a = pick(rng, EN_WORDS);
      const b = pick(rng, EN_WORDS);
      track(a, tokens.enWords, seen.enWords);
      track(b, tokens.enWords, seen.enWords);
      return `${a}${b[0]!.toUpperCase()}${b.slice(1)}${i % 97}`;
    }
    if (mode < 0.7) return cjkRun();
    return `${cjkRun()} ${pick(rng, EN_WORDS)}`;
  };

  const insert = db.prepare(`
    INSERT INTO kg_nodes (id, type, name, description, file_path, line_number, signature,
                          semantic, tags, metadata, community, importance, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const now = 1756500000000; // 固定时间戳，保证语料确定性
  const buildStart = performance.now();
  db.exec("BEGIN");
  for (let i = 0; i < scale; i++) {
    const name = makeName(i);
    const description = makeDescription();
    const semantic = segment() + " " + segment();
    insert.run(
      `kg:${pick(rng, TYPE_POOL)}:node-${i}`,
      pick(rng, TYPE_POOL),
      name,
      description,
      `src/synthetic/mod-${i % 200}.ts`,
      pickInt(rng, 1, 4000),
      `${pick(rng, EN_WORDS)}(${pick(rng, EN_WORDS)})`,
      semantic,
      JSON.stringify([pick(rng, TAG_POOL)]),
      "{}",
      null,
      Math.round(rng() * 100) / 100,
      now,
      now,
    );
  }
  db.exec("COMMIT");
  const buildMs = Math.round(performance.now() - buildStart);
  return { db, corpus: { tokens, buildMs } };
}

// ──────────────────────────────────────────────────────────────────────────
// 查询集（3 类 × 20，从实际语料采样）
// ──────────────────────────────────────────────────────────────────────────

interface QuerySet {
  exact: string[]; // 精确词：2 字 CJK（走兜底）/ >=3 字 CJK / 英文整词
  reword: string[]; // 语序改写：多词乱序组合（整串 LIKE 难命中，FTS OR 语义可召回）
  prefix: string[]; // 前缀：英文词前缀（3-5 字符）+ 中文串 3 字前缀（均 >=3 字符，FTS 可覆盖）
}

function buildQueries(corpus: Corpus): QuerySet {
  const rng = mulberry32(SEED * 7 + 1);
  const { cjkShort, cjkLong, enWords, cjkRuns } = corpus.tokens;

  const exact: string[] = [];
  // 10 个 CJK：5 个 2 字（B 组走 LIKE 兜底腿，诚实反映生产模式）+ 5 个 >=3 字（FTS 可覆盖）
  for (let i = 0; i < 5; i++) exact.push(pick(rng, cjkShort));
  for (let i = 0; i < 5; i++) exact.push(pick(rng, cjkLong));
  // 10 个英文整词
  for (let i = 0; i < 10; i++) exact.push(pick(rng, enWords));

  const reword: string[] = [];
  // 10 个含 2 字 CJK 的双词乱序（B 组部分走兜底）+ 10 个纯 >=3 字组合（纯 FTS）
  for (let i = 0; i < 10; i++) {
    const a = pick(rng, cjkShort);
    const b = pick(rng, enWords);
    reword.push(rng() < 0.5 ? `${a} ${b}` : `${b} ${a}`);
  }
  for (let i = 0; i < 10; i++) {
    const a = pick(rng, cjkLong);
    const b = pick(rng, enWords);
    const c = pick(rng, enWords);
    reword.push(`${c} ${a} ${b}`);
  }

  const prefix: string[] = [];
  // 10 个英文前缀（3-5 字符，可能截在词中——子串匹配语义）
  for (let i = 0; i < 10; i++) {
    const w = pick(rng, enWords.filter((x) => x.length >= 5));
    prefix.push(w.slice(0, pickInt(rng, 3, 5)));
  }
  // 10 个中文串 3 字前缀（来自 >=4 字连续中文串，trigram 可覆盖）
  for (let i = 0; i < 10; i++) {
    prefix.push(pick(rng, cjkRuns).slice(0, 3));
  }

  return { exact, reword, prefix };
}

// ──────────────────────────────────────────────────────────────────────────
// A/B 两组查询执行器
// ──────────────────────────────────────────────────────────────────────────

/** A = 现状 LIKE：逐字照抄 src/kal/knowledge-access-layer.ts queryKG 的 LIKE SQL（去 typeFilter 分支） */
const LIKE_SQL = `
        SELECT id, type, name, description, tags, importance
        FROM kg_nodes
        WHERE (name LIKE ? OR description LIKE ? OR semantic LIKE ?)
        ORDER BY importance DESC, id ASC
        LIMIT ?
      `;

function runLike(db: Database, query: string): number {
  const pattern = `%${query}%`;
  return (db.query(LIKE_SQL).all(pattern, pattern, pattern, LIMIT) as unknown[]).length;
}

/**
 * B = FTS5 trigram：MATCH 词规则镜像 KAL.sanitizeFTS5(query, 3)（>=3 字符词 `"词"*` OR 连接），
 * <3 字 CJK 短词走 LIKE 兜底腿（镜像 queryVault P1-S2 层2 生产模式），结果并集去重后截 LIMIT。
 */
const FTS_SQL = `
        SELECT n.id, n.type, n.name, n.description, n.tags, n.importance
        FROM kg_nodes_fts fts
        JOIN kg_nodes n ON n.rowid = fts.rowid
        WHERE kg_nodes_fts MATCH ?
        ORDER BY n.importance DESC, n.id ASC
        LIMIT ?
      `;

const FTS_FALLBACK_SQL = `
        SELECT id, type, name, description, tags, importance
        FROM kg_nodes
        WHERE (name LIKE ? OR description LIKE ? OR semantic LIKE ?)
        ORDER BY importance DESC, id ASC
        LIMIT ?
      `;

function toFtsMatch(query: string): { match: string | null; shortCjk: string[] } {
  const words = query
    .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const shortCjk = words.filter((w) => w.length < 3 && /[\u4e00-\u9fa5]/.test(w));
  const ftsWords = words.filter((w) => w.length >= 3);
  const match = ftsWords.map((w) => `"${w}"*`).join(" OR ");
  return { match: match || null, shortCjk };
}

function runFts(db: Database, query: string): number {
  const { match, shortCjk } = toFtsMatch(query);
  const rows: Array<{ id: string }> = match
    ? (db.query(FTS_SQL).all(match, LIMIT) as Array<{ id: string }>)
    : [];
  const seen = new Set(rows.map((r) => r.id));
  for (const w of shortCjk) {
    if (rows.length >= LIMIT) break; // 已满则不再扫兜底腿（先查上限再扫，防溢出 LIMIT）
    const pattern = `%${w}%`;
    const likeRows = db
      .query(FTS_FALLBACK_SQL)
      .all(pattern, pattern, pattern, LIMIT) as Array<{ id: string }>;
    for (const r of likeRows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
        if (rows.length >= LIMIT) break;
      }
    }
  }
  return rows.length;
}

// ──────────────────────────────────────────────────────────────────────────
// 计时与统计
// ──────────────────────────────────────────────────────────────────────────

interface ClassStat {
  p50: number;
  p95: number;
  avgRecall: number;
}

interface CellStat {
  like: ClassStat;
  fts: ClassStat;
  gainP95: number; // like.p95 / fts.p95（fts.p95 下限 0.01ms 防除零）
  fallbackQueries: number; // B 组中触发 LIKE 兜底腿的查询数
}

const CLASS_NAMES = ["exact", "reword", "prefix"] as const;
type ClassName = (typeof CLASS_NAMES)[number];

const CLASS_LABELS: Record<ClassName, string> = {
  exact: "精确词",
  reword: "语序改写",
  prefix: "前缀",
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function percentile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(q * s.length) - 1);
  return s[Math.max(0, idx)]!;
}

function benchClass(db: Database, queries: string[], runner: (db: Database, q: string) => number): ClassStat {
  // 预热：每查询 1 次（页缓存 / 预编译语句 / FTS 段缓存）
  for (const q of queries) runner(db, q);
  const perQueryMedian: number[] = [];
  const recalls: number[] = [];
  for (const q of queries) {
    const times: number[] = [];
    let count = 0;
    for (let r = 0; r < TIMED_RUNS; r++) {
      const t0 = performance.now();
      count = runner(db, q);
      times.push(performance.now() - t0);
    }
    perQueryMedian.push(median(times));
    recalls.push(count);
  }
  return {
    p50: percentile(perQueryMedian, 0.5),
    p95: percentile(perQueryMedian, 0.95),
    avgRecall: recalls.reduce((a, b) => a + b, 0) / recalls.length,
  };
}

function benchCell(db: Database, queries: QuerySet): Record<ClassName, CellStat> {
  const out = {} as Record<ClassName, CellStat>;
  for (const cls of CLASS_NAMES) {
    const qs = queries[cls];
    const like = benchClass(db, qs, runLike);
    const fts = benchClass(db, qs, runFts);
    const fallbackQueries = qs.filter((q) => toFtsMatch(q).shortCjk.length > 0).length;
    out[cls] = {
      like,
      fts,
      gainP95: like.p95 / Math.max(fts.p95, 0.01),
      fallbackQueries,
    };
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 报告生成
// ──────────────────────────────────────────────────────────────────────────

function fmtMs(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function tierTable(scale: number, cells: Record<ClassName, CellStat>, buildMs: number, degraded?: string): string {
  const lines: string[] = [];
  lines.push(`### ${scaleLabel(scale)} 行`);
  lines.push("");
  if (degraded) {
    lines.push(`> ⚠️ **降级**：${degraded}`);
    lines.push("");
  }
  lines.push(`合成库构建（含 FTS 触发器同步索引写入）：${buildMs} ms`);
  lines.push("");
  lines.push("| 查询类型 | LIKE p50 (ms) | LIKE p95 (ms) | LIKE 召回均值 | FTS p50 (ms) | FTS p95 (ms) | FTS 召回均值 | p95 增益 | B 兜底腿查询数 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const cls of CLASS_NAMES) {
    const c = cells[cls];
    lines.push(
      `| ${CLASS_LABELS[cls]} | ${fmtMs(c.like.p50)} | ${fmtMs(c.like.p95)} | ${c.like.avgRecall.toFixed(1)} | ${fmtMs(c.fts.p50)} | ${fmtMs(c.fts.p95)} | ${c.fts.avgRecall.toFixed(1)} | ${c.gainP95.toFixed(2)}x | ${c.fallbackQueries}/${QUERIES_PER_CLASS} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const wallStart = performance.now();
  console.log(
    `[bench-kal] 开始 — Bun ${Bun.version} / ${process.platform} / ${os.cpus()[0]?.model ?? "unknown cpu"} / seed=${SEED}`,
  );

  const scaleResults: Array<{ scale: number; cells: Record<ClassName, CellStat>; buildMs: number; degraded?: string }> = [];

  for (const scale of SCALES) {
    const t0 = performance.now();
    try {
      const { db, corpus } = buildSyntheticDb(scale);
      // 冒烟反馈回路：FTS 索引必须真实在位（行数一致 + 已知词可命中），否则该组数据无效
      const ftsCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes_fts").get() as { c: number }).c;
      const nodeCount = (db.query("SELECT COUNT(*) AS c FROM kg_nodes").get() as { c: number }).c;
      if (ftsCount !== nodeCount) throw new Error(`FTS 索引行数不一致 fts=${ftsCount} nodes=${nodeCount}`);
      const probe = corpus.tokens.enWords[0]!;
      const smoke = runFts(db, probe);
      if (smoke === 0) throw new Error(`FTS 冒烟查询零命中（probe="${probe}"）`);

      const queries = buildQueries(corpus);
      const cells = benchCell(db, queries);
      scaleResults.push({ scale, cells, buildMs: corpus.buildMs });
      const tierMs = Math.round(performance.now() - t0);
      console.log(
        `[bench-kal] ${scale} 行完成（${tierMs} ms）：` +
          CLASS_NAMES.map((c) => `${c} p95 LIKE=${fmtMs(cells[c].like.p95)}ms FTS=${fmtMs(cells[c].fts.p95)}ms (${cells[c].gainP95.toFixed(2)}x)`).join("；"),
      );
      db.close();
    } catch (err) {
      // 50k 跑不完如实降级注明
      scaleResults.push({
        scale,
        cells: {} as Record<ClassName, CellStat>,
        buildMs: 0,
        degraded: `${scale} 档执行失败：${err instanceof Error ? err.message : String(err)}`,
      });
      console.error(`[bench-kal] ${scale} 档失败降级：`, err);
    }
  }

  // 结论门禁：p95 中位增益 = 全部成功格（2 规模 × 3 类型）p95 增益的中位数
  const okTiers = scaleResults.filter((r) => !r.degraded);
  const gains = okTiers.flatMap((r) => CLASS_NAMES.map((c) => r.cells[c]!.gainP95));
  const medianGain = gains.length ? median(gains) : 0;
  const verdict =
    gains.length === 0
      ? "数据不足，无法判定（全部档位失败）"
      : medianGain < 2
        ? "W5/W8 正式关闭（LIKE 现状保留）"
        : "立项排期";

  const totalMs = Math.round(performance.now() - wallStart);
  const md = buildReport(scaleResults, medianGain, verdict, totalMs);
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, md, "utf-8");
  console.log(`[bench-kal] 报告已写入 ${REPORT_PATH}（总耗时 ${totalMs} ms，p95 中位增益 ${medianGain.toFixed(2)}x）`);
  console.log(`[bench-kal] 结论：${verdict}`);
}

function buildReport(
  scaleResults: Array<{ scale: number; cells: Record<ClassName, CellStat>; buildMs: number; degraded?: string }>,
  medianGain: number,
  verdict: string,
  totalMs: number,
): string {
  const lines: string[] = [];
  lines.push(`# KAL 检索基准：LIKE（现状） vs FTS5 trigram — ${REPORT_DATE}`);
  lines.push("");
  lines.push(
    `> **摘要**：W5/W8 重立项前置门禁数据。合成 kg_nodes（CJK+英文混合）${SCALES.map(scaleLabel).join("/")} 共 ${SCALES.length} 档，对照组 A=现状 LIKE（照抄 \`src/kal/knowledge-access-layer.ts\` queryKG 的 LIKE SQL），B=FTS5 trigram（S2 基建同款虚拟表+触发器，脚本内内存库，非生产迁移）。3 类查询 × 每类 20 条，预热 1 次后计时 3 次取中位数，p50/p95 跨 20 查询。数字全部来自本次实跑（seed=${SEED} 可复现），总耗时 ${totalMs} ms。`,
  );
  lines.push("");
  lines.push(`> **结论行：FTS p95 中位增益 ${medianGain.toFixed(2)}x → ${verdict}**`);
  lines.push("");
  lines.push("## 方法");
  lines.push("");
  lines.push("- **语料**：内存 SQLite（`:memory:`，不入真实 `data/`），建表用 `src/kg/schema.ts` 的 `KG_SCHEMA_DDL`；name=中英混合标识符/中文串，description/semantic=中文串（2-4 词连写）与英文短语（2-4 词空格分隔）交错，importance 随机 0-1，其余列按 schema 填充。");
  lines.push("- **A 组（现状 LIKE）**：`WHERE (name LIKE ? OR description LIKE ? OR semantic LIKE ?)`，整串 `%q%`，`ORDER BY importance DESC, id ASC LIMIT 10`——与 queryKG 生产 SQL 逐字一致（去 typeFilter 分支）。");
  lines.push("- **B 组（FTS5 trigram）**：脚本内建 `kg_nodes_fts`（fts5 trigram 虚拟表 + AFTER INSERT/DELETE/UPDATE 同步触发器，镜像 `src/memory/sqlite-memory.ts` P1-S2 模式）。MATCH 规则镜像 `KAL.sanitizeFTS5(query, 3)`：词拆分、>=3 字符、`\"词\"*` OR 连接；**<3 字 CJK 短词走 LIKE 兜底腿**（镜像 queryVault 生产兜底模式），并集去重截 LIMIT 10。");
  lines.push("- **查询集**（从实际写入语料的 token 采样，保证命中面真实）：");
  lines.push("  - 精确词：5× 2 字 CJK（B 组走兜底腿）+ 5× >=3 字 CJK + 10× 英文整词；");
  lines.push("  - 语序改写：10× 2 字 CJK + 英文双词乱序 + 10× >=3 字 CJK + 双英文三词乱序（整串 LIKE 语义天然难命中，FTS OR 语义可召回——召回差异即现状真实短板）；");
  lines.push("  - 前缀：10× 英文词 3-5 字符前缀 + 10× 中文串 3 字前缀（均 >=3 字符，FTS 可覆盖）。");
  lines.push(`- **计时**：每查询预热 1 次 → 计时 ${TIMED_RUNS} 次取中位数；p50/p95 为跨 ${QUERIES_PER_CLASS} 条查询的 per-query 中位数分位数；召回均值 = LIMIT ${LIMIT}（生产默认）下实际返回行数。`);
  lines.push(`- **环境**：Bun ${Bun.version} / ${process.platform} / ${os.cpus()[0]?.model ?? "unknown"} / 日期 ${REPORT_DATE}。`);
  lines.push(`- **门禁口径**：p95 增益 = LIKE p95 / FTS p95（FTS p95 下限 0.01ms 防除零，即增益上限封顶 100x 量级）；**中位增益 = ${SCALES.length} 规模 × 3 类型共 ${SCALES.length * 3} 格 p95 增益的中位数**；<2x → W5/W8 正式关闭（LIKE 现状保留），>=2x → 立项排期。`);
  lines.push("");
  lines.push("## 结果矩阵");
  lines.push("");
  for (const r of scaleResults) {
    if (r.degraded) {
      lines.push(`### ${scaleLabel(r.scale)} 行`);
      lines.push("");
      lines.push(`> ⚠️ **降级**：${r.degraded}`);
      lines.push("");
    } else {
      lines.push(tierTable(r.scale, r.cells, r.buildMs));
    }
  }
  lines.push("## 召回差异分析");
  lines.push("");
  const ok = scaleResults.filter((r) => !r.degraded);
  if (ok.length) {
    const biggest = ok[ok.length - 1]!;
    lines.push(
      `- **语序改写**（最能体现现状短板）：LIKE 为整串子串匹配，乱序多词组合近乎零召回（均值 ${biggest.cells.reword.like.avgRecall.toFixed(1)}/${LIMIT}）；FTS OR 语义可召回（均值 ${biggest.cells.reword.fts.avgRecall.toFixed(1)}/${LIMIT}，触顶即 ${LIMIT}）。该差异是能力差异而非纯速度差异：即使速度增益不达标，召回鸿沟本身也是 W5/W8 的立项论据之一。`,
    );
    lines.push(
      `- **精确词**：2 字 CJK 词是中文查询主形态，trigram 最小 3 字符限制使其在 B 组仍走 LIKE 兜底腿（每类 ${biggest.cells.exact.fallbackQueries}/${QUERIES_PER_CLASS} 条含短词），该类增益被兜底腿拉平——即 P1-S2 已知局限在 KG 侧同样成立。`,
    );
    lines.push(
      `- **前缀**：>=3 字符前缀两侧均可命中，差异主要来自扫描方式（全表三列 LIKE vs trigram 索引）。`,
    );
  } else {
    lines.push("- 全部档位失败，无召回数据。");
  }
  lines.push("");
  lines.push("## 结论");
  lines.push("");
  lines.push(`- **p95 中位增益（${SCALES.length * 3} 格中位数）：${medianGain.toFixed(2)}x**`);
  lines.push(`- **结论行：${verdict}**`);
  lines.push("");
  lines.push("### 门禁解读");
  lines.push("");
  if (medianGain >= 2) {
    lines.push(
      "- 达到 2x 门槛 → W5（KG 索引优化）/W8 按本数据**立项排期**；落地形态建议：kg_nodes 侧 fts5 trigram 虚拟表 + 触发器（本脚本 B 组即原型），KAL queryKG 增加 MATCH 主腿 + 2 字 CJK LIKE 兜底腿（queryVault 同款模式），并接受语序改写召回能力提升这一附加收益。",
    );
  } else {
    lines.push(
      "- 未达 2x 门槛 → W5/W8 **正式关闭（LIKE 现状保留）**；语序改写召回短板另行记录，不作为索引优化立项依据。",
    );
  }
  lines.push("- 局限：合成语料为随机组合，词频分布较真实语料均匀；内存库无页缓存竞争；单机单次运行，绝对值会随环境波动，结论以倍数（相对增益）为准。");
  lines.push("");
  return lines.join("\n") + "\n";
}

main();
