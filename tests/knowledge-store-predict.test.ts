// 回归测试：BehaviorKnowledge.predict 不就地修改共享 outcomes 数组（FIX C）
//
// 缺陷：behavior.outcomes.sort(...) 会就地排序传入对象上的数组，若该对象被复用/持久化，
// 其顺序会被悄悄改变。修复后用副本排序。
import { test, expect } from "bun:test";
import { BehaviorKnowledge } from "../src/dre/storage/knowledge-store.ts";

test("predict 不就地修改共享 outcomes 顺序", () => {
  const behavior = {
    outcomes: [
      { result: "low", probability: 0.3 },
      { result: "high", probability: 0.9 },
    ],
    preconditions: [],
  };

  const r = BehaviorKnowledge.predict(behavior as any, {});

  expect(r.predicted).toBe(true);
  expect(r.outcome).toBe("high");
  expect(r.probability).toBeCloseTo(0.9);
  // 关键断言：传入对象的 outcomes 顺序未被就地排序破坏
  expect(behavior.outcomes.map((o) => o.result)).toEqual(["low", "high"]);
});
