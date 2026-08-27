/**
 * 外部审核测试集适配层 — 将 external-benchmarks/ 下的 HumanEval / MBPP 桥接到 agent-evals。
 *
 * 与自建 48 任务并存：通过 `--external=human-eval|mbpp` 触发。
 * 验证器为“真实执行测试断言”，比关键词匹配更严格：
 *   - HumanEval：将 Agent 生成的代码拼接到 prompt + test 后运行 Python，exit 0 即通过。
 *   - MBPP：将 Agent 生成的代码 + test_list 运行，exit 0 即通过。
 *
 * 设计：
 * - 不依赖网络；Python 解释器默认依次尝试 `python3` / `python`。
 * - 允许注入 pythonCmd 便于测试/CI 固定解释器。
 * - verify 为异步（AgentTask.verify 已支持 Promise）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentTask, TaskContext } from "./tasks.js";
import type { VerifyResult } from "./verify.js";

export type ExternalKind = "human-eval" | "mbpp";

export interface ExternalLoadOptions {
  /** 只加载前 N 条（用于快速冒烟/CI） */
  limit?: number;
  /** Python 解释器命令或 [命令, ...参数]；默认自动尝试 python3 / python */
  pythonCmd?: string | string[];
}

interface PythonRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** 运行一段 Python 代码（写入临时文件后执行），带超时保护。 */
function runPython(code: string, pythonCmd?: string | string[]): Promise<PythonRunResult> {
  const candidates: string[][] = pythonCmd
    ? (Array.isArray(pythonCmd) ? [pythonCmd] : [[pythonCmd]])
    : (process.platform === "win32" ? [["python"], ["python3"]] : [["python3"], ["python"]]);
  const tmp = path.join(os.tmpdir(), `axiom-external-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(tmp, code, "utf8");

  function execOne(cmd: string[]): Promise<PythonRunResult> {
    return new Promise((resolve) => {
      let settled = false;
      const [bin, ...args] = cmd;
      const child = spawn(bin, [...args, tmp], {
        windowsHide: true,
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          resolve({ ok: false, exitCode: null, stdout, stderr: `${cmd} timed out after 20s` });
        }
      }, 20_000);
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, exitCode: null, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code, stdout, stderr });
      });
    });
  }

  return (async () => {
    try {
      let lastError = "";
      for (const cmd of candidates) {
        const result = await execOne(cmd);
        // 命令不存在（error 事件）时继续尝试下一个；运行成功或非零退出（语法/断言失败）则直接返回
        if (result.exitCode !== null || result.stderr.includes("ENOENT") || result.stderr.includes("not found")) {
          if (result.exitCode === null && (result.stderr.includes("ENOENT") || result.stderr.includes("not found"))) {
            lastError = result.stderr;
            continue;
          }
          return result;
        }
        lastError = result.stderr;
      }
      return { ok: false, exitCode: null, stdout: "", stderr: lastError || "no python interpreter available" };
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  })();
}

/** 从模型输出中提取 Python 代码：优先代码块，其次全文。 */
export function extractPythonCode(text: string): string {
  const fence = text.match(/```(?:python)?\s*\n?([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return text.trim();
}

function makeHumanEvalVerify(raw: { prompt: string; test: string; entry_point?: string }, pythonCmd?: string | string[]) {
  return async (_response: string, _ctx?: TaskContext): Promise<VerifyResult> => {
    const code = extractPythonCode(_response);
    const full = `${raw.prompt}\n${code}\n${raw.test}`;
    const result = await runPython(full, pythonCmd);
    if (result.ok) return { passed: true };
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return { passed: false, reason: detail || `python exit ${result.exitCode ?? "unknown"}` };
  };
}

function makeMbppVerify(raw: { test_setup_code?: string; test_list: string[] }, pythonCmd?: string | string[]) {
  return async (_response: string, _ctx?: TaskContext): Promise<VerifyResult> => {
    const code = extractPythonCode(_response);
    const tests = raw.test_list.join("\n");
    const full = [raw.test_setup_code, code, tests].filter(Boolean).join("\n");
    const result = await runPython(full, pythonCmd);
    if (result.ok) return { passed: true };
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    return { passed: false, reason: detail || `python exit ${result.exitCode ?? "unknown"}` };
  };
}

function toHumanEvalTask(raw: Record<string, unknown>, pythonCmd?: string | string[]): AgentTask {
  const id = String(raw.task_id ?? `HE-${Math.random().toString(36).slice(2)}`);
  const prompt = String(raw.prompt ?? "");
  const test = String(raw.test ?? "");
  return {
    id: `HE-${id}`,
    family: "coding",
    split: "held-out",
    title: `HumanEval ${id}`,
    prompt: `请补全以下 Python 函数。只输出可运行的 Python 代码，不要额外解释，不要重复函数签名（直接补全函数体）。\n\n${prompt}`,
    verify: makeHumanEvalVerify({ prompt, test, entry_point: raw.entry_point as string | undefined }, pythonCmd),
    maxTokens: 1024,
  };
}

function toMbppTask(raw: Record<string, unknown>, pythonCmd?: string | string[]): AgentTask {
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
    verify: makeMbppVerify({ test_setup_code: testSetup, test_list: testList }, pythonCmd),
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
    tasks.push(kind === "human-eval" ? toHumanEvalTask(raw, options.pythonCmd) : toMbppTask(raw, options.pythonCmd));
    if (options.limit && tasks.length >= options.limit) break;
  }
  return tasks;
}
