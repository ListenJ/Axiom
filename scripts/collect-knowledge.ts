/**
 * 金融知识采集（2026-10-07）
 *
 * 流程：**搜索（SearXNG 优先） → 按权威域名选源 → 抓正文 → 写入 Vault → 触发向量索引**
 *
 * ## 为什么先选域名再抓
 * 实测 SearXNG 对中文金融查询的首条通常是权威源（人民银行/统计局），但
 * 结果里仍会混入二手站、导流站。本脚本按 `prefer` 域名白名单择优，
 * 命中不到才退回首条 —— 避免把二手转述当一手数据入知识库。
 *
 * ## 不做什么
 * - 不做数据抽取/建模：只把**原始页面正文**按 provenance 落库（来源 URL + 抓取时间）。
 * - 不绕过 robots / 反爬：抓取走既有 DataPipeline（含 requestDelay 与 UA 策略）。
 * - 不静默降级：源没抓到就报 `skipped` 并说明原因，不写占位内容。
 *
 * Usage:
 *   bun run scripts/collect-finance-knowledge.ts              # 全部主题
 *   bun run scripts/collect-finance-knowledge.ts --only=lpr   # 单个主题（试点）
 *   bun run scripts/collect-finance-knowledge.ts --list       # 列出主题
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DataPipeline } from "../src/crawl/data-pipeline.js";
import { SearchAggregator } from "../src/crawl/search-engines.js";
import { VaultManager } from "../src/memory/vault-manager.js";
import { resolveKnowledgeDbPath } from "../src/knowledge/kb-db-path.js";
import { enableKnowledgeEmbeddingIndex } from "../src/services/knowledge-embedding-index.js";

interface FinanceTopic {
  id: string;
  /** Vault 子目录（PARA 结构下 00-Knowledge/Finance/…） */
  dir: string;
  title: string;
  query: string;
  /** 一手权威域名（官方发布方；按序择优） */
  prefer: string[];
  /** 可接受的二手域名（正规财经媒体；会显式标注"二手，需交叉核对"） */
  secondary: string[];
  /**
   * **已知官方入口**（可选）：稳定站点的入口页优先直取，不依赖搜索引擎当次返回。
   * 动因（实测）：官网索引页时常不被 SearXNG 的上游收录，
   * "中国货币政策执行报告"的查询曾只返回 DOI/新闻聚合壳；而官方入口页直抓 9409 字符稳定可复现。
   */
  seedUrls?: string[];
  tags: string[];
}

const FINANCE_TOPICS: FinanceTopic[] = [
  {
    id: "lpr",
    dir: "货币政策/LPR",
    title: "贷款市场报价利率（LPR）",
    query: "中国人民银行 贷款市场报价利率 LPR 公告",
    prefer: ["pbc.gov.cn", "chinamoney.com.cn"],
    secondary: ["eastmoney.com"],
    seedUrls: ["https://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125440/3876551/index.html"],
    tags: ["finance", "monetary-policy", "lpr"],
  },
  {
    id: "cpi",
    dir: "宏观经济/CPI",
    title: "居民消费价格指数（CPI）",
    // 修正（2026-10-07 实测）：加"数据/月度/官方"后才会命中 stats.gov.cn，
    // 原查询首条落到商业数据站 data.cnfol.com。
    query: "国家统计局 数据 居民消费价格指数 月度 官方",
    prefer: ["stats.gov.cn"],
    secondary: ["eastmoney.com"],
    seedUrls: ["https://www.stats.gov.cn/zs/tjws/zytjzbqs/jmxxggzs/"],
    tags: ["finance", "macro", "cpi"],
  },
  {
    id: "ppi",
    dir: "宏观经济/PPI",
    title: "工业生产者出厂价格指数（PPI）",
    query: "国家统计局 工业生产者出厂价格指数 PPI",
    prefer: ["stats.gov.cn"],
    secondary: ["eastmoney.com"],
    seedUrls: ["https://www.stats.gov.cn/zs/tjws/zytjzbqs/gyscz/202409/t20240910_1956355.html"],
    tags: ["finance", "macro", "ppi"],
  },
  {
    id: "gdp",
    dir: "宏观经济/GDP",
    title: "国内生产总值（GDP）",
    query: "国家统计局 国内生产总值 GDP 初步核算",
    prefer: ["stats.gov.cn"],
    secondary: ["eastmoney.com"],
    seedUrls: ["https://www.stats.gov.cn/sj/zxfb/202302/t20230203_1898258.html"],
    tags: ["finance", "macro", "gdp"],
  },
  {
    id: "csi300",
    dir: "市场指数/沪深300",
    title: "沪深300指数编制方案",
    // csindex.com.cn 是 SPA（实测直抓只得 132 字符 "Untitled"，需浏览器渲染），
    // 故保留它为一手源但预期会落到正规财经媒体的规则解读（二手）。
    query: "中证指数公司 沪深300指数 样本空间规则 修订",
    prefer: ["csindex.com.cn", "sse.com.cn", "szse.cn"],
    secondary: ["eastmoney.com", "sina.com.cn", "xueqiu.com"],
    tags: ["finance", "index", "csi300"],
  },
  {
    id: "monetary-report",
    dir: "货币政策/执行报告",
    title: "中国货币政策执行报告",
    query: "中国人民银行 中国货币政策执行报告",
    prefer: ["pbc.gov.cn"],
    secondary: ["eastmoney.com"],
    seedUrls: ["http://www.pbc.gov.cn/zhengcehuobisi/125207/125227/125957/index.html"],
    tags: ["finance", "monetary-policy", "report"],
  },
];

