import { readFile, searchFiles } from "./filesystem.js";
import { executeCommand } from "./terminal.js";
import * as path from "node:path";

export interface SymbolInfo {
  name: string;
  type: "function" | "class" | "interface" | "type" | "variable" | "export";
  line: number;
  signature?: string;
  file: string;
}

export interface SymbolSearchResult {
  success: boolean;
  symbols?: SymbolInfo[];
  error?: string;
}

export interface DiagnosticItem {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  source?: string;
  suggestions?: string[];
}

export interface DiagnosticsResult {
  success: boolean;
  diagnostics?: DiagnosticItem[];
  error?: string;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  language?: string;
  linter?: string;
}

export interface ReferenceResult {
  success: boolean;
  references?: Array<{
    file: string;
    line: number;
    column: number;
    context: string;
  }>;
  error?: string;
}

export interface OutlineResult {
  success: boolean;
  symbols?: SymbolInfo[];
  error?: string;
}

export interface CodeAction {
  title: string;
  diagnostic: string;
  edit: {
    file: string;
    line: number;
    oldText: string;
    newText: string;
  };
}

export interface CodeActionsResult {
  success: boolean;
  actions?: CodeAction[];
  error?: string;
}

// Language detection
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".py": "python",
  ".pyw": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
};

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANG_MAP[ext] || "unknown";
}

// Linter configurations per language
interface LinterConfig {
  cmd: string;
  args: string[];
  parseOutput: (output: string) => DiagnosticItem[];
  timeout: number;
}

function parseTscOutput(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(
      /^(.+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/
    );
    if (match) {
      diagnostics.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4] as "error" | "warning",
        code: match[5],
        message: match[6],
        source: "tsc",
      });
    }
  }
  return diagnostics;
}

function parsePylintOutput(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    // pylint format: file:line:column: CODE: message (C/R/W/E/F)
    const match = line.match(
      /^(.+):(\d+):(\d+):\s*([CRWEF]\d{4}):\s*(.+)$/
    );
    if (match) {
      const code = match[4];
      const severity = code.startsWith("E") || code.startsWith("F")
        ? "error"
        : code.startsWith("W")
          ? "warning"
          : "info";
      diagnostics.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity,
        code,
        message: match[5],
        source: "pylint",
      });
    }
  }
  return diagnostics;
}

function parseGoVetOutput(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    // go vet format: file:line:col: message
    const match = line.match(/^(.+):(\d+):(\d+):\s*(.+)$/);
    if (match) {
      diagnostics.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: "warning",
        message: match[4],
        source: "go vet",
      });
    }
  }
  return diagnostics;
}

function parseRustcOutput(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    // rustc format: file:line:col: error/warning: message
    const match = line.match(
      /^(.+):(\d+):(\d+):\s*(error|warning):\s*(.+)$/
    );
    if (match) {
      diagnostics.push({
        file: match[1].trim(),
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        severity: match[4] as "error" | "warning",
        message: match[5],
        source: "rustc",
      });
    }
  }
  return diagnostics;
}

function parseEslintOutput(output: string): DiagnosticItem[] {
  const diagnostics: DiagnosticItem[] = [];
  try {
    // ESLint JSON format
    const results = JSON.parse(output);
    for (const result of results) {
      for (const msg of result.messages || []) {
        diagnostics.push({
          file: result.filePath,
          line: msg.line || 1,
          column: msg.column || 1,
          severity: msg.severity === 2 ? "error" : "warning",
          code: msg.ruleId || undefined,
          message: msg.message,
          source: "eslint",
          suggestions: msg.suggestions?.map((s: { desc: string }) => s.desc),
        });
      }
    }
  } catch {
    // Fallback: try line-by-line parsing
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^(.+):(\d+):(\d+):\s*(error|warning):\s*(.+)$/);
      if (match) {
        diagnostics.push({
          file: match[1].trim(),
          line: parseInt(match[2], 10),
          column: parseInt(match[3], 10),
          severity: match[4] as "error" | "warning",
          message: match[5],
          source: "eslint",
        });
      }
    }
  }
  return diagnostics;
}

