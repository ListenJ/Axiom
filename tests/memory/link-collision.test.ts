/**
 * wiki-link 标题归一化碰撞回归测试 — P2 清理批
 *
 * 行为规格：两篇笔记标题仅大小写/空白不同（归一化后同键）时，
 * 链接解析保持确定性首见优先（既有行为不变），但碰撞必须经
 * stats().titleCollisions 可观测——不再静默吞掉。
 */

import { describe, test, expect, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { DeterministicSearchEngine } from "../../src/memory/deterministic-search.js";

const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-collision-"));

function writeNote(rel: string, frontmatterTitle: string, body: string): void {
  const full = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\ntitle: ${frontmatterTitle}\n---\n\n${body}\n`);
}

writeNote("01-Projects/Case Study.md", "Case Study", "see [[other topic]]");
writeNote("03-Resources/case-study.md", "case study", "another note");

afterAll(() => fs.rmSync(vaultDir, { recursive: true, force: true }));

describe("wiki-link 标题归一化碰撞（P2）", () => {
  test("碰撞经 stats().titleCollisions 可观测，且不破坏引擎", () => {
    const engine = new DeterministicSearchEngine(vaultDir);
    const s = engine.stats();
    expect((s as { titleCollisions?: number }).titleCollisions).toBeGreaterThanOrEqual(1);
    // 确定性解析仍然工作：搜索与网络遍历不抛错
    expect(() => engine.search("case")).not.toThrow();
    expect(() => engine.getNetwork("01-Projects/Case Study.md")).not.toThrow();
  });
});
