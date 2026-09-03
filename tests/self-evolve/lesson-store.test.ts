/**
 * 回归测试：createDefaultStore 持久化教训文件名必须使用完整 stableHash（8 hex）。
 * 修复前 index.ts 用 hash.slice(0, 6)，而内存去重/回读键都是完整 8 位 hash——
 * 6 位截断会让 hash 前 6 位相同的两个教训写到同一文件名，互相静默覆盖（数据丢失）。
 */
import { describe, expect, it } from "bun:test";
import { createDefaultStore, type LessonVaultLike } from "../../src/self-evolve/index.js";
import { stableHash } from "../../src/self-evolve/engine.js";

function makeFakeVault(written: string[]): LessonVaultLike {
  return {
    writeNote: async (notePath: string) => {
      written.push(notePath);
    },
    readNote: () => null,
    getEngine: () => ({ listNotePaths: () => written }),
  };
}

describe("createDefaultStore 教训落盘文件名", () => {
  it("使用完整 8 位 stableHash 作为文件名，而非截断 6 位", async () => {
    const written: string[] = [];
    const store = createDefaultStore(async () => makeFakeVault(written));
    const lesson = "网络中断后应指数退避重试，而非立即重试。";
    await store.write(lesson);

    expect(written).toHaveLength(1);
    const hash = stableHash(lesson);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    // 文件名必须带完整 hash
    expect(written[0]).toContain(`-${hash}.md`);
    // 不能只带前 6 位（旧行为：`-${hash.slice(0,6)}.md`，会与 hash 前 6 位相同的教训冲突）
    expect(written[0]).not.toContain(`-${hash.slice(0, 6)}.md`);
  });

  it("前 6 位 hash 相同的两个教训写入不同文件名（完整 hash 去冲突）", async () => {
    const written: string[] = [];
    const store = createDefaultStore(async () => makeFakeVault(written));

    // 真实 stableHash(djb2) 碰撞对：前 6 位相同、完整 8 位不同。
    // 修复前文件名截断 6 位会让两条教训写到同一路径，后写覆盖先写（静默丢失）。
    const lessonA = "lesson-50000-xxxxxxxxxxxx";
    const lessonB = "lesson-207009-xxxxxxxxxxxx";
    const ha = stableHash(lessonA);
    const hb = stableHash(lessonB);
    expect(ha.slice(0, 6)).toBe(hb.slice(0, 6));
    expect(ha).not.toBe(hb);

    await store.write(lessonA);
    await store.write(lessonB);

    expect(written).toHaveLength(2);
    // 完整 hash 不同 → 文件名必须不同，否则后写覆盖先写
    expect(new Set(written).size).toBe(2);
    expect(written[0]).toContain(ha);
    expect(written[1]).toContain(hb);
  });
});
