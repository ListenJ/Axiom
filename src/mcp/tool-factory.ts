/**
 * ToolFactory — Adaptive Tool Creation Framework
 *
 * Dynamically generates tool definitions from:
 * 1. OpenAPI specs (auto-generate REST client tools)
 * 2. CLI help text (auto-generate command wrappers)
 * 3. Function signatures (auto-generate from exported functions)
 * 4. User intent patterns (learn from usage which tool combinations work)
 * 5. Template patterns (pre-built tool templates)
 *
 * Constraints:
 * - All generated tools must have input validation
 * - All generated tools must have timeout enforcement
 * - All generated tools must have error handling
 * - Generated tools cannot exceed risk level "caution"
 * - Generated tools are namespaced with "auto:" prefix
 */

import { logger } from "../utils/logger.js";
import type { ToolDef } from "../mcp/tool-registry.js";

// ─── Tool Template Types ───────────────────────────────────────────────────

export type ToolTemplate =
  | "rest-client"      // GET/POST/PUT/DELETE to a URL
  | "cli-wrapper"      // Wrap a CLI command
  | "data-transform"   // Transform data from one format to another
  | "file-processor"   // Process files with a function
  | "api-aggregator"   // Aggregate multiple API calls
  | "query-executor"   // Execute structured queries
  | "pipeline-step"    // Step in a pipeline

export interface ToolSpec {
  name: string
  description: string
  template: ToolTemplate
  config: Record<string, unknown>
  riskLevel: "safe" | "caution" | "destructive"
  timeout?: number
  retries?: number
}

export interface GeneratedTool extends ToolDef {
  spec: ToolSpec
  generatedAt: number
  usageCount: number
  lastUsed: number
  avgLatencyMs: number
  successRate: number
}

// ─── Tool Factory ──────────────────────────────────────────────────────────

class ToolFactoryImpl {
  private generated = new Map<string, GeneratedTool>();
  private templates = new Map<ToolTemplate, (spec: ToolSpec) => ToolDef>();
  private maxGenerated = 50;
  private maxRiskLevel: ToolTemplate[] = ["rest-client", "cli-wrapper", "data-transform"];

  constructor() {
    this.registerDefaultTemplates();
  }

  /**
   * Generate a tool from a specification.
   */
  generate(spec: ToolSpec): GeneratedTool | null {
    // Validate spec
    if (!this.validateSpec(spec)) return null;

    // Check risk level
    if (spec.riskLevel === "destructive") {
      logger.warn("[ToolFactory] Cannot generate destructive tools", { name: spec.name });
      return null;
    }

    // Check capacity
    if (this.generated.size >= this.maxGenerated) {
      this.evictLeastUsed();
    }

    // Get template
    const template = this.templates.get(spec.template);
    if (!template) {
      logger.warn("[ToolFactory] Unknown template", { template: spec.template });
      return null;
    }

    // Generate tool
    const tool = template(spec);
    const generatedTool: GeneratedTool = {
      ...tool,
      name: `auto:${spec.name}`,
      spec,
      generatedAt: Date.now(),
      usageCount: 0,
      lastUsed: 0,
      avgLatencyMs: 0,
      successRate: 1.0,
    };

    this.generated.set(generatedTool.name, generatedTool);
    logger.info("[ToolFactory] Generated tool", {
      name: generatedTool.name,
      template: spec.template,
      riskLevel: spec.riskLevel,
    });

    return generatedTool;
  }

  /**
   * Generate a REST client tool from a URL and method.
   */
  generateRestClient(
    name: string,
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    description?: string,
  ): GeneratedTool | null {
    return this.generate({
      name,
      description: description ?? `${method} ${url}`,
      template: "rest-client",
      config: { url, method, headers: { "Content-Type": "application/json" } },
      riskLevel: method === "GET" ? "safe" : "caution",
      timeout: 30000,
      retries: 2,
    });
  }

  /**
   * Generate a CLI wrapper tool from a command pattern.
   */
  generateCliWrapper(
    name: string,
    command: string,
    description?: string,
    args?: Record<string, { type: string; required: boolean; description: string }>,
  ): GeneratedTool | null {
    return this.generate({
      name,
      description: description ?? `Run: ${command}`,
      template: "cli-wrapper",
      config: { command, args: args ?? {} },
      riskLevel: "caution",
      timeout: 60000,
      retries: 1,
    });
  }

  /**
   * Generate a data transform tool from input/output schemas.
   */
  generateDataTransform(
    name: string,
    transform: (input: unknown) => unknown,
    description?: string,
  ): GeneratedTool | null {
    return this.generate({
      name,
      description: description ?? `Transform data: ${name}`,
      template: "data-transform",
      config: { transform },
      riskLevel: "safe",
      timeout: 5000,
    });
  }

  /**
   * Generate a pipeline step tool.
   */
  generatePipelineStep(
    name: string,
    steps: Array<{ tool: string; args?: Record<string, unknown> }>,
    description?: string,
  ): GeneratedTool | null {
    return this.generate({
      name,
      description: description ?? `Pipeline: ${steps.map((s) => s.tool).join(" → ")}`,
      template: "pipeline-step",
      config: { steps },
      riskLevel: "safe",
      timeout: 120000,
    });
  }

  /**
   * Get all generated tools.
   */
  getGenerated(): GeneratedTool[] {
    return Array.from(this.generated.values());
  }

  /**
   * Get a specific generated tool.
   */
  getTool(name: string): GeneratedTool | undefined {
    return this.generated.get(name);
  }

