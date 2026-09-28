/**
 * Laya 决策链适配层（System-1 分诊 → 是否自动执行）
 *
 * 定位：Laya 是 421M ModernBERT **判别式**决策头，不是 LLM —— 它只输出校准概率，
 * 且本机实测存在三项能力缺陷（不推理输入中的数值、不处理否定、措辞敏感）。
 * 因此本模块的设计原则是：**模型只被允许提高警觉，永远不允许降低警觉**。
 *
 * 三条写死在代码里、不受模型输出影响的闸门（模型侧 `scripts/laya/laya_gate.py` 只出概率，
 * 裁定全部在这里）：
 *   1. 模型**选中的那个选项**的爆炸半径属外写/不可逆 ⇒ ESCALATE；未登记半径的选项同样升级
 *      （登记表是唯一依据，未知的动作不允许自动执行）；
 *   2. `choice` 的 top1−top2 < 0.15 ⇒ ESCALATE（模型自己拿不定）；
 *   另加三条本机实测-derived 的约束：
 *   3. 领域为数值/工程裁决的决策 ⇒ 直接 ESCALATE（实测它读不懂 `gain=0.000002 vs 0.0025`）；
 *   4. 模型不可用（WSL/权重缺失/超时）⇒ UNAVAILABLE，**绝不退化成 AUTO**。
 *
 * 半径必须按**选项**登记、不能按问题登记：实测 noul 头与爆炸半径分不开
 * （Spearman(tier, noul)=+0.41、min(tier3) < max(tier0)），把它当批准判据不是保守而是常数；
 * 而"这道题里有不可逆选项"也不等于"选中的动作不可逆" —— 曾据此把模型选中的
 * 最不可逆性最低的选项判成外写动作。所以 noul 在这里只做交叉核对（记 notes、不改裁定）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { readString } from "../utils/env.js";

export type LayaDomain = "triage" | "escalation" | "numeric" | "engineering";

/** 实测不可委托给它的领域：数值比较与工程结论。 */
export const NON_DELEGABLE_DOMAINS: readonly LayaDomain[] = ["numeric", "engineering"];

/**
 * 问题规格 —— 与 laya `RLAgent.predict(state, questions)` 的真实入参同形：
 * questions 是**以 key 索引的对象**，不是字符串数组（传数组会 `AttributeError: 'list' object has no attribute 'keys'`）。
 * 真库契约（laya/agent.py `_check_question`，2026-09-25 对照源码确认）：**每道题都必须带
 * `instructions`**；choice 的选项字段叫 **`criteria`**（label→描述 的 dict，或 label 列表）——
 * 早期类型写成 `options` 且 choice 只在 fake runner 单测里跑过、从未过真模型，首次实跑即
 * 被 `ValueError` 打回。裁决逻辑读的 `probabilities` 以 criteria 的 label 为键。
 */
export type LayaQuestion =
  | { type: "choice"; criteria: Record<string, string> | string[]; instructions: string }
  | { type: "score"; criteria: string[]; instructions: string }
  | { type: "noul"; instructions: string; criteria?: Record<string, string> };

export interface LayaAnswer {
  type: "choice" | "score" | "noul";
  probabilities?: Record<string, number>;
  noul?: number;
  score?: number;
}

/** 动作的爆炸半径（与 scripts/laya 侧登记表同一分档）。后两档不得自动执行。 */
export type BlastRadius = "local_reversible" | "preauthorized_spend" | "external_write" | "destructive";
export const ESCALABLE_RADII: readonly BlastRadius[] = ["external_write", "destructive"];

export interface LayaDecision {
  id: string;
  domain: LayaDomain;
  questions: Record<string, LayaQuestion>;
  /**
   * 选项 → 爆炸半径。**按选项登记，不按问题登记**：一道题里有不可逆选项，
   * 不代表模型选中的那个不可逆。未登记的选项按未知动作处理 ⇒ 升级。
   * 同一决策内各 choice 题的选项名不得重名（半径按选项名索引）。
   */
  optionBlastRadius?: Record<string, BlastRadius>;
  /**
   * 纯 noul/score 题没有"选项"可登记，于是按**该决策闸住的动作本身**登记半径。
   * 两者都缺 ⇒ 无从判定可逆性 ⇒ 一律升级；剥掉 noul 的裁定权不能把这类决策变成没有闸门。
   */
  actionBlastRadius?: BlastRadius;
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
  /** 判定的**成因**：AUTO 时为空。 */
  reasons: string[];
  /** 交叉核对痕迹（如 noul 与登记表不一致）：只记录，不参与裁定。 */
  notes?: string[];
  chosen?: string;
  margin?: number;
}

