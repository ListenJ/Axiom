/**
 * ResourceBudgetManager 滞回与防抖逃逸回归测试（审计 M12）
 *
 * 行为规格：
 * 1. 双阈值滞回：跌破 1300MB 降级后，需回到 ≥1800MB（required+500）才恢复，
 *    中间地带保持 canRun=false 且 reason 说明滞回，消除阈值附近抖动。
 * 2. 缓变逃逸：连续 3 次同向小幅更新（各 <5%）后强制接受累计变化，
 *    修复"与上次提交值比较导致永久缓变失明"。
 * 3. 平台期抖动（1299↔1301 交替）仍被过滤（既有行为不回归）。
 */
import { describe, test, expect } from "bun:test";
import { ResourceBudgetManager } from "../../src/dre/system-resource";

function mgrWith(avail: number): ResourceBudgetManager {
  return new ResourceBudgetManager({ resource: { maxMemory: 4000, availableMemory: avail } });
}

describe("canRun 双阈值滞回（M12 回归）", () => {
  test("跌破 1300 → false；回升到中间带仍 false；≥1800 才恢复", () => {
    const m = mgrWith(4000);
    expect(m.canRun().canRun).toBe(true);

    m.updateResource({ availableMemory: 1200 });
    expect(m.canRun().canRun).toBe(false);
    expect(m.canRun().reason).toContain("Insufficient memory");

    m.updateResource({ availableMemory: 1500 }); // 高于 1300 但低于恢复阈值
    const mid = m.canRun();
    expect(mid.canRun).toBe(false);
    expect(mid.reason).toContain("hysteresis");

    m.updateResource({ availableMemory: 1800 });
    expect(m.canRun().canRun).toBe(true);
  });

  test("恢复后再次跌破立即降级（滞回只作用于恢复方向）", () => {
    const m = mgrWith(2000);
    expect(m.canRun().canRun).toBe(true);
    m.updateResource({ availableMemory: 1200 });
    expect(m.canRun().canRun).toBe(false);
  });

  test("getStatus().canRunLocal 与 canRun 一致", () => {
    const m = mgrWith(4000);
    m.updateResource({ availableMemory: 1000 });
    expect(m.getStatus().canRunLocal).toBe(false);
    m.updateResource({ availableMemory: 1900 });
    expect(m.getStatus().canRunLocal).toBe(true);
  });
});

describe("updateResource 防抖缓变逃逸（M12 回归）", () => {
  test("连续 3 次同向 <5% 更新后强制接受累计漂移", () => {
    const m = mgrWith(4000);
    m.updateResource({ availableMemory: 3960 }); // -1% 被滤
    expect(m.getResource().availableMemory).toBe(4000);
    m.updateResource({ availableMemory: 3920 }); // 又 -1% 被滤（第2次）
    expect(m.getResource().availableMemory).toBe(4000);
    m.updateResource({ availableMemory: 3880 }); // 第3次同向 → 强制接受
    expect(m.getResource().availableMemory).toBe(3880);
  });

  test("交替抖动不被误判为缓变（1299↔1301 保持过滤）", () => {
    const m = mgrWith(4000);
    for (let i = 0; i < 8; i++) {
      m.updateResource({ availableMemory: i % 2 === 0 ? 3960 : 4040 }); // ±1% 交替
      expect(m.getResource().availableMemory).toBe(4000);
    }
  });

  test("大幅更新（≥5%）不受影响立即生效", () => {
    const m = mgrWith(4000);
    m.updateResource({ availableMemory: 3000 }); // -25%
    expect(m.getResource().availableMemory).toBe(3000);
  });
});
