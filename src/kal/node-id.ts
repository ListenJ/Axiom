/**
 * 全局 Node ID 体系
 *
 * 格式: {store}:{type}:{identifier}
 *
 * 三个存储使用统一的 ID 命名空间:
 * - vault:  Vault 笔记 (Obsidian)
 * - kg:     知识图谱节点 (SQLite/PostgreSQL)
 * - dre:    DRE 知识条目 (确定性推理)
 *
 * 跨存储引用: 任意存储的节点可通过 node_id 关联到其他存储
 */

/** 存储前缀 */
export type StorePrefix = "vault" | "kg" | "dre";

import { createHash } from "node:crypto";

/** 生成全局 node_id */
export function createNodeId(
  store: StorePrefix,
  type: string,
  identifier: string
): string {
  const normalizedId = identifier
    .replace(/[^a-zA-Z0-9\-_\/]/g, "_")
    .slice(0, 128);
  // 审计 F-5 / R3 Task 3.4（2026-08-24）：归一化会把全部非 ASCII 字符
  // （如中文标题）折叠为 "_"——两个不同的纯中文标识符会得到完全相同的
  // ID，导致 KG 节点被静默合并。当归一化发生信息丢失时追加原文短哈希，
  // 保证"不同原文 ⇒ 不同 ID"；纯 ASCII 标识符保持既有格式不变。
  if (normalizedId !== identifier) {
    const suffix = createHash("sha1").update(identifier).digest("hex").slice(0, 8);
    return `${store}:${type}:${normalizedId.slice(0, 119)}-${suffix}`;
  }
  return `${store}:${type}:${normalizedId}`;
}

/** 解析 node_id */
export function parseNodeId(nodeId: string): {
  store: StorePrefix;
  type: string;
  identifier: string;
} | null {
  const parts = nodeId.split(":");
  if (parts.length < 3) return null;

  const store = parts[0] as StorePrefix;
  if (!["vault", "kg", "dre"].includes(store)) return null;

  return {
    store,
    type: parts[1],
    identifier: parts.slice(2).join(":"),
  };
}

/** 从 Vault 路径生成 node_id */
export function vaultPathToNodeId(path: string): string {
  const hash = simpleHash(path);
  return createNodeId("vault", "note", hash);
}

/** 从 KG 节点生成 node_id */
export function kgNodeToNodeId(nodeId: string, nodeType: string): string {
  return createNodeId("kg", nodeType, nodeId);
}

/** 从 DRE 知识条目生成 node_id */
export function dreKnowledgeToNodeId(knowledgeId: string, domain: string): string {
  return createNodeId("dre", domain, knowledgeId);
}

/** 简单哈希函数 (用于路径→ID转换) */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