function getLinterConfig(filePath: string): LinterConfig | null {
  const lang = detectLanguage(filePath);

  switch (lang) {
    case "typescript":
    case "javascript": {
      // Prefer eslint if available, fallback to tsc
      const safeFilePath = filePath.replace(/"/g, '\\"');
      return {
        cmd: "npx",
        args: ["eslint", "--format", "json", `"${safeFilePath}"`],
        parseOutput: parseEslintOutput,
        timeout: 30000,
      };
    }
    case "python": {
      const safeFilePath = filePath.replace(/"/g, '\\"');
      return {
        cmd: "python",
        args: ["-m", "pylint", "--output-format=text", `"${safeFilePath}"`],
        parseOutput: parsePylintOutput,
        timeout: 30000,
      };
    }
    case "go": {
      const safeFilePath = filePath.replace(/"/g, '\\"');
      return {
        cmd: "go",
        args: ["vet", `"${safeFilePath}"`],
        parseOutput: parseGoVetOutput,
        timeout: 30000,
      };
    }
    case "rust": {
      return {
        cmd: "cargo",
        args: ["check", "--message-format=short"],
        parseOutput: parseRustcOutput,
        timeout: 60000,
      };
    }
    default:
      return null;
  }
}

// Simple regex-based symbol extraction (no full parser needed)
const PATTERNS: Array<{
  regex: RegExp;
  type: SymbolInfo["type"];
  group: number;
}> = [
  {
    regex:
      /(?:export\s+)?(?:async\s+)?(?:function\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    type: "function",
    group: 1,
  },
  {
    regex:
      /(?:export\s+)?(?:class\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s+extends\s+\w+)?\s*\{/g,
    type: "class",
    group: 1,
  },
  {
    regex:
      /(?:export\s+)?(?:interface\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s+extends\s+[^{]+)?\s*\{/g,
    type: "interface",
    group: 1,
  },
  {
    regex:
      /(?:export\s+)?(?:type\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=\u003c]/g,
    type: "type",
    group: 1,
  },
  {
    regex:
      /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]/g,
    type: "variable",
    group: 1,
  },
  {
    regex:
      /(?:export\s+\{[^}]*\})|(?:export\s+(?:default\s+)?(?:class|function|interface|type|const|let|var)\s+\w+)/g,
    type: "export",
    group: 0,
  },
];

export async function findSymbols(
  filePath: string
): Promise<SymbolSearchResult> {
  const file = await readFile(filePath);
  if (!file.success || !file.content) {
    return {
      success: false,
      error: file.error || "Failed to read file",
    };
  }

  const symbols: SymbolInfo[] = [];
  const lines = file.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0; // Reset regex
      const match = pattern.regex.exec(line);
      if (match) {
        symbols.push({
          name: match[pattern.group] || "export",
          type: pattern.type,
          line: i + 1,
          signature: line.trim().substring(0, 120),
          file: filePath,
        });
      }
    }
  }

  return { success: true, symbols };
}

export async function findReferences(
  symbol: string,
  searchPath: string = "."
): Promise<ReferenceResult> {
  const result = await searchFiles(symbol, {
    path: searchPath,
    pattern: `\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    maxResults: 50,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const references = result.matches?.map((m) => ({
    file: m.file,
    line: m.line,
    column: m.content.indexOf(symbol) + 1,
    context: m.content,
  }));

  return { success: true, references };
}

export async function getDiagnostics(
  filePath?: string,
  options?: { quick?: boolean; language?: string }
): Promise<DiagnosticsResult> {
  // If no filePath, run project-wide TypeScript check
  if (!filePath) {
    const cmd = "npx tsc --noEmit";
    const result = await executeCommand(cmd, { timeout: 60000 });
    const diagnostics = parseTscOutput(result.stdout + result.stderr);
    const errorCount = diagnostics.filter((d) => d.severity === "error").length;
    const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
    const infoCount = diagnostics.filter((d) => d.severity === "info").length;

    return {
      success: true,
      diagnostics,
      errorCount,
      warningCount,
      infoCount,
      language: "typescript",
      linter: "tsc",
    };
  }

  const lang = options?.language || detectLanguage(filePath);
  const linterConfig = getLinterConfig(filePath);

  if (!linterConfig) {
    // Fallback to TypeScript for TS/JS or basic syntax check
    if (lang === "typescript" || lang === "javascript") {
      const safeFilePath = filePath.replace(/"/g, '\\"');
      const cmd = options?.quick
        ? `npx tsc --noEmit --skipLibCheck "${safeFilePath}"`
        : `npx tsc --noEmit "${safeFilePath}"`;
      const result = await executeCommand(cmd, { timeout: 60000 });
      const diagnostics = parseTscOutput(result.stdout + result.stderr);
      const errorCount = diagnostics.filter((d) => d.severity === "error").length;
      const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
      const infoCount = diagnostics.filter((d) => d.severity === "info").length;

      return {
        success: true,
        diagnostics,
        errorCount,
        warningCount,
        infoCount,
        language: lang,
        linter: "tsc",
      };
    }

    return {
      success: false,
      error: `No linter available for language: ${lang}`,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      language: lang,
    };
  }

  // Run language-specific linter
  const result = await executeCommand(
    `${linterConfig.cmd} ${linterConfig.args.join(" ")}`,
    { timeout: linterConfig.timeout }
  );

  // Linter may exit with non-zero code even with valid output
  const diagnostics = linterConfig.parseOutput(result.stdout + result.stderr);
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
  const infoCount = diagnostics.filter((d) => d.severity === "info").length;

  return {
    success: true,
    diagnostics,
    errorCount,
    warningCount,
    infoCount,
    language: lang,
    linter: linterConfig.cmd,
  };
}

/**
 * Quick diagnostics for a single file using faster checks
 */
export async function getQuickDiagnostics(
  filePath: string
): Promise<DiagnosticsResult> {
  const lang = detectLanguage(filePath);

  if (lang === "typescript" || lang === "javascript") {
    // Use tsc with skipLibCheck for speed
    return getDiagnostics(filePath, { quick: true, language: lang });
  }

  // For other languages, use the standard linter
  return getDiagnostics(filePath, { language: lang });
}

/**
 * Get code actions (fix suggestions) for a file
 */
export async function getCodeActions(
  filePath: string
): Promise<CodeActionsResult> {
  const lang = detectLanguage(filePath);
  const actions: CodeAction[] = [];

  if (lang === "typescript" || lang === "javascript") {
    // Use ESLint with fix-dry-run to get suggestions
    const result = await executeCommand(
      `npx eslint --format json --fix-dry-run "${filePath}"`,
      { timeout: 30000 }
    );

    try {
      const eslintResults = JSON.parse(result.stdout);
      for (const eslintResult of eslintResults) {
        for (const msg of eslintResult.messages || []) {
          if (msg.fix) {
            actions.push({
              title: `Fix: ${msg.message}`,
              diagnostic: msg.ruleId || "unknown",
              edit: {
                file: filePath,
                line: msg.line || 1,
                oldText: msg.fix.text || "",
                newText: msg.fix.text || "",
              },
            });
          }
        }
      }
    } catch {
      // Parse error, return empty actions
    }
  }

  // Add generic suggestions based on common patterns
  const fileResult = await readFile(filePath);
  if (fileResult.success && fileResult.content) {
    // Suggest adding types to untyped parameters
    const untypedMatches = fileResult.content.matchAll(
      /function\s+\w+\s*\(([^)]*)\)\s*\{/g
    );
    for (const match of untypedMatches) {
      const params = match[1];
      if (params && !params.includes(":") && params.trim()) {
        actions.push({
          title: "Add type annotations to function parameters",
          diagnostic: "missing-types",
          edit: {
            file: filePath,
            line: 1,
            oldText: params,
            newText: params,
          },
        });
      }
    }
  }

  return { success: true, actions };
}

export async function getFileOutline(
  filePath: string
): Promise<OutlineResult> {
  const result = await findSymbols(filePath);
  if (!result.success) {
    return result;
  }

  // Sort by line number
  const symbols = result.symbols?.sort((a, b) => a.line - b.line) || [];

  return { success: true, symbols };
}

export async function analyzeCode(
  filePath: string
): Promise<{
  success: boolean;
  metrics?: {
    lines: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
    functions: number;
    classes: number;
    interfaces: number;
    exports: number;
    imports: number;
  };
  error?: string;
}> {
  const file = await readFile(filePath);
  if (!file.success || !file.content) {
    return { success: false, error: file.error || "Failed to read file" };
  }

  const lines = file.content.split("\n");
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let functions = 0;
  let classes = 0;
  let interfaces = 0;
  let exports = 0;
  let imports = 0;

  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      blankLines++;
      continue;
    }

    if (inBlockComment) {
      commentLines++;
      if (trimmed.endsWith("*/")) {
        inBlockComment = false;
      }
      continue;
    }

    if (trimmed.startsWith("//")) {
      commentLines++;
      continue;
    }

    if (trimmed.startsWith("/*")) {
      commentLines++;
      if (!trimmed.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }

    codeLines++;

    if (/\bfunction\b/.test(trimmed)) functions++;
    if (/\bclass\b/.test(trimmed)) classes++;
    if (/\binterface\b/.test(trimmed)) interfaces++;
    if (/\bexport\b/.test(trimmed)) exports++;
    if (/\bimport\b/.test(trimmed)) imports++;
  }

  return {
    success: true,
    metrics: {
      lines: lines.length,
      codeLines,
      commentLines,
      blankLines,
      functions,
      classes,
      interfaces,
      exports,
      imports,
    },
  };
}

export async function getCallGraph(
  filePath: string,
  symbol: string
): Promise<{
  success: boolean;
  callers?: Array<{ file: string; line: number; context: string }>;
  callees?: Array<{ name: string; line: number }>;
  error?: string;
}> {
  const file = await readFile(filePath);
  if (!file.success || !file.content) {
    return { success: false, error: file.error || "Failed to read file" };
  }

  const lines = file.content.split("\n");
  const callees: Array<{ name: string; line: number }> = [];

  // Find function body of the symbol
  let inFunction = false;
  let braceCount = 0;
  let funcStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      new RegExp(`\\bfunction\\s+${symbol}\\b|\\b${symbol}\\s*\\(`, "i").test(
        line
      )
    ) {
      inFunction = true;
      funcStart = i;
      braceCount = 0;
    }

    if (inFunction) {
      braceCount += (line.match(/\{/g) || []).length;
      braceCount -= (line.match(/\}/g) || []).length;

      // Find function calls within this function
      const callMatches = line.matchAll(
        /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g
      );
      for (const match of callMatches) {
        const name = match[1];
        if (name !== symbol && !["if", "while", "for", "switch", "catch"].includes(name)) {
          callees.push({ name, line: i + 1 });
        }
      }

      if (braceCount === 0 && funcStart !== i) {
        inFunction = false;
      }
    }
  }

  // Find callers - search in all files
  const callerSearch = await searchFiles(symbol + "(", {
    path: ".",
    maxResults: 20,
  });

  const callers =
    callerSearch.matches
      ?.filter((m) => m.file !== filePath)
      .map((m) => ({
        file: m.file,
        line: m.line,
        context: m.content,
      })) || [];

  return { success: true, callers, callees };
}
