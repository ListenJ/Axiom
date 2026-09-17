import { describe, it, expect, beforeEach } from "bun:test";
import { atomStore } from "../../src/dre/runtime/atom-engine.js";

/**
 * DRE 检索升级（T3 步骤 1.2 切片 3）
 *
 * 原实现为朴素子串匹配：整串 `content.toLowerCase().includes(query)` +
 * 凑够 limit 即 break。以下用例逐条对应它的三个缺陷。
 *
 * 注意：atomStore 是单例，用例内使用唯一前缀避免相互污染。
 */
const P = `tr${Date.now().toString(36)}`;

function add(content: string): string {
  return atomStore.create("fact", content).id;
}

describe("DRE atomStore.search 检索升级", () => {
  beforeEach(() => {
    // 清掉本套用例此前创建的原子（只删自己的，避免影响其他用例）
    for (const a of atomStore.queryByKind("fact")) {
      if (a.content.startsWith(P)) atomStore.delete(a.id);
    }
  });

  it("缺陷1：空格分隔的中文查询能命中连写内容（原 includes 必然 0 结果）", () => {
    const id = add(`${P} 确定性检索引擎的设计与实现`);
    const hits = atomStore.search(`${P} 确定性 检索`);
    expect(hits.map((a) => a.id)).toContain(id);
  });

  it("缺陷2：结果按相关性排序，而非插入顺序", () => {
    // 先插入弱相关，再插入强相关；原实现会先返回弱相关
    const weak = add(`${P} 引擎概述`);
    const strong = add(`${P} 确定性检索 确定性检索 引擎`);
    const hits = atomStore.search(`${P} 确定性检索`);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].id).toBe(strong);
    expect(hits.findIndex((a) => a.id === strong)).toBeLessThan(
      hits.findIndex((a) => a.id === weak),
    );
  });

  it("缺陷3：不因凑够 limit 提前 break（更相关的项在后也不能漏）", () => {
    // 插入大量弱相关项把 limit 占满，最后才放强相关项
    for (let i = 0; i < 5; i++) add(`${P} 无关内容占位 ${i}`);
    const strong = add(`${P} 确定性检索 确定性检索`);
    const hits = atomStore.search(`${P} 确定性检索`, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(strong);
  });

  it("确定性：同一查询两次调用给出完全相同的顺序", () => {
    add(`${P} alpha 确定性检索`);
    add(`${P} beta 确定性检索`);
    const a = atomStore.search(`${P} 确定性检索`).map((x) => x.id);
    const b = atomStore.search(`${P} 确定性检索`).map((x) => x.id);
    expect(a).toEqual(b);
  });

  it("无关查询不匹配该原子（不返回它）", () => {
    const id = add(`${P} 确定性检索引擎`);
    // 注意：查询里**不能**再带 P 前缀 —— 前缀本身也是一个 token，会与内容匹配上
    // （这是正确行为，第一版测试误把它当成"无关查询"）。这里只断言目标原子不在结果里。
    const hits = atomStore.search("zzzq-nonexistent-topic-xyz");
    expect(hits.map((a) => a.id)).not.toContain(id);
  });

  it("limit 生效且不超量", () => {
    for (let i = 0; i < 4; i++) add(`${P} 检索 ${i}`);
    expect(atomStore.search(`${P} 检索`, 2).length).toBeLessThanOrEqual(2);
  });

  it("空查询返回空数组且不抛错", () => {
    expect(() => atomStore.search("")).not.toThrow();
    expect(atomStore.search("")).toHaveLength(0);
  });
});
