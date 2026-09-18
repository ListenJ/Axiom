/**
 * self-evolve 教训跨进程回读测试（审计 B2-M2）。
 *
 * 背景：store.write 将教训持久化到 vault（00-Meta/self-evolve/lessons/*），
 * 但 list() 只返回内存 Map —— 进程重启后闭环记忆清零，与注释声明不符。
 *
 * Contract:
 *   - store.write 保持既有行为：更新内存索引 + 持久化到 vault；
 *   - 新 store 实例（模拟新进程，内存索引为空）首次 list() 从 vault 回读已持久化教训；
 *   - 回读与运行时写入共用同一去重键（stableHash(lesson)），同教训不重复；
 *   - vault 不可用时回读静默跳过，list() 仍返回内存教训。
 */
import { describe, test, expect } from "bun:test";
import { createDefaultStore, type LessonVaultLike } from "../src/self-evolve/index.js";

/** 内存 fake vault：镜像 VaultManager 的关键行为——
 *  writeNote 前置 frontmatter 落盘；readNote 剥离首个 frontmatter 并 trim；
 *  getEngine().listNotePaths() 返回全部笔记相对路径。 */
function makeFakeVault(): LessonVaultLike & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    writeNote: async (notePath, content) => {
      files.set(notePath, content);
      return notePath;
    },
    readNote: (notePath) => {
      const raw = files.get(notePath);
      if (raw === undefined) return null;
      const m = raw.match(/^---\n([\s\S]*?)\n---/);
      return { content: (m ? raw.slice(m[0].length) : raw).trim() };
    },
    getEngine: () => ({ listNotePaths: () => [...files.keys()] }),
  };
}

describe("self-evolve lessons vault restore", () => {
  test("写教训 → 新实例首次 list() 从 vault 回读该教训", async () => {
    const vault = makeFakeVault();
    const first = createDefaultStore(async () => vault);
    await first.write("Always run typecheck after editing prompt templates");
    expect(vault.files.size).toBe(1); // 写路径确实持久化到 vault

    const fresh = createDefaultStore(async () => vault); // 模拟新进程：内存索引为空
    const list = await fresh.list();
    expect(list).toContain("Always run typecheck after editing prompt templates");
  });

  test("回读与运行时写入同键去重：新实例回读后重写同教训不产生重复", async () => {
    const vault = makeFakeVault();
    const first = createDefaultStore(async () => vault);
    const lesson = "Dedupe: prefer editing existing files";
    await first.write(lesson);

    const fresh = createDefaultStore(async () => vault);
    await fresh.list(); // 触发回读
    await fresh.write(lesson); // 运行时重写同教训
    const list = await fresh.list();
    expect(list.filter((l) => l === lesson)).toHaveLength(1);
  });

  test("vault 不可用（provider 返回 null）时 list() 不抛错且返回内存教训", async () => {
    const store = createDefaultStore(async () => null);
    await store.write("memory-only lesson");
    await expect(store.list()).resolves.toContain("memory-only lesson");
  });

  test("回读内容与写路径落盘格式闭环： lessons 目录外的笔记不被回读", async () => {
    const vault = makeFakeVault();
    const first = createDefaultStore(async () => vault);
    await first.write("Lesson inside lessons dir");
    // 模拟 vault 中一条非 lessons 目录的笔记（不应被回读）
    await vault.writeNote("03-Resources/other.md", "---\ntitle: other\n---\n\n# Other\n\nnot a lesson\n");
    expect([...vault.files.keys()].some((p) => p.startsWith("03-Resources/"))).toBe(true);

    const fresh = createDefaultStore(async () => vault);
    const list = await fresh.list();
    expect(list).toContain("Lesson inside lessons dir");
    expect(list).not.toContain("not a lesson");
  });
});
