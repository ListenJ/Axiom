/**
 * 统一知识访问层 (Knowledge Access Layer)
 *
 * 核心功能:
 * 1. 统一查询接口 — 一次查询，fan-out 到多个存储
 * 2. 结果合并 — 跨存储的结果按相关性排序
 * 3. 统一格式 — 所有知识单元返回相同的结构
 * 4. 存储路由 — 根据查询意图自动选择存储
 *
 * 支持的存储:
 * - Vault: 笔记内容搜索 (FTS5)
 * - KG: 图谱关系查询 (SQLite)
 * - DRE: 确定性知识查询 (SQLite)
 */

import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { createNodeId, parseNodeId, type StorePrefix } from "./node-id.js";

// ========== 统一知识单元 ==========

/** 知识单元 — 跨存储的统一格式 */
export interface KnowledgeUnit {
  /** 全局 node_id */
  nodeId: string;
  /** 来源存储 */
  store: StorePrefix;
  /** 知识类型 */
  type: string;
  /** 标题 */
  title: string;
  /** 内容摘要 */
  snippet: string;
  /** 相关性分数 (0-1) */
  relevance: number;
  /** 标签 */
  tags: string[];
  /** 元数据 */
  metadata: Record<string, unknown>;
}

/** 查询意图 */
export interface QueryIntent {
  /** 原始查询 */
  query: string;
  /** 目标存储 (可选，不指定则fan-out) */
  targetStore?: StorePrefix;
  /** 类型过滤 */
  typeFilter?: string[];
  /** 标签过滤 */
  tagFilter?: string[];
  /** 最大结果数 */
  limit?: number;
}

/** 查询结果 */
export interface QueryResult {
  /** 查询解释 */
  interpretation: string;
  /** 命中的存储 */
  storesQueried: StorePrefix[];
  /** 合并后的结果 */
  results: KnowledgeUnit[];
  /** 总耗时 (ms) */
  duration: number;
}

/**
 * 语义候选召回**端口**（A5 后半，2026-09-21）
 *
 * 语义腿只负责"把词面召不到、但语义相近的 nodeId 拉进候选"；**不决定最终排序**
 * （D3）。真实实现由组合根注入 —— 通常包住 `recallBySimilarity()`（向量表）+
 * 授权门后的 embedder；本模块**不** import 网络层、不 import embedding 实现
 * （依赖注入，规则 8），因此可在无网络、无模型的情况下被完整测试。
 *
 * 未注入该端口 ⇒ `query()` 行为与引入前**逐字节一致**（这是本改动的安全前提）。
 */
export interface SemanticRecallPort {
  /**
   * @param query 原始查询串（本层不做改写）
   * @param opts.topK 期望候选上限（调用方按 `limit` 传，注入方可自行截断）
   * @returns 候选 `{id, score}`；**顺序不被信任**（本层会自行规范化为
   *          `score desc, node_id 码元升序`，故注入方返回乱序不影响结果）
   */
  recall(query: string, opts: { topK: number }): Promise<ReadonlyArray<{ id: string; score: number }>>;
}

// ========== KAL 主类 ==========

/**
 * 审计 L2：vaultNodeIdToPath 反查缓存容量上限。
 * 该 Map 仅作归一化 nodeId -> 原始路径的反查缓存，淘汰只影响未命中时的
 * 降级路径——getReferences 的 W6 逻辑会经适配器 listNotePaths 重建兜底。
 */
const MAX_VAULT_NODE_ID_TO_PATH_ENTRIES = 1000;

export class KnowledgeAccessLayer {
  private db: Database;
  /** 可选 vault 引擎适配器（P1-T2/O3-F2）：提供 wiki-link 入链查询，未注入时 getReferences 保持仅 KG 边；W6 增加 listNotePaths 供顺序无关反查 */
  private vault?: { getWikiBacklinks(notePath: string): Array<{ path: string; title: string }>; listNotePaths?(): string[] };
  /** O3-F2：queryVault 结果的 nodeId -> 原始路径映射（归一化不可逆，反查靠它） */
  private vaultNodeIdToPath = new Map<string, string>();
  /** 可选语义候选召回端口（A5 后半）。未注入 ⇒ query() 走原词法路径，行为不变 */
  private semantic?: SemanticRecallPort;

