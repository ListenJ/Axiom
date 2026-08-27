/**
 * 知识库存储层
 *
 * 实现知识条目的 CRUD + 版本快照 + 三段甄别集成
 *
 * 范式设计 (3NF/4NF):
 * - knowledge_node: 知识条目主表
 * - knowledge_revision: 版本快照 (多值依赖分离)
 * - kg_edge: 知识图谱边
 * - hypothesis: 假设验证表 (v2.9.0 新增)
 *
 * 知识范式 (v2.9.0 扩展):
 * - fact: 事实 (已验证的陈述)
 * - rule: 规则 (条件→结论)
 * - procedure: 过程 (步骤序列)
 * - concept: 概念 (抽象定义)
 * - behavior: 行为 (条件→可能结果, 动态模式)
 * - prediction: 预测 (给定条件→预期结果)
 * - hypothesis: 假设 (待验证的陈述)
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";

/** 知识范式类型 */
export type KnowledgeParadigm =
  | "fact"
  | "rule"
  | "procedure"
  | "concept"
  | "behavior"
  | "prediction"
  | "hypothesis";

/** 行为描述 — 知识的动态模式 */
export interface Behavior {
  /** 触发条件 */
  triggers: string[];
  /** 可能结果 (带概率) */
  outcomes: Array<{ result: string; probability: number }>;
  /** 前置条件 */
  preconditions: string[];
  /** 副作用 */
  sideEffects?: string[];
}

/** 预测函数 — 基于条件的预期结果 */
export interface Prediction {
  /** 输入条件 */
  conditions: Record<string, unknown>;
  /** 预期结果 */
  expectedResult: unknown;
  /** 置信度 */
  confidence: number;
  /** 验证方法 */
  verificationMethod?: string;
  /** 最后验证时间 */
  lastVerifiedAt?: number;
}

/** 假设 — 待验证的知识 */
export interface Hypothesis {
  /** 假设陈述 */
  claim: string;
  /** 支持证据 */
  supportingEvidence: string[];
  /** 反对证据 */
  contradictingEvidence: string[];
  /** 验证状态 */
  status: "untested" | "testing" | "confirmed" | "refuted" | "inconclusive";
  /** 验证计划 */
  verificationPlan?: string;
  /** 验证结果 */
  verificationResult?: string;
  /** 提出时间 */
  proposedAt: number;
  /** 最后验证时间 */
  lastTestedAt?: number;
}

/** 知识条目 */
export interface KnowledgeNode {
  nodeId: string;
  title: string;
  content: string;
  contentHash: string;
  schemaVersion: number;
  domain: string;
  paradigm: KnowledgeParadigm;
  confidence: number;
  sourceType: "manual" | "web" | "llm" | "ocr" | "kg";
  sourceUri?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  isVerified: boolean;
  /** 行为描述 (paradigm=behavior 时必填) */
  behavior?: Behavior;
  /** 预测 (paradigm=prediction 时必填) */
  prediction?: Prediction;
  /** 假设 (paradigm=hypothesis 时必填) */
  hypothesis?: Hypothesis;
}

/** 知识版本 */
export interface KnowledgeRevision {
  nodeId: string;
  revision: number;
  content: string;
  diff?: string;
  reason?: string;
  verifiedBy?: string;
  createdAt: number;
}

/** 知识图谱边 */
export interface KGEdge {
  srcNode: string;
  dstNode: string;
  relation: "is-a" | "part-of" | "depends-on" | "derives-from" | "related-to";
  weight: number;
  evidence?: string[];
}

/**
 * 知识库存储
 */