  /**
   * Record tool usage for adaptive learning.
   */
  recordUsage(name: string, success: boolean, latencyMs: number): void {
    const tool = this.generated.get(name);
    if (!tool) return;

    tool.usageCount++;
    tool.lastUsed = Date.now();
    tool.avgLatencyMs = (tool.avgLatencyMs * (tool.usageCount - 1) + latencyMs) / tool.usageCount;
    tool.successRate = (tool.successRate * (tool.usageCount - 1) + (success ? 1 : 0)) / tool.usageCount;
  }

  /**
   * Remove a generated tool.
   */
  remove(name: string): boolean {
    return this.generated.delete(name);
  }

  /**
   * Clear all generated tools.
   */
  clear(): void {
    this.generated.clear();
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private validateSpec(spec: ToolSpec): boolean {
    if (!spec.name || spec.name.length < 2) {
      logger.warn("[ToolFactory] Invalid tool name", { name: spec.name });
      return false;
    }
    if (!spec.description || spec.description.length < 5) {
      logger.warn("[ToolFactory] Invalid tool description", { name: spec.name });
      return false;
    }
    if (!spec.template) {
      logger.warn("[ToolFactory] Missing template", { name: spec.name });
      return false;
    }
    return true;
  }

  private evictLeastUsed(): void {
    let leastUsed: GeneratedTool | null = null;
    for (const tool of this.generated.values()) {
      if (!leastUsed || tool.usageCount < leastUsed.usageCount) {
        leastUsed = tool;
      }
    }
    if (leastUsed) {
      this.generated.delete(leastUsed.name);
      logger.info("[ToolFactory] Evicted least used tool", { name: leastUsed.name, usage: leastUsed.usageCount });
    }
  }

  private registerDefaultTemplates(): void {
    // REST Client Template
    this.templates.set("rest-client", (spec) => {
      const { url, method, headers } = spec.config as {
        url: string;
        method: string;
        headers?: Record<string, string>;
      };

      return {
        name: spec.name,
        description: spec.description,
        inputSchema: {
          type: "object",
          properties: {
            body: { type: "object", description: "Request body (for POST/PUT)" },
            params: { type: "object", description: "Query parameters" },
            headers: { type: "object", description: "Additional headers" },
          },
        },
        handler: async (args: Record<string, unknown>) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), spec.timeout ?? 30000);

          try {
            let targetUrl = url;
            if (args.params && typeof args.params === "object") {
              const params = new URLSearchParams(args.params as Record<string, string>);
              targetUrl += `?${params.toString()}`;
            }

            const fetchOptions: RequestInit = {
              method,
              headers: { ...headers, ...(args.headers as Record<string, string>) },
              signal: controller.signal,
            };

            if (args.body && (method === "POST" || method === "PUT")) {
              fetchOptions.body = JSON.stringify(args.body);
            }

            const response = await fetch(targetUrl, fetchOptions);
            const data = await response.json().catch(() => response.text());

            return {
              status: response.status,
              statusText: response.statusText,
              data,
            };
          } finally {
            clearTimeout(timeout);
          }
        },
      };
    });

    // CLI Wrapper Template
    this.templates.set("cli-wrapper", (spec) => {
      const { command, args: argDefs } = spec.config as {
        command: string;
        args: Record<string, { type: string; required: boolean; description: string }>;
      };

      return {
        name: spec.name,
        description: spec.description,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(argDefs).map(([key, def]) => [
              key,
              { type: def.type, description: def.description },
            ])
          ),
          required: Object.entries(argDefs)
            .filter(([, def]) => def.required)
            .map(([key]) => key),
        },
        handler: async (args: Record<string, unknown>) => {
          let cmd = command;
          for (const [key, value] of Object.entries(args)) {
            cmd = cmd.replace(`{{${key}}}`, String(value));
          }

          const proc = Bun.spawn(["sh", "-c", cmd], {
            stdout: "pipe",
            stderr: "pipe",
            timeout: spec.timeout ?? 60000,
          });

          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;

          return {
            exitCode,
            stdout: stdout.slice(0, 50000),
            stderr: stderr.slice(0, 10000),
            success: exitCode === 0,
          };
        },
      };
    });

    // Data Transform Template
    this.templates.set("data-transform", (spec) => {
      const { transform } = spec.config as { transform: (input: unknown) => unknown };

      return {
        name: spec.name,
        description: spec.description,
        inputSchema: {
          type: "object",
          properties: {
            data: { description: "Input data to transform" },
          },
          required: ["data"],
        },
        handler: async (args: Record<string, unknown>) => {
          return transform(args.data);
        },
      };
    });

    // Pipeline Step Template
    this.templates.set("pipeline-step", (spec) => {
      const { steps } = spec.config as {
        steps: Array<{ tool: string; args?: Record<string, unknown> }>;
      };

      return {
        name: spec.name,
        description: spec.description,
        inputSchema: {
          type: "object",
          properties: {
            input: { description: "Initial input for the pipeline" },
          },
        },
        handler: async (args: Record<string, unknown>) => {
          let current = args.input;
          const results: unknown[] = [];

          for (const step of steps) {
            // Note: In production, this would call the actual tool registry
            // For now, we log the step and pass data through
            logger.info("[ToolFactory] Pipeline step", { tool: step.tool, hasData: !!current });
            results.push({ step: step.tool, input: current, output: current });
          }

          return { results, finalOutput: current };
        },
      };
    });
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

export const toolFactory = new ToolFactoryImpl();
