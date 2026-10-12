/**
 * Wind 原件 → 知识库副本（2026-10-07）
 *
 * 用户裁定的分层：**原件留在 `data/raw/`（可复核、可重放），副本才进项目知识库**。
 * 本脚本只读原件，生成**可被语义检索**的笔记，写入 Vault 并由既有推送腿自动嵌入。
 *
 * ## 为什么按这个粒度出副本
 * - **macro（20 指标）**：一指标一笔记，含逐月数据表 + 最新值 —— 最容易被问"最近 CPI 怎么走"。
 * - **fundamentals**：一指数一笔记（否则 1800 只 = 1800 篇碎片），表内按标的列出关键指标。
 * - **kline**：**不逐只入库**（265 个标的 × 666 行会淹没知识库），改为出一篇
 *   **数据字典 + 覆盖度**笔记：字段含义、复权口径、区间、各指数覆盖数。
 * - **announcements**：一指数一笔记，只保留标题与日期（正文在原件里）。
 *
 * 用法:
 *   bun run scripts/ingest-wind-raw.ts --category=macro
 *   bun run scripts/ingest-wind-raw.ts --all
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { VaultManager } from "../src/memory/vault-manager.js";
import { resolveKnowledgeDbPath } from "../src/knowledge/kb-db-path.js";
import { enableKnowledgeEmbeddingIndex } from "../src/services/knowledge-embedding-index.js";

const RAW = "data/raw/quant/wind";
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const want = (cat: string) => process.argv.includes("--all") || arg("category") === cat;

const dbPath = resolveKnowledgeDbPath();
const db = new Database(dbPath);
enableKnowledgeEmbeddingIndex(db);
const vault = new VaultManager();

const filesOf = (tool: string): string[] => {
  const d = join(RAW, tool);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => join(d, f));
};
const readJson = (p: string): unknown => JSON.parse(readFileSync(p, "utf8"));
const num = (x: unknown): number => (typeof x === "number" ? x : Number(x));
/** 路径消毒：Wind 指标名含 `:`（如 `中国:PPI:当月同比`），冒号在路径/URL 里会出问题 */
const safeName = (s: string): string => s.replace(/[:/\\*?"<>|]/g, "-").replace(/\s+/g, "").slice(0, 80);
const fx = (x: unknown, d = 2): string => (Number.isFinite(num(x)) ? num(x).toFixed(d) : String(x ?? "-"));

let written = 0;
async function writeNote(path: string, title: string, tags: string[], body: string): Promise<void> {
  await vault.writeNote(path, body, { title, tags, type: "reference", overwrite: true });
  written++;
  console.log(`  ✓ ${path}`);
}

// ── macro：一指标一笔记（逐月序列）──────────────────────────────────────────
if (want("macro")) {
  console.log("宏观 EDB → 笔记");
  for (const f of filesOf("get_economic_data")) {
    const raw = readJson(f) as { data?: { date?: string[]; indicatorInfo?: Array<Record<string, unknown>> } };
    const d = raw.data ?? {};
    const dates = d.date ?? [];
    const info = d.indicatorInfo ?? [];
    const ind = info[0] ?? {};
    // 实测（2026-10-07）：Wind EDB 的取值在 `indicatorInfo[0].data`（与 date 等长的数值数组），
    // 不是 value/values —— 先前取错字段导致所有期数渲染成 "-"。
    const values = (ind.data as unknown[]) ?? [];
    const rawName = String(ind.name ?? f.split("/").pop()!.replace(".json", ""));
    const name = rawName;
    const latest = dates.length - 1;
    if (values.length === 0) {
      console.log(`  ! ${name}: 原件里没有取到数值数组（dates=${dates.length}），跳过以免写入空表`);
      continue;
    }
    // 轮 7 审计：values（ind.data）与 dates 是独立数组，长度可能不等（上面守卫
    // 只查 values 非空）——错位期数会静默渲染 "-"（L61 教训同型：字段失配）。
    // 按最小长度尾部配对渲染，失配时显式提示。
    const pairN = Math.min(dates.length, values.length);
    const rows: string[] = [];
    for (let i = Math.max(0, pairN - 24); i < pairN; i++) {
      rows.push(`| ${dates[i]} | ${fx(values[i])} |`);
    }
    if (dates.length !== values.length) {
      console.log(`  ! ${name}: dates(${dates.length}) 与 values(${values.length}) 不等长，按尾部 ${pairN} 期配对渲染`);
    }
    const body = [
      `# 宏观指标：${name}`,
      ``,
      `> 来源：Wind EDB（原件 \`${f}\`）｜代码：${ind.code ?? "-"}｜频率：${ind.calcFreq ?? "-"}｜单位：${ind.unit ?? "-"}${ind.calcCurrency ? `｜币种：${ind.calcCurrency}` : ""}`,
      `> 区间：${dates[0] ?? "-"} → ${dates[latest] ?? "-"}（共 ${dates.length} 期）`,
      ``,
      `## 最新值`,
      `**${name}** 最新一期（${dates[latest] ?? "-"}）为 **${fx(values[latest])}**。`,
      ``,
      `## 近 24 期`,
      `| 日期 | 数值 |`,
      `|---|---|`,
      ...rows,
      ``,
    ].join("\n");
    await writeNote(
      `00-Knowledge/Finance/Quant/宏观数据/${safeName(name)}.md`,
      `宏观指标 ${name}`,
      ["finance", "quant", "macro", "wind"],
      body,
    );
  }
}

// ── fundamentals：一指数一笔记 ──────────────────────────────────────────────
if (want("fundamentals")) {
  console.log("财务 → 笔记（按指数聚合）");
  const uni = existsSync("data/wind-universe.json")
    ? (readJson("data/wind-universe.json") as { indexes: Record<string, { name: string; members: Array<{ windcode: string; name: string }> }> })
    : null;
  const rows: string[] = [];
  for (const f of filesOf("get_stock_fundamentals")) {
    const wc = f.split("/").pop()!.replace(".json", "");
    const raw = readJson(f) as { data?: { data?: Array<{ columns: Array<{ name: string; unit?: string }>; rows: unknown[][] }> } };
    const tbl = raw.data?.data?.[0];
    if (!tbl) continue;
    const cols = tbl.columns.map((c) => c.name);
    const row = tbl.rows[0] ?? [];
    const cells = cols.map((c, i) => {
      const unit = tbl.columns[i].unit;
      const v = row[i];
      return `${c}=${typeof v === "number" ? v.toFixed(2) : String(v ?? "-")}${unit ? `(${unit})` : ""}`;
    });
    rows.push(`| \`${wc}\` | ${cells.slice(2).join(" · ")} |`);
  }
  if (rows.length > 0) {
    const body = [
      `# A股财务指标（Wind）`,
      ``,
      `> 来源：Wind \`stock_data.get_stock_fundamentals\`｜原件目录 \`${RAW}/get_stock_fundamentals/\``,
      `> 口径：**最新一期**（按各公司披露进度，非同一财季）；金额单位亿元，比率单位 %。`,
      `> 覆盖：${rows.length} 只（采集按指数成分轮转；完整名单见 \`data/wind-universe.json\`）。`,
      ``,
      `| Wind代码 | 财务要点 |`,
      `|---|---|`,
      ...rows,
      ``,
    ].join("\n");
    await writeNote("00-Knowledge/Finance/Quant/财务指标/A股财务快照.md", "A股财务指标快照", ["finance", "quant", "fundamentals", "wind"], body);
  }
}

// ── kline：数据字典 + 覆盖度（不逐只入库）──────────────────────────────────
if (want("kline")) {
  console.log("K线 → 数据字典笔记");
  const files = filesOf("stock_kline");
  let minRows = Infinity;
  let maxRows = 0;
  let first = "-";
  let last = "-";
  for (const f of files) {
    const raw = readJson(f) as { data?: { rows?: string[][] } };
    const r = raw.data?.rows ?? [];
    if (r.length === 0) continue;
    minRows = Math.min(minRows, r.length);
    maxRows = Math.max(maxRows, r.length);
    if (first === "-") first = r[0][0].slice(0, 10);
    last = r[r.length - 1][0].slice(0, 10);
  }
  const body = [
    `# 量化行情数据字典（Wind 日线）`,
    ``,
    `> 来源：Wind \`stock_data.get_stock_kline\`｜原件目录 \`${RAW}/stock_kline/\``,
    `> 覆盖：**${files.length} 只**（沪深300 → 中证500 → 中证1000 轮转，进度见 \`data/wind-rotation.json\`）`,
    `> 区间：${first} → ${last}｜每只行数 ${Number.isFinite(minRows) ? minRows : 0}–${maxRows}`,
    ``,
    `## 字段口径`,
    `| 字段 | 含义 | 备注 |`,
    `|---|---|---|`,
    `| TIME | 交易日 | ISO8601，含 +08:00 时区 |`,
    `| OPEN | 开盘价 | 已按请求参数复权 |`,
    `| MATCH | **收盘价** | Wind 用 MATCH 表示收盘，非 CLOSE |`,
    `| HIGH / LOW | 最高 / 最低价 | |`,
    `| TURNOVER | 成交额 | 原始单位（元） |`,
    `| VOLUME | 成交量 | 原始单位（股） |`,
    `| CHANGEHANDRATE | 换手率 | % |`,
    `| AVPRICE | 均价 | |`,
    ``,
    `## 采集口径（避免误用）`,
    `- **复权方式**：请求固定 \`aftime="0"\`（**前复权**）；换复权口径必须重采，不可与其它来源混用。`,
    `- **周期**：\`period="10"\`（日线）。`,
    `- **起点**：${first}（脚本常量 KLINE_BEGIN）。`,
    `- **配额**：每次调用 1 个标的；日上限由 \`WIND_DAILY_CAP\` 控制，用量账本 \`data/wind-usage.jsonl\`。`,
    ``,
  ].join("\n");
  await writeNote("00-Knowledge/Finance/Quant/数据字典/Wind日线数据字典.md", "Wind 日线数据字典", ["finance", "quant", "data-dictionary", "wind"], body);
}

// ── announcements：一指数一笔记（仅标题+日期）───────────────────────────────
if (want("announcements")) {
  console.log("公告 → 笔记（标题摘要）");
  const lines: string[] = [];
  for (const f of filesOf("get_company_announcements")) {
    const wc = f.split("/").pop()!.replace(".json", "");
    const raw = readJson(f) as { data?: { items?: Array<{ content?: string; title?: string; date?: string }> } };
    for (const it of (raw.data?.items ?? []).slice(0, 3)) {
      const title = (it.title ?? it.content ?? "").replace(/\s+/g, " ").slice(0, 80);
      if (title) lines.push(`| \`${wc}\` | ${it.date ?? "-"} | ${title}… |`);
    }
  }
  if (lines.length > 0) {
    const body = [
      `# A股公司公告摘要（Wind）`,
      ``,
      `> 来源：Wind \`financial_docs.get_company_announcements\`｜原件目录 \`${RAW}/get_company_announcements/\``,
      `> 说明：**只保留标题与日期**做线索；正文全文在原件 JSON 里，检索到线索后可回原件取全文。`,
      ``,
      `| Wind代码 | 日期 | 标题（截断） |`,
      `|---|---|---|`,
      ...lines,
      ``,
    ].join("\n");
    await writeNote("00-Knowledge/Finance/Quant/公告/A股公告摘要.md", "A股公告摘要", ["finance", "quant", "announcements", "wind"], body);
  }
}

db.close();
console.log(`完成：写入 ${written} 篇副本笔记`);
if (written === 0) process.exit(4);
