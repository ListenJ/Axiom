/**
 * 整改 D2（2026-08-25）——nvidia-smi 可选探测插件
 *
 * 契约：
 *  - parseNvidiaSmiOutput(text): number | null —— 取第一个 GPU 的
 *    memory.free MiB 整数；空文本/垃圾文本/非整数值一律 null。
 *  - startVramProbe(opts?)：env AXIOM_VRAM_PROBE=1 才启动，否则返回 no-op
 *    stop 且不启动定时器；成功解析后写入 ResourceBudgetManager 的
 *    availableMemory；stop 后不再轮询。
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  parseNvidiaSmiOutput,
  startVramProbe,
} from "../../src/dre/system-resource-probe.js";
import { getResourceBudgetManager } from "../../src/dre/system-resource.js";

describe("parseNvidiaSmiOutput 表驱动（D2）", () => {
  test.each([
    ["单卡正常输出", "12288\n", 12288],
    ["Windows CRLF", "24576\r\n", 24576],
    ["多卡取第一块", "12288\n8192\n4096\n", 12288],
    ["带空白缩进", "  8192  \n", 8192],
    ["无换行单值", "16384", 16384],
    ["垃圾文本", "NVIDIA-SMI has failed because there are no devices", null],
    ["空字符串", "", null],
    ["仅空白", "  \n \r\n", null],
    ["占位值 N/A", "[N/A]\n", null],
    ["权限不足占位", "[Insufficient Permissions]\n", null],
    ["小数不是合法整数", "8192.5\n", null],
    ["负数非法", "-5\n", null],
  ])("%s", (_label, input, expected) => {
    expect(parseNvidiaSmiOutput(input as string)).toBe(expected);
  });
});

describe("startVramProbe 门控与轮询（D2）", () => {
  const originalAvail = getResourceBudgetManager().getResource().availableMemory;

  afterEach(() => {
    delete process.env.AXION_VRAM_PROBE;
    getResourceBudgetManager().updateResource({ availableMemory: originalAvail });
  });

  test("AXIOM_VRAM_PROBE 未设 → 返回 no-op stop 且完全不轮询", async () => {
    let calls = 0;
    const stop = startVramProbe({
      intervalMs: 10,
      exec: async () => {
        calls++;
        return { stdout: "1024\n" };
      },
    });
    stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
  });

  test("AXIOM_VRAM_PROBE=1 → 注入 fake exec 轮询生效且 updateResource 生效，停止后不再轮询", async () => {
    process.env.AXIOM_VRAM_PROBE = "1";
    let calls = 0;
    const stop = startVramProbe({
      intervalMs: 10,
      exec: async () => {
        calls++;
        return { stdout: "1024\n" };
      },
    });

    try {
      // 等待至少 3 次调用（首次立即 + 轮询）
      const deadline = Date.now() + 2000;
      while (calls < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(calls).toBeGreaterThanOrEqual(3);
      // 1024 与默认 4000 差异远超 5% 防抖阈值 → 首次更新即生效
      expect(getResourceBudgetManager().getResource().availableMemory).toBe(1024);
    } finally {
      stop();
    }

    // stop 后不再轮询
    const afterStop = calls;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(afterStop);
  });
});
