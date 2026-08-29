/**
 * 外部审核测试集适配层 — 将 external-benchmarks/ 下的 HumanEval / MBPP 桥接到 agent-evals。
 *
 * 与自建 48 任务并存：通过 `--external=human-eval|mbpp` 触发。
 * 验证器为“真实执行测试断言”，比关键词匹配更严格：
 *   - HumanEval：将 Agent 生成的代码拼接到 prompt + test 后运行 Python，exit 0 即通过。
 *   - MBPP：将 Agent 生成的代码 + test_list 运行，exit 0 即通过。
 *
 * 设计：
 * - 不依赖网络；解释器在沙箱容器内解析，默认依次尝试 `python3` / `python`。
 * - 审计 P1-3（2026-08-29）：LLM 生成的代码一律经 SandboxProvider（默认 docker-sandbox，
 *   默认禁网 + 资源限制）执行；沙箱不可用时结果标注 skipped，绝不回退为宿主直跑。
 * - 允许注入 pythonCmd 便于测试/CI 固定沙箱内解释器；可注入 sandbox 提供者便于测试。
 * - verify 为异步（AgentTask.verify 已支持 Promise）。
 */
import fs from "node:fs";
import path from "node:path";
import { dockerSandbox } from "../sandbox/docker-sandbox.js";
import { shellQuoteArg } from "../utils/spawn-env.js";
import type { SandboxOptions, SandboxProvider, SandboxResult } from "../sandbox/types.js";
import type { AgentTask, TaskContext } from "./tasks.js";
import type { VerifyResult } from "./verify.js";

export type ExternalKind = "human-eval" | "mbpp";

export interface ExternalLoadOptions {
  /** 只加载前 N 条（用于快速冒烟/CI） */
  limit?: number;
  /** 沙箱内 Python 解释器命令或 [命令, ...参数]；默认自动尝试 python3 / python */
  pythonCmd?: string | string[];
  /** 审计 P1-3：沙箱提供者（默认 dockerSandbox）；测试可注入 fake */
  sandbox?: SandboxProvider;
}

interface PythonRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** 审计 P1-3：单次评测执行超时（与原直跑语义一致，保持 20s）。 */
const SANDBOX_TIMEOUT_MS = 20_000;
/** 生成的 Python 脚本文件名（落在挂载目录内，容器内经 /workspace 相对引用）。 */
const GENERATED_SCRIPT = "generated_code.py";
/** 脚本运行目录根：项目内 .tmp 下（docker-sandbox 挂载白名单拒绝宿主用户目录首段，如 os.tmpdir）。 */
const RUN_DIR_ROOT = path.resolve(process.cwd(), ".tmp", "external-eval-runs");
/** 容器为 Linux 环境，解释器候选不再区分宿主平台。 */
const DEFAULT_PYTHON_CANDIDATES: string[][] = [["python3"], ["python"]];

function resolveSandbox(sandbox?: SandboxProvider): SandboxProvider {
  return sandbox ?? dockerSandbox;
}

/** 构造沙箱命令：解释器 + 脚本（POSIX 单引号包裹——容器恒为 Linux；脚本内容在文件内，命令面无注入面）。 */
function buildSandboxCommand(cmd: string[]): string {
  return [...cmd, GENERATED_SCRIPT].map((a) => shellQuoteArg(a, "linux")).join(" ");
}

/** 解释器缺失判定：容器内无该解释器（127 / not found / ENOENT）→ 尝试下一候选。 */
function isInterpreterMissing(res: SandboxResult): boolean {
  const text = `${res.stderr}\n${res.error ?? ""}`;
  return res.exitCode === 127 || /not found|enoent|no such file/i.test(text);
}

