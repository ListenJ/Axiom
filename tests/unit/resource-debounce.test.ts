import { describe, test, expect } from "bun:test";
import { ResourceBudgetManager } from "../../src/dre/system-resource";

/**
 * Task 8 — H-07 防抖：1299↔1301 抖动无防抖
 * src/dre/system-resource.ts:75 VRAM 估算阈值抖动
 * 修复要求：变化<5% 过滤（阈值防抖），输出稳定
 */

describe("resource-debounce H-07", () => {
  test("1299↔1301 抖动应被防抖，输出稳定", () => {
    const mgr = new ResourceBudgetManager({
      resource: { availableMemory: 4000, maxMemory: 4000 },
    });
    // required = 1100+200=1300，1299 为不可运行阈值下，1301 为可运行
    mgr.updateResource({ availableMemory: 1299 });
    const firstCanRun = mgr.canRun().canRun;
    const firstMem = mgr.getResource().availableMemory;
    expect(firstCanRun).toBe(false);
    expect(firstMem).toBe(1299);

    mgr.updateResource({ availableMemory: 1301 });
    const secondCanRun = mgr.canRun().canRun;
    const secondMem = mgr.getResource().availableMemory;

    // 未防抖时：1301 会使 canRun 翻转为 true（抖动）-> 此断言 FAIL
    // 防抖后：变化 2/1299≈0.15% <5% 被忽略，应保持 1299 且 canRun 仍 false -> PASS
    expect(secondCanRun).toBe(firstCanRun);
    expect(secondMem).toBe(1299);
  });

  test("变化<5% 应被忽略，保持稳定值", () => {
    const mgr = new ResourceBudgetManager({
      resource: { availableMemory: 2000, maxMemory: 4000 },
    });
    mgr.updateResource({ availableMemory: 2000 });
    // 2000 -> 2050 约 2.5% <5% 应被忽略
    mgr.updateResource({ availableMemory: 2050 });
    expect(mgr.getResource().availableMemory).toBe(2000);

    // 2000 -> 2099 约 4.95% 仍 <5% 忽略
    mgr.updateResource({ availableMemory: 2099 });
    expect(mgr.getResource().availableMemory).toBe(2000);
  });

  test("变化≥5% 应被接受", () => {
    const mgr = new ResourceBudgetManager({
      resource: { availableMemory: 2000, maxMemory: 4000 },
    });
    mgr.updateResource({ availableMemory: 2000 });
    // 2000 -> 2100 =5% 边界应接受（<5%才忽略）
    mgr.updateResource({ availableMemory: 2100 });
    expect(mgr.getResource().availableMemory).toBe(2100);

    // 2100 -> 3000 约42% 接受
    mgr.updateResource({ availableMemory: 3000 });
    expect(mgr.getResource().availableMemory).toBe(3000);

    // 大幅下降 3000->1000 约66% 接受且 canRun 翻转
    mgr.updateResource({ availableMemory: 1000 });
    expect(mgr.getResource().availableMemory).toBe(1000);
    expect(mgr.canRun().canRun).toBe(false);
  });

  test("连续抖动序列仍稳定", () => {
    const mgr = new ResourceBudgetManager({
      resource: { availableMemory: 4000, maxMemory: 4000 },
    });
    mgr.updateResource({ availableMemory: 1299 });
    expect(mgr.canRun().canRun).toBe(false);
    // 多次小幅抖动
    mgr.updateResource({ availableMemory: 1301 });
    mgr.updateResource({ availableMemory: 1299 });
    mgr.updateResource({ availableMemory: 1300 });
    mgr.updateResource({ availableMemory: 1301 });
    // 均 <5% 应保持最初稳定值 1299
    expect(mgr.getResource().availableMemory).toBe(1299);
    expect(mgr.canRun().canRun).toBe(false);
  });

  test("canRun 在阈值内不应翻转，阈值外应翻转", () => {
    const mgr = new ResourceBudgetManager({
      resource: { availableMemory: 4000, maxMemory: 4000 },
    });
    mgr.updateResource({ availableMemory: 2000 });
    expect(mgr.canRun().canRun).toBe(true);
    // 小幅下降 <5% 忽略，保持 true
    mgr.updateResource({ availableMemory: 1950 }); // -2.5%
    expect(mgr.canRun().canRun).toBe(true);
    expect(mgr.getResource().availableMemory).toBe(2000);
    // 大幅下降至临界下 >5% 应翻转
    mgr.updateResource({ availableMemory: 1299 });
    expect(mgr.canRun().canRun).toBe(false);
  });
});