export interface LayaThresholds {
  marginMin: number;
  /** noul 的交叉核对线：越过它且与登记表结论不一致时留痕，不据此升级。 */
  noulCrossCheck: number;
}

export const DEFAULT_THRESHOLDS: LayaThresholds = { marginMin: 0.15, noulCrossCheck: 0.5 };

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
      const notes: string[] = [];
      let auto = true;
      let chosen: string | undefined;
      let margin: number | undefined;
      const nouls: Array<{ q: string; v: number }> = [];

      if (NON_DELEGABLE_DOMAINS.includes(dec.domain)) {
        return {
          id: dec.id,
          verdict: "ESCALATE" as const,
          reasons: [`领域 ${dec.domain} 不可委托给 Laya（实测不做数值/工程推理）`],
        };
      }

      const answers = answersByDecision[dec.id] ?? {};
      for (const q of Object.keys(dec.questions)) {
        const r = answers[q];
        if (!r) {
          auto = false;
          reasons.push(`${q}: 模型未作答`);
          continue;
        }
        if (r.type === "choice" && r.probabilities) {
          const top = Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]);
          chosen = top[0]?.[0];
          margin = (top[0]?.[1] ?? 0) - (top[1]?.[1] ?? 0);
          if (chosen && dec.forbiddenAuto?.includes(chosen)) {
            auto = false;
            reasons.push(`${q}: 选中 ${chosen} 在 forbiddenAuto 清单内`);
          }
          if (margin < th.marginMin) {
            auto = false;
            reasons.push(`${q}: margin ${margin.toFixed(3)} < ${th.marginMin}`);
          }
        } else if (r.type === "noul") {
          nouls.push({ q, v: r.noul ?? 0 });
        }
      }

      // 半径按「这次真正要执行的东西」取：选中了选项就按选项登记，没有选项
      // （纯 noul/score 题）就按该决策所闸住的动作登记。两者都没登记 ⇒ 升级，
      // 因为登记表是唯一依据 —— 未知动作不允许自动执行。
      const radius = chosen ? dec.optionBlastRadius?.[chosen] : dec.actionBlastRadius;
      if (!radius) {
        auto = false;
        reasons.push(chosen
          ? `选中 ${chosen} 未登记爆炸半径（未知动作不自动执行）`
          : "该决策未登记 actionBlastRadius（无半径即无从判定可逆性）");
      } else if (ESCALABLE_RADII.includes(radius)) {
        auto = false;
        reasons.push(`${chosen ? `选中 ${chosen}` : "该动作"} 半径=${radius} ⇒ 外写/不可逆`);
      }

      // noul 与爆炸半径实测分不开（Spearman +0.41、min(tier3)<max(tier0)），拿它裁定
      // 等于给闸门加常数（一切都升级、自动化归零）。这里只做交叉核对：不一致就留痕，不改裁定。
      const escalable = radius !== undefined && ESCALABLE_RADII.includes(radius);
      for (const { q, v } of nouls) {
        if (v > th.noulCrossCheck && !escalable) {
          notes.push(`${q}: noul ${v.toFixed(3)} 高，但登记表半径=${radius ?? "未登记"}（可逆侧）— 以登记表为准`);
        } else if (v <= th.noulCrossCheck && escalable) {
          notes.push(`${q}: noul ${v.toFixed(3)} 低，但登记表半径=${radius}（外写/不可逆）— 以登记表为准`);
        }
      }

      return {
        id: dec.id,
        verdict: (auto ? "AUTO" : "ESCALATE") as TriageResult["verdict"],
        reasons,
        ...(notes.length ? { notes } : {}),
        chosen,
        margin,
      };
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
 * Linux 原生 runner：在 bun 与 Laya venv 同机的 Linux 上直接调 python，
 * 不经 wsl.exe。与 WSL runner 逐参数同形（同一 laya_gate.py、同一 --stdin-json 协议），
 * 只有进程拉起方式不同 —— 换机只换 runner，不换裁定层。
 */
export interface LocalLayaRunnerOptions {
  python?: string;
  script?: string;
  repoRoot?: string;
  timeoutMs?: number;
}