export class KnowledgeStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 写入知识条目 (需经三段甄别)
   */
  write(node: Omit<KnowledgeNode, "createdAt" | "updatedAt" | "revision" | "contentHash">): KnowledgeNode {
    const now = Date.now();
    const contentHash = createHash("sha256").update(node.content).digest("hex");
    let finalRevision = 1;
    let createdAt = now;

    const txn = this.db.transaction(() => {
      // 检查是否已存在
      const existing = this.db.prepare(
        "SELECT revision, created_at FROM knowledge_node WHERE node_id = ?"
      ).get(node.nodeId) as { revision: number; created_at: number } | undefined;

      const revision = existing ? existing.revision + 1 : 1;
      finalRevision = revision;
      if (existing) createdAt = existing.created_at;

      // 保存版本快照
      if (existing) {
        const oldContent = this.db.prepare(
          "SELECT content FROM knowledge_node WHERE node_id = ?"
        ).get(node.nodeId) as { content: string } | undefined;

        if (oldContent) {
          const diff = this.computeDiff(oldContent.content, node.content);
          this.db.prepare(`
            INSERT INTO knowledge_revision (node_id, revision, content, diff, reason, verified_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(node.nodeId, existing.revision, oldContent.content, diff, "update", node.sourceType, now);
        }
      }

      // 插入或更新
      this.db.prepare(`
        INSERT INTO knowledge_node (
          node_id, title, content, content_hash, schema_version,
          domain, paradigm, confidence, source_type, source_uri,
          created_at, updated_at, revision, is_verified,
          behavior, prediction, hypothesis
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          content_hash = excluded.content_hash,
          domain = excluded.domain,
          paradigm = excluded.paradigm,
          confidence = excluded.confidence,
          source_type = excluded.source_type,
          source_uri = excluded.source_uri,
          updated_at = excluded.updated_at,
          revision = excluded.revision,
          is_verified = excluded.is_verified,
          behavior = excluded.behavior,
          prediction = excluded.prediction,
          hypothesis = excluded.hypothesis
      `).run(
        node.nodeId, node.title, node.content, contentHash,
        node.schemaVersion || 1, node.domain, node.paradigm,
        node.confidence, node.sourceType, node.sourceUri || null,
        createdAt, now, revision, node.isVerified ? 1 : 0,
        node.behavior ? JSON.stringify(node.behavior) : null,
        node.prediction ? JSON.stringify(node.prediction) : null,
        node.hypothesis ? JSON.stringify(node.hypothesis) : null
      );
    });

    txn();

    return {
      ...node,
      contentHash,
      createdAt,
      updatedAt: now,
      revision: finalRevision,
    };
  }

  /**
   * 读取知识条目
   */
  read(nodeId: string): KnowledgeNode | null {
    const row = this.db.prepare(`
      SELECT * FROM knowledge_node WHERE node_id = ?
    `).get(nodeId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToNode(row);
  }

  /**
   * 搜索知识条目
   */
  search(query: string, options?: {
    domain?: string;
    paradigm?: string;
    minConfidence?: number;
    limit?: number;
  }): KnowledgeNode[] {
    const limit = Math.max(1, Math.min(100, Number(options?.limit) || 10));

    // 有查询时优先使用 FTS5 全文索引 (O(log N) vs O(N))
    if (query && query.trim().length > 0) {
      try {
        const ftsSql = `
          SELECT n.* FROM knowledge_node n
          JOIN knowledge_node_fts f ON n.node_id = f.node_id
          WHERE knowledge_node_fts MATCH ?
          ${options?.domain ? "AND n.domain = ?" : ""}
          ${options?.paradigm ? "AND n.paradigm = ?" : ""}
          ${options?.minConfidence ? "AND n.confidence >= ?" : ""}
          ORDER BY n.confidence DESC, n.updated_at DESC
          LIMIT ?
        `;
        const ftsParams: (string | number)[] = [query];
        if (options?.domain) ftsParams.push(options.domain);
        if (options?.paradigm) ftsParams.push(options.paradigm);
        if (options?.minConfidence) ftsParams.push(options.minConfidence);
        ftsParams.push(limit);

        const rows = this.db.prepare(ftsSql).all(...ftsParams) as Array<Record<string, unknown>>;
        if (rows.length > 0) return rows.map((row) => this.rowToNode(row));
      } catch {
        // FTS5 不可用或查询语法错误，降级到 LIKE
      }
    }

    // 降级: LIKE 全表扫描
    let sql = "SELECT * FROM knowledge_node WHERE 1=1";
    const params: (string | number)[] = [];

    if (query) {
      sql += " AND (title LIKE ? OR content LIKE ?)";
      params.push(`%${query}%`, `%${query}%`);
    }

    if (options?.domain) {
      sql += " AND domain = ?";
      params.push(options.domain);
    }

    if (options?.paradigm) {
      sql += " AND paradigm = ?";
      params.push(options.paradigm);
    }

    if (options?.minConfidence) {
      sql += " AND confidence >= ?";
      params.push(options.minConfidence);
    }

    sql += " ORDER BY confidence DESC, updated_at DESC";
    sql += " LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToNode(row));
  }

  /**
   * 获取知识条目版本历史
   */
  getRevisions(nodeId: string): KnowledgeRevision[] {
    const rows = this.db.prepare(`
      SELECT * FROM knowledge_revision
      WHERE node_id = ? ORDER BY revision DESC
    `).all(nodeId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      nodeId: row.node_id as string,
      revision: row.revision as number,
      content: row.content as string,
      diff: row.diff as string | undefined,
      reason: row.reason as string | undefined,
      verifiedBy: row.verified_by as string | undefined,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * 添加知识图谱边
   */
  addEdge(edge: KGEdge): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kg_edge (src_node, dst_node, relation, weight, evidence)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      edge.srcNode,
      edge.dstNode,
      edge.relation,
      edge.weight,
      edge.evidence ? JSON.stringify(edge.evidence) : null
    );
  }

  /**
   * 获取节点的出边
   */
  getOutEdges(nodeId: string): KGEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM kg_edge WHERE src_node = ?
    `).all(nodeId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      srcNode: row.src_node as string,
      dstNode: row.dst_node as string,
      relation: row.relation as KGEdge["relation"],
      weight: row.weight as number,
      evidence: row.evidence ? JSON.parse(row.evidence as string) : undefined,
    }));
  }

  /**
   * 获取节点的入边
   */
  getInEdges(nodeId: string): KGEdge[] {
    const rows = this.db.prepare(`
      SELECT * FROM kg_edge WHERE dst_node = ?
    `).all(nodeId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      srcNode: row.src_node as string,
      dstNode: row.dst_node as string,
      relation: row.relation as KGEdge["relation"],
      weight: row.weight as number,
      evidence: row.evidence ? JSON.parse(row.evidence as string) : undefined,
    }));
  }

  /**
   * BFS 子图检索
   */
  subgraph(seedNodeId: string, depth: number = 2, maxNodes: number = 50): KnowledgeNode[] {
    const visited = new Set<string>();
    const result: KnowledgeNode[] = [];
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: seedNodeId, depth: 0 }];

    while (queue.length > 0 && result.length < maxNodes) {
      const { nodeId, depth: currentDepth } = queue.shift()!;

      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = this.read(nodeId);
      if (node) {
        result.push(node);
      }

      if (currentDepth >= depth) continue;

      // 获取邻居
      const outEdges = this.getOutEdges(nodeId);
      const inEdges = this.getInEdges(nodeId);

      for (const edge of [...outEdges, ...inEdges]) {
        const neighbor = edge.srcNode === nodeId ? edge.dstNode : edge.srcNode;
        if (!visited.has(neighbor)) {
          queue.push({ nodeId: neighbor, depth: currentDepth + 1 });
        }
      }
    }

    return result;
  }

  /**
   * 计算差异 (简化版)
   */
  private computeDiff(oldContent: string, newContent: string): string {
    // 简化实现：只记录变更标记
    if (oldContent === newContent) return "";
    return `@@ -old +new @@\n-${oldContent.slice(0, 100)}\n+${newContent.slice(0, 100)}`;
  }

  /**
   * 行转知识条目
   */
  private rowToNode(row: Record<string, unknown>): KnowledgeNode {
    return {
      nodeId: row.node_id as string,
      title: row.title as string,
      content: row.content as string,
      contentHash: row.content_hash as string,
      schemaVersion: row.schema_version as number,
      domain: row.domain as string,
      paradigm: row.paradigm as KnowledgeNode["paradigm"],
      confidence: row.confidence as number,
      sourceType: row.source_type as KnowledgeNode["sourceType"],
      sourceUri: row.source_uri as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      revision: row.revision as number,
      isVerified: (row.is_verified as number) === 1,
      behavior: row.behavior ? JSON.parse(row.behavior as string) : undefined,
      prediction: row.prediction ? JSON.parse(row.prediction as string) : undefined,
      hypothesis: row.hypothesis ? JSON.parse(row.hypothesis as string) : undefined,
    };
  }
}

