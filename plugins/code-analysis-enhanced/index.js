/**
 * Enhanced Code Analysis — 未实现占位（审计去伪 / 规则 12）
 *
 * 审计结论：本插件原先注册的 4 个工具（analyze_complexity / generate_dependency_graph /
 * detect_vulnerabilities / find_code_smells）返回的是 `Math.random()` 生成的复杂度、
 * pass/fail、漏洞 severity 与随机行号，以及硬编码的依赖图 —— 属**伪造结果**。
 * 源码里自己写着 "Simulated analysis - in production, use ast-parser or similar"。
 *
 * 为什么必须撤掉：调用 `detect_vulnerabilities` 会拿到随机的 severity 与随机行号。
 * 这比"未实现"更危险 —— 空结果会被使用者发现，**看似合理的随机结果不会被发现**，
 * 而它会被当成真实静态分析结论使用。
 *
 * 处置：撤掉全部工具注册，显式声明未实现（"要么补行为，要么撤接口"）。
 * 保留 plugin.json 的 id/name/version 与目录结构，因此插件仍可被安装/启用，
 * 只是不再提供任何工具 —— 接口形状在，伪造行为不在。
 *
 * 本文件为 .js 而非 .ts：顶层 plugins/ 不在 tsconfig 的 include 范围内
 * （仅 src/** 与 tests/**），且插件加载器走 `await import(entry)`，
 * 声明指向 .ts 在运行期无法加载（原 plugin.json 声明 index.js 而只有 index.ts，
 * 正是"启用必抛 Entry file not found"的成因）。
 *
 * 恢复方式：基于真实实现（ast-parser / eslint / tsc API 等）重写工具注册，
 * 并同步更新 plugin.json 的 `tools` 列表。
 */
export default {
  // 显式声明不提供任何工具（plugin-registry 只读取 pluginModule.tools）
  tools: [],

  activate(context) {
    context?.logger?.warn(
      "[code-analysis-enhanced] NOT IMPLEMENTED — refused to register fabricated tools (Math.random severity/lines). See docs/operations-log.md 2026-09-14.",
    );
  },

  deactivate() {
    // 无状态可清理
  },
};
