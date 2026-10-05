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
 *   bun run calibrate:laya -- --drift docs/decisions/laya/drift-suite.json [--strict]
 * 先把 cases 模板（同目录 calibration-cases.template.json）人工填满 expected 再跑。
 *
 * 漂移套件（--drift，label-free）：skill §5 实测"同一命题换措辞可在 0.30↔0.83 翻面"，
 * 措辞敏感性是 Laya 最大已知弱点。漂移探针不需要人工标注——对同一命题的多份措辞，
 * 比 choice 是否一致 + margin 极差是否越过稳定性带（0.15，对齐 ADR-008 闸 3）。
 * 默认只报告（不稳定是已知缺陷，不是门禁失败）；--strict 时不稳定 ⇒ 非零退出。
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
  /** 服务端未回传 probabilities 的用例数（不参与 margin 统计与门槛建议） */
  noDistribution: number;
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
    drift: get("--drift"),
    out: get("--out"),
  };
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  if (a.drift) return runDrift(argv);
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
    let noDistribution = 0;
    for (const c of list) {
      const r = byId.get(c.id);
      const ans = r?.answers?.[c.question];
      const got = ans?.choice ?? "<none>";
      if (!ans?.probabilities) {
        // 缺分布：跳过 margin 统计（0 会把门槛拉向 0 / 1 会虚高），报告显式计数
        noDistribution++;
        if (got !== c.expected) misses.push({ id: c.id, expected: c.expected, got, margin: Number.NaN });
        continue;
      }
      const margin = marginOf(ans.probabilities);
      if (got === c.expected) correctMargins.push(margin);
      else misses.push({ id: c.id, expected: c.expected, got, margin });
    }
    const sorted = [...correctMargins].sort((x, y) => x - y);
    const effective = list.length - noDistribution;
    domainReport[domain] = {
      cases: list.length,
      hitRate: Number((correctMargins.length / Math.max(1, effective)).toFixed(4)),
      marginMin: Number((sorted[0] ?? 0).toFixed(4)),
      marginP50: Number(percentile(sorted, 50).toFixed(4)),
      noDistribution,
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

  const out = a.out ?? a.cases.replace(/\.json5?$/i, "") + ".report.json";
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

  console.log(`标定完成：${cases.length} 用例（batch ok=${resp.ok} failed=${resp.failed}）→ ${out}`);
  for (const [domain, r] of Object.entries(domainReport)) {
    const s = suggestions[domain];
    const nd = r.noDistribution > 0 ? `（${r.noDistribution} 条无分布已剔除）` : "";
    console.log(`  ${domain}: 命中率=${(r.hitRate * 100).toFixed(1)}%${nd} margin(min/p50)=${r.marginMin}/${r.marginP50} ⇒ 建议门槛=${s ?? "不可标定（人工域）"}`);
  }
  console.log("下一步：人工复核报告后，把建议门槛落回 src/decision/laya-triage.ts 闸 3 常量（改判定前读 ADR-008 更正节）。");
  return 0;
}

// ─────────────────────────────────────────────────────────
// 漂移套件（label-free 自一致性探针）
// ─────────────────────────────────────────────────────────

/** 稳定性带：对齐 ADR-008 闸 3 的 choice top1−top2 门槛。 */
export const STABILITY_BAND = 0.15;

export interface DriftSample {
  choice: string;
  margin: number;
  /** 服务端响应缺 choice 或可用分布时为 true：该样本不可判定，不得伪造 stable。 */
  missing?: boolean;
}

export interface DriftVerdict {
  verdict: "stable" | "unstable" | "insufficient";
  spread: number;
  reason: string;
}

/**
 * 单命题的措辞稳定性判定：choice 全一致 **且** margin 极差在稳定性带内才算 stable。
 * 单措辞 ⇒ insufficient（一份措辞测不出漂移，不给假绿）。
 */
export function judgeDrift(samples: DriftSample[]): DriftVerdict {
  if (samples.length < 2) {
    return { verdict: "insufficient", spread: 0, reason: "措辞数 <2，无法判定漂移" };
  }
  if (samples.some((s) => s.missing)) {
    return { verdict: "insufficient", spread: 0, reason: "存在缺失 choice/分布，无法判定漂移" };
  }
  const choices = new Set(samples.map((s) => s.choice));
  const margins = samples.map((s) => s.margin);
  const spread = Number((Math.max(...margins) - Math.min(...margins)).toFixed(4));
  if (choices.size > 1) {
    return { verdict: "unstable", spread, reason: `choice 跨措辞翻面：${[...choices].join(" / ")}` };
  }
  if (spread > STABILITY_BAND) {
    return { verdict: "unstable", spread, reason: `margin 极差 ${spread} > 稳定性带 ${STABILITY_BAND}` };
  }
  return { verdict: "stable", spread, reason: `choice 一致且 margin 极差 ${spread} ≤ ${STABILITY_BAND}` };
}

