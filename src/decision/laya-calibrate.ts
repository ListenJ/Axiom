/**
 * Laya confidence 阈值标定 harness（契约第六节遗留项的工具化）
 *
 * 背景：Laya 输出的 `confidence` 是**分布置信度**（checkpoint 自带
 * temperature_by_options 告警，见 skill §5），不是正确率。开发流程链里
 * 闸 3 的 choice 门槛（top1−top2 < 0.15 ⇒ ESCALATE）沿 ADR-008 实测区间
 * （0.042–0.411）取值；本 harness 用人工标注数据把它变成**可复核的标定**：
 *
 *   1. 从 cases 文件读标注用例（state / question / expected / 域标签）
 *   2. 经 layaDecideBatch 打真实服务拿 choice 分布
 *   3. 按 expected 分组输出：命中率、平均 top1−top2 margin、逐用例明细
 *   4. 结论写入 calibration 文件（建议门槛 = 在期望域上保持命中率 ≥0.9 的
 *      最小 margin 阈值），复核通过后人工落回 laya-triage 闸 3 常量
 *
 * 域纪律（继承 ADR-008 §7）：numeric / engineering 域连模型都不问——标定
 * 也不得跨域外推；每条用例必须带 domain 标签，报告按域分组。
 *
 * 用法：
 *   bun run calibrate:laya -- --cases docs/decisions/laya/calibration-cases.json \
 *     [--out docs/decisions/laya/calibration-report.json]
 * 先把 cases 模板（同目录 calibration-cases.template.json）人工填满 expected 再跑。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { layaDecideBatch } from "./laya-http.js";

interface CalibrationCase {
  id: string;
  domain: "triage" | "review" | "batch";
  state: string;
  question: string;
  criteria: string[];
  /** 人工标注的正确标签（标定前必须填；本 harness 不做无标注的"裸跑"） */
  expected: string;
}

interface DomainReport {
  cases: number;
  /** top1 == expected 的比例 */
  hitRate: number;
  /** 正确用例的 top1−top2 margin 分布（min/p50），门槛建议的依据 */
  marginMin: number;
  marginP50: number;
  misses: Array<{ id: string; expected: string; got: string; margin: number }>;
}

function marginOf(probabilities: Record<string, number> | undefined): number {
  if (!probabilities) return 0;
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  return sorted.length >= 2 ? sorted[0] - sorted[1] : 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function parseArgs(argv: string[]) {
  const get = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    cases: get("--cases"),
    out: get("--out"),
  };
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  if (!a.cases || !existsSync(a.cases)) {
    console.error("需要 --cases <path>（模板：docs/decisions/laya/calibration-cases.template.json，人工填满 expected）");
    return 2;
  }
  const cases = JSON.parse(readFileSync(a.cases, "utf8")) as CalibrationCase[];
  const unlabeled = cases.filter((c) => !c.expected);
  if (unlabeled.length > 0) {
    console.error(`标定要求全部用例人工标注 expected；缺 ${unlabeled.length} 条：${unlabeled.slice(0, 5).map((c) => c.id).join(",")}`);
    return 2;
  }
  const badDomain = cases.filter((c) => !["triage", "review", "batch"].includes(c.domain));
  if (badDomain.length > 0) {
    console.error(`domain 必须是 triage|review|batch（闸 3 只在这三域生效，不得跨域外推）：${badDomain[0]?.id}`);
    return 2;
  }
  if (!process.env.LAYA_DECISION_URL) {
    console.error("需要 LAYA_DECISION_URL（标定打真实服务；基址按规则 11 经 env 提供）");
    return 2;
  }

  // 在线并发纪律（契约第四节）：标定走在线档 concurrency=2
  const items = cases.map((c) => ({
    id: c.id,
    state: c.state,
    questions: {
      [c.question]: {
        type: "choice" as const,
        instructions: "Answer with the best-fitting label.",
        criteria: c.criteria,
      },
    },
  }));
  const resp = await layaDecideBatch({ items }, { maxConcurrency: 2 });
  const byId = new Map(resp.results.map((r) => [r.id, r]));

  const domains = new Map<string, CalibrationCase[]>();
  for (const c of cases) domains.set(c.domain, [...(domains.get(c.domain) ?? []), c]);

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    total: cases.length,
    batchOk: resp.ok,
    batchFailed: resp.failed,
    domains: {} as Record<string, DomainReport>,
  };
  const domainReport = report.domains as Record<string, DomainReport>;

  for (const [domain, list] of domains) {
    const misses: DomainReport["misses"] = [];
    const correctMargins: number[] = [];
    for (const c of list) {
      const r = byId.get(c.id);
      const ans = r?.answers?.[c.question];
      const got = ans?.choice ?? "<none>";
      const margin = marginOf(ans?.probabilities);
      if (got === c.expected) correctMargins.push(margin);
      else misses.push({ id: c.id, expected: c.expected, got, margin });
    }
    const sorted = [...correctMargins].sort((x, y) => x - y);
    domainReport[domain] = {
      cases: list.length,
      hitRate: Number((correctMargins.length / list.length).toFixed(4)),
      marginMin: Number((sorted[0] ?? 0).toFixed(4)),
      marginP50: Number(percentile(sorted, 50).toFixed(4)),
      misses,
    };
  }

  // 门槛建议：每域取「命中率 ≥0.9 且覆盖全部正确用例」的最小 margin；
  // 达不到 0.9 的域给 null（说明该域当前不该依赖 choice 门槛，走人工）。
  const suggestions: Record<string, number | null> = {};
  for (const [domain, r] of Object.entries(domainReport)) {
    suggestions[domain] = r.hitRate >= 0.9 && r.marginMin > 0 ? Number(r.marginMin.toFixed(3)) : null;
  }
  (report as { thresholdSuggestions: Record<string, number | null> }).thresholdSuggestions = suggestions;

  const out = a.out ?? a.cases.replace(/\.json$/, "") + ".report.json";
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

  console.log(`标定完成：${cases.length} 用例（batch ok=${resp.ok} failed=${resp.failed}）→ ${out}`);
  for (const [domain, r] of Object.entries(domainReport)) {
    const s = suggestions[domain];
    console.log(`  ${domain}: 命中率=${(r.hitRate * 100).toFixed(1)}% margin(min/p50)=${r.marginMin}/${r.marginP50} ⇒ 建议门槛=${s ?? "不可标定（人工域）"}`);
  }
  console.log("下一步：人工复核报告后，把建议门槛落回 src/decision/laya-triage.ts 闸 3 常量（改判定前读 ADR-008 更正节）。");
  return 0;
}

export { main as runCalibration };

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
