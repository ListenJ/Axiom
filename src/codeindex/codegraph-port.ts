/**
 * `CodeIndexPort` 的 codeindex 实现（ADR-013 依赖倒置的组合面）。
 *
 * memory（内核）只声明 `CodeIndexPort`；本适配器把 `src/codeindex` 的本地 AST 索引实现
 * 接上去，由**组合根**（进程入口）调用 `installCodeIndexPort()` 装配。方向为
 * **外围(codeindex) → 内核(memory)**，符合 ADR-013。
 */
import {
  tryLocal,
  searchSymbolsLocal,
  getCallersLocal,
  getCalleesLocal,
  isProjectIndexed,
  indexProject,
} from "./local-index.js";
import { setCodeIndexPort, type CodeIndexPort } from "../memory/codegraph-index.js";

/** 用 codeindex 的真实实现构造端口。 */
export function createCodeIndexPort(): CodeIndexPort {
  return {
    isIndexed: (projectName) => isProjectIndexed(projectName),
    index: (projectPath, projectName) => {
      indexProject(projectPath, projectName);
    },
    searchSymbols: (projectPath, projectName, query, opts) =>
      tryLocal(projectPath, projectName, () => searchSymbolsLocal(query, projectName, opts)),
    getCallers: (projectPath, projectName, symbolName, opts) =>
      tryLocal(projectPath, projectName, () => getCallersLocal(symbolName, projectName, opts)),
    getCallees: (projectPath, projectName, symbolName, opts) =>
      tryLocal(projectPath, projectName, () => getCalleesLocal(symbolName, projectName, opts)),
  };
}

/** 组合根装配：把 codeindex 实现注入 memory 的 `CodeIndexPort` 槽。 */
export function installCodeIndexPort(): void {
  setCodeIndexPort(createCodeIndexPort());
}
