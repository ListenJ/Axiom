import { logger } from "../../utils/logger.js";
import { readString } from "../../utils/env.js";
import type { TaskRole } from "../../services/index.js";
import { RateLimitedSemaphore } from "../../utils/concurrency/rate-limited-semaphore.js";

export const OPENCODE_FREE_MODELS = [
  { id: "opencode/deepseek-v4-flash-free", rpm: 30, concurrentLimit: 2, context: 128000, priority: 1 },
  { id: "opencode/big-pickle", rpm: 20, concurrentLimit: 2, context: 64000, priority: 2 },
  { id: "opencode/nemotron-3-super-free", rpm: 20, concurrentLimit: 2, context: 128000, priority: 3 },
];

export const DEFAULT_OPEN_CODE_MODEL = readString("OPENCODE_DEFAULT_MODEL", OPENCODE_FREE_MODELS[0].id);

const COMPLEXITY_THRESHOLDS = {
  maxPromptLength: 8000,
  maxContextLines: 200,
  maxFiles: 5,
};

export type TaskType =
  | "code-complete"
  | "code-explain"
  | "file-search"
  | "symbol-search"
  | "quick-fix"
  | "simple-chat"
  | "doc-generate"
  | "test-scaffold";

export type ExecutionStrategy =
  | "opencode-only"
  | "parallel"
  | "opencode-primary"
  | "axiom-only";

export interface OpenCodeToolResult {
  content: string;
  model: string;
  provider: string;
  strategy: ExecutionStrategy;
  latencyMs: number;
  tokenSaved: number;
  fallbackUsed: boolean;
  contextInjected: boolean;
  toolsUsed: string[];
}

export interface ModelRuntimeState {
  sem: RateLimitedSemaphore;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenUntil: number;
  totalCalls: number;
  totalFailures: number;
  droppedStarts: number;
  latencyHistory: number[];
}

export interface ComplexityAssessment {
  score: number;
  taskType: TaskType;
  recommendedStrategy: ExecutionStrategy;
  reasons: string[];
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

export function hashPrompt(prompt: string): string {
  const prefix = prompt.slice(0, 80).replace(/\s+/g, "_");
  return `${prefix}_${prompt.length}`;
}

export function estimateTokenSaved(prompt: string, result: string): number {
  const promptTokens = estimateTokens(prompt);
  return Math.floor(promptTokens * 0.5);
}

export function isCommonWord(word: string): boolean {
  const common = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our",
    "this", "that", "with", "have", "from", "they", "she", "will", "would", "there", "their", "what",
    "about", "which", "when", "make", "like", "time", "just", "know", "take", "people", "year", "good",
    "some", "come", "could", "state", "over", "think", "also", "back", "after", "use", "two", "how",
    "work", "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day",
    "most", "us", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
    "did", "done", "get", "got", "gotten", "go", "went", "gone", "see", "saw", "seen", "come", "came",
    "know", "knew", "known", "take", "took", "taken", "find", "found", "think", "thought", "tell", "told",
    "become", "became", "leave", "left", "feel", "felt", "put", "bring", "brought", "begin", "began",
    "keep", "kept", "hold", "held", "write", "wrote", "written", "stand", "stood", "hear", "heard",
    "let", "make", "made", "say", "said", "pay", "paid", "run", "ran", "move", "live", "believe",
    "bring", "happen", "stand", "open", "walk", "offer", "remember", "love", "consider", "appear",
    "buy", "wait", "serve", "die", "send", "expect", "build", "stay", "fall", "cut", "reach", "kill",
    "remain", "code", "function", "class", "const", "let", "var", "import", "export", "return",
    "async", "await", "if", "else", "for", "while", "switch", "case", "try", "catch", "throw",
  ]);
  return common.has(word.toLowerCase());
}

export function extractIdentifiersFromPrompt(prompt: string): string[] {
  const identifiers: string[] = [];

  const matches = prompt.match(/\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+)\b/g);
  if (matches) {
    for (const id of matches) {
      if (id.length > 2 && !isCommonWord(id)) {
        identifiers.push(id);
      }
    }
  }

  const fileMatches = prompt.match(/\b\w+\.(ts|js|tsx|jsx|py|go|rs)\b/g);
  if (fileMatches) {
    for (const f of fileMatches) {
      const base = f.replace(/\.(ts|js|tsx|jsx|py|go|rs)$/, "");
      if (!identifiers.includes(base)) identifiers.push(base);
    }
  }

  return [...new Set(identifiers)].slice(0, 5);
}

export function extractFilePaths(grepOutput: string): string[] {
  const lines = grepOutput.split("\n");
  const paths = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^([^:]+):\d+:/);
    if (match) paths.add(match[1]);
  }
  return Array.from(paths);
}

