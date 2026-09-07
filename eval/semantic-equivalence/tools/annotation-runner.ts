/**
 * S-A4 标注 runner（M3 / ANNOTATION-GUIDE v1.0 §7-§9）
 *
 * 子命令：
 *   compare  --run r1   对比 annotator-A/B 全量标注 → 三分类 Cohen's κ + 分歧清单
 *                       （arbitration/pending-<run>.json）+ 预报告（reports/report-<run>.md/.json）
 *   finalize --run r1   仲裁 resolved-<run>.json 就位后，合并出终局双口径报告
 *   gold     --annotator A [--run r1]
 *                       校准会：将某标注员的 gold 标注与 answer-key 对账，全对 exit 0
 *
 * 口径（与指南一致，勿在此改规则；规则变更先改指南并独立提交）：
 * - κ 仅在 verdict 三分类（equivalent / equivalent_with_notes / not_equivalent）上计算；
 *   任一方 uncertain 的配对不入 κ，单独披露（§6.7）。
 * - κ ≥ 0.7 方可发布等价率（§8）；< 0.7 runner 退出码 2 并写明停线。
 * - 分歧触发（§7）：verdict 不一致；或 verdict 相同但 error_classes 集合不同。
 * - 双口径（§9）：严格 = equivalent / (N − uncertain − contested)；
 *   宽松 = (equivalent + equivalent_with_notes) / (N − uncertain − contested)。
 * - compare 阶段的等价率是**预报告**（仅双方一致项 + 未仲裁分歧单列）；
 *   finalize 才是终局口径（合并 resolved，contested 剔除并披露）。
 * - rationale 引用检查为启发式警告（rationale 未包含源文本任一 ≥8 字连续子串），
 *   仅写入报告 warnings，不阻断 —— 终判由仲裁人复核。
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";

const BASE = join(import.meta.dir, "..");
const DATASET_DIR = join(BASE, "dataset");
const GOLD_DIR = join(BASE, "gold");
const ANN_DIR = join(BASE, "annotations");
const ARB_DIR = join(BASE, "arbitration");
const REPORT_DIR = join(BASE, "reports");

const VERDICTS = ["equivalent", "equivalent_with_notes", "not_equivalent"] as const;
type Verdict = (typeof VERDICTS)[number] | "uncertain";
interface Annotation {
  example_id: string;
  run: string;
  annotator: string;
  verdict: Verdict;
  error_classes: string[];
  severity?: string;
  rationale: string;
  annotated_at: string;
}

function readAnnotationDir(annotator: string, run: string): Map<string, Annotation> {
  const dir = join(ANN_DIR, `annotator-${annotator}`);
  const map = new Map<string, Annotation>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const a = JSON.parse(readFileSync(join(dir, f), "utf8")) as Annotation;
    if (a.run !== run) continue;
    if (map.has(a.example_id)) throw new Error(`annotator-${annotator} 重复标注: ${a.example_id}`);
    map.set(a.example_id, a);
  }
  return map;
}

function readDatasetIds(): Map<string, { source_text: string; task_type: string }> {
  const map = new Map();
  for (const f of readdirSync(DATASET_DIR).filter((x) => x.endsWith(".json"))) {
    const ex = JSON.parse(readFileSync(join(DATASET_DIR, f), "utf8"));
    map.set(ex.id, { source_text: ex.source_text, task_type: ex.task_type });
  }
  return map;
}

function subsetOfSource(rationale: string, sourceText: string): boolean {
  const win = 8;
  const src = sourceText.replace(/\s+/g, "");
  const rat = rationale.replace(/\s+/g, "");
  for (let i = 0; i + win <= src.length; i++) {
    if (rat.includes(src.slice(i, i + win))) return true;
  }
  return false;
}

/** 三分类 Cohen's κ（双方均为非 uncertain 的配对） */
function cohensKappa(pairs: Array<{ a: Verdict; b: Verdict }>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const count = new Map<string, number>();
  const margA = new Map<string, number>();
  const margB = new Map<string, number>();
  for (const { a, b } of pairs) {
    count.set(`${a}|${b}`, (count.get(`${a}|${b}`) ?? 0) + 1);
    margA.set(a, (margA.get(a) ?? 0) + 1);
    margB.set(b, (margB.get(b) ?? 0) + 1);
  }
  const po = pairs.filter(({ a, b }) => a === b).length / n;
  let pe = 0;
  for (const v of VERDICTS) pe += ((margA.get(v) ?? 0) / n) * ((margB.get(v) ?? 0) / n);
  if (pe === 1) return po === 1 ? 1 : null; // 边际全退化时 κ 无定义
  return (po - pe) / (1 - pe);
}

