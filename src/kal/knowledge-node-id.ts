/**
 * **KAL/索引口径**的知识 nodeId 映射 —— 单一来源（2026-09-21）
 *
 * ## 为什么需要它、为什么放在 `src/kal/`
 * 写入侧（vault 笔记、DRE 知识条目）与索引/查询侧（`kb-corpus`、`KnowledgeAccessLayer`）
 * 必须用**同一个 nodeId**，否则向量写进去也召不回（且不报错）。三条映射此前散在
 * `kb-corpus` 与 KAL 内部，写入侧一旦 import `knowledge/` 就会造成
 * `memory <-> knowledge` / `dre <-> knowledge` 的**目录级环**（实测：架构门禁 Test 15 失败）。
 * 放到 `src/kal/`（只依赖 `utils/` 的叶子层）后，写入侧与索引侧都 import 它而**不产生环**。
 *
 * ## ⚠️ 与 `node-id.ts` 里同名概念的区别（不要混用）
 * `node-id.ts` 另有 `vaultPathToNodeId(path)`——它是 `createNodeId("vault","note", simpleHash(path))`，
 * **与 KAL 查询/物化实际使用的 `createNodeId("vault","note", path)` 口径不同**。
 * 本模块是 KAL/索引一致性的口径；那套哈希口径属历史遗留，**不要**用于 embedding 索引。
 */
import { createNodeId } from "./node-id.js";

/** Vault 笔记 nodeId（归一化不可逆 ⇒ 只能由**原始路径**计算，不能由 id 反推） */
export function vaultNoteNodeId(path: string): string {
  return createNodeId("vault", "note", path);
}

/** DRE 知识条目 nodeId（domain + 原始 node_id） */
export function dreKnowledgeNodeId(domain: string, rawNodeId: string): string {
  return createNodeId("dre", domain, rawNodeId);
}

/** KG 节点 nodeId：`kg_nodes.id` **本身就是**完整 node_id（审计 M14），原样使用 */
export function kgNodeId(rawId: string): string {
  return rawId;
}