/** 领域 → 主题表。新增领域只需在此追加，脚本/归档/入库链路自动适配。 */
const DOMAINS: Record<string, { knowledgeDir: string; topics: FinanceTopic[] }> = {
  /** 金融基础与统计口径（最新官方发布页） */
  finance: { knowledgeDir: "Finance", topics: [] as FinanceTopic[] },
  /**
   * 量化交易知识体系（2026-10-07 按用户目标新增）：
   * 目标是支撑「一整个量化交易模型的构建」，故按建模全链路选题，
   * 而非零散概念 —— 数据口径 → 因子 → 回测 → 组合 → 风控 → 执行 → 衍生品 → 统计。
   */
  quant: {
    knowledgeDir: "Finance/Quant",
    topics: [
      { id: "microstructure", dir: "市场微观结构", title: "市场微观结构与订单簿", query: "market microstructure limit order book price formation", prefer: ["arxiv.org"], secondary: ["ssrn.com", "sciencedirect.com"], tags: ["quant", "microstructure", "orderbook"] },
      { id: "factor-model", dir: "因子模型", title: "多因子模型与 Alpha 因子构建", query: "multifactor model alpha factor construction equity returns", prefer: ["arxiv.org", "ssrn.com"], secondary: ["papers.ssrn.com"], tags: ["quant", "factor", "alpha"] },
      { id: "backtest-bias", dir: "回测方法论", title: "回测偏差：前视/幸存者/数据窥探", query: "backtest overfitting look-ahead bias survivorship bias quantitative trading", prefer: ["arxiv.org", "ssrn.com"], secondary: ["papers.ssrn.com"], tags: ["quant", "backtest", "methodology"] },
      { id: "portfolio-optimization", dir: "组合优化", title: "组合优化（均值方差/风险平价/Black-Litterman）", query: "portfolio optimization mean variance risk parity Black-Litterman", prefer: ["arxiv.org"], secondary: ["ssrn.com"], tags: ["quant", "portfolio", "optimization"] },
      { id: "risk-management", dir: "风险管理", title: "风险度量：VaR/CVaR/回撤/压力测试", query: "value at risk CVaR drawdown stress testing portfolio", prefer: ["arxiv.org"], secondary: ["ssrn.com"], tags: ["quant", "risk", "var"] },
      { id: "execution", dir: "交易执行", title: "执行算法与交易成本（TWAP/VWAP/实施差额）", query: "optimal execution algorithm VWAP TWAP implementation shortfall market impact", prefer: ["arxiv.org", "ssrn.com"], secondary: [], tags: ["quant", "execution", "tca"] },
      { id: "derivatives", dir: "衍生品定价", title: "期权定价与希腊字母", query: "option pricing Black-Scholes Greeks stochastic volatility", prefer: ["arxiv.org"], secondary: [], tags: ["quant", "derivatives", "options"] },
      { id: "time-series", dir: "时间序列", title: "时间序列分析：协整/状态空间/GARCH", query: "cointegration state space GARCH financial time series forecasting", prefer: ["arxiv.org"], secondary: [], tags: ["quant", "timeseries", "garch"] },
      { id: "transaction-cost", dir: "交易成本", title: "市场冲击与滑点建模", query: "market impact model slippage transaction cost square root law", prefer: ["arxiv.org", "ssrn.com"], secondary: [], tags: ["quant", "cost", "impact"] },
      { id: "data-caliber", dir: "数据口径", title: "量化数据口径：复权/停牌/退市/财报调整", query: "quantitative trading data adjustment survivorship delisting corporate action point in time", prefer: ["arxiv.org", "ssrn.com"], secondary: [], tags: ["quant", "data", "caliber"] },
    ],
  },
  /**
   * 设计 / 前端原型（2026-10-07 按用户要求新增）：
   * 覆盖「设计原则 → 设计系统 → 原型工具 → 无障碍 → 动效 → 落地组件」全链。
   */
  design: {
    knowledgeDir: "Design",
    topics: [
      { id: "design-system", dir: "设计系统", title: "设计系统（Design System）构建方法", query: "how to build a design system tokens components documentation", prefer: ["nngroup.com", "smashingmagazine.com"], secondary: ["material.io", "m3.material.io"], tags: ["design", "design-system", "tokens"] },
      { id: "interaction-principles", dir: "交互原则", title: "交互设计十原则与可用性启发式", query: "Nielsen 10 usability heuristics interaction design principles", prefer: ["nngroup.com"], secondary: ["interaction-design.org"], tags: ["design", "ux", "heuristics"] },
      { id: "accessibility", dir: "无障碍", title: "无障碍设计与 WCAG 2.2", query: "WCAG 2.2 accessibility guidelines practical implementation", prefer: ["w3.org"], secondary: ["nngroup.com", "webaim.org"], tags: ["design", "a11y", "wcag"] },
      { id: "prototyping", dir: "原型工具", title: "快速原型方法与工具（Figma 等）", query: "prototyping methods low fidelity high fidelity Figma workflow", prefer: ["nngroup.com", "figma.com"], secondary: ["interaction-design.org"], tags: ["design", "prototype", "figma"] },
      { id: "motion", dir: "动效设计", title: "界面动效与过渡设计原则", query: "UI motion design principles easing duration transitions", prefer: ["material.io", "nngroup.com"], secondary: ["m3.material.io"], tags: ["design", "motion", "animation"] },
      { id: "information-architecture", dir: "信息架构", title: "信息架构与导航设计", query: "information architecture navigation design card sorting tree testing", prefer: ["nngroup.com"], secondary: [], tags: ["design", "ia", "navigation"] },
      { id: "layout-responsive", dir: "响应式布局", title: "响应式布局与栅格系统", query: "responsive layout grid system breakpoints spacing scale", prefer: ["web.dev", "nngroup.com"], secondary: ["developer.mozilla.org"], tags: ["design", "layout", "responsive"] },
      { id: "component-library", dir: "组件库", title: "无头组件库与可访问组件实践（Radix/shadcn）", query: "Radix UI shadcn headless component accessibility composition patterns", prefer: ["radix-ui.com", "ui.shadcn.com"], secondary: ["developer.mozilla.org"], tags: ["design", "components", "radix"] },
      { id: "color-typography", dir: "色彩与字体", title: "界面配色与排版尺度", query: "UI color system typography scale contrast ratio guidelines", prefer: ["material.io", "web.dev"], secondary: ["nngroup.com"], tags: ["design", "color", "typography"] },
      { id: "usability-testing", dir: "可用性测试", title: "可用性测试方法与样本量", query: "usability testing methods sample size how many participants", prefer: ["nngroup.com"], secondary: [], tags: ["design", "research", "usability"] },
    ],
  },
};
// finance 领域复用既有选题（官方数据源，保持 seedUrls 直取）
DOMAINS.finance.topics = FINANCE_TOPICS;


