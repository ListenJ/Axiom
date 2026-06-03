/**
 * VSCode Extension Adapter
 * 
 * Provides integration with Visual Studio Code.
 * Communicates via stdin/stdout JSON-RPC (similar to LSP).
 * 
 * Protocol:
 * - IDE sends: { id, method, params }
 * - Agent responds: { id, result } or { id, error }
 * 
 * Methods:
 * - initialize: Set up connection
 * - analyze: Analyze current file
 * - complete: Get completions at cursor
 * - refactor: Get refactoring suggestions
 * - explain: Explain selected code
 */

import { IdeAdapter, IdeAction, IdeActionResponse, CodeContext, CodeSuggestion } from "../ide-core.js";
import { logger } from "../../utils/logger.js";

interface VSCodeMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface VSCodeResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class VSCodeAdapter implements IdeAdapter {
  readonly name = "vscode";
  readonly supportedLanguages = [
    "typescript", "javascript", "python", "java", "c", "cpp", "csharp",
    "go", "rust", "ruby", "php", "swift", "kotlin", "scala",
    "html", "css", "json", "yaml", "markdown",
  ];

  private connected = false;
  private messageId = 0;
  private pendingRequests = new Map<number, (response: VSCodeResponse) => void>();

  async initialize(): Promise<void> {
    // Set up stdin/stdout communication
    process.stdin.on("data", (data) => {
      this.handleMessage(data.toString());
    });

    this.connected = true;
    logger.info("[VSCodeAdapter] Initialized");
  }

  async handleAction(action: IdeAction): Promise<IdeActionResponse> {
    switch (action.type) {
      case "analyze":
        return this.handleAnalyze(action);
      case "complete":
        return this.handleComplete(action);
      case "refactor":
        return this.handleRefactor(action);
      case "explain":
        return this.handleExplain(action);
      case "fix":
        return this.handleFix(action);
      default:
        return {
          success: false,
          suggestions: [],
          error: `Unknown action type: ${action.type}`,
        };
    }
  }

  async sendSuggestion(suggestion: CodeSuggestion): Promise<void> {
    this.sendMessage({
      id: ++this.messageId,
      method: "showSuggestion",
      params: { suggestion },
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async handleAnalyze(action: IdeAction): Promise<IdeActionResponse> {
    const { idePlugin } = await import("../ide-core.js");
    return idePlugin.handleAction(action);
  }

  private async handleComplete(action: IdeAction): Promise<IdeActionResponse> {
    const { idePlugin } = await import("../ide-core.js");
    return idePlugin.handleAction(action);
  }

  private async handleRefactor(action: IdeAction): Promise<IdeActionResponse> {
    const { idePlugin } = await import("../ide-core.js");
    return idePlugin.handleAction(action);
  }

  private async handleExplain(action: IdeAction): Promise<IdeActionResponse> {
    const context = action.context;
    const selection = context.selection;
    
    if (!selection) {
      return {
        success: false,
        suggestions: [],
        error: "No code selected for explanation",
      };
    }

    // Extract selected code
    const lines = context.content.split("\n");
    const selectedLines = lines.slice(selection.start.line, selection.end.line + 1);
    
    if (selectedLines.length === 0) {
      return {
        success: false,
        suggestions: [],
        error: "Empty selection",
      };
    }

    // Create explanation suggestion
    const explanation: CodeSuggestion = {
      type: "documentation",
      code: selectedLines.join("\n"),
      description: `Explain selected ${context.language} code`,
      confidence: 0.95,
      details: `Selected ${selectedLines.length} line(s) of code`,
    };

    return {
      success: true,
      suggestions: [explanation],
    };
  }

  private async handleFix(action: IdeAction): Promise<IdeActionResponse> {
    const { idePlugin } = await import("../ide-core.js");
    return idePlugin.handleAction(action);
  }

  private handleMessage(data: string): void {
    try {
      const messages = data.split("\n").filter(Boolean);
      for (const msg of messages) {
        const parsed: VSCodeMessage = JSON.parse(msg);
        this.processMessage(parsed);
      }
    } catch (error: any) {
      logger.error("[VSCodeAdapter] Failed to parse message", error);
    }
  }

  private processMessage(message: VSCodeMessage): void {
    logger.debug(`[VSCodeAdapter] Received: ${message.method}`, { id: message.id });

    // Handle request from VSCode
    if (message.method === "initialize") {
      this.sendResponse(message.id, { status: "ok", capabilities: this.getCapabilities() });
    } else if (message.method === "analyze" || message.method === "complete" || 
               message.method === "refactor" || message.method === "explain" || 
               message.method === "fix") {
      this.handleAction({
        type: message.method as any,
        context: message.params?.context as CodeContext,
        params: message.params,
      }).then((result) => {
        this.sendResponse(message.id, result);
      });
    }
  }

  private sendResponse(id: number, result: unknown): void {
    const response: VSCodeResponse = { id, result };
    process.stdout.write(JSON.stringify(response) + "\n");
  }

  private sendMessage(message: VSCodeMessage): void {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  private getCapabilities(): Record<string, unknown> {
    return {
      name: this.name,
      languages: this.supportedLanguages,
      actions: ["analyze", "complete", "refactor", "explain", "fix"],
      features: {
        realtime: true,
        diagnostics: true,
        completions: true,
        refactorings: true,
      },
    };
  }
}
