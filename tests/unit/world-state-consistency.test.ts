import { describe, it, expect, beforeEach } from "bun:test";
import { worldState, BELIEF_HISTORY_MAX } from "../../src/dre/runtime/world-state.js";

/** 每个用例前清空信念相关路径，避免用例间互相污染（worldState 是单例） */
function reset(): void {
  worldState.set("mental.beliefs", {});
  worldState.set("mental.beliefHistory", []);
}

describe("WorldState 一致性（审计修复）", () => {
  beforeEach(reset);

  describe("信念不再静默覆盖历史", () => {
    it("首次写入 revision = 1，并记录一条 transition", () => {
      worldState.setBelief("b1", "天空是蓝的", 0.8);
      const beliefs = worldState.getBeliefs();
      expect(beliefs.b1.statement).toBe("天空是蓝的");
      expect(beliefs.b1.revision).toBe(1);

      const hist = worldState.getBeliefHistory("b1");
      expect(hist).toHaveLength(1);
      expect(hist[0].from).toBeUndefined();
      expect(hist[0].to.statement).toBe("天空是蓝的");
    });

    it("同一 id 再写入 ⇒ revision 递增且留下 from→to 记录（此前是静默覆盖）", () => {
      worldState.setBelief("b1", "天空是蓝的", 0.8);
      worldState.setBelief("b1", "天空是绿的", 0.3);

      const b = worldState.getBeliefs().b1;
      expect(b.statement).toBe("天空是绿的");
      expect(b.revision).toBe(2);

      const hist = worldState.getBeliefHistory("b1");
      expect(hist).toHaveLength(2);
      // 关键：能看出它被翻转过，而不是"一直如此"
      expect(hist[1].from?.statement).toBe("天空是蓝的");
      expect(hist[1].from?.confidence).toBe(0.8);
      expect(hist[1].to.statement).toBe("天空是绿的");
    });

    it("重复写入完全相同的内容不刷历史，但仍递增 revision", () => {
      worldState.setBelief("b1", "不变", 0.5);
      worldState.setBelief("b1", "不变", 0.5);
      expect(worldState.getBeliefHistory("b1")).toHaveLength(1);
      expect(worldState.getBeliefs().b1.revision).toBe(2);
    });

    it("历史有界：不超过 BELIEF_HISTORY_MAX", () => {
      for (let i = 0; i < BELIEF_HISTORY_MAX + 20; i++) {
        worldState.setBelief("b1", `语句 ${i}`, 0.5);
      }
      const hist = worldState.getBeliefHistory();
      expect(hist.length).toBeLessThanOrEqual(BELIEF_HISTORY_MAX);
      // 保留的是最近的
      expect(hist[hist.length - 1].to.statement).toBe(`语句 ${BELIEF_HISTORY_MAX + 19}`);
    });
  });

  describe("稳定 tie-breaker（此前顺序随插入变化）", () => {
    it("按 confidence 降序、其次 beliefId 升序 —— 与插入顺序无关", () => {
      // 故意以相反的顺序插入
      worldState.setBelief("zzz", "低", 0.2);
      worldState.setBelief("aaa", "高", 0.9);
      worldState.setBelief("mmm", "并列", 0.2);

      const sorted = worldState.getBeliefsSorted();
      expect(sorted.map((b) => b.beliefId)).toEqual(["aaa", "mmm", "zzz"]);
    });

    it("同一份状态两次读取给出完全相同的顺序（可复现）", () => {
      worldState.setBelief("b", "x", 0.5);
      worldState.setBelief("a", "y", 0.5);
      const first = worldState.getBeliefsSorted().map((b) => b.beliefId);
      worldState.setBelief("b", "x", 0.5); // 重写一条，不应改变顺序
      const second = worldState.getBeliefsSorted().map((b) => b.beliefId);
      expect(second).toEqual(first);
      expect(first).toEqual(["a", "b"]);
    });

    it("confidence 并列且 id 相同前缀时仍确定（localeCompare 兜底）", () => {
      worldState.setBelief("item-10", "x", 0.5);
      worldState.setBelief("item-2", "y", 0.5);
      const ids = worldState.getBeliefsSorted().map((b) => b.beliefId);
      expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    });
  });

  describe("入参校验（此前 NaN/越界值被照单全收）", () => {
    it("confidence 为 NaN / Infinity / 越界 ⇒ 抛错", () => {
      expect(() => worldState.setBelief("b", "s", NaN)).toThrow(/confidence/);
      expect(() => worldState.setBelief("b", "s", Infinity)).toThrow(/confidence/);
      expect(() => worldState.setBelief("b", "s", -0.1)).toThrow(/confidence/);
      expect(() => worldState.setBelief("b", "s", 1.5)).toThrow(/confidence/);
    });

    it("空 id / 空 statement ⇒ 抛错", () => {
      expect(() => worldState.setBelief("", "s", 0.5)).toThrow(/beliefId/);
      expect(() => worldState.setBelief("  ", "s", 0.5)).toThrow(/beliefId/);
      expect(() => worldState.setBelief("b", "", 0.5)).toThrow(/statement/);
    });

    it("非法 status ⇒ 抛错（goal / hypothesis）", () => {
      expect(() => worldState.setGoal("g", "d", "nonsense" as never)).toThrow(/status/);
      expect(() => worldState.setHypothesis("h", "s", "nonsense" as never)).toThrow(/status/);
    });

    it("setIntent 同样校验", () => {
      expect(() => worldState.setIntent("i", Number.NaN)).toThrow(/confidence/);
      expect(() => worldState.setIntent("", 0.5)).toThrow(/intent/);
    });

    it("合法边界值 0 与 1 允许", () => {
      expect(() => worldState.setBelief("b0", "s", 0)).not.toThrow();
      expect(() => worldState.setBelief("b1", "s", 1)).not.toThrow();
    });
  });
});