function rates(entries: Array<{ verdict: Verdict; contested?: boolean }>) {
  const contested = entries.filter((e) => e.contested).length;
  const uncertain = entries.filter((e) => e.verdict === "uncertain" && !e.contested).length;
  const denom = entries.length - contested - uncertain;
  const eq = entries.filter((e) => !e.contested && e.verdict === "equivalent").length;
  const eqNotes = entries.filter((e) => !e.contested && e.verdict === "equivalent_with_notes").length;
  return {
    n: entries.length,
    contested,
    uncertain,
    denominator: denom,
    strict: denom > 0 ? eq / denom : null,
    loose: denom > 0 ? (eq + eqNotes) / denom : null,
    equivalent: eq,
    equivalent_with_notes: eqNotes,
    not_equivalent: entries.filter((e) => !e.contested && e.verdict === "not_equivalent").length,
  };
}

function errDist(anns: Annotation[]): Record<string, number> {
  const dist: Record<string, number> = { E1: 0, E2: 0, E3: 0, E4: 0 };
  for (const a of anns) for (const c of a.error_classes ?? []) if (c in dist) dist[c]++;
  return dist;
}

// ========== compare ==========
function cmdCompare(run: string): number {
  const A = readAnnotationDir("A", run);
  const B = readAnnotationDir("B", run);
  const dataset = readDatasetIds();
  const allIds = [...new Set([...A.keys(), ...B.keys()])].sort();

  const agreed: Array<{ id: string; verdict: Verdict; annotator: string }> = [];
  const pending: any[] = [];
  const uncertainPairs: string[] = [];
  const incomplete: string[] = [];
  const malformed: string[] = [];
  const warnings: string[] = [];

  for (const id of allIds) {
    if (id.startsWith("gold-")) continue; // gold 不入等价率统计
    const a = A.get(id);
    const b = B.get(id);
    if (!a || !b) {
      incomplete.push(id);
      continue;
    }
    for (const [who, ann] of [["A", a], ["B", b]] as const) {
      if (ann.verdict === "not_equivalent" && (!ann.error_classes || ann.error_classes.length === 0)) {
        malformed.push(`${id}(${who}): not_equivalent 但 error_classes 为空（§3.2）`);
      }
      if (ann.verdict === "equivalent" && ann.error_classes && ann.error_classes.length > 0) {
        malformed.push(`${id}(${who}): equivalent 但 error_classes 非空（§3.2）`);
      }
      const src = dataset.get(id)?.source_text;
      if (src && ann.rationale && !subsetOfSource(ann.rationale, src)) {
        warnings.push(`${id}(${who}): rationale 未检出源文本 ≥8 字连续引用（启发式，请仲裁人复核 §10.1）`);
      }
    }
    if (a.verdict === "uncertain" || b.verdict === "uncertain") {
      uncertainPairs.push(id);
      continue;
    }
    if (a.verdict !== b.verdict) {
      pending.push({ example_id: id, type: "verdict_mismatch", A: { verdict: a.verdict, error_classes: a.error_classes }, B: { verdict: b.verdict, error_classes: b.error_classes } });
      continue;
    }
    const ea = [...(a.error_classes ?? [])].sort().join(",");
    const eb = [...(b.error_classes ?? [])].sort().join(",");
    if (ea !== eb) {
      pending.push({ example_id: id, type: "error_class_mismatch", A: { verdict: a.verdict, error_classes: a.error_classes }, B: { verdict: b.verdict, error_classes: b.error_classes } });
      continue;
    }
    agreed.push({ id, verdict: a.verdict, annotator: "A+B" });
  }

  const kappa = cohensKappa(
    allIds
      .filter((id) => A.has(id) && B.has(id))
      .filter((id) => A.get(id)!.verdict !== "uncertain" && B.get(id)!.verdict !== "uncertain")
      .filter((id) => !id.startsWith("gold-"))
      .map((id) => ({ a: A.get(id)!.verdict, b: B.get(id)!.verdict }))
  );

  // 预报告口径：仅双方一致项（分歧项未仲裁，单列不计入）
  const pre = rates(agreed.map((x) => ({ verdict: x.verdict })));
  const distA = errDist([...A.values()].filter((x) => !x.example_id.startsWith("gold-")));
  const distB = errDist([...B.values()].filter((x) => !x.example_id.startsWith("gold-")));

  mkdirSync(ARB_DIR, { recursive: true });
  mkdirSync(REPORT_DIR, { recursive: true });
  const pendingPath = join(ARB_DIR, `pending-${run}.json`);
  writeFileSync(pendingPath, JSON.stringify({ run, generated_at: new Date().toISOString(), pending, incomplete, uncertain_pairs: uncertainPairs }, null, 2) + "\n", "utf8");

  const kappaLine = kappa === null ? "n/a（可比配对为 0 或边际退化）" : kappa.toFixed(3);
  const kappaPass = kappa !== null && kappa >= 0.7;
  const md = `# S-A4 标注预报告（run=${run}，仲裁前口径）

> 事实：κ 与计数为测量输出；等价率解读为判断（指南 §10.4）。本报告为仲裁前预口径，终局报告以 finalize 为准。

## 一致性
- Cohen's κ（三分类，双方非 uncertain 配对）= **${kappaLine}**（门禁 ≥ 0.7：${kappaPass ? "通过" : "未通过 → 停线（§8）"})
- 双方一致项：${agreed.length}；分歧项：${pending.length}（→ arbitration/pending-${run}.json）；incomplete：${incomplete.length}；uncertain 配对：${uncertainPairs.length}

## 预口径等价率（仅一致项，N=${pre.denominator}）
- 严格：${pre.strict === null ? "n/a" : (pre.strict * 100).toFixed(1) + "%"}（equivalent ${pre.equivalent}）
- 宽松：${pre.loose === null ? "n/a" : (pre.loose * 100).toFixed(1) + "%"}（+ equivalent_with_notes ${pre.equivalent_with_notes}）
- not_equivalent：${pre.not_equivalent}

## 错误类分布（各自全部标注，含分歧项）
- A：${JSON.stringify(distA)}
- B：${JSON.stringify(distB)}

## 质量告警
- malformed：${malformed.length === 0 ? "无" : ""}
${malformed.map((m) => "  - " + m).join("\n")}
- rationale 引用启发式警告：${warnings.length === 0 ? "无" : ""}
${warnings.map((w) => "  - " + w).join("\n")}

## 批次信息
- run=${run}；标注员 A/B（上下文隔离子代理）；dataset=${dataset.size} 例（指南 §9）
`;
  writeFileSync(join(REPORT_DIR, `report-${run}.md`), md, "utf8");
  writeFileSync(
    join(REPORT_DIR, `report-${run}.json`),
    JSON.stringify({ run, phase: "pre-arbitration", kappa, kappa_gate_pass: kappaPass, pre_rates: pre, agreed: agreed.length, pending: pending.length, incomplete, uncertain_pairs: uncertainPairs, dist_a: distA, dist_b: distB, malformed, warnings }, null, 2) + "\n",
    "utf8"
  );

  console.log(`[runner] κ=${kappaLine} 门禁${kappaPass ? "通过" : "未通过(停线)"}`);
  console.log(`[runner] 一致 ${agreed.length} ｜ 分歧 ${pending.length} ｜ incomplete ${incomplete.length} ｜ uncertain 配对 ${uncertainPairs.length}`);
  console.log(`[runner] 预口径（仅一致项）严格 ${pre.strict === null ? "n/a" : (pre.strict * 100).toFixed(1) + "%"} ｜ 宽松 ${pre.loose === null ? "n/a" : (pre.loose * 100).toFixed(1) + "%"}`);
  console.log(`[runner] pending → ${relative(process.cwd(), pendingPath)}`);
  if (malformed.length) console.log(`[runner] MALFORMED ${malformed.length} 条（见报告）`);
  return kappaPass ? 0 : 2;
}