export function extractGlobPattern(prompt: string): string | null {
  const globMatch = prompt.match(/\*\*?\/[^\s'"]+/);
  if (globMatch) return globMatch[0];

  const extMatch = prompt.match(/\*\.(ts|js|tsx|jsx|py|go|rs|json|md|yaml|yml)\b/);
  if (extMatch) return `*${extMatch[0]}`;

  if (/\btypescript\b|\b\.ts\b/.test(prompt)) return "*.ts";
  if (/\bjavascript\b|\b\.js\b/.test(prompt)) return "*.js";
  if (/\bjson\b/.test(prompt)) return "*.json";
  if (/\bmarkdown\b|\b\.md\b/.test(prompt)) return "*.md";

  return null;
}

export function mapTaskTypeToRole(taskType: TaskType): TaskRole {
  switch (taskType) {
    case "code-complete":
    case "quick-fix":
    case "test-scaffold":
      return "coding";
    case "code-explain":
    case "doc-generate":
      return "general-chat";
    case "file-search":
    case "symbol-search":
      return "general-tool";
    default:
      return "general-chat";
  }
}

export function inferTaskType(prompt: string): TaskType {
  const p = prompt.toLowerCase();

  if (/\b(find|search|查找|搜索|where is|locate)\b/.test(p) && /\.(ts|js|tsx|jsx|py|go|json|md|yaml)\b/.test(p)) {
    return "file-search";
  }
  if (/\b(symbol|class|function|interface|定义|声明)\b/.test(p) && /\b(where|find|search|查找)\b/.test(p)) {
    return "symbol-search";
  }
  if (/\b(complete|补全|finish|fill|implement)\b/.test(p)) {
    return "code-complete";
  }
  if (/\b(explain|解释|what does|how does|说明)\b/.test(p)) {
    return "code-explain";
  }
  if (/\b(fix|bug|debug|修复|错误|bug)\b/.test(p)) {
    return "quick-fix";
  }
  if (/\b(document|doc|文档|注释|jsdoc)\b/.test(p)) {
    return "doc-generate";
  }
  if (/\b(test|测试|unit test|spec)\b/.test(p)) {
    return "test-scaffold";
  }

  return "simple-chat";
}

export function buildAssessmentFromStrategy(strategy: ExecutionStrategy, typeHint?: TaskType): ComplexityAssessment {
  return {
    score: strategy === "opencode-only" ? 10 : strategy === "parallel" ? 30 : strategy === "opencode-primary" ? 50 : 80,
    taskType: typeHint || "simple-chat",
    recommendedStrategy: strategy,
    reasons: ["用户指定策略"],
  };
}

export function assessComplexity(prompt: string, typeHint?: TaskType): ComplexityAssessment {
  const reasons: string[] = [];
  let score = 0;

  if (prompt.length > COMPLEXITY_THRESHOLDS.maxPromptLength) {
    score += 30;
    reasons.push("Prompt 过长（>8000 字符）");
  } else if (prompt.length > 4000) {
    score += 15;
    reasons.push("Prompt 较长");
  }

  const steps = (prompt.match(/\b(step|步骤|首先|然后|最后|接着|之后)\b/gi) || []).length;
  if (steps >= 3) {
    score += 20;
    reasons.push("多步骤任务");
  }

  const fileRefs = prompt.match(/\b\w+\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c)\b/g);
  if (fileRefs && fileRefs.length > COMPLEXITY_THRESHOLDS.maxFiles) {
    score += 20;
    reasons.push(`涉及 ${fileRefs.length} 个文件`);
  }

  const complexKeywords = /\b(architecture|design|system|refactor|implement|framework|微服务|架构|设计|系统|框架)\b/gi;
  if (complexKeywords.test(prompt)) {
    score += 15;
    reasons.push("涉及架构/设计");
  }

  const reasoningKeywords = /\b(reasoning|math|algorithm|prove|optimize|证明|算法|优化|推导)\b/gi;
  if (reasoningKeywords.test(prompt)) {
    score += 15;
    reasons.push("需要推理/数学能力");
  }

  let taskType = typeHint || inferTaskType(prompt);

  if (taskType === "simple-chat") score = Math.max(0, score - 20);
  if (taskType === "file-search") score = Math.max(0, score - 30);
  if (taskType === "code-complete") score = Math.max(0, score - 10);

  score = Math.min(100, Math.max(0, score));

  let strategy: ExecutionStrategy;
  if (score < 20) {
    strategy = "opencode-only";
    reasons.push("简单任务 → OpenCode 直接执行");
  } else if (score < 40) {
    strategy = "parallel";
    reasons.push("中等复杂度 → 并行执行取最快");
  } else if (score < 60) {
    strategy = "opencode-primary";
    reasons.push("较复杂 → OpenCode 优先，失败回退");
  } else {
    strategy = "axiom-only";
    reasons.push("复杂任务 → 直接走 Axiom 主力模型");
  }

  return { score, taskType, recommendedStrategy: strategy, reasons };
}

export function checkCircuitBreaker(modelId: string, state: ModelRuntimeState): void {
  if (state.consecutiveFailures >= 3) {
    state.circuitOpen = true;
    state.circuitOpenUntil = Date.now() + 60000;
    logger.warn(`[OpenCodeToolAgent] Circuit breaker OPEN for ${modelId}`, {
      resumeAt: new Date(state.circuitOpenUntil).toISOString(),
    });
  }
}
