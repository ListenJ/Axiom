/**
 * Laya 决策链适配层（System-1 分诊 → 是否自动执行）
 *
 * 定位：Laya 是 421M ModernBERT **判别式**决策头，不是 LLM —— 它只输出校准概率，
 * 且本机实测存在三项能力缺陷（不推理输入中的数值、不处理否定、措辞敏感）。
 * 因此本模块的设计原则是：**模型只被允许提高警觉，永远不允许降低警觉**。
 *
 * 三条写死在代码里、不受模型输出影响的闸门（与 scripts/laya/laya_gate.py 同口径）：
 *   1. 动作不可逆 / 涉及外写 ⇒ 一律 ESCALATE；
 *   2. `choice` 的 top1−top2 < 0.15 ⇒ ESCALATE（模型自己拿不定）；
 *   3. 任一 `noul(需批准)` > 0.5 ⇒ ESCALATE。
 * 另加两条本机实测-derived 的约束：
 *   4. 领域为数值/工程裁决的决策 ⇒ 直接 ESCALATE（实测它读不懂 `gain=0.000002 vs 0.0025`）；
 *   5. 模型不可用（WSL/权重缺失/超时）⇒ UNAVAILABLE，**绝不退化成 AUTO**。
 */
import { existsSync } from "node:fs";
import path from "node:path";

export type LayaDomain = "triage" | "escalation" | "numeric" | "engineering";

/** 实测不可委托给它的领域：数值比较与工程结论。 */
export const NON_DELEGABLE_DOMAINS: readonly LayaDomain[] = ["numeric", "engineering"];

/**
 * 问题规格 —— 与 laya `RLAgent.predict(state, questions)` 的真实入参同形：
 * questions 是**以 key 索引的对象**，不是字符串数组（传数组会 `AttributeError: 'list' object has no attribute 'keys'`）。
 */
export type LayaQuestion =
  | { type: "choice"; options: Record<string, string> }
  | { type: "noul" | "score"; instructions: string; criteria?: string[] };

export interface LayaAnswer {
  type: "choice" | "score" | "noul";
  probabilities?: Record<string, number>;
  noul?: number;
  score?: number;
}

export interface LayaDecision {
  id: string;
  domain: LayaDomain;
  questions: Record<string, LayaQuestion>;
  /** 这些 key 一旦选中对应动作即不可逆/外写 ⇒ 无条件升级 */
  irreversibleQuestions?: string[];
  /** 即使 margin 够大也不得自动执行的**选项** */
  forbiddenAuto?: string[];
}

export interface LayaGateSpec {
  state: Record<string, unknown>;
  decisions: LayaDecision[];
}

export interface TriageResult {
  id: string;
  verdict: "AUTO" | "ESCALATE" | "UNAVAILABLE";
  reasons: string[];
  chosen?: string;
  margin?: number;
}

export interface LayaThresholds {
  marginMin: number;
  escalateNoul: number;
}

export const DEFAULT_THRESHOLDS: LayaThresholds = { marginMin: 0.15, escalateNoul: 0.5 };

/** 依赖注入：判定核心与"怎么问到模型"解耦，测试用 fake、生产用 WSL runner。 */
export interface LayaTriageDeps {
  /** 返回 {decisionId: {question: answer}} —— 与 laya_gate.py 的 JSON 输出同形 */
  run: (spec: LayaGateSpec) => Promise<Record<string, Record<string, LayaAnswer>>>;
  thresholds?: LayaThresholds;
  enabled?: boolean;
}

export interface LayaTriage {
  triage(spec: LayaGateSpec): Promise<TriageResult[]>;
  /** 只对判为 AUTO 且可逆的动作执行；其余原样返回，绝不代跑。 */
  decideAndRun(
    spec: LayaGateSpec,
    actions: Record<string, () => Promise<unknown>>,
  ): Promise<{ executed: Array<{ id: string; ok: boolean; detail?: string }>; escalated: TriageResult[] }>;
}

