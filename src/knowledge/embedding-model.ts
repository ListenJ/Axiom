/**
 * embedding **模型标签**的单一来源（2026-09-21）
 *
 * ## 为什么需要它
 * 向量表 `knowledge_embeddings` 按 `model` 列区分向量来源（换模型 ⇒ 旧向量不可比、需清账）。
 * **写入腿（索引脚本）与读取腿（KAL 语义端口）必须用同一个标签**，否则会出现
 * "写进去了、读不出来"的最恶性失效模式（表里有数据、召回恒空，且不报错）。
 * 故两处都必须调本函数，**禁止各写各的字符串**。
 *
 * ## 标签口径
 * `${provider}/${model}`（如 `siliconflow/BAAI/bge-m3`）—— 只记"哪个路由产出的向量"。
 *
 * ## 为什么是**纯函数**（不自己查注册表）
 * 本模块位于 `src/knowledge/`。架构门禁（`tests/architecture-integrity.test.ts` Test 9）
 * 限制"一个顶层目录最多依赖 8 个其它顶层目录"，而 `knowledge` 已用到 8 个；
 * 若此处 import `src/router/`，就会顶破该门禁（实测：9 → 门禁失败）。
 * 故把"取哪个路由"交给调用方（组合根 / 脚本）注入，本模块只负责**标签口径**这一件事 ——
 * 这同时也是更好的分层：knowledge 层不反向依赖 router 层。
 *
 * ## 与发布面闸门的关系
 * 调用方经 `findModelsForRole("embedding")` 取模型 ⇒ **自动继承 `devOnly` 闸门**：
 * 发布默认下 SiliconFlow 条目被过滤 ⇒ 传入空数组 ⇒ 返回 `null` ⇒ 调用方**不发起任何调用**
 * （这正是 D5「发布面不依赖 SiliconFlow」在 embedding 链路上的落点）。
 */

/** 由"当前可用于 embedding 的模型列表"推导标签；无可用路由（未配置 / 被 devOnly 过滤）⇒ `null` */
export function embeddingModelTagOf(
  models: ReadonlyArray<{ provider: string; model: string }>,
): string | null {
  const model = models[0];
  if (!model) return null;
  return `${model.provider}/${model.model}`;
}
