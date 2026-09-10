/**
 * ModelOutputStore 自动清理 — persist 低频触发 purgeOld，防止磁盘无限增长。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ModelOutputStore } from "../src/utils/model-output-store.js";

describe("ModelOutputStore auto purge", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-output-purge-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("persist triggers purgeOld when interval elapsed and removes stale files", async () => {
    const store = new ModelOutputStore({ baseDir: dir, enabled: true });
    const old = store.persist({
      provider: "deepseek", model: "m", prompt: "old", latencyMs: 1, success: true,
      response: { content: "x" },
    });
    expect(old.success).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old.filePath, past, past);

    const auto = new ModelOutputStore({
      baseDir: dir, enabled: true, autoPurgeIntervalMs: 1, purgeMaxAgeDays: 0,
    });
    auto.persist({
      provider: "deepseek", model: "m2", prompt: "new", latencyMs: 1, success: true,
      response: { content: "y" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(fs.existsSync(old.filePath)).toBe(false);
  });

  test("auto purge disabled leaves stale files untouched", async () => {
    const store = new ModelOutputStore({ baseDir: dir, enabled: true });
    const old = store.persist({
      provider: "deepseek", model: "m", prompt: "old", latencyMs: 1, success: true,
      response: { content: "x" },
    });
    await new Promise((r) => setTimeout(r, 50));
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old.filePath, past, past);

    const noAuto = new ModelOutputStore({ baseDir: dir, enabled: true, autoPurge: false });
    noAuto.persist({
      provider: "deepseek", model: "m2", prompt: "new", latencyMs: 1, success: true,
      response: { content: "y" },
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(fs.existsSync(old.filePath)).toBe(true);
  });
});

