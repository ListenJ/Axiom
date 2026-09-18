import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OCREngine } from "../../src/ocr/engine.js";

let tmpLang = "";
beforeAll(() => {
  tmpLang = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-lang-"));
  fs.writeFileSync(path.join(tmpLang, "eng.traineddata"), "fake-data", "utf8"); // 只有 eng
});
afterAll(() => { try { fs.rmSync(tmpLang, { recursive: true, force: true }); } catch {} });

describe("OCREngine.assertLangsAvailable（防崩溃预校验）", () => {
  it("缺失语言包 → 抛友好错误（含缺失项 + 可用列表），而非 tesseract worker 未捕获异常", async () => {
    const e = new OCREngine(tmpLang);
    let err = "";
    try { await e.initialize(["chi_sim"]); } catch (e2: unknown) { err = e2 instanceof Error ? e2.message : String(e2); }
    expect(err).toContain("OCR 语言包缺失");
    expect(err).toContain("chi_sim");
    expect(err).toContain("eng"); // 可用语言列表
  });
});
