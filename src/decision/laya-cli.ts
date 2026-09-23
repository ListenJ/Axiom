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
import {
  createLayaTriage,
  createWslLayaRunner,
  toWslPath,
  type LayaGateSpec,
  type TriageResult,
} from "./laya-triage.js";

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
};

function parseArgs(argv: string[]) {
  return {
    check: argv.includes("--check"),
    run: argv.includes("--run"),
    json: argv.includes("--json"),
    spec: argv[argv.indexOf("--spec") + 1] ?? "",
  };
}

async function doCheck(): Promise<number> {
  const gate = toWslPath(path.resolve(process.cwd(), "scripts", "laya", "laya_gate.py"));
  const p = Bun.spawn(
    ["wsl.exe", "-d", process.env.LAYA_WSL_DISTRO ?? "Arch", "--",
      process.env.LAYA_PYTHON ?? "/root/.venvs/laya/bin/python",
      gate, "--check"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await p.exited;
  const out = await new Response(p.stdout).text();
  console.log(out.trim() || JSON.stringify({ ok: false, error: `laya_gate --check 退出码 ${code}` }));
  return code === 0 ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  if (a.check) return doCheck();
  if (!a.spec || !existsSync(a.spec)) {
    console.error("需要 --spec <path>（或 --check 探可用性）");
    return 2;
  }
  const spec = JSON.parse(readFileSync(a.spec, "utf8")) as LayaGateSpec;
  const triage = createLayaTriage({ run: createWslLayaRunner() });

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
      console.log(`${r.verdict.padEnd(11)} ${r.id}${extra}${r.reasons.length ? `\n              · ${r.reasons.join("\n              · ")}` : ""}`);
    }
  }
  return results.some((r) => r.verdict === "UNAVAILABLE") ? 3 : 0;
}

if (import.meta.main) process.exit(await main());
