/**
 * Agent 评测报告扩展（S3）— 失败原因聚类 + 延迟分位/趋势/对比视图。
 *
 * 定位：单轮明细（report.toMarkdown）之外的聚合视图。趋势/对比直接消费
 * registry.getTrend / compare 的返回值，不新增查询逻辑（规则 1 最小改动）；
 * 失败聚类消费本轮 TaskResult 的 reason，按关键词分桶。
 */
import type { TaskResult } from "./metrics.js";
import type { RunComparison, RunRow } from "./metrics-types.js";

/** 失败原因聚类桶 */
export interface FailureCluster {
  /** 桶名：执行错误 / 限流 / 超时 / 内容缺失 / JSON缺失 / 其他 */
  bucket: string;
  count: number;
  /** 代表样例（失败 reason 截断 ~120 字符，最多 3 条） */
  samples: string[];
}

const SAMPLE_LEN = 120; // reason 样例截断长度（对齐 runner 的 reason.slice(0, 200) 之外的展示口径）
const MAX_SAMPLES = 3; // 每桶最多代表样例数
const TAG_LEN = 28; // run_tag 展示截断长度
const FALLBACK_MAX_DROP_PP = 10; // 回落提示阈值（对齐 registry.checkRegression 默认 maxDropPp=10，仅做展示）

/** 分桶规则：自上而下第一个命中的桶即归桶（数组顺序即优先级） */
const BUCKET_RULES: Array<{ bucket: string; match: (reason: string) => boolean }> = [
  { bucket: "限流", match: (r) => /rate.?limit/i.test(r) || /429/.test(r) || /too\s*many\s*requests/i.test(r) },
  { bucket: "超时", match: (r) => /time\s*limit\s*exceeded/i.test(r) || /timeout/i.test(r) || /timed\s*out/i.test(r) },
  { bucket: "内容缺失", match: (r) => /empty\s*(content|response)/i.test(r) || r.includes("空白") },
  { bucket: "JSON缺失", match: (r) => r.toLowerCase().includes("json") },
];

/**
 * 按 reason 关键词把失败结果聚类（能力失败 + 执行错误均纳入；通过任务不计入）。
 * 分桶优先级自上而下：执行错误（reason 以 `[ERROR] ` 开头）→ 限流/无配额 → 超时
 * → 内容缺失 → JSON 缺失 → 其他。执行错误优先于关键词匹配：runner 把 provider 侧故障
 * 统一包装为 `[ERROR] <message>`，其 message 常含 rate limit / timeout 等字样，按语义
 * 归入执行错误而非能力缺陷桶，避免与能力失败混淆。
 *
 * 计数口径：以每条 result 为一个样本、不去重——runTasks 输出已 pickBest，同一 taskId
 * 在结果中已唯一（自适应重跑只保留最优样本），因此无需 taskId 去重。
 */
export function clusterFailures(results: TaskResult[]): FailureCluster[] {
  const buckets = new Map<string, { count: number; samples: string[] }>();
  const ensure = (bucket: string) => {
    if (!buckets.has(bucket)) buckets.set(bucket, { count: 0, samples: [] });
    return buckets.get(bucket)!;
  };
  const pushSample = (entry: { count: number; samples: string[] }, sample: string) => {
    if (entry.samples.length >= MAX_SAMPLES || entry.samples.includes(sample)) return;
    entry.samples.push(sample);
  };

  for (const r of results) {
    if (r.passed) continue; // 通过任务不计入
    const reason = (r.reason ?? "").trim();
    // 执行错误桶：runner 的执行错误标记（优先级最高）
    const rule = reason.startsWith("[ERROR] ")
      ? undefined
      : BUCKET_RULES.find((x) => x.match(reason));
    const bucket = reason.startsWith("[ERROR] ") ? "执行错误" : rule ? rule.bucket : "其他";
    const entry = ensure(bucket);
    entry.count += 1;
    if (reason) pushSample(entry, reason.slice(0, SAMPLE_LEN));
  }

  return [...buckets.entries()]
    .map(([bucket, v]) => ({ bucket, count: v.count, samples: v.samples }))
    .sort((x, y) => y.count - x.count);
}

