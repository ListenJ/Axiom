/**
 * 全自动审计链 —— 强约束审计的机械化底座，由 Laya 决策闸驱动。
 *
 * 定位：把审计提示词里可机械化的部分做成**确定性 stage**（同输入同输出、排序稳定、
 * 无时间戳参与），每个 stage 以「本地只读核验」的身份登记进 Laya 分诊
 * （`actionBlastRadius: "local_reversible"`）；链跑起来时只有判为 AUTO 的 stage 被执行，
 * 未登记半径 / 外写半径 / 模型不可用 ⇒ 一律不执行（失败方向与 ADR-008 一致：
 * 模型只能提高警觉，永远不能降低警觉）。
 *
 * stage 一览（id 与 REVERSIBLE_ACTIONS 注册键一致）：
 *   audit:inventory        递归文件清单 + 分类 + 行数（Phase 0 的分母）
 *   audit:vector-scan      依赖清单 + 代码模式双通道扫"向量化"痕迹（模块 7 铁证）
 *   audit:claims           声明提取（确定性 / zero-LLM / 非向量化 → file:line）
 *   audit:determinism-scan 三个扫描 stage 的 N 次复跑字节比对（结构性确定性）
 *   audit:laya-determinism laya_gate 同 spec 跨进程 N≥5 次，概率逐字节比对（13.5 实测要求）
 *
 * `--stages-only` 是**人**直接跑只读扫描的入口（与 `bun run audit:runtime` 同性质），
 * 不经过模型闸；自动化路径默认必须过闸。
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readString } from "../utils/env.js";
import {
  createLayaTriage,
  createPlatformLayaRunner,
  selectRunnerKind,
  toWslPath,
  type LayaGateSpec,
  type LayaTriage,
  type TriageResult,
} from "./laya-triage.js";

export const AUDIT_STAGE_IDS = [
  "audit:inventory",
  "audit:vector-scan",
  "audit:claims",
  "audit:determinism-scan",
  "audit:laya-determinism",
] as const;

export type AuditStageId = (typeof AUDIT_STAGE_IDS)[number];

// ---------------------------------------------------------------------------
// 共享：目录遍历与排除面
// ---------------------------------------------------------------------------

/** 任意深度都跳过的目录名（构建产物 / 依赖 / 缓存 / 隐藏态；.github 例外，属 CI 配置）。 */
const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", "dist", "build", "target", "coverage", ".next",
  ".cache", ".venv", "venv", "__pycache__", ".pytest_cache", ".turbo", ".bun",
]);

/** 仅在仓库顶层跳过的目录（归档 / 运行态 / 第三方载荷 —— 均非待审源码面）。 */
const SKIP_TOP_LEVEL = new Set([
  "archive", "tmp", "reports", "playwright-report", "test-results", "eval-results",
  "external-benchmarks", "python_libs", "vendor", "knowledge-base", "data",
  "axiom-memory", "openclaw-memory",
]);

const TEXT_EXTS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "jsx", "cts", "mts", "py", "go", "rs", "md",
  "json", "toml", "yml", "yaml", "sh", "bash", "sql", "css", "scss", "html",
  "vue", "svelte", "ps1", "psm1", "cmd", "bat", "txt", "svg",
]);

const ASSET_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "woff", "woff2", "ttf", "otf",
  "exe", "dll", "so", "dylib", "deb", "rpm", "AppImage", "wasm", "bin",
  "db", "traineddata", "zip", "tar", "gz", "mp4", "webm", "wav", "mp3", "pdf",
]);

/** 遍历时逐层排序 ⇒ 输出与文件系统返回顺序无关（确定性的第一来源）。 */
async function walk(
  root: string,
  rel: string,
  out: string[],
): Promise<void> {
  const abs = path.resolve(root, rel);
  const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const top = !rel.includes("/");
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      if (top && SKIP_TOP_LEVEL.has(e.name)) continue;
      await walk(root, child, out);
    } else if (e.isFile()) {
      if (e.name.endsWith(".log")) continue;
      out.push(child);
    }
  }
}

