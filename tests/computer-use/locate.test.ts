/**
 * 无头定位测试 — 过滤纯函数
 */
import { describe, it, expect } from "bun:test";
import { filterElementsByQuery } from "../../src/computer-use/locate.js";
import type { InteractiveElement } from "../../src/crawl/lightpanda-client.js";

const els: InteractiveElement[] = [
  { index: 0, tag: "button", text: "保存", role: "button", x: 0, y: 0, width: 100, height: 40, centerX: 50, centerY: 20, visible: true, attrs: { id: "save" } },
  { index: 1, tag: "button", text: "取消", role: "button", x: 110, y: 0, width: 100, height: 40, centerX: 160, centerY: 20, visible: true, attrs: {} },
  { index: 2, tag: "input", text: "", role: "input", x: 0, y: 60, width: 300, height: 36, centerX: 150, centerY: 78, visible: true, attrs: { placeholder: "搜索" } },
];

describe("filterElementsByQuery", () => {
  it("按文本子串过滤（大小写不敏感，含 attrs）", () => {
    const m = filterElementsByQuery(els, { text: "保存" });
    expect(m.length).toBe(1);
    expect(m[0].index).toBe(0);
    expect(m[0].bbox).toEqual({ x: 0, y: 0, width: 100, height: 40, centerX: 50, centerY: 20 });
    // attrs 也参与匹配（placeholder=搜索）
    const m2 = filterElementsByQuery(els, { text: "搜索" });
    expect(m2.length).toBe(1);
    expect(m2[0].index).toBe(2);
  });
  it("按 role / tag / index 过滤", () => {
    expect(filterElementsByQuery(els, { role: "button" }).length).toBe(2);
    expect(filterElementsByQuery(els, { tag: "input" }).length).toBe(1);
    expect(filterElementsByQuery(els, { index: 1 }).length).toBe(1);
  });
  it("组合条件取交集", () => {
    expect(filterElementsByQuery(els, { role: "button", text: "取消" }).length).toBe(1);
    expect(filterElementsByQuery(els, { role: "input", text: "保存" }).length).toBe(0);
  });
});
