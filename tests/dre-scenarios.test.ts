/**
 * DRE 真实使用场景测试（更深覆盖）
 *
 * 场景：
 *   A. 宿主集成开关：AXIOM_DRE_ENABLED=0 → initDreKernel 返回 null
 *   B. 知识写入闭环：writeKnowledge(低风险事实) → 通过预筛直接入库 →
 *      searchData 检索命中 → getCognitiveState 状态可查
 *   C. LLM 降级链：无本地 LLM/无云 key + DRE_GAP_FILL_FINE=0 →
 *      runWithLLM 落回 deterministic/rule（零 LLM token）
 *   D. 跨会话记忆：会话 A 写入 blackboard → 会话 B 读取命中
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import { initDreKernel, shutdownDreKernel } from "../src/dre/host.js";
import { CognitivePipeline } from "../src/dre/index.js";
import { writeFact, readFact, getGlobalBlackboard } from "../src/memory/blackboard.js";

const DB = ".tmp/dre-scenarios.db";
const OLD: Record<string, string | undefined> = {};

function saveEnv(k: string) {
  OLD[k] = process.env[k];
}
function restoreEnv(k: string) {
  if (OLD[k] === undefined) delete process.env[k];
  else process.env[k] = OLD[k];
}

describe("A. DRE 宿主集成开关", () => {
  beforeAll(async () => {
    await shutdownDreKernel();
    saveEnv("AXIOM_DRE_ENABLED");
    process.env.AXIOM_DRE_ENABLED = "0";
  });
  afterAll(async () => {
    restoreEnv("AXIOM_DRE_ENABLED");
  });
  it("AXIOM_DRE_ENABLED=0 时 initDreKernel 返回 null 且不启动 Kernel", async () => {
    const k = await initDreKernel();
    expect(k).toBeNull();
  });
});

describe("B+C. DRE 知识闭环与 LLM 降级链", () => {
  beforeAll(async () => {
    await shutdownDreKernel();
    saveEnv("DRE_DB_PATH");
    saveEnv("DRE_LLM_URL");
    saveEnv("DRE_AUTO_TICK");
    saveEnv("DRE_GAP_FILL_FINE");
    saveEnv("DEEPSEEK_API_KEY");
    process.env.DRE_DB_PATH = DB;
    process.env.DRE_LLM_URL = "http://127.0.0.1:8080"; // 本地 llama.cpp（不可达 → 降级）
    process.env.DRE_AUTO_TICK = "0";
    process.env.DRE_GAP_FILL_FINE = "0";
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(async () => {
    await shutdownDreKernel();
    for (const k of ["DRE_DB_PATH", "DRE_LLM_URL", "DRE_AUTO_TICK", "DRE_GAP_FILL_FINE", "DEEPSEEK_API_KEY"]) restoreEnv(k);
    for (const p of [DB, `${DB}-shm`, `${DB}-wal`]) {
      try { fs.rmSync(p); } catch { /* ignore */ }
    }
  });

  it("B. 低风险知识写入 → 预筛入库 → 检索命中 → 认知状态可查", async () => {
    const k = await initDreKernel();
    expect(k).not.toBeNull();
    const dre = k!.getEngine();
    const id = `kb-scenario-${Date.now()}`;
    const write = await dre.writeKnowledge({
      id,
      title: "地球自转周期",
      content: "地球绕自身轴自转一周大约需要 23 小时 56 分，这是基本的天文事实。",
      domain: "science",
      paradigm: "fact",
      sourceType: "manual",
    });
    expect(write.accepted).toBe(true);
    const search = await dre.searchData("地球自转", { limit: 5 });
    expect(search.atoms.length + search.knowledgeNodes.length).toBeGreaterThan(0);
    const state = dre.getCognitiveState();
    expect(state.persona).toBeDefined();
    expect(state.consciousness).toBeDefined();
    expect(state.reasoning).toBeDefined();
  });

  it("C. 无 LLM 环境下 runWithLLM 降级到 deterministic/rule 且完成 6 阶段", async () => {
    const k = await initDreKernel();
    expect(k).not.toBeNull();
    const pipeline = new CognitivePipeline(k!.getEngine());
    const res = await pipeline.runWithLLM("分析知识库检索模块的性能瓶颈");
    expect(["deterministic", "rule"] as string[]).toContain(res.fallbackLevel as string);
    expect((res.trace ?? []).map((s) => s.stage)).toEqual([
      "classify", "knowledge", "reasoning", "constraint", "action", "reflection",
    ]);
  });
});

describe("D. 跨会话记忆（blackboard）", () => {
  beforeEach(() => {
    getGlobalBlackboard().clear();
  });
  afterEach(() => {
    getGlobalBlackboard().clear();
  });
  it("会话 A 写入实验进度 → 会话 B 读取命中（同工作区全量记忆）", () => {
    writeFact("exp:progress", { step: "P0", done: true, note: "DRE apiKey 已接线" }, "session-A");
    const read = readFact("exp:progress");
    expect(read.hit).toBe(true);
    expect(read.entry?.value).toEqual({ step: "P0", done: true, note: "DRE apiKey 已接线" });
  });
});