export function createLocalLayaRunner(opts: LocalLayaRunnerOptions = {}) {
  const python = readString("LAYA_PYTHON", opts.python ?? "/root/.venvs/laya/bin/python");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const scriptRel = opts.script ?? path.join("scripts", "laya", "laya_gate.py");
  const scriptAbs = path.resolve(repoRoot, scriptRel);

  return async (spec: LayaGateSpec): Promise<Record<string, Record<string, LayaAnswer>>> => {
    if (!existsSync(scriptAbs)) throw new Error(`缺少 ${scriptRel}`);

    const proc = Bun.spawn([python, scriptAbs, "--stdin-json"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
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

/** 平台 → runner 种类。Windows 走 WSL，其余（Linux/macOS）走本机 python。 */
export function selectRunnerKind(platform: string = process.platform): "wsl" | "local" {
  return platform === "win32" ? "wsl" : "local";
}

/**
 * 按当前平台选生产 runner；LAYA_DECISION_URL 已配置时**优先走 HTTP 服务 runner**
 * （多语言决策收拢 TS，不依赖 python venv/WSL/本地权重；2026-09-28）。
 * 测试用 platform 参数固定分支。
 */
export function createPlatformLayaRunner(
  opts: WslLayaRunnerOptions & LocalLayaRunnerOptions & HttpLayaRunnerOptions & { platform?: string } = {},
) {
  const httpConfigured = opts.baseUrl !== undefined ? opts.baseUrl !== "" : readString("LAYA_DECISION_URL", "") !== "";
  if (httpConfigured) return createHttpLayaRunner(opts);
  return selectRunnerKind(opts.platform) === "wsl"
    ? createWslLayaRunner(opts)
    : createLocalLayaRunner(opts);
}

/**
 * HTTP 服务 runner：内网 Laya 决策服务（multilingual，契约见
 * ~/.axiom/axiom-secrets/laya-service.contract.md，基址按规则 11 经 env 读取）。
 * 与 python runner 逐参数同形——同一 LayaGateSpec 入、同一 {decisionId: {question: answer}} 出，
 * 裁定层与失败方向（runner 抛错 ⇒ UNAVAILABLE，绝不退化 AUTO）完全不变。
 * state 为结构化上下文 ⇒ JSON 序列化成契约要求的文本；choice/score 的 criteria 归一为标签数组。
 */
export interface HttpLayaRunnerOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
}

export function createHttpLayaRunner(opts: HttpLayaRunnerOptions = {}) {
  return async (spec: LayaGateSpec): Promise<Record<string, Record<string, LayaAnswer>>> => {
    const { layaDecideBatch } = await import("./laya-http.js");
    const items = spec.decisions.map((d) => ({
      id: d.id,
      state: JSON.stringify(spec.state ?? {}),
      questions: Object.fromEntries(
        Object.entries(d.questions).map(([q, qs]) => [
          q,
          qs.type === "noul"
            ? { type: qs.type, instructions: qs.instructions }
            : {
                type: qs.type,
                instructions: qs.instructions,
                criteria: Array.isArray(qs.criteria) ? qs.criteria : Object.keys(qs.criteria),
              },
        ]),
      ),
    }));
    const resp = await layaDecideBatch(
      { items },
      {
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
        ...(opts.timeoutMs ? { batchTimeoutMs: opts.timeoutMs } : {}),
      },
    );
    const failed = resp.results.filter((r) => !r?.ok);
    if (failed.length > 0) {
      // 契约"逐条容错"是批量吞吐层的语义；闸门语义要求**每个决策都有答案**——
      // 缺答案的决策宁可 UNAVAILABLE 也不静默放行 ⇒ 有失败即整体抛错（triage 层统一记 UNAVAILABLE）。
      throw new Error(`Laya HTTP 批量失败 ${failed.length}/${resp.total}：${failed[0]?.error?.slice(0, 120)}`);
    }
    const out: Record<string, Record<string, LayaAnswer>> = {};
    for (const r of resp.results) {
      if (!r.ok || !r.answers) throw new Error(`Laya HTTP 结果缺答案：id=${r.id}`);
      out[r.id] = r.answers;
    }
    return out;
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
  const distro = readString("LAYA_WSL_DISTRO") || opts.distro || "Arch";
  const python = readString("LAYA_PYTHON", "/root/.venvs/laya/bin/python");
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