// ========== 知识层增强: 行为、预测、假设 ==========

/**
 * 行为知识 — 让知识"动"起来
 */
export class BehaviorKnowledge {
  /**
   * 从规则知识中提取行为模式
   */
  static extractFromRule(node: KnowledgeNode): Behavior | null {
    if (node.paradigm !== "rule") return null;
    // 解析 "IF condition THEN conclusion" 格式
    const match = node.content.match(/IF\s+(.+?)\s+THEN\s+(.+)/i);
    if (!match) return null;
    return {
      triggers: [match[1].trim()],
      outcomes: [{ result: match[2].trim(), probability: node.confidence }],
      preconditions: [],
    };
  }

  /**
   * 预测给定条件下的行为结果
   */
  static predict(behavior: Behavior, conditions: Record<string, unknown>): {
    predicted: boolean;
    outcome?: string;
    probability: number;
  } {
    // 检查前置条件
    for (const pre of behavior.preconditions) {
      const key = pre.split("=")[0]?.trim();
      const expected = pre.split("=")[1]?.trim();
      if (key && expected && conditions[key] !== expected) {
        return { predicted: false, probability: 0 };
      }
    }
    // 返回最高概率的结果（复制后排序，避免就地修改共享的 outcomes 数组）
    const best = [...behavior.outcomes].sort((a, b) => b.probability - a.probability)[0];
    return {
      predicted: true,
      outcome: best?.result,
      probability: best?.probability || 0,
    };
  }
}