interface DriftCase {
  id: string;
  question: string;
  criteria: string[];
  paraphrases: string[];
}

export async function runDrift(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (!a.drift || !existsSync(a.drift)) {
    console.error("需要 --drift <path>（漂移套件：同命题多措辞，见 docs/decisions/laya/drift-suite.json）");
    return 2;
  }
  if (!process.env.LAYA_DECISION_URL) {
    console.error("需要 LAYA_DECISION_URL（漂移探针打真实服务；基址按规则 11 经 env 提供）");
    return 2;
  }
  const suite = JSON.parse(readFileSync(a.drift, "utf8")) as DriftCase[];
  if (suite.length === 0) {
    console.error("漂移套件为空");
    return 2;
  }
  const single = suite.find((c) => (c.paraphrases?.length ?? 0) < 2);
  if (single) {
    console.error(`命题 ${single.id} 只有 ${single.paraphrases?.length ?? 0} 份措辞：漂移探针要求同命题 ≥2 份措辞（否则测不出漂移）`);
    return 2;
  }

  // 全部措辞一并发（在线并发纪律 2）——id 用 `命题#序号` 保序回填
  const items = suite.flatMap((c) =>
    c.paraphrases.map((state, i) => ({
      id: `${c.id}#${i}`,
      state,
      questions: {
        [c.question]: {
          type: "choice" as const,
          instructions: "Answer with the best-fitting label.",
          criteria: c.criteria,
        },
      },
    })),
  );
  const resp = await layaDecideBatch({ items }, { maxConcurrency: 2 });
  const byId = new Map(resp.results.map((r) => [r.id, r]));

  const propositions = suite.map((c) => {
    const samples: DriftSample[] = [];
    for (let i = 0; i < c.paraphrases.length; i++) {
      const ans = byId.get(`${c.id}#${i}`)?.answers?.[c.question];
      if (
        !ans ||
        typeof ans.choice !== "string" ||
        !ans.probabilities ||
        Object.keys(ans.probabilities).length === 0
      ) {
        samples.push({ choice: "", margin: 0, missing: true });
      } else {
        samples.push({ choice: ans.choice, margin: marginOf(ans.probabilities) });
      }
    }
    const v = judgeDrift(samples);
    return {
      id: c.id,
      paraphrases: c.paraphrases.length,
      choices: samples.map((s) => s.choice),
      margins: samples.map((s) => Number(s.margin.toFixed(4))),
      spread: v.spread,
      verdict: v.verdict,
      reason: v.reason,
    };
  });

  const unstable = propositions.filter((p) => p.verdict === "unstable").length;
  const insufficient = propositions.filter((p) => p.verdict === "insufficient").length;
  const report = {
    generatedAt: new Date().toISOString(),
    suite: a.drift,
    stabilityBand: STABILITY_BAND,
    total: propositions.length,
    stable: propositions.length - unstable - insufficient,
    unstable,
    insufficient,
    batchFailed: resp.failed,
    propositions,
  };
  const out = a.out ?? a.drift.replace(/\.json5?$/i, "") + ".drift-report.json";
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

  console.log(`漂移套件完成：${propositions.length} 命题（不稳定 ${unstable}，不足 ${insufficient}）→ ${out}`);
  for (const p of propositions) {
    const mark = p.verdict === "stable" ? "stable  " : p.verdict === "unstable" ? "UNSTABLE" : "不足    ";
    console.log(`  [${mark}] ${p.id}: choices=[${p.choices.join(",")}] margins=[${p.margins.join(",")}] spread=${p.spread} — ${p.reason}`);
  }
  if (unstable > 0) {
    console.log("注意：措辞不稳定是 Laya 已知缺陷（skill §5）——该命题在自动化裁定中应走人工或加固定措辞模板。");
  }
  if (argv.includes("--strict") && (unstable > 0 || insufficient > 0)) return 1;
  return 0;
}

export { main as runCalibration };

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
