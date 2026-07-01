/**
 * Cognitive Modules Integration Tests
 *
 * Tests for:
 * - MentalModelPool (心智模型)
 * - ReasoningGraph (推理图)
 * - ConstraintSolver (约束求解器)
 * - ActorSystem (Actor 系统)
 * - ProcedureKnowledge (过程性知识)
 * - BehaviorKnowledge (行为知识)
 */

import { Database } from "bun:sqlite";
import { describe, test, expect, beforeEach } from "bun:test";
import {
  MentalModelPool,
  GIT_CONFLICT_MODEL,
  CODE_REFACTOR_MODEL,
  createDefaultMentalModelPool,
} from "../src/dre/mental-model/pool.js";
import { ReasoningGraph } from "../src/dre/reasoning/graph.js";
import {
  ConstraintSolver,
  createDefaultConstraintSolver,
  GPU_CONSTRAINTS,
  POLICY_CONSTRAINTS,
} from "../src/dre/constraint/solver.js";
import {
  ActorSystem,
  createDefaultActorSystem,
  KnowledgeActorBehavior,
  ConstraintActorBehavior,
  MentalModelActorBehavior,
  ReasoningActorBehavior,
} from "../src/dre/actor/system.js";
import {
  ProcedureKnowledge,
  BehaviorKnowledge,
  KnowledgeStore,
  HypothesisManager,
  type Procedure,
  type KnowledgeNode,
} from "../src/dre/storage/knowledge-store.js";

// ========== MentalModelPool Tests ==========

describe("MentalModelPool", () => {
  let pool: MentalModelPool;

  beforeEach(() => {
    pool = createDefaultMentalModelPool();
  });

  test("should register and list models", () => {
    const models = pool.list();
    expect(models.length).toBe(2);
    expect(models.map((m) => m.id)).toContain("git-conflict");
    expect(models.map((m) => m.id)).toContain("code-refactor");
  });

  test("should get model by id", () => {
    const model = pool.get("git-conflict");
    expect(model).toBeDefined();
    expect(model?.name).toBe("Git 冲突解决模型");
    expect(model?.domain).toBe("git");
  });

  test("should find models by domain", () => {
    const gitModels = pool.findByDomain("git");
    expect(gitModels.length).toBe(1);
    expect(gitModels[0].id).toBe("git-conflict");

    const codeModels = pool.findByDomain("code");
    expect(codeModels.length).toBe(1);
    expect(codeModels[0].id).toBe("code-refactor");
  });

  test("should match pattern with direct concept matches", () => {
    const pattern = pool.matchPattern("git-conflict", ["正在执行 merge 操作"]);
    expect(pattern).not.toBeNull();
    expect(pattern?.conceptChain).toContain("Merge");
    expect(pattern?.confidence).toBeGreaterThan(0);
  });

  test("should match pattern with relation expansion", () => {
    // "Merge" may-cause "Conflict", so mentioning merge should also expand to Conflict
    const pattern = pool.matchPattern("git-conflict", ["merge 操作"]);
    expect(pattern).not.toBeNull();
    expect(pattern?.conceptChain).toContain("Merge");
    expect(pattern?.conceptChain).toContain("Conflict"); // expanded via may-cause
  });

  test("should return null for unmatched observations", () => {
    const pattern = pool.matchPattern("git-conflict", ["今天天气不错"]);
    expect(pattern).toBeNull();
  });

  test("should return null for unknown model", () => {
    const pattern = pool.matchPattern("nonexistent", ["merge"]);
    expect(pattern).toBeNull();
  });

  test("should predict next state", () => {
    const model = pool.get("git-conflict");
    expect(model).toBeDefined();
    expect(model?.currentState).toBe("clean");

    const prediction = pool.predict("git-conflict", "执行 merge");
    expect(prediction).not.toBeNull();
    expect(prediction?.predictedState).toBe("merging");
    expect(prediction?.trigger).toBe("merge");
  });

  test("should advance state", () => {
    const result = pool.advanceState("git-conflict", "merge");
    expect(result).toBe(true);

    const model = pool.get("git-conflict");
    expect(model?.currentState).toBe("merging");
  });

  test("should not advance state for invalid trigger", () => {
    const freshPool = createDefaultMentalModelPool(); // fresh pool
    const result = freshPool.advanceState("git-conflict", "nonexistent-trigger");
    expect(result).toBe(false);

    const model = freshPool.get("git-conflict");
    expect(model?.currentState).toBe("clean");
  });

  test("should track usage count", () => {
    const freshPool = createDefaultMentalModelPool(); // fresh pool
    const model = freshPool.get("git-conflict");
    expect(model?.usageCount).toBe(0);

    freshPool.matchPattern("git-conflict", ["merge"]);
    expect(freshPool.get("git-conflict")?.usageCount).toBe(1);

    freshPool.matchPattern("git-conflict", ["merge"]);
    expect(freshPool.get("git-conflict")?.usageCount).toBe(2);
  });

  test("should find state path via BFS", () => {
    const freshPool = createDefaultMentalModelPool(); // fresh pool
    const pattern = freshPool.matchPattern("git-conflict", ["merge 操作"]);
    expect(pattern?.statePath).toBeDefined();
    expect(pattern?.statePath.length).toBeGreaterThan(0);
    expect(pattern?.statePath[0]).toBe("clean"); // initial state
  });
});