function classify(rel: string): "core" | "config" | "test" | "docs" | "vendor" | "asset" {
  const base = rel.split("/").pop() ?? rel;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  if (ASSET_EXTS.has(ext)) return "asset";
  if (/^docs\//.test(rel)) return "docs";
  if (ext === "md") return "docs";
  if (/^(tests|e2e|e2e-visual)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return "test";
  if (/^(config|deploy)\//.test(rel)) return "config";
  if (/^(Dockerfile|docker-compose|ecosystem\.config|tsconfig|bunfig|bun\.lock|playwright\.config|\.env\.example|package\.json|package\.lock)/.test(base) || /^(json|toml|ya?ml|lock)$/.test(ext)) return "config";
  return "core";
}

// ---------------------------------------------------------------------------
// Stage 1：文件清单（Phase 0 的覆盖率分母）
// ---------------------------------------------------------------------------

export interface InventoryEntry { path: string; type: string; lines: number }

export interface InventoryResult {
  files: InventoryEntry[];
  counts: Record<string, number>;
  total: number;
  textLines: number;
}

export async function scanInventory(repoRoot: string): Promise<InventoryResult> {
  const rels: string[] = [];
  await walk(repoRoot, "", rels);
  const files: InventoryEntry[] = [];
  const counts: Record<string, number> = { core: 0, config: 0, test: 0, docs: 0, vendor: 0, asset: 0 };
  let textLines = 0;
  for (const rel of rels) {
    const type = classify(rel);
    let lines = 0;
    const ext = (rel.split(".").pop() ?? "").toLowerCase();
    if (TEXT_EXTS.has(ext)) {
      const abs = path.resolve(repoRoot, rel);
      try {
        if (statSync(abs).size <= 1_000_000) {
          const text = readFileSync(abs, "utf8");
          // 与 wc -l 同口径：尾随换行不另算一行
          lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          textLines += lines;
        }
      } catch {
        lines = -1; // 读取失败也要留痕，不许静默吞掉
      }
    }
    counts[type] = (counts[type] ?? 0) + 1;
    files.push({ path: rel, type, lines });
  }
  return { files, counts, total: files.length, textLines };
}

// ---------------------------------------------------------------------------
// Stage 2：向量化痕迹双通道扫描（模块 7 的铁证通道）
// ---------------------------------------------------------------------------

const VECTOR_DEP_RE = /faiss|chroma|qdrant|annoy|hnsw|sentence-transformer|pgvector|pinecone|weaviate|milvus|lancedb|vectorize|vectra|memoryvec|embed|openai|cohere|voyage/i;
const VECTOR_CODE_RE = /cosine\s*similarity|cosineSimilarity|dotProduct\s*\(|dot\(\s*vec|embedding|emb\.\d+\b|vectoriz|faiss|hnswlib|sentence_transformers|getEmbedding/i;
const CODE_EXTS = new Set(["ts", "tsx", "js", "mjs", "cjs", "jsx", "cts", "mts", "py", "go", "rs"]);

export interface ScanHit { location: string; kind: string; match: string; line: number; text: string }

export interface VectorScanResult {
  depHits: ScanHit[];
  codeHits: ScanHit[];
  scannedFiles: number;
}

export async function scanVectorFootprint(repoRoot: string): Promise<VectorScanResult> {
  const depHits: ScanHit[] = [];
  const codeHits: ScanHit[] = [];
  let scannedFiles = 0;

  // 通道 1：所有 package.json 的依赖声明（排除面与清单一致）
  const rels: string[] = [];
  await walk(repoRoot, "", rels);
  for (const rel of rels) {
    if (!rel.endsWith("package.json")) continue;
    try {
      const pkg = JSON.parse(readFileSync(path.resolve(repoRoot, rel), "utf8")) as Record<string, unknown>;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        const deps = pkg[section];
        if (!deps || typeof deps !== "object") continue;
        for (const name of Object.keys(deps as Record<string, string>)) {
          const m = VECTOR_DEP_RE.exec(name);
          if (m) depHits.push({ location: rel, kind: `dependency:${section}`, match: name, line: 0, text: String((deps as Record<string, string>)[name]) });
        }
      }
    } catch { /* 解析不了的 package.json 记不入命中，但也不算证据 */ }
  }

  // 通道 2：代码模式扫描（ts/js/py/go/rs）
  for (const rel of rels) {
    const ext = (rel.split(".").pop() ?? "").toLowerCase();
    if (!CODE_EXTS.has(ext)) continue;
    const abs = path.resolve(repoRoot, rel);
    let text: string;
    try {
      if (statSync(abs).size > 1_000_000) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scannedFiles++;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = VECTOR_CODE_RE.exec(lines[i]);
      if (m) codeHits.push({ location: `${rel}:${i + 1}`, kind: "code-pattern", match: m[0], line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return { depHits, codeHits, scannedFiles };
}

// ---------------------------------------------------------------------------
// Stage 3：声明提取（"声明 vs 实际"对照表的声明侧来源）
// ---------------------------------------------------------------------------

const CLAIM_RE = /(确定性|deterministic|zero.?LLM|zero-llm|非向量化|不使用向量化|无向量化|non-?vector|never generate|不生成文本|同输入同输出)/i;
const CLAIM_FILES_DEFAULT = [
  "README.md", "LIMITATIONS.md",
  "docs/ARCHITECTURE.md", "docs/AXIOM-ARCHITECTURE.md", "docs/KNOWLEDGE-BASE.md",
  "docs/PHILOSOPHY.md", "docs/RUNTIME-SPEC.md", "docs/SECURITY-MEASURES.md",
];

export interface ClaimHit { claim: string; file: string; line: number }

export async function extractClaims(repoRoot: string, files: string[] = CLAIM_FILES_DEFAULT): Promise<ClaimHit[]> {
  const hits: ClaimHit[] = [];
  for (const rel of files) {
    const abs = path.resolve(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = CLAIM_RE.exec(lines[i]);
      if (m) hits.push({ claim: m[0], file: rel, line: i + 1 });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Stage 4/5：确定性复跑比对
// ---------------------------------------------------------------------------

export function allEqual(outputs: string[]): boolean {
  return outputs.length > 0 && outputs.every((o) => o === outputs[0]);
}

/**
 * 确定性裁定：所有跨进程运行**全部零退出**且输出逐字节一致才算确定。
 * 单独抽出来是因为首轮实跑的假绿：五次全 exit=2、报错输出"一致"被当成了确定通过。
 */
export function determinismVerdict(exitCodes: number[], answers: string[]): boolean {
  return exitCodes.length > 0 && exitCodes.every((c) => c === 0) && allEqual(answers);
}

/** 结构性确定性：同一扫描在同一进程内复跑 N 次做字节比对（快通道 N=5，重清单 N=2 并如实标注）。 */
export interface DeterminismScanResult {
  runs: number;
  vectorScan: { runs: number; identical: boolean };
  claims: { runs: number; identical: boolean };
  inventory: { runs: number; identical: boolean; note: string };
}

export async function determinismScan(repoRoot: string, runs: number): Promise<DeterminismScanResult> {
  const vectorOutputs: string[] = [];
  const claimOutputs: string[] = [];
  const inventoryOutputs: string[] = [];
  const inventoryRuns = 2; // 全量清单带行数统计，跑 5 次代价过高；N=2 且在报告里如实标注口径
  for (let i = 0; i < runs; i++) {
    vectorOutputs.push(JSON.stringify(await scanVectorFootprint(repoRoot)));
    claimOutputs.push(JSON.stringify(await extractClaims(repoRoot)));
  }
  for (let i = 0; i < inventoryRuns; i++) {
    const inv = await scanInventory(repoRoot);
    inventoryOutputs.push(JSON.stringify({ counts: inv.counts, total: inv.total, textLines: inv.textLines }));
  }
  return {
    runs,
    vectorScan: { runs, identical: allEqual(vectorOutputs) },
    claims: { runs, identical: allEqual(claimOutputs) },
    inventory: { runs: inventoryRuns, identical: allEqual(inventoryOutputs), note: "in-process、N=2（重清单降配，非跨进程口径）" },
  };
}

/** 模型侧确定性（13.5）：同一 spec 跨进程独立运行 N 次，laya_gate 的 stdout 逐字节比对。 */
export interface LayaDeterminismResult {
  runs: number;
  exitCodes: number[];
  identical: boolean;
  outputs: string[];
  errors?: string[];
}

export async function layaDeterminism(repoRoot: string, specPath: string, runs: number): Promise<LayaDeterminismResult> {
  const scriptAbs = path.resolve(repoRoot, "scripts", "laya", "laya_gate.py");
  if (!existsSync(scriptAbs)) throw new Error("缺少 scripts/laya/laya_gate.py");
  const python = readString("LAYA_PYTHON", "/root/.venvs/laya/bin/python");
  const timeoutMs = Number(readString("AUDIT_LAYA_TIMEOUT_MS", "240000"));
  const wsl = selectRunnerKind() === "wsl";
  // wsl.exe 会把 Windows 形态的路径参数捣碎（剥 :\ 与 \）——必须先转 WSL 挂载路径，
  // 与 createWslLayaRunner 同一纪律（首轮实跑就栽在这里：exit=2 且输出"一致"）。
  const scriptArg = wsl ? toWslPath(scriptAbs) : scriptAbs;
  const specArg = wsl ? toWslPath(path.resolve(specPath)) : path.resolve(specPath);

  const outputs: string[] = [];
  const errors: string[] = [];
  const codes: number[] = [];
  for (let i = 0; i < runs; i++) {
    const cmd = wsl
      ? ["wsl.exe", "-d", readString("LAYA_WSL_DISTRO", "Arch"), "--", python, scriptArg, "--spec", specArg]
      : [python, scriptArg, "--spec", specArg];
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const killed = new Promise<"timeout">((res) => {
      if (timeoutMs > 0) timer = setTimeout(() => { proc.kill(); res("timeout"); }, timeoutMs);
    });
    const settled = await Promise.race([proc.exited, killed]);
    clearTimeout(timer);
    const out = await new Response(proc.stdout).text();
    const errText = await new Response(proc.stderr).text();
    if (settled === "timeout") throw new Error(`laya_gate 超时（${timeoutMs}ms，第 ${i + 1} 次运行）`);
    codes.push(settled);
    outputs.push(out);
    if (settled !== 0) errors.push(`run${i + 1} exit=${settled}: ${errText.slice(0, 200)}`);
  }
  // 失败方向：任何一次非零退出 ⇒ 不确定（一致的报错输出不算"确定"）。
  const answers = outputs.map((o) => {
    const i = o.indexOf("{");
    return i >= 0 ? o.slice(i).trim() : o.trim();
  });
  return {
    runs,
    exitCodes: codes,
    identical: determinismVerdict(codes, answers),
    outputs: answers.map((o) => o.slice(0, 400)),
    ...(errors.length ? { errors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stage 注册表 + 链驱动
// ---------------------------------------------------------------------------

export interface AuditStageContext { repoRoot: string; outDir: string; specPath: string; runs: number }

export type AuditAction = (ctx: AuditStageContext) => Promise<{ ok: boolean; detail: string }>;

function save(outDir: string, name: string, data: unknown): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.resolve(outDir, name), JSON.stringify(data, null, 2));
}

/** 每个 stage 的实现体；REVERSIBLE_ACTIONS 注册的闭包最终都落到这里（便于单测注入 tmp 夹具）。 */
export const AUDIT_STAGES: Record<AuditStageId, AuditAction> = {
  "audit:inventory": async (ctx) => {
    const inv = await scanInventory(ctx.repoRoot);
    save(ctx.outDir, "inventory.json", inv);
    return { ok: inv.total > 0, detail: `total=${inv.total} core=${inv.counts.core} test=${inv.counts.test} docs=${inv.counts.docs} config=${inv.counts.config} asset=${inv.counts.asset} textLines=${inv.textLines}` };
  },
  "audit:vector-scan": async (ctx) => {
    const r = await scanVectorFootprint(ctx.repoRoot);
    save(ctx.outDir, "vector-scan.json", r);
    return { ok: true, detail: `deps=${r.depHits.length} code=${r.codeHits.length} scannedFiles=${r.scannedFiles}` };
  },
  "audit:claims": async (ctx) => {
    const hits = await extractClaims(ctx.repoRoot);
    save(ctx.outDir, "claims.json", hits);
    return { ok: true, detail: `claims=${hits.length}` };
  },
  "audit:determinism-scan": async (ctx) => {
    const r = await determinismScan(ctx.repoRoot, ctx.runs);
    save(ctx.outDir, "determinism-scan.json", r);
    const parts: Array<{ identical: boolean }> = [r.vectorScan, r.claims, r.inventory];
    return { ok: parts.every((p) => p.identical), detail: `vector=${r.vectorScan.identical} claims=${r.claims.identical} inventory=${r.inventory.identical} (runs=${r.runs}/${r.inventory.runs})` };
  },
  "audit:laya-determinism": async (ctx) => {
    const r = await layaDeterminism(ctx.repoRoot, ctx.specPath, ctx.runs);
    save(ctx.outDir, "laya-determinism.json", r);
    return { ok: r.identical === true, detail: `runs=${r.runs} identical=${r.identical} exitCodes=${r.exitCodes.join(",")}` };
  },
};

export interface AuditChainResult {
  triage: TriageResult[];
  executed: Array<{ id: string; ok: boolean; detail?: string }>;
  escalated: TriageResult[];
  outDir: string;
}

export interface AuditChainDeps {
  repoRoot?: string;
  specPath?: string;
  outDir?: string;
  runs?: number;
  /** 测试注入；缺省按平台选生产 runner。 */
  triage?: LayaTriage;
}

export async function runAuditChain(deps: AuditChainDeps = {}): Promise<AuditChainResult> {
  const repoRoot = deps.repoRoot ?? process.cwd();
  const specPath = deps.specPath ?? path.join(repoRoot, "docs", "decisions", "laya", "audit-chain-triage.json");
  const outDir = deps.outDir ?? path.join(repoRoot, ".tmp", "audit");
  const runs = deps.runs ?? Number(readString("AUDIT_DET_RUNS", "5"));

  const spec = JSON.parse(readFileSync(specPath, "utf8")) as LayaGateSpec;
  const triage = deps.triage ?? createLayaTriage({ run: createPlatformLayaRunner({ repoRoot }) });

  const ctx: AuditStageContext = { repoRoot, outDir, specPath, runs };
  const actions = Object.fromEntries(
    AUDIT_STAGE_IDS.map((id) => [id, () => AUDIT_STAGES[id](ctx)]),
  );

  const { executed, escalated } = await triage.decideAndRun(spec, actions);
  const results: TriageResult[] = await triage.triage(spec);

  save(outDir, "evidence.json", {
    spec: { state: spec.state, decisionIds: spec.decisions.map((d) => d.id) },
    specPath,
    triage: results,
    executed,
    escalated,
    platform: process.platform,
    runnerKind: selectRunnerKind(),
  });

  const md = renderReportSkeleton({ triage: results, executed, escalated, runs });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.resolve(outDir, "audit-report-skeleton.md"), md);

  return { triage: results, executed, escalated, outDir };
}

function renderReportSkeleton(r: {
  triage: TriageResult[];
  executed: Array<{ id: string; ok: boolean; detail?: string }>;
  escalated: TriageResult[];
  runs: number;
}): string {
  const lines: string[] = [
    "# 全自动审计链 · 证据骨架（机器生成，人工裁定写在 docs/reviews 正式报告）",
    "",
    "## 分诊台账（Laya 闸）",
    ...r.triage.map((t) => `- ${t.verdict} ${t.id}${t.reasons.length ? ` :: ${t.reasons.join("; ")}` : ""}${t.notes?.length ? ` 〔交叉核对：${t.notes.join("; ")}〕` : ""}`),
    "",
    "## 执行台账",
    ...r.executed.map((e) => `- EXECUTED ${e.id} ok=${e.ok} ${e.detail ?? ""}`),
    ...r.escalated.map((e) => `- ESCALATED ${e.id} :: ${e.reasons.join("; ") || "非 AUTO"}`),
    "",
    `确定性复跑次数：N=${r.runs}（模型侧为跨进程；结构性扫描口径见 determinism-scan.json）`,
    "",
    "证据 JSON 与本骨架落盘于 .tmp/audit/；正式报告必须引用这里的实测数字。",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function flagValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
}

function parseArgs(argv: string[]) {
  return {
    stagesOnly: argv.includes("--stages-only"),
    json: argv.includes("--json"),
    spec: flagValue(argv, "--spec"),
    stage: flagValue(argv, "--stage"),
    outDir: flagValue(argv, "--out-dir"),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  const repoRoot = process.cwd();
  const specPath = a.spec || path.join(repoRoot, "docs", "decisions", "laya", "audit-chain-triage.json");
  const outDir = a.outDir || path.join(repoRoot, ".tmp", "audit");
  const runs = Number(readString("AUDIT_DET_RUNS", "5"));
  const ctx: AuditStageContext = { repoRoot, outDir, specPath, runs };

  if (a.stagesOnly) {
    const ids = (a.stage ? [a.stage as AuditStageId] : AUDIT_STAGE_IDS)
      .filter((id): id is AuditStageId => (AUDIT_STAGE_IDS as readonly string[]).includes(id));
    if (ids.length === 0) {
      console.error(`未知 stage：${a.stage}（可选：${AUDIT_STAGE_IDS.join(", ")}）`);
      return 2;
    }
    let fail = 0;
    for (const id of ids) {
      const r = await AUDIT_STAGES[id](ctx);
      console.log(`${r.ok ? "OK  " : "FAIL"} ${id} ${r.detail}`);
      if (!r.ok) fail++;
    }
    return fail > 0 ? 1 : 0;
  }

  if (!existsSync(specPath)) {
    console.error(`缺少 spec：${specPath}`);
    return 2;
  }

  const result = await runAuditChain({ repoRoot, specPath, outDir, runs });
  if (a.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const t of result.triage) {
      const extra = t.chosen ? ` chosen=${t.chosen} margin=${t.margin?.toFixed(3)}` : "";
      const notes = t.notes?.length ? `\n              ⚠ ${t.notes.join("\n              ⚠ ")}` : "";
      console.log(`${t.verdict.padEnd(11)} ${t.id}${extra}${t.reasons.length ? `\n              · ${t.reasons.join("\n              · ")}` : ""}${notes}`);
    }
    for (const e of result.executed) console.log(`EXECUTED ${e.id} ok=${e.ok} ${e.detail ?? ""}`);
    for (const e of result.escalated) console.log(`ESCALATED ${e.id} :: ${e.reasons.join("; ") || "非 AUTO"}`);
    console.log(`证据目录：${result.outDir}`);
  }
  return result.executed.some((e) => !e.ok) ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
