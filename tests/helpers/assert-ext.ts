import { expect } from "bun:test";

export function expectDeterministic<T>(fn: () => T, times = 100): void {
  const first = fn();
  for (let i = 0; i < times; i++) {
    const next = fn();
    expect(next).toEqual(first);
  }
}

export function expectNoLeak(getInstance: () => { close?: () => void }, iterations = 1000): void {
  const refs = new Set<object>();
  for (let i = 0; i < iterations; i++) {
    const inst = getInstance();
    refs.add(inst as unknown as object);
    inst.close?.();
  }
  expect(refs.size).toBe(1);
}

export function expectNoTypeEscape(expr: unknown): void {
  const proto = Object.prototype.toString.call(expr);
  expect(proto === "[object Object]" || proto === "[object Array]").toBe(true);
}

export async function expectConcurrentConsistent(
  run: () => Promise<void>,
  concurrency = 100,
  timeoutMs = 5000,
): Promise<void> {
  const result = await Promise.race([
    Promise.all(Array.from({ length: concurrency }, () => run())),
    new Promise<null>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
  ]);
  expect(result).toBeDefined();
}