// ========== finalize ==========
function cmdFinalize(run: string): number {
  const resolvedPath = join(ARB_DIR, `resolved-${run}.json`);
  if (!existsSync(resolvedPath)) {
    console.error(`[runner] 缺 ${relative(process.cwd(), resolvedPath)} —— 先完成仲裁（§7）`);
    return 1;
  }
  const resolved = JSON.parse(readFileSync(resolvedPath, "utf8")) as Array<{
    example_id: string;
    final_verdict: Verdict;
    contested?: boolean;
    adopted_from?: string;
  }>;
  const A = readAnnotationDir("A", run);
  const B = readAnnotationDir("B", run);
  const dataset = readDatasetIds();
  const allIds = [...new Set([...A.keys(), ...B.keys()])].filter((id) => !id.startsWith("gold-")).sort();
  const resMap = new Map(resolved.map((r) => [r.example_id, r]));

  const finalEntries: Array<{ verdict: Verdict; contested: boolean }> = [];
  const unresolved: string[] = [];
  const adoptedStats = { A: 0, B: 0, arbitrator: 0 };
  let contestedList: string[] = [];

  for (const id of allIds) {
    const a = A.get(id);
    const b = B.get(id);
    const r = resMap.get(id);
    if (a && b && a.verdict === b.verdict && a.verdict !== "uncertain" && [...(a.error_classes ?? [])].sort().join() === [...(b.error_classes ?? [])].sort().join()) {
      finalEntries.push({ verdict: a.verdict, contested: false });
      continue;
    }
    if (!r) {
      unresolved.push(id);
      continue;
    }
    if (r.adopted_from && r.adopted_from in adoptedStats) adoptedStats[r.adopted_from as keyof typeof adoptedStats]++;
    if (r.contested) contestedList.push(id);
    finalEntries.push({ verdict: r.final_verdict, contested: !!r.contested });
  }

  const fin = rates(finalEntries);
  const distMerged = errDist([...A.values(), ...B.values()].filter((x) => !x.example_id.startsWith("gold-")));
  const kappa = cohensKappa(
    allIds
      .filter((id) => A.has(id) && B.has(id))
      .filter((id) => A.get(id)!.verdict !== "uncertain" && B.get(id)!.verdict !== "uncertain")
      .map((id) => ({ a: A.get(id)!.verdict, b: B.get(id)!.verdict }))
  );

  const md = `# S-A4 首轮等价率终局报告（run=${run}，仲裁后口径）

## 双口径（N=${fin.denominator} = 全部 ${fin.n} − contested ${fin.contested} − uncertain ${fin.uncertain}）
- **严格**：${fin.strict === null ? "n/a" : (fin.strict * 100).toFixed(1) + "%"}（equivalent ${fin.equivalent}）
- **宽松**：${fin.loose === null ? "n/a" : (fin.loose * 100).toFixed(1) + "%"}（+ equivalent_with_notes ${fin.equivalent_with_notes}）
- not_equivalent：${fin.not_equivalent}

## 一致性与过程（事实）
- 仲裁前 Cohen's κ（三分类）= ${kappa === null ? "n/a" : kappa.toFixed(3)}（门禁 ≥0.7：${kappa !== null && kappa >= 0.7 ? "通过" : "未通过"}）
- contested（剔除并披露，§7.5）：${contestedList.length === 0 ? "0" : contestedList.join(", ")}
- 仲裁采纳来源：A=${adoptedStats.A} B=${adoptedStats.B} 仲裁人自判=${adoptedStats.arbitrator}
- unresolved（缺仲裁决定）: ${unresolved.length === 0 ? "0" : unresolved.join(", ")}
- 错误类分布（A+B 合计，含分歧项重复计数）：${JSON.stringify(distMerged)}
- dataset：${dataset.size} 例；run=${run}

## 解读（判断，非事实）
- 本报告为现状基线（R1：candidate_mr=kg-writer 现有抽取投影）的 before 口径；S-A1/S-A2 上线后同集重测 after 对比。
`;
  writeFileSync(join(REPORT_DIR, `report-${run}-final.md`), md, "utf8");
  writeFileSync(
    join(REPORT_DIR, `report-${run}-final.json`),
    JSON.stringify({ run, phase: "final", rates: fin, kappa_pre_arbitration: kappa, contested: contestedList, unresolved, adopted_stats: adoptedStats, dist_merged: distMerged }, null, 2) + "\n",
    "utf8"
  );
  console.log(`[runner] 终局：严格 ${((fin.strict ?? 0) * 100).toFixed(1)}% ｜ 宽松 ${((fin.loose ?? 0) * 100).toFixed(1)}%（N=${fin.denominator}，contested ${fin.contested}）`);
  if (unresolved.length) console.log(`[runner] 警告：${unresolved.length} 例缺仲裁决定，未计入终局口径`);
  return unresolved.length ? 1 : 0;
}

