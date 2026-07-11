import { spawn } from "bun";
import { logger } from "../../utils/logger.js";
import { router, type ChatMessage } from "../../services/index.js";
import {
  type TaskType,
  type ExecutionStrategy,
  type OpenCodeToolResult,
  type ModelRuntimeState,
  type ComplexityAssessment,
  DEFAULT_OPEN_CODE_MODEL,
  OPENCODE_FREE_MODELS,
  stripAnsi,
  estimateTokenSaved,
  checkCircuitBreaker,
  mapTaskTypeToRole,
} from "./types.js";

export class CodegenExecutor {
  constructor(
    private modelStates: Map<string, ModelRuntimeState>,
    private cwd: string,
    private selectNextModel: () => string,
  ) {}

  async callOpenCode(
    prompt: string,
    model: string,
    timeoutMs = 30000
  ): Promise<{ content: string; model: string; latencyMs: number }> {
    const startTime = Date.now();
    const state = this.modelStates.get(model)!;

    if (!state.sem.tryAcquire()) {
      state.droppedStarts++;
      state.totalCalls++;
      throw new Error(`[OpenCodeToolAgent] model ${model} is at capacity (active=${state.sem.active}/${state.sem.permits}, rpm=${state.sem.currentRpm}/${state.sem.rpm})`);
    }
    state.totalCalls++;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const proc = spawn({
        cmd: ["opencode", "run", "--model", model, "--pure", prompt],
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.cwd,
        env: { ...process.env },
      });

      const textDecoder = new TextDecoder();
      let output = "";
      let stderr = "";

      const stdoutReader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          output += textDecoder.decode(value, { stream: true });
        }
      } finally {
        stdoutReader.releaseLock();
      }

      const stderrReader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          stderr += textDecoder.decode(value, { stream: true });
        }
      } finally {
        stderrReader.releaseLock();
      }

      const exitCode = await proc.exited;
      clearTimeout(timer);

      const latencyMs = Date.now() - startTime;
      state.sem.tryRelease();

      if (exitCode !== 0 && !output) {
        state.consecutiveFailures++;
        checkCircuitBreaker(model, state);
        throw new Error(`OpenCode exited with code ${exitCode}: ${stderr}`);
      }

      state.consecutiveFailures = 0;
      state.latencyHistory.push(latencyMs);
      if (state.latencyHistory.length > 10) state.latencyHistory.shift();

      const cleaned = stripAnsi(output || stderr);

      return { content: cleaned, model, latencyMs };
    } catch (error) {
      clearTimeout(timer);
      state.sem.tryRelease();
      state.consecutiveFailures++;
      state.totalFailures++;
      checkCircuitBreaker(model, state);
      throw error;
    }
  }

  async callAxiom(
    prompt: string,
    taskType: TaskType
  ): Promise<{ content: string; model: string; provider: string }> {
    const role = mapTaskTypeToRole(taskType);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ];

    const result = await router.execute({ role, messages, trackAs: taskType });

    return {
      content: result.content || "",
      model: result.model,
      provider: result.provider,
    };
  }

  async runOpenCodeOnly(
    prompt: string,
    options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const model = options?.model ?? this.selectNextModel();
    const result = await this.callOpenCode(prompt, model, options?.timeoutMs);

    return {
      content: result.content,
      model: result.model,
      provider: "opencode",
      strategy: "opencode-only",
      latencyMs: result.latencyMs,
      tokenSaved: estimateTokenSaved(prompt, result.content),
      fallbackUsed: false,
      contextInjected: prompt.length > 500,
      toolsUsed: [],
    };
  }

  async runParallel(
    prompt: string,
    taskType: TaskType,
    options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const model = this.selectNextModel();

    const opencodePromise = this.callOpenCode(prompt, model, options?.timeoutMs ?? 30000)
      .then((r): { source: "opencode"; result: typeof r } => ({ source: "opencode", result: r }))
      .catch((err): { source: "opencode"; result: { content: string; model: string; latencyMs: number; error?: string } } => ({
        source: "opencode",
        result: { content: "", model, latencyMs: 0, error: err.message },
      }));

    const axiomPromise = this.callAxiom(prompt, taskType)
      .then((r): { source: "axiom"; result: typeof r } => ({ source: "axiom", result: r }))
      .catch((err): { source: "axiom"; result: { content: string; model: string; provider: string; latencyMs: number; error?: string } } => ({
        source: "axiom",
        result: { content: "", model: "", provider: "", latencyMs: 0, error: err.message },
      }));

    const winner = await Promise.race([opencodePromise, axiomPromise]);

    if (winner.source === "opencode" && winner.result.content) {
      const latencyMs = Date.now() - startTime;
      return {
        content: winner.result.content,
        model: winner.result.model,
        provider: "opencode",
        strategy: "parallel",
        latencyMs,
        tokenSaved: estimateTokenSaved(prompt, winner.result.content),
        fallbackUsed: false,
        contextInjected: true,
        toolsUsed: [],
      };
    }

    const settled = await Promise.allSettled([opencodePromise, axiomPromise]);

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.result.content && !("error" in s.value.result)) {
        return {
          content: s.value.result.content,
          model: s.value.result.model,
          provider: s.value.source === "opencode" ? "opencode" : s.value.result.provider || "axiom",
          strategy: "parallel",
          latencyMs: Date.now() - startTime,
          tokenSaved: s.value.source === "opencode" ? estimateTokenSaved(prompt, s.value.result.content) : 0,
          fallbackUsed: s.value.source !== "opencode",
          contextInjected: true,
          toolsUsed: [],
        };
      }
    }

    return {
      content: "[System] All execution paths failed for this task.",
      model: "degraded",
      provider: "local",
      strategy: "parallel",
      latencyMs: Date.now() - startTime,
      tokenSaved: 0,
      fallbackUsed: true,
      contextInjected: true,
      toolsUsed: [],
    };
  }

  async runOpenCodePrimary(
    prompt: string,
    taskType: TaskType,
    options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const model = this.selectNextModel();

    try {
      const ocResult = await this.callOpenCode(prompt, model, options?.timeoutMs ?? 30000);
      return {
        content: ocResult.content,
        model: ocResult.model,
        provider: "opencode",
        strategy: "opencode-primary",
        latencyMs: Date.now() - startTime,
        tokenSaved: estimateTokenSaved(prompt, ocResult.content),
        fallbackUsed: false,
        contextInjected: true,
        toolsUsed: [],
      };
    } catch (error) {
      logger.warn("[OpenCodeToolAgent] OpenCode failed, falling back to Axiom", {
        model,
        error: error instanceof Error ? error.message : String(error),
      });

      const axResult = await this.callAxiom(prompt, taskType);
      return {
        content: axResult.content,
        model: axResult.model,
        provider: axResult.provider,
        strategy: "opencode-primary",
        latencyMs: Date.now() - startTime,
        tokenSaved: 0,
        fallbackUsed: true,
        contextInjected: true,
        toolsUsed: [],
      };
    }
  }

  async runAxiomOnly(
    prompt: string,
    taskType: TaskType,
    _options?: { model?: string; timeoutMs?: number }
  ): Promise<OpenCodeToolResult> {
    const startTime = Date.now();
    const result = await this.callAxiom(prompt, taskType);

    return {
      content: result.content,
      model: result.model,
      provider: result.provider,
      strategy: "axiom-only",
      latencyMs: Date.now() - startTime,
      tokenSaved: 0,
      fallbackUsed: false,
      contextInjected: true,
      toolsUsed: [],
    };
  }
}