const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

type SourceTier = "primary" | "secondary" | "fallback";

/**
 * **聚合/跳转域名拒绝表**（2026-10-07 实测）：搜索引擎结果里常混入
 * `news.google.com/rss/articles/...`（跳转壳）与 `bing.com/ck/a`（重定向），
 * 抓到的正文只有几百字符且不是原始出处 —— 实测浪费掉一个主题
 * （"中国货币政策执行报告"曾落到 Google News 跳转页，仅 517 字符）。
 * 这类来源一律不作为落库源。
 */
export const DENY_HOSTS = ["news.google.com", "google.com", "bing.com", "baidu.com", "doc88.com", "docin.com", "renrendoc.com"];

/** 正文长度下限：低于此值视为跳转壳/导航页，不落库 */
const MIN_CONTENT_CHARS = 800;

const hostMatches = (link: string | undefined, domains: string[]): boolean => {
  try {
    const host = new URL(link ?? "").hostname.replace(/^www\./, "");
    return domains.some((d) => host.endsWith(d));
  } catch {
    return false;
  }
};

/**
 * 三档候选（一手 > 二手 > 兜底），**返回有序候选列表**而非单一结果：
 * 首个候选抓取失败或正文过短时继续试下一个，避免整条主题因一次抓取失败而丢。
 */