/** run_tag 过长时截断为前 TAG_LEN 字符 + `…`（表格列宽收敛） */
function shortTag(tag: string): string {
  return tag.length > TAG_LEN ? `${tag.slice(0, TAG_LEN)}…` : tag;
}

/** 成本展示：$0.001 形式（3 位小数），空值（null/undefined/NaN）显示 `-` */
function formatCost(cost: number | null | undefined): string {
  return typeof cost === "number" && Number.isFinite(cost) ? `$${cost.toFixed(3)}` : "-";
}

/** diff 展示：正数带 `+`，负数自带 `-`；precision 用于 pp 等需要固定小数位的口径 */
function signed(v: number, suffix = "", precision?: number): string {
  const text = precision !== undefined ? v.toFixed(precision) : String(v);
  return `${v > 0 ? "+" : ""}${text}${suffix}`;
}

/**
 * 最近 N 轮通过率趋势 Markdown（runs 升序；已取末 N 轮时 limit 仅为兜底再截断）。
 * 表头：run_tag | 时间 | 通过率 | 延迟 | 成本。空数组输出占位提示。
 */
export function trendMarkdown(runs: RunRow[], opts?: { limit?: number; family?: string }): string {
  const limit = opts?.limit;
  const rows = typeof limit === "number" && limit > 0 ? runs.slice(-limit) : runs;
  if (rows.length === 0) return "## 趋势\n\n（无历史记录）";

  const lines: string[] = [`## 最近 ${rows.length} 轮趋势`, ""];
  lines.push("| run_tag | 时间 | 通过率 | 延迟 | 成本 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    lines.push(
      `| ${shortTag(r.runTag)} | ${r.startedAt} | ${r.summaryPassRate}% | ${Math.round(r.summaryAvgLatencyMs)}ms | ${formatCost(r.summaryTotalCostUsd)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * 两轮对比 Markdown（直接消费 registry.compare 返回的 RunComparison，纯输出不查库）。
 * 候选通过率回落 ≥ FALLBACK_MAX_DROP_PP pp 时追加一行回归提示（对齐 checkRegression 精神，
 * 但只展示不判定：实际放行判定仍由 registry.checkRegression 负责）。
 */
export function compareMarkdown(cmp: RunComparison): string {
  const { summaryDiff } = cmp;
  const lines: string[] = [`## 对比: ${cmp.a.runTag} → ${cmp.b.runTag}`, ""];
  lines.push(
    [
      `通过率 ${signed(summaryDiff.passRate, " pp", 1)}`,
      `任务数 ${signed(summaryDiff.totalDiff)}`,
      `泛化率 ${summaryDiff.generalizationDiff === null ? "N/A" : signed(summaryDiff.generalizationDiff)}`,
      `平均延迟 ${signed(summaryDiff.avgLatencyDiff, "ms")}`,
    ].join(" ｜ "),
  );
  const dropPp = cmp.a.summaryPassRate - cmp.b.summaryPassRate;
  if (dropPp >= FALLBACK_MAX_DROP_PP) lines.push(`⚠️ 通过率回落超 ${FALLBACK_MAX_DROP_PP}pp`);
  lines.push("");
  lines.push("| 族 | 基准通过率 | 候选通过率 | 差(pp) |");
  lines.push("| --- | --- | --- | --- |");
  for (const f of cmp.familyDiffs) {
    const rate = (s: RunComparison["familyDiffs"][number]["a"]) => (s === null ? "-" : `${s.passRate}%`);
    lines.push(
      `| ${f.family} | ${rate(f.a)} | ${rate(f.b)} | ${f.passRateDiff === null ? "-" : signed(f.passRateDiff)} |`,
    );
  }
  return lines.join("\n");
}
