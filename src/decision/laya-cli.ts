/**
 * Laya 决策链 CLI —— 把"分诊 → 是否自动执行"接到本仓库的真实状态上。
 *
 *   bun run decide:laya -- --check                 # 只探可用性（WSL + venv + 权重）
 *   bun run decide:laya -- --spec docs/decisions/laya-spec.json [--json]
 *   bun run decide:laya -- --spec ... --run        # 仅执行 AUTO 且已注册为可逆的动作
 *
 * 动作注册表面向**只读/可逆**的本地核验；不存在"删除数据/推送/花额度"类动作，
 * 那类只能以 ESCALATE 交回人类（与闸门规则 1 一致，代码里根本没有该出口）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readString } from "../utils/env.js";
import {
  AUDIT_STAGE_IDS,
  AUDIT_STAGES,
  type AuditStageContext,
  type AuditStageId,
} from "./audit-chain.js";
import {
  createLayaTriage,
  createPlatformLayaRunner,
  selectRunnerKind,
  toWslPath,
  type LayaGateSpec,
  type TriageResult,
} from "./laya-triage.js";

/** 审计 stage 的默认上下文；与 runAuditChain 的缺省保持同一口径。 */
function auditStageContext(): AuditStageContext {
  const repoRoot = process.cwd();
  return {
    repoRoot,
    outDir: path.join(repoRoot, ".tmp", "audit"),
    specPath: path.join(repoRoot, "docs", "decisions", "laya", "audit-chain-triage.json"),
    runs: Number(readString("AUDIT_DET_RUNS", "5")),
  };
}

/** 可自动执行的动作：全部本地、只读或幂等可逆。新增必须同时补测试。 */
export const REVERSIBLE_ACTIONS: Record<string, { describe: string; run: () => Promise<{ ok: boolean; detail: string }> }> = {
  "verify:typecheck": {
    describe: "bun x tsc --noEmit",
    run: async () => {
      const p = Bun.spawn(["bun", "x", "tsc", "--noEmit"], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      const out = await new Response(p.stdout).text();
      return { ok: code === 0, detail: `exit=${code} ${out.slice(0, 200)}` };
    },
  },
  "verify:runtime-audit": {
    describe: "bun run audit:runtime",
    run: async () => {
      const p = Bun.spawn(["bun", "run", "audit:runtime"], { stdout: "pipe", stderr: "pipe" });
      const code = await p.exited;
      const out = await new Response(p.stdout).text();
      return { ok: code === 0, detail: `exit=${code} ${out.slice(-300)}` };
    },
  },
  // 审计链五个只读 stage：实现体在 audit-chain.ts（单测直接打实现体），
  // 这里只做"注册键 → 上下文"的绑定。半径登记见 audit-chain-triage.json。
  ...Object.fromEntries(
    AUDIT_STAGE_IDS.map((id) => [id, {
      describe: `审计链 stage（实现体 audit-chain.ts:${id}）`,
      run: async () => AUDIT_STAGES[id as AuditStageId](auditStageContext()),
    }]),
  ),
};

function flagValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
}

function parseArgs(argv: string[]) {
  return {
    check: argv.includes("--check"),
    run: argv.includes("--run"),
    json: argv.includes("--json"),
    spec: flagValue(argv, "--spec"),
  };
}

/** 可用性探测结果（mode = http | python，开发流程两种落点，见 skill §10） */
export interface LayaAvailability {
  available: boolean;
  mode: "http" | "python";
  detail: string;
}

/**
 * 落点可用性探测（--check）。
 * LAYA_DECISION_URL 已配置 ⇒ 探 HTTP /health/live（3s 超时），**不静默回退 python**
 * （配置了 HTTP 却探 python 会把"服务端拓扑变更"误报成"本机环境缺失"）；未配置 ⇒ 原 python 探测。
 */
export async function checkLayaAvailability(
  opts: {
    probePython?: () => Promise<{ available: boolean; detail: string }>;
  } = {},
): Promise<LayaAvailability> {
  const url = readString("LAYA_DECISION_URL", "").trim();
  if (url !== "") {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/health/live`, { signal: AbortSignal.timeout(3000) });
      return res.ok
        ? { available: true, mode: "http", detail: `HTTP ${url} /health/live 200（开发流程落点就绪）` }
        : { available: false, mode: "http", detail: `HTTP ${url} /health/live ${res.status}` };
    } catch (err) {
      return {
        available: false,
        mode: "http",
        detail: `LAYA_DECISION_URL=${url} 不可达：${(err as Error).message.slice(0, 80)}（检查服务端拓扑，不回退 python）`,
      };
    }
  }
  const probe = opts.probePython ?? probePythonLocally;
  const r = await probe();
  return { available: r.available, mode: "python", detail: r.detail };
}

/** 原 python 落点探测（WSL + venv + 权重；--check 秒级，不加载模型）。 */
async function probePythonLocally(): Promise<{ available: boolean; detail: string }> {
  const gate = toWslPath(path.resolve(process.cwd(), "scripts", "laya", "laya_gate.py"));
  const python = readString("LAYA_PYTHON", "/root/.venvs/laya/bin/python");
  // Windows 宿主经 WSL；Linux 原生直接调 venv python
  const cmd = selectRunnerKind() === "wsl"
    ? ["wsl.exe", "-d", readString("LAYA_WSL_DISTRO", "Arch"), "--", python, gate, "--check"]
    : [python, path.resolve(process.cwd(), "scripts", "laya", "laya_gate.py"), "--check"];
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await p.exited;
  const out = await new Response(p.stdout).text();
  return { available: code === 0, detail: out.trim() || `laya_gate --check 退出码 ${code}` };
}

async function doCheck(): Promise<number> {
  const r = await checkLayaAvailability();
  console.log(r.detail);
  return r.available ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  if (a.check) return doCheck();
  if (!a.spec || !existsSync(a.spec)) {
    console.error("需要 --spec <path>（或 --check 探可用性）");
    return 2;
  }
  const spec = JSON.parse(readFileSync(a.spec, "utf8")) as LayaGateSpec;
  const triage = createLayaTriage({ run: createPlatformLayaRunner() });

  if (a.run) {
    const actions = Object.fromEntries(Object.entries(REVERSIBLE_ACTIONS).map(([id, v]) => [id, v.run]));
    const { executed, escalated } = await triage.decideAndRun(spec, actions);
    for (const e of executed) console.log(`EXECUTED ${e.id} ok=${e.ok} ${e.detail ?? ""}`);
    for (const r of escalated) console.log(`ESCALATED ${r.id} :: ${r.reasons.join("; ") || "非 AUTO"}`);
    return executed.some((e) => !e.ok) ? 1 : 0;
  }

  const results: TriageResult[] = await triage.triage(spec);
  if (a.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      const extra = r.chosen ? ` chosen=${r.chosen} margin=${r.margin?.toFixed(3)}` : "";
      const notes = r.notes?.length ? `\n              ⚠ ${r.notes.join("\n              ⚠ ")}` : "";
      console.log(`${r.verdict.padEnd(11)} ${r.id}${extra}${r.reasons.length ? `\n              · ${r.reasons.join("\n              · ")}` : ""}${notes}`);
    }
  }
  return results.some((r) => r.verdict === "UNAVAILABLE") ? 3 : 0;
}

if (import.meta.main) process.exit(await main());