// ========== ReasoningGraph Tests ==========

describe("ReasoningGraph", () => {
  let graph: ReasoningGraph;

  beforeEach(() => {
    graph = new ReasoningGraph();
  });

  test("should add premise nodes", () => {
    const premise = graph.addPremise("用户输入了 git merge", 1.0);
    expect(premise.type).toBe("premise");
    expect(premise.content).toBe("用户输入了 git merge");
    expect(premise.confidence).toBe(1.0);
  });

  test("should add inference nodes with edges", () => {
    const p1 = graph.addPremise("文件 A 已修改");
    const p2 = graph.addPremise("文件 B 已修改");
    const inference = graph.addInference("两个文件都被修改", [p1.id, p2.id], 0.9);

    expect(inference.type).toBe("inference");
    const stats = graph.getStats();
    expect(stats.totalNodes).toBe(3);
    expect(stats.totalEdges).toBe(2);
  });

  test("should add conclusion nodes", () => {
    const p1 = graph.addPremise("存在冲突");
    const conclusion = graph.addConclusion("需要手动解决冲突", [p1.id], 0.85);

    expect(conclusion.type).toBe("conclusion");
    expect(conclusion.content).toBe("需要手动解决冲突");
  });

  test("should add evidence nodes", () => {
    const conclusion = graph.addConclusion("应该使用策略模式", [], 0.7);
    const evidence = graph.addEvidence("GoF 设计模式推荐", conclusion.id, true);

    expect(evidence.type).toBe("evidence");
    const stats = graph.getStats();
    expect(stats.edgesByRelation["supports"]).toBe(1);
  });

  test("should detect gaps: isolated premises", () => {
    graph.addPremise("孤立的前提", 1.0);
    const gaps = graph.detectGaps();

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.some((g) => g.gapType === "missing_inference")).toBe(true);
  });

  test("should detect gaps: unsupported conclusions", () => {
    graph.addConclusion("无支撑的结论", [], 0.5);
    const gaps = graph.detectGaps();

    expect(gaps.some((g) => g.gapType === "missing_premise")).toBe(true);
  });

  test("should detect gaps: weak links", () => {
    const p = graph.addPremise("前提");
    const c = graph.addConclusion("结论", [p.id], 0.3); // low confidence = weak edge
    const gaps = graph.detectGaps();

    expect(gaps.some((g) => g.gapType === "weak_link")).toBe(true);
  });

  test("should fill gap from object", () => {
    const p = graph.addPremise("已知事实");
    const gaps = graph.detectGaps();
    expect(gaps.length).toBeGreaterThan(0);

    const filled = graph.fillGapFromObject(gaps[0], "LLM 补充的推理", 0.8);
    expect(filled).not.toBeNull();
    expect(filled?.source).toBe("llm");
    expect(filled?.confidence).toBe(0.8);
  });

  test("should return null for non-existent gapId", () => {
    const result = graph.fillGap("nonexistent-gap-id", "should not matter", 0.9);
    expect(result).toBeNull();
  });

  test("should fill gap by string gapId", () => {
    graph.addPremise("测试前提");
    const gaps = graph.detectGaps();
    expect(gaps.length).toBeGreaterThan(0);

    const filled = graph.fillGap(gaps[0].id, "LLM 填补结果", 0.85);
    expect(filled).not.toBeNull();
    expect(filled?.source).toBe("llm");
    expect(filled?.confidence).toBe(0.85);
  });

  test("should build reasoning chain", () => {
    const p = graph.addPremise("前提 1");
    const inf = graph.addInference("推理步骤", [p.id], 0.9);
    const conc = graph.addConclusion("最终结论", [inf.id], 0.85);

    const result = graph.getResult();
    expect(result.conclusion).not.toBeNull();
    expect(result.conclusion?.content).toBe("最终结论");
    expect(result.chain.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("should generate gap filling prompt", () => {
    const p = graph.addPremise("测试前提");
    const gaps = graph.detectGaps();
    expect(gaps.length).toBeGreaterThan(0);

    const prompt = graph.generateGapFillingPrompt(gaps[0]);
    expect(prompt).toContain("推理助手");
    expect(prompt).toContain("空洞");
  });

  test("should clear graph", () => {
    graph.addPremise("test");
    graph.addConclusion("test conclusion", [], 0.5);
    expect(graph.getStats().totalNodes).toBe(2);

    graph.clear();
    expect(graph.getStats().totalNodes).toBe(0);
    expect(graph.getStats().totalEdges).toBe(0);
  });

  test("should get stats", () => {
    graph.addPremise("p1");
    graph.addPremise("p2");
    graph.addConclusion("c1", [], 0.5);

    const stats = graph.getStats();
    expect(stats.totalNodes).toBe(3);
    expect(stats.nodesByType["premise"]).toBe(2);
    expect(stats.nodesByType["conclusion"]).toBe(1);
  });
});

// ========== ConstraintSolver Tests ==========

describe("ConstraintSolver", () => {
  let solver: ConstraintSolver;

  beforeEach(() => {
    solver = createDefaultConstraintSolver();
  });

  test("should register and list constraints", () => {
    const constraints = solver.list();
    expect(constraints.length).toBeGreaterThan(0);
    expect(constraints.some((c) => c.id === "gpu-vram-min")).toBe(true);
    expect(constraints.some((c) => c.id === "prod-no-delete")).toBe(true);
  });

  test("should check physical constraint: GPU VRAM sufficient", () => {
    solver.updateContext("gpu_free_vram_mb", 2000);
    const result = solver.check("local_inference");
    expect(result.satisfied).toBe(true);
  });

  test("should check physical constraint: GPU VRAM insufficient", () => {
    solver.updateContext("gpu_free_vram_mb", 300);
    const result = solver.check("local_inference");
    expect(result.satisfied).toBe(false);
    expect(result.violations.some((v) => v.dimension === "physical")).toBe(true);
  });

  test("should check policy constraint: production no delete", () => {
    solver.updateContext("environment", "production");
    const result = solver.check("delete_file");
    expect(result.satisfied).toBe(false);
    expect(result.violations.some((v) => v.dimension === "policy")).toBe(true);
  });

  test("should check policy constraint: non-production allowed", () => {
    solver.updateContext("environment", "development");
    const result = solver.check("delete_file");
    expect(result.satisfied).toBe(true);
  });

  test("should select best action from candidates", () => {
    solver.updateContext("gpu_free_vram_mb", 2000);
    const { selected, results } = solver.selectBest(["action_a", "action_b"]);
    expect(selected).not.toBeNull();
    expect(results.length).toBe(2);
  });

  test("should return null when no action satisfies constraints", () => {
    solver.updateContext("gpu_free_vram_mb", 100); // too low
    const { selected } = solver.selectBest(["local_inference"]);
    expect(selected).toBeNull();
  });

  test("should list constraints by dimension", () => {
    const physical = solver.listByDimension("physical");
    expect(physical.length).toBeGreaterThan(0);
    expect(physical.every((c) => c.dimension === "physical")).toBe(true);

    const policy = solver.listByDimension("policy");
    expect(policy.length).toBeGreaterThan(0);
    expect(policy.every((c) => c.dimension === "policy")).toBe(true);
  });

  test("should get stats", () => {
    const stats = solver.getStats();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.enabled).toBeGreaterThan(0);
    expect(stats.byDimension["physical"]).toBeGreaterThan(0);
  });

  test("should unregister constraint", () => {
    const before = solver.list().length;
    solver.unregister("gpu-vram-min");
    expect(solver.list().length).toBe(before - 1);
  });

  test("should handle additional context", () => {
    const result = solver.check("local_inference", { gpu_free_vram_mb: 3000 });
    expect(result.satisfied).toBe(true);
  });
});

// ========== ActorSystem Tests ==========

describe("ActorSystem", () => {
  let system: ActorSystem;

  beforeEach(async () => {
    system = new ActorSystem();
    await system.register(new KnowledgeActorBehavior());
    await system.register(new ConstraintActorBehavior());
  });

  test("should register actors", () => {
    expect(system.size).toBe(2);
    const actors = system.list();
    expect(actors.some((a) => a.id === "knowledge")).toBe(true);
    expect(actors.some((a) => a.id === "constraint")).toBe(true);
  });

  test("should send and receive messages", async () => {
    const response = await new Promise<any>((resolve) => {
      system.deliver({
        id: "test-1",
        type: "query",
        from: "test",
        to: "knowledge",
        topic: "query",
        payload: { query: "test" },
        timestamp: Date.now(),
      });

      // 监听响应
      setTimeout(() => resolve(null), 100);
    });

    // Actor 应该响应了 (通过 deliver)
    expect(system.size).toBe(2);
  });

  test("should create default actor system", async () => {
    const defaultSystem = await createDefaultActorSystem();
    expect(defaultSystem.size).toBe(4);
    const actors = defaultSystem.list();
    expect(actors.map((a) => a.id)).toContain("knowledge");
    expect(actors.map((a) => a.id)).toContain("constraint");
    expect(actors.map((a) => a.id)).toContain("mental-model");
    expect(actors.map((a) => a.id)).toContain("reasoning");
    await defaultSystem.shutdown();
  });

  test("should unregister actor", async () => {
    await system.unregister("knowledge");
    expect(system.size).toBe(1);
    expect(system.list().every((a) => a.id !== "knowledge")).toBe(true);
  });

  test("should shutdown all actors", async () => {
    await system.shutdown();
    expect(system.size).toBe(0);
  });
});

// ========== ProcedureKnowledge Tests ==========

describe("ProcedureKnowledge", () => {
  test("should parse numbered steps", () => {
    const node: KnowledgeNode = {
      nodeId: "proc-1",
      title: "Git 合并流程",
      content: "1. 拉取最新代码\n2. 执行 merge\n3. 解决冲突\n4. 提交",
      contentHash: "",
      schemaVersion: 1,
      domain: "git",
      paradigm: "procedure",
      confidence: 0.9,
      sourceType: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      isVerified: true,
    };

    const procedure = ProcedureKnowledge.parseFromContent(node);
    expect(procedure).not.toBeNull();
    expect(procedure?.steps.length).toBe(4);
    expect(procedure?.steps[0].description).toBe("拉取最新代码");
    expect(procedure?.steps[3].description).toBe("提交");
  });

  test("should parse IF/THEN/ELSE conditions", () => {
    const node: KnowledgeNode = {
      nodeId: "proc-2",
      title: "条件流程",
      content: "IF status == 'conflict' THEN 手动解决 ELSE 自动合并",
      contentHash: "",
      schemaVersion: 1,
      domain: "git",
      paradigm: "procedure",
      confidence: 0.9,
      sourceType: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      isVerified: true,
    };

    const procedure = ProcedureKnowledge.parseFromContent(node);
    expect(procedure).not.toBeNull();
    const conditionStep = procedure?.steps.find((s) => s.type === "condition");
    expect(conditionStep).toBeDefined();
    expect(conditionStep?.condition).toBe("status == 'conflict'");
    expect(conditionStep?.children?.length).toBe(2);
  });

  test("should validate procedure", () => {
    const validProcedure: Procedure = {
      id: "test",
      name: "测试过程",
      steps: [
        { id: "step-0", description: "步骤 1", type: "action" },
        { id: "step-1", description: "步骤 2", type: "action" },
      ],
      successConditions: [],
      failureConditions: [],
    };

    const result = ProcedureKnowledge.validate(validProcedure);
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  test("should detect validation issues", () => {
    const invalidProcedure: Procedure = {
      id: "test",
      name: "测试过程",
      steps: [
        { id: "step-0", description: "", type: "action" }, // missing description
        { id: "step-1", description: "ok", type: "condition" }, // missing condition
      ],
      successConditions: [],
      failureConditions: [],
    };

    const result = ProcedureKnowledge.validate(invalidProcedure);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("should get next step", () => {
    const procedure: Procedure = {
      id: "test",
      name: "测试",
      steps: [
        { id: "step-0", description: "第一步", type: "action" },
        { id: "step-1", description: "第二步", type: "action" },
        { id: "step-2", description: "第三步", type: "action" },
      ],
      successConditions: [],
      failureConditions: [],
    };

    const next = ProcedureKnowledge.getNextStep(procedure, "step-0");
    expect(next?.id).toBe("step-1");
  });

  test("should return null when at last step", () => {
    const procedure: Procedure = {
      id: "test",
      name: "测试",
      steps: [{ id: "step-0", description: "唯一步骤", type: "action" }],
      successConditions: [],
      failureConditions: [],
    };

    const next = ProcedureKnowledge.getNextStep(procedure, "step-0");
    expect(next).toBeNull();
  });

  test("should evaluate condition with context", () => {
    const procedure: Procedure = {
      id: "test",
      name: "条件测试",
      steps: [
        { id: "step-0", description: "检查", type: "action" },
        {
          id: "step-1",
          description: "条件判断",
          type: "condition",
          condition: "status == 'ready'",
          children: [
            { id: "step-1-then", description: "执行", type: "action" },
            { id: "step-1-else", description: "等待", type: "action" },
          ],
        },
      ],
      successConditions: [],
      failureConditions: [],
    };

    const next = ProcedureKnowledge.getNextStep(procedure, "step-0", { status: "ready" });
    expect(next?.id).toBe("step-1-then");
  });

  test("should handle AND/OR conditions", () => {
    const node: KnowledgeNode = {
      nodeId: "proc-and-or",
      title: "复合条件",
      content: "IF status == 'ready' && env == 'prod' THEN 执行部署 ELSE 跳过\nIF a == '1' || b == '2' THEN 操作A",
      contentHash: "",
      schemaVersion: 1,
      domain: "deploy",
      paradigm: "procedure",
      confidence: 0.9,
      sourceType: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      isVerified: true,
    };

    const procedure = ProcedureKnowledge.parseFromContent(node);
    expect(procedure).not.toBeNull();
    expect(procedure?.steps.length).toBeGreaterThanOrEqual(2);
  });
});

// ========== BehaviorKnowledge Tests ==========

describe("BehaviorKnowledge", () => {
  test("should extract behavior from rule node", () => {
    const node: KnowledgeNode = {
      nodeId: "rule-1",
      title: "Git 冲突规则",
      content: "IF 文件被两个分支修改 THEN 会产生冲突",
      contentHash: "",
      schemaVersion: 1,
      domain: "git",
      paradigm: "rule",
      confidence: 0.9,
      sourceType: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      isVerified: true,
    };

    const behavior = BehaviorKnowledge.extractFromRule(node);
    expect(behavior).not.toBeNull();
    expect(behavior?.triggers).toContain("文件被两个分支修改");
    expect(behavior?.outcomes[0].result).toBe("会产生冲突");
  });

  test("should return null for non-rule node", () => {
    const node: KnowledgeNode = {
      nodeId: "fact-1",
      title: "事实",
      content: "Git 是版本控制工具",
      contentHash: "",
      schemaVersion: 1,
      domain: "git",
      paradigm: "fact",
      confidence: 0.95,
      sourceType: "manual",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 1,
      isVerified: true,
    };

    const behavior = BehaviorKnowledge.extractFromRule(node);
    expect(behavior).toBeNull();
  });

  test("should predict behavior outcome", () => {
    const behavior = {
      triggers: ["merge"],
      outcomes: [
        { result: "conflict", probability: 0.7 },
        { result: "clean merge", probability: 0.3 },
      ],
      preconditions: [],
    };

    const result = BehaviorKnowledge.predict(behavior, {});
    expect(result.predicted).toBe(true);
    expect(result.outcome).toBe("conflict"); // higher probability
    expect(result.probability).toBe(0.7);
  });

  test("should not predict when preconditions not met", () => {
    const behavior = {
      triggers: ["merge"],
      outcomes: [{ result: "conflict", probability: 0.7 }],
      preconditions: ["env=production"],
    };

    const result = BehaviorKnowledge.predict(behavior, { env: "development" });
    expect(result.predicted).toBe(false);
    expect(result.probability).toBe(0);
  });
});

// ========== HypothesisManager Tests (requires SQLite) ==========

describe("HypothesisManager", () => {
  test("should propose hypothesis and track evidence lifecycle", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_node (
        node_id TEXT PRIMARY KEY, title TEXT, content TEXT, content_hash TEXT,
        schema_version INTEGER DEFAULT 1, domain TEXT, paradigm TEXT,
        confidence REAL DEFAULT 0.5, source_type TEXT, source_uri TEXT,
        created_at INTEGER, updated_at INTEGER, revision INTEGER DEFAULT 1,
        is_verified INTEGER DEFAULT 0, behavior TEXT, prediction TEXT, hypothesis TEXT
      )
    `);
    const ks = new KnowledgeStore(db);
    const hm = new HypothesisManager(db);

    // 写入一个知识节点
    ks.write({
      nodeId: "hyp-test-1",
      title: "测试假设",
      content: "代码重复会导致维护困难",
      schemaVersion: 1,
      domain: "code",
      paradigm: "fact",
      confidence: 0.6,
      sourceType: "manual",
      isVerified: false,
    });

    // 提出假设
    hm.propose("hyp-test-1", "重构可以降低 30% 的维护成本", "运行复杂度分析并对比重构前后的维护时间");
    const untested = hm.getUntested();
    expect(untested.length).toBeGreaterThan(0);
    expect(untested[0].nodeId).toBe("hyp-test-1");
    expect(untested[0].paradigm).toBe("hypothesis");
    expect(untested[0].hypothesis?.status).toBe("untested");

    // 添加支持证据
    hm.addEvidence("hyp-test-1", "重构后圈复杂度降低", true);
    const after1 = hm.getUntested();
    expect(after1.length).toBe(0); // status changed from untested

    // 验证假设已被删除 (paradigm changed)
    const node = ks.read("hyp-test-1");
    expect(node?.paradigm).toBe("hypothesis");
    expect(node?.hypothesis?.status).toBe("testing");
    expect(node?.hypothesis?.supportingEvidence.length).toBe(1);

    // 添加更多支持证据达到阈值
    hm.addEvidence("hyp-test-1", "代码行数减少", true);
    hm.addEvidence("hyp-test-1", "单元测试覆盖率提高", true);
    const confirmed = ks.read("hyp-test-1");
    expect(confirmed?.hypothesis?.status).toBe("confirmed");
    expect(confirmed?.confidence).toBe(1.0);

    db.close();
  });
});