/**
 * 过程性知识 — 描述"如何做"的步骤序列
 *
 * 支持:
 * - 顺序步骤 (step1 → step2 → step3)
 * - 条件分支 (IF condition THEN stepA ELSE stepB)
 * - 循环 (WHILE condition DO steps)
 * - 错误处理 (TRY step CATCH error)
 */
export interface ProcedureStep {
  id: string;
  /** 步骤描述 */
  description: string;
  /** 步骤类型 */
  type: "action" | "condition" | "loop" | "try-catch";
  /** 子步骤 (用于 condition/loop/try-catch) */
  children?: ProcedureStep[];
  /** 条件表达式 (用于 condition/loop) */
  condition?: string;
  /** 错误处理步骤 (用于 try-catch) */
  catchStep?: ProcedureStep;
  /** 前置条件 */
  preconditions?: string[];
  /** 预期结果 */
  expectedOutcome?: string;
}

export interface Procedure {
  /** 过程 ID */
  id: string;
  /** 过程名称 */
  name: string;
  /** 步骤列表 */
  steps: ProcedureStep[];
  /** 成功条件 */
  successConditions: string[];
  /** 失败条件 */
  failureConditions: string[];
  /** 回滚步骤 */
  rollbackSteps?: ProcedureStep[];
}

export class ProcedureKnowledge {
  /**
   * 从知识节点中解析过程
   */
  static parseFromContent(node: KnowledgeNode): Procedure | null {
    if (node.paradigm !== "procedure") return null;

    const content = node.content;
    const steps: ProcedureStep[] = [];

    // 解析编号步骤: "1. xxx\n2. xxx\n3. xxx"
    const stepMatches = content.matchAll(/(\d+)\.\s+(.+)/g);
    let stepIndex = 0;
    for (const match of stepMatches) {
      steps.push({
        id: `step-${stepIndex}`,
        description: match[2].trim(),
        type: "action",
      });
      stepIndex++;
    }

    // 解析 IF/THEN/ELSE 条件
    const ifMatches = content.matchAll(/IF\s+(.+?)\s+THEN\s+(.+?)(?:\s+ELSE\s+(.+))?$/gim);
    for (const match of ifMatches) {
      steps.push({
        id: `step-${stepIndex}`,
        description: `条件判断: ${match[1]}`,
        type: "condition",
        condition: match[1].trim(),
        children: [
          { id: `step-${stepIndex}-then`, description: match[2].trim(), type: "action" },
          ...(match[3] ? [{ id: `step-${stepIndex}-else`, description: match[3].trim(), type: "action" as const }] : []),
        ],
      });
      stepIndex++;
    }

    if (steps.length === 0) return null;

    return {
      id: node.nodeId,
      name: node.title,
      steps,
      successConditions: [],
      failureConditions: [],
    };
  }