export function rankCandidates(
  results: Array<{ link?: string }>,
  prefer: string[],
  secondary: string[],
): Array<{ link: string; tier: SourceTier }> {
  const out: Array<{ link: string; tier: SourceTier }> = [];
  const seen = new Set<string>();
  const push = (link?: string, tier: SourceTier = "fallback") => {
    if (!link || seen.has(link) || hostMatches(link, DENY_HOSTS)) return;
    // 无效 URL 直接丢弃：它连主机名都解析不出，抓取必然失败，留着只会浪费一次尝试
    try {
      new URL(link);
    } catch {
      return;
    }
    seen.add(link);
    out.push({ link, tier });
  };
  for (const d of prefer) for (const r of results) if (hostMatches(r.link, [d])) push(r.link, "primary");
  for (const d of secondary) for (const r of results) if (hostMatches(r.link, [d])) push(r.link, "secondary");
  for (const r of results) push(r.link, "fallback");
  return out;
}


async function main(): Promise<void> {
  const domainId = arg("domain") ?? "finance";
  const domain = DOMAINS[domainId];
  if (!domain) {
    console.error(`未知领域：${domainId}（可选：${Object.keys(DOMAINS).join(" / ")}）`);
    process.exit(2);
  }

  if (process.argv.includes("--list")) {
    console.log(`领域 ${domainId}（入库目录 00-Knowledge/${domain.knowledgeDir}）：`);
    for (const t of domain.topics) console.log(`  ${t.id.padEnd(22)} ${t.title}`);
    process.exit(0);
  }

  const only = arg("only");
  const topics = only ? domain.topics.filter((t) => t.id === only) : domain.topics;
  if (topics.length === 0) {
    console.error(`未知主题：${only}（用 --domain=${domainId} --list 查看）`);
    process.exit(2);
  }

  const dbPath = resolveKnowledgeDbPath();
  if (!existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`);
    process.exit(2);
  }

  const db = new Database(dbPath);
  // 组合根装配：写入 Vault 时自动把新笔记送去嵌入（与 src/main.ts 同一装配路径）
  enableKnowledgeEmbeddingIndex(db);
  const vault = new VaultManager();
  const pipeline = new DataPipeline();
  const agg = new SearchAggregator();

  const TIER_LABEL: Record<SourceTier, string> = {
    primary: "一手（官方发布方）",
    secondary: "二手（正规财经媒体，结论需与官方原始口径交叉核对）",
    fallback: "兜底（未命中白名单，人工复核来源可信度）",
  };

/** 等级排序：数字越小越好（primary=0） */
const TIER_RANK: Record<SourceTier, number> = { primary: 0, secondary: 1, fallback: 2 };

/** 读既有笔记正文里的 `> 源等级：` 标记，反推等级；无标记/无笔记返回 null */
function readExistingTier(vault: VaultManager, notePath: string): SourceTier | null {
  // 轮 7 审计：原实现自建 vault 根路径口径（env 直读 + 手工拼接），与 VaultManager
  // 的配置解析/resolveSafePath 是两套独立维护的事实源——任一侧变化即分叉，而
  // "防降级覆盖"契约正依赖此读取。改为复用 vault.readNote（同一路径解析单源），
  // 本函数不再接触 env。
  const note = vault.readNote(notePath);
  if (!note) return null;
  const text = note.content;
  if (text.includes("一手（官方发布方）")) return "primary";
  if (text.includes("二手（正规财经媒体")) return "secondary";
  if (text.includes("兜底（未命中白名单")) return "fallback";
  return null;
}

  console.log(`[${domainId}] db=${dbPath} topics=${topics.length} raw=data/raw/${domainId}/`);
  let written = 0;
  let skipped = 0;

  for (const t of topics) {
    let results: Awaited<ReturnType<typeof agg.searchMulti>>;
    try {
      results = await agg.searchMulti({ query: t.query, num: 8 });
    } catch (err) {
      console.log(`[${domainId}] ${t.id}: SKIP 搜索异常 ${(err as Error).message}`);
      skipped++;
      continue;
    }
    const candidates = [
      ...(t.seedUrls ?? []).map((link) => ({ link, tier: "primary" as SourceTier })),
      ...rankCandidates(results, t.prefer, t.secondary),
    ];
    if (candidates.length === 0) {
      console.log(`[${domainId}] ${t.id}: SKIP 搜索无可用结果（全部命中拒绝表或为空）`);
      skipped++;
      continue;
    }
    // 按档位顺序尝试候选：被抓取失败/正文过短阻挡时继续下一个
    let picked: { link: string; tier: SourceTier } | null = null;
    let page: Awaited<ReturnType<typeof pipeline.crawlStructured>> = null;
    const tried: string[] = [];
    for (const cand of candidates.slice(0, 4)) {
      const got = await pipeline.crawlStructured(cand.link);
      if (got?.markdown && got.markdown.trim().length >= MIN_CONTENT_CHARS) {
        picked = cand;
        page = got;
        break;
      }
      tried.push(`${cand.link}(${got?.markdown?.trim().length ?? 0}字符)`);
    }
    if (!picked || !page) {
      console.log(`[${domainId}] ${t.id}: SKIP 候选均不合格 → ${tried.join(", ")}`);
      skipped++;
      continue;
    }
    if (tried.length > 0) console.log(`[${domainId}] ${t.id}: 跳过不合格候选 ${tried.length} 个`);
    // ── 原件归档（用户要求"保留原件，副本进项目"）────────────────────────────
    // 原件：data/raw/<domain>/<topicId>/<时间戳>-<slug>.md（逐字节保存抓取结果）
    // 清单：data/raw/<domain>/manifest.jsonl（url / fetched_at / sha256 / bytes，一行一件）
    // 副本：Vault 派生笔记（下面的 notePath）—— 项目知识库消费的是副本。
    const rawDir = `data/raw/${domainId}/${t.id}`;
    mkdirSync(rawDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rawPath = `${rawDir}/${stamp}.md`;
    const rawBody = `---\nsource: ${picked.link}\nfetched_at: ${new Date().toISOString()}\ntier: ${picked.tier}\nquery: ${t.query}\n---\n\n${page.markdown}`;
    writeFileSync(rawPath, rawBody, "utf8");
    appendFileSync(
      `data/raw/${domainId}/manifest.jsonl`,
      JSON.stringify({
        topic: t.id,
        title: t.title,
        url: picked.link,
        tier: picked.tier,
        fetched_at: new Date().toISOString(),
        raw_path: rawPath,
        bytes: Buffer.byteLength(rawBody),
        sha256: createHash("sha256").update(rawBody).digest("hex"),
        note_path: `00-Knowledge/${domain.knowledgeDir}/${t.dir}/${t.id}.md`,
      }) + "\n",
      "utf8",
    );

    const notePath = `00-Knowledge/${domain.knowledgeDir}/${t.dir}/${t.id}.md`;
    const content =
      `# ${t.title}\n\n` +
      `> 源等级：${TIER_LABEL[picked.tier]}\n` +
      `> 检索查询：${t.query}\n\n` +
      page.markdown;
    // 防降级覆盖（2026-10-07 实测教训）：搜索结果逐次波动，重跑可能把已入库的
    // **一手官方源**内容换成 arxiv/新闻聚合壳等兜底源（实测 LPR 笔记被 arxiv 论文覆盖）。
    // 契约：新源等级**不优于**既有等级时不重写，保住已核实的好来源。
    const existingTier = readExistingTier(vault, notePath);
    if (existingTier && TIER_RANK[picked.tier] > TIER_RANK[existingTier]) {
      console.log(`[${domainId}] ${t.id}: KEEP 既有 ${existingTier} 源不被 ${picked.tier} 源覆盖 (${notePath})`);
      skipped++;
      continue;
    }

    try {
      // overwrite=true：本脚本产出的是**抓取快照**（正文自带 fetched_at/source 前言），
      // 重跑应当刷新而不是报"已存在"。
      await vault.writeNote(notePath, content, {
        title: t.title,
        tags: t.tags,
        type: "reference",
        overwrite: true,
      });
    } catch (err) {
      console.log(`[${domainId}] ${t.id}: SKIP 写入失败 ${(err as Error).message}`);
      skipped++;
      continue;
    }
    console.log(
      `[finance] ${t.id}: OK ${notePath} (${page.markdown.length} chars, source=${picked.link}, tier=${picked.tier})`,
    );
    written++;
  }

  db.close();
  console.log(`[${domainId}] 完成：写入 ${written}，跳过 ${skipped}`);
  if (written === 0) process.exit(4);
}

if (import.meta.main) {
  await main();
}
