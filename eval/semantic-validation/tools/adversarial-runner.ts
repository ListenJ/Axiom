/**
 * S-A8 切片 8：对抗样例集 runner——畸形/对抗样例 100% 拦截断言 + 报告落盘
 *
 * 计划口径（docs/superpowers/plans/2026-09-08-sa8-validation-pipeline-test-plan.md 第三节切片 8）：
 * - 样例集 eval/semantic-validation/adversarial/（JSON 化、确定性可复现）；
 * - runner 断言 100% 被拦截且每例有原因码；
 * - 报告落 eval/semantic-validation/reports/（S-A4 惯例：md + json 双份）。
 *
 * 判定走 ValidationPipeline 公共接口；默认依赖为空 KG/空 memory 假件——
 * 语法合法样例的实体/溯源锚必然不可解析（级 2 fail-closed 兜底），零网络零写入。
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ValidationPipeline, type ValidationPipelineDeps } from "../../../src/semantic/validation-pipeline.js";

export interface AdversarialSample {
  id: string;
  category: string;
  variant: string;
  /** 原始畸形输入（不要求合法 MR） */
  mr: unknown;
}

export interface AdversarialCaseResult {
  id: string;
  category: string;
  variant: string;
  blocked: boolean;
  level: number;
  reasonCode: string | null;
}

export interface AdversarialReport {
  total: number;
  blocked: number;
  blockRate: number;
  allHaveReasonCode: boolean;
  byCategory: Record<string, { total: number; blocked: number }>;
  byReasonCode: Record<string, number>;
  byLevel: Record<string, number>;
  cases: AdversarialCaseResult[];
}

/** 空 KG/空 memory 假件：getNode/getByPath 恒 null，getOutEdges 恒空，写入 no-op */
export function makeEmptyDeps(): ValidationPipelineDeps {
  return {
    kg: {
      getNode: () => null,
      getOutEdges: () => [],
      addNode: () => undefined,
      addEdge: () => undefined,
    },
    memory: { getByPath: () => null },
  };
}

/** 加载样例目录下的 av-*.json（确定性文件名序） */
export function loadAdversarialSamples(dir: string): AdversarialSample[] {
  const files = readdirSync(dir)
    .filter((f) => /^av-\d+\.json$/.test(f))
    .sort();
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
    return {
      id: String(raw.id),
      category: String(raw.category),
      variant: String(raw.variant),
      mr: raw.mr,
    };
  });
}

/** 跑对抗样例套件：逐例走 ValidationPipeline.validate，收集拦截判定 */
export function runAdversarialSuite(
  samples: AdversarialSample[],
  deps: ValidationPipelineDeps = makeEmptyDeps(),
): AdversarialReport {
  const pipeline = new ValidationPipeline(deps);
  const cases: AdversarialCaseResult[] = samples.map((s) => {
    const verdict = pipeline.validate(s.mr);
    return {
      id: s.id,
      category: s.category,
      variant: s.variant,
      blocked: !verdict.pass,
      level: verdict.level,
      reasonCode: verdict.reasonCode,
    };
  });

  const byCategory: AdversarialReport["byCategory"] = {};
  const byReasonCode: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  for (const c of cases) {
    byCategory[c.category] ??= { total: 0, blocked: 0 };
    byCategory[c.category].total += 1;
    if (c.blocked) byCategory[c.category].blocked += 1;
    if (c.reasonCode !== null) byReasonCode[c.reasonCode] = (byReasonCode[c.reasonCode] ?? 0) + 1;
    const k = `level-${c.level}`;
    byLevel[k] = (byLevel[k] ?? 0) + 1;
  }

  const blocked = cases.filter((c) => c.blocked).length;
  return {
    total: cases.length,
    blocked,
    blockRate: cases.length === 0 ? 0 : blocked / cases.length,
    allHaveReasonCode: cases.every((c) => c.reasonCode !== null),
    byCategory,
    byReasonCode,
    byLevel,
    cases,
  };
}

/** 渲染 Markdown 报告（S-A4 惯例：事实与解读分节） */
export function renderReportMd(report: AdversarialReport, generatedAt: string): string {
  const catLines = Object.entries(report.byCategory)
    .map(([cat, v]) => `| ${cat} | ${v.blocked}/${v.total} |`)
    .join("\n");
  const codeLines = Object.entries(report.byReasonCode)
    .map(([code, n]) => `| ${code} | ${n} |`)
    .join("\n");
  const levelLines = Object.entries(report.byLevel)
    .map(([k, n]) => `| ${k} | ${n} |`)
    .join("\n");
  return `# S-A8 切片 8 对抗样例全量拦截报告（run=r1）

## 总量（事实）
- 样例总数：${report.total}
- 拦截：${report.blocked}（拦截率 ${(report.blockRate * 100).toFixed(1)}%）
- 每例均有原因码：${report.allHaveReasonCode ? "是" : "否"}

## 类别分布
| 类别 | 拦截/总数 |
|---|---|
${catLines}

## 原因码分布
| 原因码 | 例数 |
|---|---|
${codeLines}

## 拦截层级分布
| 层级 | 例数 |
|---|---|
${levelLines}

## 解读（判断，非事实）
- 语法级畸形（V1-V7）由级 1 fail-closed 拦截；语法合法的对抗样例（注入风格/超大 payload/超深嵌套/批量不可解析）
  由级 2 实存性校验兜底拦截（空依赖下实体/溯源锚必然不可解析）。
- 判定走 ValidationPipeline 公共接口，依赖注入空 KG/空 memory 假件，零网络零写入，同输入同结果（S-A3 重放兼容）。
- 报告生成时间：${generatedAt}
`;
}

/** main（直接运行时）：加载样例 → 跑套件 → 100% 拦截断言 → 报告落盘 md+json */
function main(): number {
  const dir = path.resolve(import.meta.dir, "../adversarial");
  const reportDir = path.resolve(import.meta.dir, "../reports");
  const samples = loadAdversarialSamples(dir);
  const report = runAdversarialSuite(samples);
  const generatedAt = new Date().toISOString();

  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, "report-adversarial-r1.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  writeFileSync(path.join(reportDir, "report-adversarial-r1.md"), renderReportMd(report, generatedAt) + "\n", "utf8");

  console.log(`total=${report.total} blocked=${report.blocked} blockRate=${report.blockRate} allHaveReasonCode=${report.allHaveReasonCode}`);
  console.log(`report -> ${path.join(reportDir, "report-adversarial-r1.{md,json}")}`);
  return report.blockRate === 1 && report.allHaveReasonCode ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