  constructor(
    db: Database,
    vault?: { getWikiBacklinks(notePath: string): Array<{ path: string; title: string }>; listNotePaths?(): string[] },
    semantic?: SemanticRecallPort,
  ) {
    this.db = db;
    this.vault = vault;
    this.semantic = semantic;
  }

  /**
   * 统一查询入口
   */
  async query(intent: QueryIntent): Promise<QueryResult> {
    const start = performance.now();
    const stores = intent.targetStore
      ? [intent.targetStore]
      : (["vault", "kg", "dre"] as StorePrefix[]);

    const results: KnowledgeUnit[] = [];
    const storesQueried: StorePrefix[] = [];

    // Fan-out 查询
    const promises = stores.map(async (store) => {
      try {
        const storeResults = await this.queryStore(store, intent);
        storesQueried.push(store);
        return storeResults;
      } catch (err) {
        logger.warn(`[KAL] Store ${store} query failed`, { error: (err as Error).message });
        return [];
      }
    });

    const storeResults = await Promise.all(promises);
    for (const storeResult of storeResults) {
      results.push(...storeResult);
    }

    // O3-F5：merge 后按 store 分组求 maxScore，归一化再排序——
    // 避免 vault 恒 0.8 等分数尺度差异导致某库被无条件压制。
    const maxByStore = new Map<StorePrefix, number>();
    for (const r of results) {
      maxByStore.set(r.store, Math.max(maxByStore.get(r.store) ?? 0, r.relevance));
    }
    for (const r of results) {
      const max = maxByStore.get(r.store);
      if (max && max > 0) r.relevance = r.relevance / max;
    }

    // ── 语义腿（可选，A5 后半）──────────────────────────────────────────────
    // 位置刻意放在**每库归一化之后、排序之前**：
    //   ① 放在归一化之前 ⇒ 新候选会抬高该库的 max，把词法分重新缩放（污染词法腿）；
    //   ② 放在排序之后 ⇒ 新候选不参与排序（等于没召回）。
    // 打分口径：对**已在词法结果里**的条目取 `max(词法分, 余弦)`（D3：向量只做候选召回，
    // 两腿都落在 0..1）；对**只有语义腿召回**的条目直接用余弦分。
    if (this.semantic) {
      try {
        const candidates = await this.semantic.recall(intent.query, { topK: intent.limit || 20 });
        // 候选顺序**不被信任**：显式规范化为 (score desc, node_id 码元升序)。
        // 用 `<`/`>` 而非 localeCompare（避免 locale 依赖）；同 id 取最高分。
        const best = new Map<string, number>();
        for (const c of candidates ?? []) {
          if (!c || typeof c.id !== "string" || !Number.isFinite(c.score)) continue;
          const prev = best.get(c.id);
          if (prev === undefined || c.score > prev) best.set(c.id, c.score);
        }
        const ordered = [...best.entries()]
          .map(([id, score]) => ({ id, score }))
          .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        const byId = new Map(results.map((r) => [r.nodeId, r]));
        const fresh: Array<{ id: string; score: number }> = [];
        for (const c of ordered) {
          const hit = byId.get(c.id);
          if (hit) {
            hit.relevance = Math.max(hit.relevance, c.score); // 已在词法结果中 ⇒ 取 max
          } else {
            fresh.push(c);
          }
        }

        if (fresh.length > 0) {
          const units = this.materializeUnitsByNodeId(fresh.map((c) => c.id));
          const scoreById = new Map(fresh.map((c) => [c.id, c.score]));
          for (const u of units) {
            results.push({
              ...u,
              relevance: scoreById.get(u.nodeId) ?? u.relevance,
              metadata: { ...u.metadata, source: "semantic" },
            });
          }
          // 物化不齐（候选指向已删除/不可达节点）**显式记录**，不静默当作"召回成功"
          if (units.length < fresh.length) {
            logger.debug("[KAL] semantic candidates not materialized", {
              requested: fresh.length,
              materialized: units.length,
            });
          }
        }
      } catch (err) {
        // 语义腿失败（embedder 抛错/超时/表损坏）⇒ 降级为纯词法，不抛、不阻断查询
        logger.warn("[KAL] semantic leg failed; degrading to lexical-only", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 按相关性排序
    // ⚠️ 刻意**不**改成 `(relevance desc, nodeId asc)`：vault 腿的 relevance 是常量 0.8，
    // 归一化后**全部并列 1.0**，其真实顺序信息只存在于 SQL 的 `ORDER BY rank` 里、靠本排序的
    // **稳定性**保留；一旦加入 nodeId 次级键，vault 结果会被按路径字典序重排 ⇒ 破坏 FTS 排序。
    // 确定性由三处保证：①每库 SQL 已带 id 次级键（审计 M1）；②stores 数组顺序固定；
    // ③语义候选已显式规范化。故此处保持原比较器不变。
    results.sort((a, b) => b.relevance - a.relevance);

    // 截断
    const limit = intent.limit || 20;
    const truncated = results.slice(0, limit);

    return {
      interpretation: `Query "${intent.query}" across [${storesQueried.join(", ")}]`,
      storesQueried,
      results: truncated,
      duration: Math.round(performance.now() - start),
    };
  }

  /**
   * 按存储查询
   */
  private async queryStore(
    store: StorePrefix,
    intent: QueryIntent
  ): Promise<KnowledgeUnit[]> {
    switch (store) {
      case "vault":
        return this.queryVault(intent);
      case "kg":
        return this.queryKG(intent);
      case "dre":
        return this.queryDRE(intent);
      default:
        return [];
    }
  }

  /**
   * 查询 Vault (FTS5 搜索)
   */
  private queryVault(intent: QueryIntent): KnowledgeUnit[] {
    try {
      const searchQuery = `
        SELECT mn.path, mn.title, mn.content, mn.tags
        FROM memory_notes_fts fts
        JOIN memory_notes mn ON mn.id = fts.rowid
        WHERE memory_notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      const limit = intent.limit || 10;
      // P1-S2 层2：trigram 库上 <3 字的 CJK 短词（常见中文双字词）MATCH 恒空，
      // 改走 memory_notes LIKE 兜底腿；unicode61 库（迁移降级/夹具）保持旧行为。
      const words = intent.query
        .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 0);
      const trigram = this.ftsUsesTrigram();
      const shortCjkWords = trigram
        ? words.filter((w) => w.length < 3 && /[\u4e00-\u9fa5]/.test(w))
        : [];
      // 短词在 trigram 下不进 MATCH（恒空）；清洗后仅含 \w/CJK，不含 LIKE 通配符，无需转义
      const ftsQuery = this.sanitizeFTS5(intent.query, trigram ? 3 : 1);
      if (!ftsQuery && shortCjkWords.length === 0) return [];

      let rows = ftsQuery
        ? (this.db.query(searchQuery).all(ftsQuery, limit) as Array<{
            path: string;
            title: string;
            content: string;
            tags: string;
          }>)
        : [];

      if (shortCjkWords.length > 0) {
        const likeClauses = shortCjkWords
          .map(() => `(mn.title LIKE ? OR mn.content LIKE ?)`)
          .join(" OR ");
        const likeParams: string[] = [];
        for (const w of shortCjkWords) {
          likeParams.push(`%${w}%`, `%${w}%`);
        }
        likeParams.push(String(limit));
        const likeRows = this.db
          .query(
            `SELECT mn.path, mn.title, mn.content, mn.tags
             FROM memory_notes mn
             WHERE (${likeClauses})
             ORDER BY mn.id ASC
             LIMIT ?`,
          )
          .all(...likeParams) as Array<{ path: string; title: string; content: string; tags: string }>;
        const seen = new Set(rows.map((r) => r.path));
        for (const r of likeRows) {
          if (!seen.has(r.path)) rows.push(r);
        }
      }

      // O3-F1：tagFilter 按 parseTags 后包含判定过滤（对齐 sqlite-memory.ts 的 AND 语义）
      const filtered = intent.tagFilter?.length
        ? rows.filter((row) => {
            const noteTags = this.safeParseTags(row.tags);
            return intent.tagFilter!.every((t) => noteTags.includes(t));
          })
        : rows;

      return filtered.map((row) => {
        const nodeId = createNodeId("vault", "note", row.path);
        // O3-F2：归一化不可逆（"." 折叠 "_"），记录 nodeId -> 原始路径供 getReferences 反查
        this.trackVaultNodeId(nodeId, row.path);
        return {
          nodeId,
          store: "vault" as StorePrefix,
          type: "note",
          title: row.title || row.path,
          snippet: (row.content || "").slice(0, 300),
          relevance: 0.8,
          tags: this.safeParseTags(row.tags),
          metadata: { path: row.path },
        };
      });
    } catch (err) {
      // FTS5 表可能不存在，静默降级
      logger.debug("[KAL] queryVault FTS5 degrade to empty", { error: String(err) });
      return [];
    }
  }

  /**
   * 查询 KG (知识图谱)
   * W5（落地形态审核 §2.3）：trigram 库走 kg_nodes_fts MATCH 主腿 +
   * <3 字 CJK LIKE 兜底腿并集去重（镜像 queryVault）；非 trigram 库走原纯 LIKE。
   * 排序恒 ORDER BY importance DESC, id ASC（保 M1/M3 红线，FTS MATCH 仅作候选召回不用 rank）。
   */
  private queryKG(intent: QueryIntent): KnowledgeUnit[] {
    try {
      const limit = intent.limit || 10;
      const typeFilter = intent.typeFilter;
      const typeFilterClause = typeFilter
        ? `AND type IN (${typeFilter.map(() => "?").join(",")})`
        : "";
      const typeFilterNClause = typeFilter
        ? `AND n.type IN (${typeFilter.map(() => "?").join(",")})`
        : "";

      type KgRow = {
        id: string;
        type: string;
        name: string;
        description: string;
        tags: string;
        importance: number;
      };

      const trigram = this.kgFtsUsable();
      let rows: KgRow[];

      if (!trigram) {
        // 原纯 LIKE 路径不变（FTS 表不存在/非 trigram）
        const likeSql = `
          SELECT id, type, name, description, tags, importance
          FROM kg_nodes
          WHERE (name LIKE ? OR description LIKE ? OR semantic LIKE ?)
          ${typeFilterClause}
          ORDER BY importance DESC, id ASC
          LIMIT ?
        `;
        const pattern = `%${intent.query}%`;
        const likeParams: (string | number)[] = [pattern, pattern, pattern];
        if (typeFilter) likeParams.push(...typeFilter);
        likeParams.push(limit);
        rows = this.db.query(likeSql).all(...likeParams) as KgRow[];
      } else {
        // W5：FTS MATCH 主腿（>=3 字符词）+ <3 字 CJK LIKE 兜底腿并集去重
        const words = intent.query
          .replace(/[^\w一-龥\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 0);
        const shortCjkWords = words.filter(
          (w) => w.length < 3 && /[一-龥]/.test(w),
        );
        const ftsQuery = this.sanitizeFTS5(intent.query, 3);
        if (!ftsQuery && shortCjkWords.length === 0) return [];

        rows = [];
        if (ftsQuery) {
          const ftsSql = `
            SELECT n.id, n.type, n.name, n.description, n.tags, n.importance
            FROM kg_nodes_fts fts
            JOIN kg_nodes n ON n.rowid = fts.rowid
            WHERE kg_nodes_fts MATCH ?
              ${typeFilterNClause}
            ORDER BY n.importance DESC, n.id ASC
            LIMIT ?
          `;
          const ftsParams: (string | number)[] = [ftsQuery];
          if (typeFilter) ftsParams.push(...typeFilter);
          ftsParams.push(limit);
          rows = this.db.query(ftsSql).all(...ftsParams) as KgRow[];
        }

        if (shortCjkWords.length > 0) {
          const likeClauses = shortCjkWords
            .map(() => `(name LIKE ? OR description LIKE ? OR semantic LIKE ?)`)
            .join(" OR ");
          const likeSql = `
            SELECT id, type, name, description, tags, importance
            FROM kg_nodes
            WHERE (${likeClauses})
              ${typeFilterClause}
            ORDER BY importance DESC, id ASC
            LIMIT ?
          `;
          const likeParams: (string | number)[] = [];
          for (const w of shortCjkWords) {
            likeParams.push(`%${w}%`, `%${w}%`, `%${w}%`);
          }
          if (typeFilter) likeParams.push(...typeFilter);
          likeParams.push(limit);
          const likeRows = this.db.query(likeSql).all(...likeParams) as KgRow[];
          const seen = new Set(rows.map((r) => r.id));
          for (const r of likeRows) {
            if (!seen.has(r.id)) rows.push(r);
          }
        }
      }

      return rows.map((row) => ({
        // 审计 M14：kg_nodes.id 已是库内完整节点 id（kg_edges 亦存原样 id），
        // 直接返回原样使 queryKG 与 getReferences 语义一致；二次 createNodeId
        // 会产出 kg:type:kg_type_x-<hash> 双前缀形态，跨接口引用即失配。
        nodeId: row.id,
        store: "kg" as StorePrefix,
        type: row.type,
        title: row.name,
        snippet: (row.description || "").slice(0, 300),
        relevance: row.importance || 0.5,
        tags: this.safeParseTags(row.tags),
        metadata: { id: row.id },
      }));
    } catch (err) {
      logger.debug("[KAL] queryKG degrade to empty", { error: String(err) });
      return [];
    }
  }

  /**
   * 查询 DRE (确定性知识)
   */
  private queryDRE(intent: QueryIntent): KnowledgeUnit[] {
    // 2026-09-17 后端收敛：补 FTS 优先腿（knowledge_node_fts），与 queryVault/queryKG
    // 的检索能力对齐；FTS 表缺失时降级 LIKE（老库兼容）。
    const typeFilterClause = intent.typeFilter
      ? "AND paradigm IN (" + intent.typeFilter.map(() => "?").join(",") + ")"
      : "";
    const limit = intent.limit || 10;
    const pattern = `%${intent.query}%`;

    const mapRow = (row: {
      node_id: string;
      title: string;
      content: string;
      domain: string;
      paradigm: string;
      confidence: number;
    }): KnowledgeUnit => ({
      nodeId: createNodeId("dre", row.domain, row.node_id),
      store: "dre" as StorePrefix,
      type: row.paradigm,
      title: row.title,
      snippet: (row.content || "").slice(0, 300),
      relevance: row.confidence || 0.5,
      tags: [row.domain, row.paradigm],
      metadata: { id: row.node_id, domain: row.domain },
    });

    try {
      const ftsQuery = `
        SELECT n.node_id, n.title, n.content, n.domain, n.paradigm, n.confidence
        FROM knowledge_node_fts fts
        JOIN knowledge_node n ON n.rowid = fts.rowid
        WHERE knowledge_node_fts MATCH ?
        ${typeFilterClause}
        ORDER BY n.confidence DESC, n.node_id ASC
        LIMIT ?
      `;
      const ftsParams: (string | number)[] = [intent.query];
      if (intent.typeFilter) ftsParams.push(...intent.typeFilter);
      ftsParams.push(limit);
      const ftsRows = this.db.query(ftsQuery).all(...ftsParams) as Array<{
        node_id: string;
        title: string;
        content: string;
        domain: string;
        paradigm: string;
        confidence: number;
      }>;
      if (ftsRows.length > 0) return ftsRows.map(mapRow);
    } catch (err) {
      // knowledge_node_fts 缺失（旧库）→ LIKE 兜底腿
      logger.debug("[KAL] queryDRE fts leg unavailable; degrading to LIKE", { error: String(err) });
    }

    try {
      const likeQuery = `
        SELECT node_id, title, content, domain, paradigm, confidence
        FROM knowledge_node
        WHERE (title LIKE ? OR content LIKE ?)
        ${typeFilterClause}
        ORDER BY confidence DESC, node_id ASC
        LIMIT ?
      `;
      const likeParams: (string | number)[] = [pattern, pattern];
      if (intent.typeFilter) likeParams.push(...intent.typeFilter);
      likeParams.push(limit);
      const rows = this.db.query(likeQuery).all(...likeParams) as Array<{
        node_id: string;
        title: string;
        content: string;
        domain: string;
        paradigm: string;
        confidence: number;
      }>;
      return rows.map(mapRow);
    } catch (err) {
      logger.debug("[KAL] queryDRE degrade to empty", { error: String(err) });
      return [];
    }
  }

  /**
   * 把 nodeId 批量物化为 `KnowledgeUnit`（A5 后半）
   *
   * ## 为什么需要它
   * 向量表按 `node_id` 存/取，语义候选只给出 `nodeId + 余弦分`；
   * 要并进 `query()` 的结果集，必须能把 nodeId 还原成完整知识单元。
   *
   * ## 三个存储的还原方式（均为**精确计算**，不是猜测）
   * - **kg**：`kg_nodes.id` 就是库内完整 node_id（审计 M14）⇒ 按主键 `IN (...)` 直查，无需枚举。
   * - **vault**：`nodeId = createNodeId("vault","note",path)`，而该归一化**不可逆**
   *   （非 ASCII 折叠为 `_`、并可能追加短哈希）⇒ 三条精确路径依次尝试：
   *   ① `vaultNodeIdToPath` 反查缓存（`queryVault`/`getReferences` 建立的）；
   *   ② 适配器 `listNotePaths()`；③ `SELECT path FROM memory_notes` 全量路径枚举（命中即停）。
   * - **dre**：`nodeId = createNodeId("dre", domain, node_id)` ⇒ 枚举 `(node_id, domain)`（两个短列）重算比对，
   *   再按 `node_id IN (...)` 取正文。
   *
   * ## 代价与边界（如实声明）
   * vault/dre 在缓存未命中时要**枚举**（只读短列，不读正文）；命中即停，故候选越集中越快。
   * 语料量级增大时这是 O(N) 的读放大 —— 属已知取舍，若要消除需给两表加 `node_id` 反向索引（另立任务）。
   * 物化不到的 id **不伪造**：直接缺席，由调用方比较数量并记录。
   */
  private materializeUnitsByNodeId(ids: readonly string[]): KnowledgeUnit[] {
    const found = new Map<string, KnowledgeUnit>();
    if (ids.length === 0) return [];

    // ① KG
    const kgIds = ids.filter((id) => id.startsWith("kg:"));
    if (kgIds.length > 0) {
      try {
        const ph = kgIds.map(() => "?").join(",");
        const rows = this.db
          .query(
            `SELECT id, type, name, description, tags, importance FROM kg_nodes WHERE id IN (${ph})`,
          )
          .all(...kgIds) as Array<{
          id: string;
          type: string;
          name: string;
          description: string;
          tags: string;
          importance: number;
        }>;
        for (const row of rows) {
          found.set(row.id, {
            nodeId: row.id,
            store: "kg",
            type: row.type,
            title: row.name,
            snippet: (row.description || "").slice(0, 300),
            relevance: row.importance || 0.5,
            tags: this.safeParseTags(row.tags),
            metadata: { id: row.id },
          });
        }
      } catch (err) {
        logger.debug("[KAL] materialize kg degraded", { error: String(err) });
      }
    }

    // ② Vault
    const vaultWanted = new Set(ids.filter((id) => id.startsWith("vault:")));
    if (vaultWanted.size > 0) {
      const idToPath = new Map<string, string>();
      for (const id of vaultWanted) {
        const p = this.vaultNodeIdToPath.get(id);
        if (p !== undefined) {
          idToPath.set(id, p);
          vaultWanted.delete(id);
        }
      }
      if (vaultWanted.size > 0 && this.vault?.listNotePaths) {
        try {
          for (const p of this.vault.listNotePaths()) {
            const nid = createNodeId("vault", "note", p);
            this.trackVaultNodeId(nid, p);
            if (vaultWanted.has(nid)) {
              idToPath.set(nid, p);
              vaultWanted.delete(nid);
              if (vaultWanted.size === 0) break;
            }
          }
        } catch (err) {
          logger.debug("[KAL] materialize vault adapter enumeration degraded", { error: String(err) });
        }
      }
      if (vaultWanted.size > 0) {
        try {
          const rows = this.db.query(`SELECT path FROM memory_notes`).all() as Array<{ path: string }>;
          for (const { path } of rows) {
            const nid = createNodeId("vault", "note", path);
            this.trackVaultNodeId(nid, path);
            if (vaultWanted.has(nid)) {
              idToPath.set(nid, path);
              vaultWanted.delete(nid);
              if (vaultWanted.size === 0) break;
            }
          }
        } catch (err) {
          logger.debug("[KAL] materialize vault path enumeration degraded", { error: String(err) });
        }
      }
      const paths = [...new Set(idToPath.values())];
      if (paths.length > 0) {
        try {
          const ph = paths.map(() => "?").join(",");
          const rows = this.db
            .query(`SELECT path, title, content, tags FROM memory_notes WHERE path IN (${ph})`)
            .all(...paths) as Array<{ path: string; title: string; content: string; tags: string }>;
          const byPath = new Map(rows.map((r) => [r.path, r]));
          for (const [nid, p] of idToPath) {
            const row = byPath.get(p);
            if (!row) continue;
            found.set(nid, {
              nodeId: nid,
              store: "vault",
              type: "note",
              title: row.title || row.path,
              snippet: (row.content || "").slice(0, 300),
              relevance: 0.8,
              tags: this.safeParseTags(row.tags),
              metadata: { path: row.path },
            });
          }
        } catch (err) {
          logger.debug("[KAL] materialize vault rows degraded", { error: String(err) });
        }
      }
    }

    // ③ DRE
    const dreWanted = new Set(ids.filter((id) => id.startsWith("dre:")));
    if (dreWanted.size > 0) {
      const idToRaw = new Map<string, string>();
      try {
        const pairs = this.db
          .query(`SELECT node_id, domain FROM knowledge_node`)
          .all() as Array<{ node_id: string; domain: string }>;
        for (const p of pairs) {
          const nid = createNodeId("dre", p.domain, p.node_id);
          if (dreWanted.has(nid)) {
            idToRaw.set(nid, p.node_id);
            dreWanted.delete(nid);
            if (dreWanted.size === 0) break;
          }
        }
      } catch (err) {
        logger.debug("[KAL] materialize dre enumeration degraded", { error: String(err) });
      }
      const rawIds = [...new Set(idToRaw.values())];
      if (rawIds.length > 0) {
        try {
          const ph = rawIds.map(() => "?").join(",");
          const rows = this.db
            .query(
              `SELECT node_id, title, content, domain, paradigm, confidence FROM knowledge_node WHERE node_id IN (${ph})`,
            )
            .all(...rawIds) as Array<{
            node_id: string;
            title: string;
            content: string;
            domain: string;
            paradigm: string;
            confidence: number;
          }>;
          const byRaw = new Map(rows.map((r) => [r.node_id, r]));
          for (const [nid, rawId] of idToRaw) {
            const row = byRaw.get(rawId);
            if (!row) continue;
            found.set(nid, {
              nodeId: nid,
              store: "dre",
              type: row.paradigm,
              title: row.title,
              snippet: (row.content || "").slice(0, 300),
              relevance: row.confidence || 0.5,
              tags: [row.domain, row.paradigm],
              metadata: { id: row.node_id, domain: row.domain },
            });
          }
        } catch (err) {
          logger.debug("[KAL] materialize dre rows degraded", { error: String(err) });
        }
      }
    }

    // 按**传入顺序**返回（确定性）；物化不到的 id 直接缺席（调用方负责比较数量）
    return ids.map((id) => found.get(id)).filter((u): u is KnowledgeUnit => u !== undefined);
  }

  /**
   * 获取跨存储引用 (通过 node_id 查找关联)
   */
  async getReferences(nodeId: string): Promise<KnowledgeUnit[]> {
    const parsed = parseNodeId(nodeId);
    if (!parsed) return [];

    // 跨存储引用：KG 出入边 UNION
    // 以该 nodeId 为源或目标的边，另一端即其引用方/被引用方。
    // （Vault wiki-link 图由 DeterministicSearchEngine 在文件层内存构建，
    //  不在本 SQLite 之内，故此处仅覆盖可在 db 中可靠验证的 KG 边。）
    const results: KnowledgeUnit[] = [];

    try {
      // 2026-09-17 后端收敛：唯一边表 kg_edges（旧表 kg_edge 已并入，缝合 UNION 与回退腿移除）
      const edges = this.db
        .query(
          `SELECT source, target, type FROM kg_edges WHERE source = ? OR target = ? LIMIT 50`,
        )
        .all(nodeId, nodeId) as Array<{ source: string; target: string; type: string }>;

      for (const edge of edges) {
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        const node = this.db
          .query(`SELECT id, type, name, description FROM kg_nodes WHERE id = ?`)
          .get(otherId) as { id: string; type: string; name: string; description: string } | undefined;

        if (node) {
          results.push({
            // kg_nodes.id 已是完整 node_id，切勿二次前缀（避免 kg:type:kg:type:x）
            nodeId: node.id,
            store: "kg",
            type: node.type,
            title: node.name,
            snippet: (node.description || "").slice(0, 300),
            relevance: 0.6,
            tags: [],
            metadata: { referencedBy: nodeId, edgeType: edge.type },
          });
        }
      }
    } catch (err) {
      // kg 表可能不存在
      logger.debug("[KAL] getReferences kg tables degrade to no edges", { error: String(err) });
    }

    // Vault wiki-link 入链（P1-T2 / O3-F2）：经 queryVault 建立的映射反查
    // 原始路径，再调适配器补齐引用腿。无映射时保守降级（归一化不可逆，不猜测）。
    // W6：未先 queryVault 时经适配器 listNotePaths 枚举重建映射——
    // 对每条已知路径精确计算 createNodeId 比对，非猜测；适配器未提供枚举时维持原降级。
    if (parsed.store === "vault") {
      try {
        let rawPath = this.vaultNodeIdToPath.get(nodeId);
        if (!rawPath && this.vault?.listNotePaths) {
          // W6 重建为反查目标服务：逐条精确计算比对，命中即停。
          // 不全量填充——批次超过容量上限时会把刚补回的最早条目再挤出，
          // 导致每次反查都重复全量枚举。
          for (const p of this.vault.listNotePaths()) {
            const nid = createNodeId("vault", "note", p);
            this.trackVaultNodeId(nid, p);
            if (nid === nodeId) {
              rawPath = p;
              break;
            }
          }
          rawPath = this.vaultNodeIdToPath.get(nodeId);
        }
        if (rawPath && this.vault) {
          for (const src of this.vault.getWikiBacklinks(rawPath)) {
            results.push({
              nodeId: createNodeId("vault", "note", src.path),
              store: "vault",
              type: "note",
              title: src.title || src.path,
              snippet: "",
              relevance: 0.55,
              tags: [],
              metadata: { referencedBy: nodeId, sourcePath: src.path },
            });
          }
        }
      } catch (err) {
        // 引擎不可用，静默降级
        logger.debug("[KAL] getReferences vault wiki-link engine unavailable", { error: String(err) });
      }
    }

    return results;
  }

  /**
   * 审计 L2：写入反查缓存并保证有界——超上限时先淘汰最早条目（Map 保持
   * 插入序，首个 key 即最旧）。仅影响缓存命中率，正确性由 W6 重建兜底。
   */
  private trackVaultNodeId(nodeId: string, path: string): void {
    if (this.vaultNodeIdToPath.size >= MAX_VAULT_NODE_ID_TO_PATH_ENTRIES) {
      const oldest = this.vaultNodeIdToPath.keys().next().value;
      if (oldest !== undefined) this.vaultNodeIdToPath.delete(oldest);
    }
    this.vaultNodeIdToPath.set(nodeId, path);
  }

  private safeParseTags(tagsJson: string): string[] {
    try {
      return JSON.parse(tagsJson || "[]");
    } catch (err) {
      logger.debug("[KAL] safeParseTags malformed tags JSON degrade to empty", { error: String(err) });
      return [];
    }
  }

  /**
   * FTS5 查询转义 (与 VaultManager 保持一致)
   * 移除特殊字符，每个词加引号和前缀通配符
   * P1-S2 层2：trigram 库上 <3 字符的词 MATCH 恒空（SQLite trigram 最小 3 字符），
   * minWordLength=3 时过滤之（短词由 queryVault 的 LIKE 兜底腿承接）；默认 1 保持旧行为。
   */
  private sanitizeFTS5(query: string, minWordLength = 1): string {
    const cleaned = query
      .replace(/[^\w\u4e00-\u9fa5\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= minWordLength)
      .map((w) => `"${w}"*`)
      .join(" OR ");
    return cleaned;
  }

  /** P1-S2 层2：memory_notes_fts 是否为 trigram（sqlite_master 探测一次并缓存） */
  private ftsTrigramCache: boolean | null = null;

  private ftsUsesTrigram(): boolean {
    if (this.ftsTrigramCache === null) {
      try {
        const row = this.db
          .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_notes_fts'")
          .get() as { sql: string } | undefined;
        this.ftsTrigramCache = Boolean(row) && /trigram/i.test(row!.sql);
      } catch {
        this.ftsTrigramCache = false;
      }
    }
    return this.ftsTrigramCache;
  }

  /** W5：kg_nodes_fts 是否为 trigram（sqlite_master 探测一次并缓存）；不存在/失败 → false 走纯 LIKE */
  private kgFtsCache: boolean | null = null;

  private kgFtsUsable(): boolean {
    if (this.kgFtsCache === null) {
      try {
        const row = this.db
          .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'kg_nodes_fts'")
          .get() as { sql: string } | undefined;
        this.kgFtsCache = Boolean(row) && /trigram/i.test(row!.sql);
      } catch {
        this.kgFtsCache = false;
      }
    }
    return this.kgFtsCache;
  }
}
