/**
 * 泛型延迟加载单例工具 — 消除 consciousness shim 文件的重复模式
 *
 * 使用示例:
 *   import { MemoryArchiver } from "../../memory/archiver.js";
 *   import { createLazySingleton } from "../utils/lazy-singleton.js";
 *
 *   export const { get: getGlobalMemoryArchiver, setForTest: setMemoryArchiverForTest } =
 *     createLazySingleton<MemoryArchiver>(() => new MemoryArchiver());
 */

import { readString } from "./env.js";

export interface LazySingleton<T> {
  /** 获取单例实例（首次调用时延迟加载） */
  get(): T;
  /** 测试用：替换实例（生产环境无效） */
  setForTest(instance: T | null): void;
}

/**
 * 创建延迟加载单例
 * @param factory 工厂函数，首次调用时执行
 * @returns 单例访问器
 */
export function createLazySingleton<T>(factory: () => T): LazySingleton<T> {
  let instance: T | null = null;

  return {
    get(): T {
      if (!instance) {
        instance = factory();
      }
      return instance;
    },

    setForTest(inst: T | null): void {
      if (readString("NODE_ENV") === "production") return;
      instance = inst;
    },
  };
}
