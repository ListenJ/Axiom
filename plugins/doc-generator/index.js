/**
 * Documentation Generator — 未实现占位（审计去伪 / 规则 12）
 *
 * 审计结论：本插件原先注册的 5 个工具（generate_api_docs / generate_readme /
 * generate_adr / generate_code_docs / generate_wiki）都**不读取任何真实源码或文件**，
 * 而是按传入参数拼模板；其中 `generate_adr` 更用 `Math.floor(Math.random() * 100) + 1`
 * 生成 ADR 编号 —— 同一个决策每次调用会得到不同的编号，属**伪造结果**。
 *
 * 为什么必须撤掉：ADR 编号是要写进仓库文件名与正文的标识（`ADR-007-xxx.md`）。
 * 随机编号会产出**看似合法、实际无法追溯**的决策记录，比"未实现"更危险 ——
 * 空结果会被发现，看似合理的随机编号不会。
 *
 * 处置：撤掉全部工具注册，显式声明未实现（"要么补行为，要么撤接口"）。
 * 保留 plugin.json 的 id/name/version 与目录结构，因此插件仍可被安装/启用，
 * 只是不再提供任何工具。
 *
 * 本文件为 .js 而非 .ts：顶层 plugins/ 不在 tsconfig 的 include 范围内
 * （仅 src/** 与 tests/**），且插件加载器走 `await import(entry)`，
 * 声明指向 .ts 在运行期无法加载（原 plugin.json 声明 index.js 而只有 index.ts，
 * 正是"启用必抛 Entry file not found"的成因）。
 *
 * 恢复方式：接入真实实现（读源码树 / JSDoc 解析 / OpenAPI 文件），并让 ADR 编号
 * 由已存在的 ADR 文件名推导（而非随机），再同步更新 plugin.json 的 `tools` 列表。
 */
export default {
  // 显式声明不提供任何工具（plugin-registry 只读取 pluginModule.tools）
  tools: [],

  activate(context) {
    context?.logger?.warn(
      "[doc-generator] NOT IMPLEMENTED — refused to register fabricated tools (Math.random ADR numbers, no real file reads). See docs/operations-log.md 2026-09-14.",
    );
  },

  deactivate() {
    // 无状态可清理
  },
};
