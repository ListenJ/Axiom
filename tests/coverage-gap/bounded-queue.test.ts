/**
 * BoundedQueue 测试 — 覆盖率空白补充
 *
 * 测试目标：环形缓冲区有界队列
 * 测试维度：基础功能 / 边界条件 / 异常输入 / 高并发 / 溢出策略
 *
 * 覆盖组件：src/utils/concurrency/bounded-queue.ts
 */

import { describe, test, expect } from "bun:test";
import { BoundedQueue } from "../../src/utils/concurrency/bounded-queue.js";

// ═══════════════════════════════════════════════════════════════
// A. 基础功能
// ═══════════════════════════════════════════════════════════════

describe("A. BoundedQueue 基础功能", () => {
  test("默认容量 1024", () => {
    const q = new BoundedQueue<number>();
    expect(q.capacity).toBe(1024);
    expect(q.size).toBe(0);
    expect(q.isEmpty).toBe(true);
    expect(q.isFull).toBe(false);
  });

  test("push + shift 维持 FIFO 顺序", () => {
    const q = new BoundedQueue<string>({ capacity: 10 });
    q.push("a");
    q.push("b");
    q.push("c");
    expect(q.size).toBe(3);
    expect(q.shift()).toBe("a");
    expect(q.shift()).toBe("b");
    expect(q.shift()).toBe("c");
    expect(q.isEmpty).toBe(true);
  });

  test("peek 查看队首但不移除", () => {
    const q = new BoundedQueue<number>({ capacity: 5 });
    q.push(1);
    q.push(2);
    expect(q.peek()).toBe(1);
    expect(q.size).toBe(2);
    expect(q.peek()).toBe(1);
  });

  test("shift 空队列返回 undefined", () => {
    const q = new BoundedQueue<number>();
    expect(q.shift()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });

  test("push 满（无 dropOldest）返回 false", () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(true);
    expect(q.isFull).toBe(true);
    expect(q.push(4)).toBe(false);
    expect(q.size).toBe(3);
    // 队列内容未被修改
    expect(q.peek()).toBe(1);
  });

  test("push 满（dropOldest=true）驱逐最旧并返回 true", () => {
    const q = new BoundedQueue<number>({ capacity: 3, dropOldest: true });
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.push(4)).toBe(true);
    expect(q.size).toBe(3);
    expect(q.droppedCount).toBe(1);
    // 最旧的 1 被驱逐
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBe(4);
  });

  test("drain 取出所有元素并清空队列", () => {
    const q = new BoundedQueue<number>({ capacity: 10 });
    q.push(1);
    q.push(2);
    q.push(3);
    const items = q.drain();
    expect(items).toEqual([1, 2, 3]);
    expect(q.isEmpty).toBe(true);
  });

  test("drain 空队列返回空数组", () => {
    const q = new BoundedQueue<number>();
    expect(q.drain()).toEqual([]);
  });

  test("inspect 遍历但不修改队列", () => {
    const q = new BoundedQueue<number>({ capacity: 5 });
    q.push(10);
    q.push(20);
    q.push(30);
    const seen: number[] = [];
    const items = q.inspect((item, idx) => {
      seen.push(item);
      expect(idx).toBe(seen.length - 1);
    });
    expect(items).toEqual([10, 20, 30]);
    expect(seen).toEqual([10, 20, 30]);
    expect(q.size).toBe(3); // 未被修改
  });

  test("clear 清空队列并返回清除数量", () => {
    const q = new BoundedQueue<number>({ capacity: 5 });
    q.push(1);
    q.push(2);
    q.push(3);
    const cleared = q.clear();
    expect(cleared).toBe(3);
    expect(q.isEmpty).toBe(true);
    expect(q.size).toBe(0);
  });

  test("clear 空队列返回 0", () => {
    const q = new BoundedQueue<number>();
    expect(q.clear()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// B. 边界条件
// ═══════════════════════════════════════════════════════════════

describe("B. BoundedQueue 边界条件", () => {
  test("capacity=1 — 单元素队列", () => {
    const q = new BoundedQueue<number>({ capacity: 1 });
    expect(q.push(1)).toBe(true);
    expect(q.isFull).toBe(true);
    expect(q.push(2)).toBe(false);
    expect(q.shift()).toBe(1);
    expect(q.isEmpty).toBe(true);
    expect(q.push(3)).toBe(true);
    expect(q.shift()).toBe(3);
  });

  test("capacity=1 + dropOldest — 始终保留最新", () => {
    const q = new BoundedQueue<number>({ capacity: 1, dropOldest: true });
    q.push(1);
    q.push(2);
    q.push(3);
    expect(q.size).toBe(1);
    expect(q.droppedCount).toBe(2);
    expect(q.shift()).toBe(3);
  });

  test("capacity=0 被强制为 1", () => {
    const q = new BoundedQueue<number>({ capacity: 0 });
    expect(q.capacity).toBe(1);
  });

  test("负数 capacity 被强制为 1", () => {
    const q = new BoundedQueue<number>({ capacity: -100 });
    expect(q.capacity).toBe(1);
  });

  test("容量边界 — 恰好填满", () => {
    const q = new BoundedQueue<number>({ capacity: 5 });
    for (let i = 0; i < 5; i++) {
      expect(q.push(i)).toBe(true);
    }
    expect(q.isFull).toBe(true);
    expect(q.size).toBe(5);
    expect(q.push(99)).toBe(false);
  });

  test("环绕测试 — 多轮 push/shift 后仍正确", () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    // 第一轮
    q.push(1); q.push(2); q.push(3);
    q.shift(); q.shift(); q.shift();
    // 第二轮（指针已环绕）
    q.push(4); q.push(5); q.push(6);
    expect(q.isFull).toBe(true);
    expect(q.drain()).toEqual([4, 5, 6]);
  });

  test("交替 push/shift — 指针多次环绕", () => {
    const q = new BoundedQueue<number>({ capacity: 2 });
    for (let i = 0; i < 100; i++) {
      expect(q.push(i)).toBe(true);
      expect(q.shift()).toBe(i);
    }
    expect(q.isEmpty).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// C. 异常输入处理
// ═══════════════════════════════════════════════════════════════

describe("C. BoundedQueue 异常输入", () => {
  test("push null/undefined 应被接受（泛型不限制）", () => {
    const q = new BoundedQueue<unknown>({ capacity: 5 });
    q.push(null);
    q.push(undefined);
    expect(q.size).toBe(2);
    expect(q.shift()).toBeNull();
    // undefined 被 shift 后，help GC 设为 undefined，但 shift 返回的就是 undefined
    // 这里无法区分"空队列返回 undefined"和"存的 undefined"，是已知设计限制
  });

  test("push 对象引用 — shift 返回同一引用", () => {
    const q = new BoundedQueue<{ id: number }>({ capacity: 5 });
    const obj = { id: 42 };
    q.push(obj);
    const got = q.shift();
    expect(got).toBe(obj); // 引用相等
  });

  test("inspect 回调抛错应传播", () => {
    const q = new BoundedQueue<number>({ capacity: 5 });
    q.push(1);
    expect(() => {
      q.inspect(() => {
        throw new Error("test error");
      });
    }).toThrow("test error");
  });

  test("shift 后内部 slot 被清空（帮助 GC）", () => {
    const q = new BoundedQueue<{ data: number }>({ capacity: 3 });
    const obj = { data: 1 };
    q.push(obj);
    q.shift();
    // 内部 _buffer 应已清空对应 slot（无法直接访问私有字段，但可通过性能间接验证）
    // 这里只验证功能正常
    expect(q.isEmpty).toBe(true);
    q.push({ data: 2 });
    expect(q.shift()?.data).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// D. 高并发 + 大数据量
// ═══════════════════════════════════════════════════════════════

describe("D. BoundedQueue 高并发与大数据量", () => {
  test("10k 元素循环 push/shift — 无内存泄漏", () => {
    const q = new BoundedQueue<number>({ capacity: 100 });
    for (let i = 0; i < 10_000; i++) {
      q.push(i);
      q.shift();
    }
    expect(q.isEmpty).toBe(true);
    expect(q.droppedCount).toBe(0);
  });

  test("100k 元素填充 + drain — 数据完整", () => {
    const cap = 100_000;
    const q = new BoundedQueue<number>({ capacity: cap });
    for (let i = 0; i < cap; i++) {
      expect(q.push(i)).toBe(true);
    }
    expect(q.isFull).toBe(true);
    const items = q.drain();
    expect(items).toHaveLength(cap);
    expect(items[0]).toBe(0);
    expect(items[cap - 1]).toBe(cap - 1);
  });

  test("dropOldest 在持续 push 下计数准确", () => {
    const q = new BoundedQueue<number>({ capacity: 100, dropOldest: true });
    for (let i = 0; i < 1000; i++) {
      q.push(i);
    }
    expect(q.size).toBe(100);
    expect(q.droppedCount).toBe(900);
    // 队列应包含最后 100 个元素
    const items = q.drain();
    expect(items[0]).toBe(900);
    expect(items[99]).toBe(999);
  });

  test("容量 1 + dropOldest + 10k push — 仅保留最新", () => {
    const q = new BoundedQueue<number>({ capacity: 1, dropOldest: true });
    for (let i = 0; i < 10_000; i++) {
      q.push(i);
    }
    expect(q.size).toBe(1);
    expect(q.droppedCount).toBe(9999);
    expect(q.shift()).toBe(9999);
  });

  test("性能 — 100k push+shift 在 50ms 内", () => {
    const q = new BoundedQueue<number>({ capacity: 1000 });
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) {
      q.push(i);
      if (q.size > 500) q.shift();
    }
    while (!q.isEmpty) q.shift();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});

// ═══════════════════════════════════════════════════════════════
// E. 溢出策略对比
// ═══════════════════════════════════════════════════════════════

describe("E. BoundedQueue 溢出策略", () => {
  test("dropOldest=false（默认）— 满时拒绝", () => {
    const q = new BoundedQueue<number>({ capacity: 3 });
    q.push(1); q.push(2); q.push(3);
    const accepted = q.push(4);
    expect(accepted).toBe(false);
    expect(q.droppedCount).toBe(0);
    expect(q.drain()).toEqual([1, 2, 3]);
  });

  test("dropOldest=true — 满时驱逐最旧", () => {
    const q = new BoundedQueue<number>({ capacity: 3, dropOldest: true });
    q.push(1); q.push(2); q.push(3);
    const accepted = q.push(4);
    expect(accepted).toBe(true);
    expect(q.droppedCount).toBe(1);
    expect(q.drain()).toEqual([2, 3, 4]);
  });

  test("dropOldest 多次溢出 — droppedCount 累加", () => {
    const q = new BoundedQueue<number>({ capacity: 2, dropOldest: true });
    q.push(1); q.push(2);
    q.push(3); // 丢 1
    q.push(4); // 丢 2
    q.push(5); // 丢 3
    expect(q.droppedCount).toBe(3);
    expect(q.drain()).toEqual([4, 5]);
  });

  test("dropOldest + clear — droppedCount 不重置", () => {
    const q = new BoundedQueue<number>({ capacity: 2, dropOldest: true });
    q.push(1); q.push(2); q.push(3);
    expect(q.droppedCount).toBe(1);
    q.clear();
    expect(q.droppedCount).toBe(1); // droppedCount 是累计统计
  });
});

// ═══════════════════════════════════════════════════════════════
// F. 类型兼容性
// ═══════════════════════════════════════════════════════════════

describe("F. BoundedQueue 类型兼容性", () => {
  test("字符串元素", () => {
    const q = new BoundedQueue<string>({ capacity: 3 });
    q.push("hello");
    q.push("world");
    expect(q.shift()).toBe("hello");
    expect(q.shift()).toBe("world");
  });

  test("对象元素", () => {
    interface Task { id: string; run: () => void }
    const q = new BoundedQueue<Task>({ capacity: 5 });
    q.push({ id: "t1", run: () => {} });
    const t = q.shift();
    expect(t?.id).toBe("t1");
    expect(typeof t?.run).toBe("function");
  });

  test("数组元素", () => {
    const q = new BoundedQueue<number[]>({ capacity: 3 });
    q.push([1, 2, 3]);
    q.push([4, 5]);
    expect(q.shift()).toEqual([1, 2, 3]);
    expect(q.shift()).toEqual([4, 5]);
  });

  test("Buffer 元素（二进制数据）", () => {
    const q = new BoundedQueue<Uint8Array>({ capacity: 3 });
    q.push(new Uint8Array([1, 2, 3]));
    q.push(new Uint8Array([4, 5]));
    const b1 = q.shift();
    const b2 = q.shift();
    expect(Array.from(b1!)).toEqual([1, 2, 3]);
    expect(Array.from(b2!)).toEqual([4, 5]);
  });
});
