/**
 * Agent status and tool routes
 */
import type { RouteContext } from "./types.js";

export async function handleAgentsStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/status" && ctx.req.method === "GET") {
    const { checkOpenCode, OPENCODE_FREE_MODELS } = await import("../agents/opencode-agent.js");
    const { checkHermes } = await import("../agents/hermes-agent.js");
    const { checkKimiCodeApiKey, checkKimiCli, KIMI_CODE_MODEL } = await import("../agents/kimi-code-agent.js");
    const opencodeOk = await checkOpenCode();
    const hermesOk = await checkHermes();
    const kimiApiOk = checkKimiCodeApiKey();
    const kimiCliOk = await checkKimiCli();
    return ctx.jsonResponse({
      opencode: { installed: opencodeOk, freeModels: OPENCODE_FREE_MODELS, cli: "bun run src/cli.ts code:open" },
      hermes: { installed: hermesOk, installGuide: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" },
      kimiCode: { apiKeyConfigured: kimiApiOk, cliInstalled: kimiCliOk, model: KIMI_CODE_MODEL, cli: "bun run src/cli.ts kimi:open" },
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleOpenCodeModels(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/opencode/models" && ctx.req.method === "GET") {
    const { checkOpenCode, listOpenCodeModels, OPENCODE_FREE_MODELS } = await import("../agents/opencode-agent.js");
    const installed = await checkOpenCode();
    const models = installed ? await listOpenCodeModels() : [];
    return ctx.jsonResponse({ installed, freeModels: OPENCODE_FREE_MODELS, models: models.slice(0, 50), total: models.length }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleOpenCodeOpen(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/opencode/open" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const model = body.model || "opencode/deepseek-v4-flash-free";
    const prompt = body.prompt || "";
    return ctx.jsonResponse({
      command: `bun run src/cli.ts code:open ${prompt ? "\"" + prompt + "\" " : ""}--model=${model}`,
      note: "OpenCode 是交互式 TUI 工具，请在终端中运行上述命令。",
      model,
      prompt,
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleKimiStatus(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/kimi/status" && ctx.req.method === "GET") {
    const { checkKimiCodeApiKey, checkKimiCli, KIMI_CODE_MODEL } = await import("../agents/kimi-code-agent.js");
    const apiKeyOk = checkKimiCodeApiKey();
    const cliOk = await checkKimiCli();
    return ctx.jsonResponse({
      apiKeyConfigured: apiKeyOk,
      cliInstalled: cliOk,
      model: KIMI_CODE_MODEL,
      baseUrl: process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1",
      ready: apiKeyOk || cliOk,
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleKimiChat(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/kimi/chat" && ctx.req.method === "POST") {
    const { kimiCodeChat, checkKimiCodeApiKey, getKimiCodeGuide, KIMI_CODE_MODEL } = await import("../agents/kimi-code-agent.js");
    const body = await ctx.req.json();
    if (!checkKimiCodeApiKey()) {
      return ctx.jsonResponse({ error: "KIMI_CODE_API_KEY not configured", guide: getKimiCodeGuide() }, 503, ctx.baseHeaders);
    }
    try {
      const result = await kimiCodeChat({
        messages: body.messages || [
          { role: "system", content: body.system || "You are Kimi Code, an expert programming assistant." },
          { role: "user", content: body.prompt || body.message || "" },
        ],
        temperature: body.temperature ?? 0.7,
        timeout: body.timeout ?? 60000,
      });
      return ctx.jsonResponse({ ...result, model: KIMI_CODE_MODEL }, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

export async function handleKimiOpen(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/kimi/open" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const prompt = body.prompt || "";
    return ctx.jsonResponse({
      command: `bun run src/cli.ts kimi:open ${prompt ? "\"" + prompt + "\" " : ""}`,
      note: "Kimi Code CLI 是交互式 TUI 工具，请在终端中运行上述命令。",
      prompt,
    }, 200, ctx.baseHeaders);
  }
  return null;
}

export async function handleHermesTask(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/hermes/task" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { checkHermes, runHermesTask } = await import("../agents/hermes-agent.js");
    const installed = await checkHermes();
    if (!installed) {
      return ctx.jsonResponse({
        error: "Hermes 未安装",
        installGuide: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"
      }, 503, ctx.baseHeaders);
    }
    const result = await runHermesTask({ prompt: body.prompt || "", cwd: body.cwd, timeoutMs: body.timeoutMs || 300_000 });
    return ctx.jsonResponse({ success: result.success, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }, 200, ctx.baseHeaders);
  }
  return null;
}

// ===== OpenCode 编码任务 API（直接执行，非交互式）=====

export async function handleOpenCodeGenerate(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/opencode/generate" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { executeCodeGenerate } = await import("../agents/opencode-agent.js");
    try {
      const result = await executeCodeGenerate({
        prompt: body.prompt || "",
        language: body.language,
        context: body.context,
        model: body.model,
      });
      return ctx.jsonResponse(result, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

export async function handleOpenCodeRefactor(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/opencode/refactor" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { executeCodeRefactor } = await import("../agents/opencode-agent.js");
    try {
      const result = await executeCodeRefactor({
        code: body.code || "",
        description: body.description || "",
        language: body.language,
      });
      return ctx.jsonResponse(result, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

export async function handleOpenCodeReview(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/opencode/review" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { executeCodeReview } = await import("../agents/opencode-agent.js");
    try {
      const result = await executeCodeReview({
        code: body.code || "",
        language: body.language,
        context: body.context,
      });
      return ctx.jsonResponse(result, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
    }
  }
  return null;
}

export async function handleOpenCodeTest(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname === "/agents/opencode/test" && ctx.req.method === "POST") {
    const body = await ctx.req.json();
    const { executeCodeTest } = await import("../agents/opencode-agent.js");
    try {
      const result = await executeCodeTest({
        code: body.code || "",
        language: body.language,
        framework: body.framework,
      });
      return ctx.jsonResponse(result, 200, ctx.baseHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return ctx.jsonResponse({ error: msg }, 500, ctx.baseHeaders);
    }
  }
  return null;
}