  /**
   * 验证过程完整性
   */
  static validate(procedure: Procedure): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (procedure.steps.length === 0) {
      issues.push("过程没有步骤");
    }

    for (const step of procedure.steps) {
      if (!step.description) {
        issues.push(`步骤 ${step.id} 缺少描述`);
      }
      if (step.type === "condition" && !step.condition) {
        issues.push(`条件步骤 ${step.id} 缺少条件表达式`);
      }
      if (step.type === "loop" && !step.condition) {
        issues.push(`循环步骤 ${step.id} 缺少循环条件`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * 获取下一步 (考虑条件分支)
   */
  static getNextStep(procedure: Procedure, currentStepId: string, context?: Record<string, unknown>): ProcedureStep | null {
    const currentIndex = procedure.steps.findIndex((s) => s.id === currentStepId);
    if (currentIndex === -1 || currentIndex >= procedure.steps.length - 1) return null;

    const nextStep = procedure.steps[currentIndex + 1];

    // 如果是条件步骤，根据上下文选择分支
    if (nextStep.type === "condition" && nextStep.condition && context) {
      const conditionResult = evaluateCondition(nextStep.condition, context);
      if (conditionResult && nextStep.children && nextStep.children.length > 0) {
        return nextStep.children[0]; // THEN 分支
      } else if (!conditionResult && nextStep.children && nextStep.children.length > 1) {
        return nextStep.children[1]; // ELSE 分支
      }
    }

    return nextStep;
  }
}

/**
 * 简单条件求值器 (支持基本比较操作 + AND/OR 逻辑)
 */
function evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
  // 支持 OR: "A || B"
  if (condition.includes("||")) {
    const parts = condition.split("||");
    return parts.some((part) => evaluateCondition(part.trim(), context));
  }

  // 支持 AND: "A && B"
  if (condition.includes("&&")) {
    const parts = condition.split("&&");
    return parts.every((part) => evaluateCondition(part.trim(), context));
  }

  // 支持: "key == value", "key != value", "key contains value", "key exists"
  const eqMatch = condition.match(/(\w+)\s*==\s*(.+)/);
  if (eqMatch) {
    const key = eqMatch[1].trim();
    const expected = eqMatch[2].trim().replace(/['"]/g, "");
    return String(context[key]) === expected;
  }

  const neqMatch = condition.match(/(\w+)\s*!=\s*(.+)/);
  if (neqMatch) {
    const key = neqMatch[1].trim();
    const expected = neqMatch[2].trim().replace(/['"]/g, "");
    return String(context[key]) !== expected;
  }

  const containsMatch = condition.match(/(\w+)\s+contains\s+(.+)/);
  if (containsMatch) {
    const key = containsMatch[1].trim();
    const search = containsMatch[2].trim().replace(/['"]/g, "");
    return String(context[key]).includes(search);
  }

  const existsMatch = condition.match(/(\w+)\s+exists/);
  if (existsMatch) {
    const key = existsMatch[1].trim();
    return context[key] !== undefined && context[key] !== null;
  }

  return false;
}

/**
 * 假设管理 — 科学验证态度
 */
export class HypothesisManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * 提出新假设
   */
  propose(nodeId: string, claim: string, verificationPlan?: string): void {
    const node = this.db.prepare(
      "SELECT * FROM knowledge_node WHERE node_id = ?"
    ).get(nodeId) as Record<string, unknown> | undefined;

    if (!node) return;

    const hypothesis: Hypothesis = {
      claim,
      supportingEvidence: [],
      contradictingEvidence: [],
      status: "untested",
      verificationPlan,
      proposedAt: Date.now(),
    };

    this.db.prepare(`
      UPDATE knowledge_node SET paradigm = 'hypothesis', hypothesis = ? WHERE node_id = ?
    `).run(JSON.stringify(hypothesis), nodeId);
  }

  /**
   * 添加证据
   */
  addEvidence(nodeId: string, evidence: string, supports: boolean): void {
    const row = this.db.prepare(
      "SELECT hypothesis FROM knowledge_node WHERE node_id = ?"
    ).get(nodeId) as { hypothesis: string } | undefined;

    if (!row?.hypothesis) return;

    let hypothesis: Hypothesis;
    try {
      hypothesis = JSON.parse(row.hypothesis);
    } catch {
      // 损坏行无法追加证据：跳过该条，不拖垮调用方
      return;
    }
    if (supports) {
      hypothesis.supportingEvidence.push(evidence);
    } else {
      hypothesis.contradictingEvidence.push(evidence);
    }

    // 自动更新状态（净证据占优判定，避免"曾有支持证据即永久无法驳斥"）
    const s = hypothesis.supportingEvidence.length;
    const c = hypothesis.contradictingEvidence.length;
    if (s >= 3 && s > c) {
      hypothesis.status = "confirmed";
    } else if (c >= 3 && c > s) {
      hypothesis.status = "refuted";
    } else if (s > 0 || c > 0) {
      hypothesis.status = "testing";
    }

    this.db.prepare(`
      UPDATE knowledge_node SET hypothesis = ?, confidence = ? WHERE node_id = ?
    `).run(
      JSON.stringify(hypothesis),
      this.calculateHypothesisConfidence(hypothesis),
      nodeId
    );
  }

  /**
   * 获取所有待验证假设
   */
  getUntested(): KnowledgeNode[] {
    // 不在 SQL 层做 json_extract 过滤：单条损坏 JSON 会令整个查询抛错。
    // 改为取出全部 hypothesis 行，按行解析并跳过损坏/非 untested 条目。
    const rows = this.db.prepare(`
      SELECT * FROM knowledge_node WHERE paradigm = 'hypothesis'
      ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;

    const out: KnowledgeNode[] = [];
    for (const row of rows) {
      let hypothesis: Hypothesis;
      try {
        hypothesis = JSON.parse(row.hypothesis as string);
      } catch {
        continue;
      }
      if (hypothesis.status !== "untested") continue;
      out.push({
        nodeId: row.node_id as string,
        title: row.title as string,
        content: row.content as string,
        contentHash: row.content_hash as string,
        schemaVersion: row.schema_version as number,
        domain: row.domain as string,
        paradigm: "hypothesis" as const,
        confidence: row.confidence as number,
        sourceType: row.source_type as KnowledgeNode["sourceType"],
        sourceUri: row.source_uri as string | undefined,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
        revision: row.revision as number,
        isVerified: (row.is_verified as number) === 1,
        hypothesis,
      });
    }
    return out;
  }

  /**
   * 计算假设置信度
   */
  private calculateHypothesisConfidence(hypothesis: Hypothesis): number {
    const total = hypothesis.supportingEvidence.length + hypothesis.contradictingEvidence.length;
    if (total === 0) return 0.5;
    return hypothesis.supportingEvidence.length / total;
  }
}