/** 运行一段 Python 代码（写入挂载目录后经沙箱执行），带 20s 超时保护。 */
async function runPython(
  code: string,
  pythonCmd: string | string[] | undefined,
  sandbox: SandboxProvider,
): Promise<PythonRunResult> {
  // 审计 P1-3：沙箱不可用 → skipped（fail-closed），绝不回退宿主直跑。
  if (!(await sandbox.available())) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: `skipped: ${sandbox.name} sandbox unavailable — model-generated code is not executed on the host`,
    };
  }
  const runDir = path.join(RUN_DIR_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, GENERATED_SCRIPT), code, "utf8");

  try {
    const candidates: string[][] = pythonCmd
      ? (Array.isArray(pythonCmd) ? [pythonCmd] : [[pythonCmd]])
      : DEFAULT_PYTHON_CANDIDATES;
    let lastError = "";
    for (const cmd of candidates) {
      const opts: SandboxOptions = {
        command: buildSandboxCommand(cmd),
        cwd: runDir,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        networkAccess: false,
      };
      const result = await sandbox.execute(opts);
      if (result.exitCode === 0) {
        return { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      }
      // 解释器缺失时继续尝试下一个候选；非零退出（语法/断言失败）则直接返回
      if (isInterpreterMissing(result)) {
        lastError = result.stderr || result.error || lastError;
        continue;
      }
      return { ok: false, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr || result.error || "" };
    }
    return { ok: false, exitCode: null, stdout: "", stderr: lastError || "no python interpreter available" };
  } finally {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 从模型输出中提取 Python 代码：优先代码块，其次全文。 */
export function extractPythonCode(text: string): string {
  const fence = text.match(/```(?:python)?\s*\n?([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return text.trim();
}

function makeHumanEvalVerify(raw: { prompt: string; test: string; entry_point?: string }, options: ExternalLoadOptions) {
  return async (_response: string, _ctx?: TaskContext): Promise<VerifyResult> => {
    const code = extractPythonCode(_response);
    const full = `${raw.prompt}\n${code}\n${raw.test}`;
    const result = await runPython(full, options.pythonCmd, resolveSandbox(options.sandbox));
    if (result.ok) return { passed: true };
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return { passed: false, reason: detail || `python exit ${result.exitCode ?? "unknown"}` };
  };
}

function makeMbppVerify(raw: { test_setup_code?: string; test_list: string[] }, options: ExternalLoadOptions) {
  return async (_response: string, _ctx?: TaskContext): Promise<VerifyResult> => {
    const code = extractPythonCode(_response);
    const tests = raw.test_list.join("\n");
    const full = [raw.test_setup_code, code, tests].filter(Boolean).join("\n");
    const result = await runPython(full, options.pythonCmd, resolveSandbox(options.sandbox));
    if (result.ok) return { passed: true };
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return { passed: false, reason: detail || `python exit ${result.exitCode ?? "unknown"}` };
  };
}

function toHumanEvalTask(raw: Record<string, unknown>, options: ExternalLoadOptions): AgentTask {
  const id = String(raw.task_id ?? `HE-${Math.random().toString(36).slice(2)}`);
  const prompt = String(raw.prompt ?? "");
  const test = String(raw.test ?? "");
  return {
    id: `HE-${id}`,
    family: "coding",
    split: "held-out",
    title: `HumanEval ${id}`,
    prompt: `请补全以下 Python 函数。只输出可运行的 Python 代码，不要额外解释，不要重复函数签名（直接补全函数体）。\n\n${prompt}`,
    verify: makeHumanEvalVerify({ prompt, test, entry_point: raw.entry_point as string | undefined }, options),
    maxTokens: 1024,
  };
}

function toMbppTask(raw: Record<string, unknown>, options: ExternalLoadOptions): AgentTask {
  const id = String(raw.task_id ?? `MBPP-${Math.random().toString(36).slice(2)}`);
  const text = String(raw.text ?? "");
  const testList = Array.isArray(raw.test_list) ? (raw.test_list as unknown[]).map(String) : [];
  const testSetup = typeof raw.test_setup_code === "string" ? raw.test_setup_code : undefined;
  return {
    id: `MBPP-${id}`,
    family: "coding",
    split: "held-out",
    title: `MBPP ${id}`,
    prompt: `根据以下描述编写 Python 函数。只输出可运行的 Python 代码，不要额外解释。\n\n${text}`,
    verify: makeMbppVerify({ test_setup_code: testSetup, test_list: testList }, options),
    maxTokens: 1024,
  };
}

/** 加载外部基准为 AgentTask[]。 */
export function loadExternalTasks(kind: ExternalKind, options: ExternalLoadOptions = {}): AgentTask[] {
  const fileName = kind === "human-eval" ? "HumanEval.jsonl" : "mbpp.jsonl";
  const file = path.resolve(process.cwd(), "external-benchmarks", fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`外部基准文件不存在: ${file}（请确认 external-benchmarks/ 已就绪）`);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const tasks: AgentTask[] = [];
  for (const line of lines) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 跳过损坏行，保持解析健壮
    }
    tasks.push(kind === "human-eval" ? toHumanEvalTask(raw, options) : toMbppTask(raw, options));
    if (options.limit && tasks.length >= options.limit) break;
  }
  return tasks;
}