// ========== gold ==========
function cmdGold(annotator: string, run: string): number {
  const keyPath = join(GOLD_DIR, "answer-key.json");
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  const keyMap = new Map(key.gold.map((g: any) => [g.id, g]));
  const anns = readAnnotationDir(annotator, run);
  const goldIds = [...keyMap.keys()].sort();
  let pass = 0;
  const fails: string[] = [];
  for (const id of goldIds) {
    const a = anns.get(id);
    const k = keyMap.get(id);
    if (!a) {
      fails.push(`${id}: 未标注`);
      continue;
    }
    const verdictOk = a.verdict === k.expected_verdict;
    const classesOk =
      k.expected_verdict === "not_equivalent"
        ? [...(a.error_classes ?? [])].sort().join(",") === [...k.expected_error_classes].sort().join(",")
        : (a.error_classes ?? []).length === 0;
    if (verdictOk && classesOk) {
      pass++;
    } else {
      fails.push(`${id}: 判=${a.verdict}/${(a.error_classes ?? []).join("+") || "-"} 预埋=${k.expected_verdict}/${k.expected_error_classes.join("+") || "-"}${verdictOk ? "（verdict 对、错误类不符）" : ""}`);
    }
  }
  console.log(`[runner] gold 校准（annotator ${annotator}）：${pass}/${goldIds.length} 全对=${pass === goldIds.length ? "是，可上岗" : "否 → 回炉细则再校准（§8）"}`);
  for (const f of fails) console.log(`  - ${f}`);
  return pass === goldIds.length ? 0 : 1;
}

// ========== CLI ==========
const args = process.argv.slice(2);
const cmd = args[0];
function opt(name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const run = opt("--run", "r1");

switch (cmd) {
  case "compare":
    process.exit(cmdCompare(run));
    break;
  case "finalize":
    process.exit(cmdFinalize(run));
    break;
  case "gold":
    process.exit(cmdGold(opt("--annotator", "A"), run));
    break;
  default:
    console.error("用法: annotation-runner.ts compare|finalize|gold [--run r1] [--annotator A]");
    process.exit(1);
}
