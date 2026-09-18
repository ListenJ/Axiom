/**
 * OCREngine.initialize() 并发 — 在途初始化未同步发布导致的 worker 泄漏
 *
 * 缺陷形态：`if (this.worker) return;` 之后才 `this.worker = await createWorker(...)`。
 * 两个并发 initialize() 都会看到 `worker === null` ⇒ 各自创建 worker，
 * 第二次赋值覆盖第一次 ⇒ **第一个 worker 永远不会被 terminate（句柄/内存泄漏）**。
 *
 * 修法（与 `vault-stats-cache._refresh` 同一套原子模式）：把"在途初始化承诺"在
 * 任何 await **之前**同步发布，后到者复用同一张承诺。
 *
 * 测试用真实临时 langPath（含 dummy eng.traineddata）绕开语言包校验，
 * 通过构造参数注入 worker 工厂 —— 不 mock 模块，避免污染同进程其它用例。
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OCREngine } from "../src/ocr/engine.js";
import type { Worker } from "tesseract.js";

const dirs: string[] = [];
function makeLangDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocr-lang-"));
  writeFileSync(join(dir, "eng.traineddata"), "dummy");
  dirs.push(dir);
  return dir;
}

function fakeWorker(): Worker {
  return { terminate: async () => {}, recognize: async () => ({ data: {} }) } as unknown as Worker;
}

afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

describe("OCREngine 并发初始化", () => {
  it("并发 initialize() 只创建一次 worker", async () => {
    let created = 0;
    const engine = new OCREngine(makeLangDir(), {
      workerFactory: async () => {
        created++;
        await new Promise((r) => setTimeout(r, 30));
        return fakeWorker();
      },
    });

    await Promise.all([engine.initialize(["eng"]), engine.initialize(["eng"]), engine.initialize(["eng"])]);

    expect(created).toBe(1);
  });

  it("已初始化后再次 initialize() 不重复创建 worker", async () => {
    let created = 0;
    const engine = new OCREngine(makeLangDir(), {
      workerFactory: async () => {
        created++;
        return fakeWorker();
      },
    });

    await engine.initialize(["eng"]);
    await engine.initialize(["eng"]);

    expect(created).toBe(1);
  });

  it("初始化失败后可重试（在途承诺不残留）", async () => {
    let attempts = 0;
    const engine = new OCREngine(makeLangDir(), {
      workerFactory: async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return fakeWorker();
      },
    });

    await expect(engine.initialize(["eng"])).rejects.toThrow(/OCREngine|OCR initialization failed/);
    await engine.initialize(["eng"]);
    expect(attempts).toBe(2);
  });
});