export function createLayaTriage(deps: LayaTriageDeps): LayaTriage {
  const th = deps.thresholds ?? DEFAULT_THRESHOLDS;

  async function triage(spec: LayaGateSpec): Promise<TriageResult[]> {
    if (deps.enabled === false) {
      return spec.decisions.map((d) => ({ id: d.id, verdict: "UNAVAILABLE" as const, reasons: ["分诊已禁用"] }));
    }

    // 领域不可委托的决策连模型都不问：既省一次推理，也避免"先问了再否掉"的假象。
    // 判定本身仍由下面的逐条检查给出，这里只是不调用 runner。
    const askable = spec.decisions.filter((d) => !NON_DELEGABLE_DOMAINS.includes(d.domain));

    let answersByDecision: Record<string, Record<string, LayaAnswer>> = {};
    try {
      if (askable.length > 0) {
        answersByDecision = await deps.run({ state: spec.state, decisions: askable });
      }
    } catch (err) {
      // 失败方向：可问的决策记 UNAVAILABLE（绝不落到 AUTO），而被领域封杀的决策
      // 无论模型是否可用都必须是 ESCALATE —— 它的升级理由不依赖模型健康。
      const msg = err instanceof Error ? err.message : String(err);
      return spec.decisions.map((d) =>
        NON_DELEGABLE_DOMAINS.includes(d.domain)
          ? { id: d.id, verdict: "ESCALATE" as const, reasons: [`领域 ${d.domain} 不可委托给 Laya（实测不做数值/工程推理）`] }
          : { id: d.id, verdict: "UNAVAILABLE" as const, reasons: [`Laya 不可用：${msg.slice(0, 160)}`] },
      );
    }

    return spec.decisions.map((dec) => {
      const reasons: string[] = [];
      let auto = true;
      let chosen: string | undefined;
      let margin: number | undefined;

      if (NON_DELEGABLE_DOMAINS.includes(dec.domain)) {
        return {
          id: dec.id,
          verdict: "ESCALATE" as const,
          reasons: [`领域 ${dec.domain} 不可委托给 Laya（实测不做数值/工程推理）`],
        };
      }

      const answers = answersByDecision[dec.id] ?? {};
      for (const [q, qs] of Object.entries(dec.questions)) {
        const r = answers[q];
        if (!r) {
          auto = false;
          reasons.push(`${q}: 模型未作答`);
          continue;
        }
        const irreversible = dec.irreversibleQuestions?.includes(q) ?? false;
        // "是否需人批准"这类语义写在 instructions 上，question key 只是标识符
        const askText = qs.type === "choice" ? q : qs.instructions;
        if (r.type === "choice" && r.probabilities) {
          const top = Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]);
          chosen = top[0]?.[0];
          margin = (top[0]?.[1] ?? 0) - (top[1]?.[1] ?? 0);
          if (irreversible || (chosen && dec.forbiddenAuto?.includes(chosen))) {
            auto = false;
            reasons.push(`${q}: 选中 ${chosen} 属不可逆/禁止自动动作`);
          }
          if (margin < th.marginMin) {
            auto = false;
            reasons.push(`${q}: margin ${margin.toFixed(3)} < ${th.marginMin}`);
          }
        } else if (r.type === "noul") {
          const v = r.noul ?? 0;
          if (v > th.escalateNoul && /批准|approv/i.test(askText)) {
            auto = false;
            reasons.push(`${q}: noul ${v.toFixed(3)} > ${th.escalateNoul} 需人批准`);
          }
        }
      }
      return { id: dec.id, verdict: auto ? "AUTO" : "ESCALATE", reasons, chosen, margin };
    });
  }

  return {
    triage,
    async decideAndRun(spec, actions) {
      const results = await triage(spec);
      const executed: Array<{ id: string; ok: boolean; detail?: string }> = [];
      const escalated: TriageResult[] = [];
      for (const r of results) {
        if (r.verdict !== "AUTO") {
          escalated.push(r);
          continue;
        }
        const fn = actions[r.id];
        if (!fn) {
          escalated.push({ ...r, verdict: "ESCALATE", reasons: [...r.reasons, "无对应可执行动作，视为未覆盖"] });
          continue;
        }
        try {
          await fn();
          executed.push({ id: r.id, ok: true });
        } catch (err) {
          executed.push({ id: r.id, ok: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }
      return { executed, escalated };
    },
  };
}

/**
 * 生产 runner：经 WSL 调用仓库内的 scripts/laya/laya_gate.py。
 * 一律用 args 数组直传、不经 shell ⇒ 不存在命令注入面，也不受 Windows 引号规则影响
 * （本文件的上一版就是被 Windows→WSL 命令串引号吃掉变量才测错了）。
 */
export interface WslLayaRunnerOptions {
  distro?: string;
  python?: string;
  /** 仓库内相对路径，默认 scripts/laya/laya_gate.py */
  script?: string;
  repoRoot?: string;
  timeoutMs?: number;
}

/** Windows 盘符路径 → WSL 挂载路径；非 Windows 绝对路径原样返回。 */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

export function createWslLayaRunner(opts: WslLayaRunnerOptions = {}) {
  const distro = process.env.LAYA_WSL_DISTRO ?? opts.distro ?? "Arch";
  const python = process.env.LAYA_PYTHON ?? "/root/.venvs/laya/bin/python";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const scriptRel = opts.script ?? path.join("scripts", "laya", "laya_gate.py");
  const scriptAbs = toWslPath(path.resolve(repoRoot, scriptRel));

  return async (spec: LayaGateSpec): Promise<Record<string, Record<string, LayaAnswer>>> => {
    if (!existsSync(path.resolve(repoRoot, scriptRel))) throw new Error(`缺少 ${scriptRel}`);

    const probe = Bun.spawn(["wsl.exe", "-d", distro, "--", "test", "-x", python], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await probe.exited) !== 0) throw new Error(`WSL ${distro} 内 ${python} 不可执行`);

    const proc = Bun.spawn(
      ["wsl.exe", "-d", distro, "--", python, scriptAbs, "--stdin-json"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    proc.stdin.write(JSON.stringify(spec));
    proc.stdin.end();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const killed = new Promise<"timeout">((res) => {
      if (timeoutMs > 0) timer = setTimeout(() => { proc.kill(); res("timeout"); }, timeoutMs);
    });
    const settled = await Promise.race([proc.exited, killed]);
    clearTimeout(timer);
    const out = await new Response(proc.stdout).text();
    const errText = await new Response(proc.stderr).text();
    if (settled === "timeout") throw new Error(`laya_gate 超时（${timeoutMs}ms）`);
    if (settled !== 0) throw new Error(`laya_gate 退出码 ${settled}：${errText.slice(0, 200)}`);
    try {
      return JSON.parse(out) as Record<string, Record<string, LayaAnswer>>;
    } catch {
      throw new Error(`laya_gate 输出不是 JSON：${out.slice(0, 160)}`);
    }
  };
}
