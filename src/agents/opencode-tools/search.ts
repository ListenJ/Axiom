import { logger } from "../../utils/logger.js";
import { getGlobalBlackboard } from "../../memory/blackboard.js";
import { getReadOptimizer, type ReadRequest } from "../../utils/read-optimizer.js";
import { PiCodeToolsAdapter } from "../../pi-agent/pi-code-tools.js";
import { isCodegraphInitialized, searchSymbols, type CodeGraphSearchResult } from "../../memory/codegraph-index.js";
import {
  type TaskType,
  extractIdentifiersFromPrompt,
  extractFilePaths,
  extractGlobPattern,
  estimateTokens,
} from "./types.js";

export interface SearchDeps {
  piTools: PiCodeToolsAdapter;
  cwd: string;
  codegraphReady: boolean;
}

export interface PreprocessResult {
  enhancedPrompt: string;
  toolsUsed: string[];
  tokenSaved: number;
}

export class ContextPreprocessor {
  constructor(private deps: SearchDeps) {}

  async preprocessWithPiTools(
    prompt: string,
    taskType: TaskType,
    injectContext: boolean
  ): Promise<PreprocessResult> {
    if (!injectContext) {
      return { enhancedPrompt: prompt, toolsUsed: [], tokenSaved: 0 };
    }

    const toolsUsed: string[] = [];
    const contextParts: string[] = [];
    let tokenSaved = 0;

    const identifiers = extractIdentifiersFromPrompt(prompt);

    switch (taskType) {
      case "code-complete":
      case "quick-fix":
      case "code-explain": {
        if (identifiers.length > 0) {
          const bb = getGlobalBlackboard();
          const bbGrepKey = `grep:${identifiers[0]}:${this.deps.cwd}`;
          const bbGrep = bb.read(bbGrepKey, { minConfidence: 0.7 });

          let grepResultContent = "";
          if (bbGrep.hit && bbGrep.entry) {
            grepResultContent = String(bbGrep.entry.value ?? "");
            toolsUsed.push("blackboard:grep");
          } else {
            const grepResult = await this.deps.piTools.grep(identifiers[0], { path: this.deps.cwd });
            if (grepResult.success && grepResult.content) {
              grepResultContent = grepResult.content;
              toolsUsed.push("grep");
              tokenSaved += estimateTokens(grepResultContent);
              bb.write(bbGrepKey, grepResultContent, "opencode-tool-agent", {
                confidence: 0.8,
                expireMs: 60 * 1000,
                tags: ["grep", identifiers[0]],
              });
            }
          }

          if (grepResultContent) {
            contextParts.push(`## 代码搜索结果\n${grepResultContent}`);

            const filePaths = extractFilePaths(grepResultContent).slice(0, 2);
            for (const fp of filePaths) {
              const bbReadKey = `read:${fp}`;
              const bbRead = bb.read(bbReadKey, { minConfidence: 0.7 });

              let fileContent = "";
              if (bbRead.hit && bbRead.entry) {
                fileContent = String(bbRead.entry.value ?? "");
                toolsUsed.push("blackboard:read");
              } else {
                const readResult = await this.deps.piTools.readFile(fp, { limit: 50 });
                if (readResult.success) {
                  fileContent = readResult.content;
                  toolsUsed.push(`read:${fp}`);
                  tokenSaved += estimateTokens(fileContent);
                  bb.write(bbReadKey, fileContent, "opencode-tool-agent", {
                    confidence: 0.9,
                    expireMs: 2 * 60 * 1000,
                    tags: ["read", fp],
                  });
                }
              }

              if (fileContent) {
                contextParts.push(`## 文件: ${fp}\n${fileContent}`);
              }
            }
          }
        }
        break;
      }

      case "file-search": {
        const bb = getGlobalBlackboard();
        const globPattern = extractGlobPattern(prompt);
        if (globPattern) {
          const bbFindKey = `find:${globPattern}:${this.deps.cwd}`;
          const bbFind = bb.read(bbFindKey, { minConfidence: 0.7 });

          let findResultContent = "";
          if (bbFind.hit && bbFind.entry) {
            findResultContent = String(bbFind.entry.value ?? "");
            toolsUsed.push("blackboard:find");
          } else {
            const findResult = await this.deps.piTools.findFiles(globPattern, { path: this.deps.cwd });
            if (findResult.success && findResult.content) {
              findResultContent = findResult.content;
              toolsUsed.push("find");
              bb.write(bbFindKey, findResultContent, "opencode-tool-agent", {
                confidence: 0.9,
                expireMs: 60 * 1000,
                tags: ["find", globPattern],
              });
            }
          }

          if (findResultContent) {
            contextParts.push(`## 文件列表\n${findResultContent}`);
          }
        }
        break;
      }

      case "symbol-search": {
        const bb = getGlobalBlackboard();
        if (identifiers.length > 0 && this.deps.codegraphReady) {
          const bbSymbolKey = `symbol:${identifiers[0]}`;
          const bbSymbol = bb.read(bbSymbolKey, { minConfidence: 0.7 });

          let symbols: { kind: string; name: string; filePath: string; startLine: number }[] = [];
          if (bbSymbol.hit && bbSymbol.entry) {
            symbols = bbSymbol.entry.value as typeof symbols;
            toolsUsed.push("blackboard:symbol");
          } else {
            const cgSymbols = await searchSymbols(identifiers[0], { limit: 10, projectPath: this.deps.cwd });
            symbols = cgSymbols.map((s) => ({
              kind: s.node.kind,
              name: s.node.name,
              filePath: s.node.filePath,
              startLine: s.node.startLine,
            }));
            if (symbols.length > 0) {
              toolsUsed.push("codegraph:searchSymbols");
              tokenSaved += symbols.length * 50;
              bb.write(bbSymbolKey, symbols, "opencode-tool-agent", {
                confidence: 0.85,
                expireMs: 3 * 60 * 1000,
                tags: ["symbol", identifiers[0]],
              });
            }
          }

          if (symbols.length > 0) {
            contextParts.push(`## 符号搜索结果\n${symbols.map((s) => `${s.kind} ${s.name} (${s.filePath}:${s.startLine})`).join("\n")}`);
          }
        }
        break;
      }

      case "doc-generate":
      case "test-scaffold": {
        const bb = getGlobalBlackboard();
        if (identifiers.length > 0) {
          const bbGrepKey = `grep:${identifiers[0]}:${this.deps.cwd}`;
          const bbGrep = bb.read(bbGrepKey, { minConfidence: 0.7 });

          let grepContent = "";
          if (bbGrep.hit && bbGrep.entry) {
            grepContent = String(bbGrep.entry.value ?? "");
          } else {
            const grepResult = await this.deps.piTools.grep(identifiers[0], { path: this.deps.cwd });
            if (grepResult.success && grepResult.content) {
              grepContent = grepResult.content;
              toolsUsed.push("grep");
            }
          }

          if (grepContent) {
            contextParts.push(`## 相关代码\n${grepContent}`);
          }

          const refPattern = taskType === "test-scaffold" ? "*.test.*" : "*.md";
          const findResult = await this.deps.piTools.findFiles(refPattern, { path: this.deps.cwd });
          if (findResult.success && findResult.content) {
            const refs = findResult.content.split("\n").filter(Boolean).slice(0, 2);
            for (const ref of refs) {
              const readResult = await this.deps.piTools.readFile(ref, { limit: 30 });
              if (readResult.success) {
                toolsUsed.push(`read:${ref}`);
                contextParts.push(`## 参考: ${ref}\n${readResult.content}`);
              }
            }
          }
        }
        break;
      }

      default:
        break;
    }

    if (contextParts.length > 0) {
      const enhanced = `${contextParts.join("\n\n---\n\n")}\n\n---\n\n## 任务\n\n${prompt}`;
      return { enhancedPrompt: enhanced, toolsUsed, tokenSaved };
    }

    return { enhancedPrompt: prompt, toolsUsed, tokenSaved };
  }
}
