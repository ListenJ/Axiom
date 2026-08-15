/**
 * OCR v7 结构化输出测试 — recognize 显式请求 blocks 并从 blocks→paragraphs→lines 提取
 *
 * tesseract.js v7 不再暴露 data.lines；必须 recognize(img, {}, { blocks: true })，
 * 行文本位于 data.blocks[].paragraphs[].lines[]。本测试 mock createWorker 验证：
 *   1) recognize 以 { blocks: true } 调用；
 *   2) 行提取正确（文本/置信度/bbox）；
 *   3) 旧版 data.lines 兼容路径仍在。
 */
import { describe, it, expect, mock } from "bun:test";

const recognizeCalls: unknown[] = [];

const v7Worker = {
  recognize: async () => ({
    data: {
      text: "Hello World\nSecond line",
      confidence: 90,
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                { text: "Hello World", confidence: 95, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 }, words: [{}, {}] },
                { text: "Second line", confidence: 88, bbox: { x0: 0, y0: 25, x1: 120, y1: 45 }, words: [{}, {}] },
              ],
            },
          ],
        },
      ],
    },
  }),
  setParameters: async () => {},
  terminate: async () => {},
};

const legacyWorker = {
  recognize: async () => ({
    data: {
      text: "Legacy line",
      confidence: 80,
      lines: [{ text: "Legacy line", confidence: 80, bbox: { x0: 1, y0: 2, x1: 50, y1: 12 }, words: [{}] }],
    },
  }),
  setParameters: async () => {},
  terminate: async () => {},
};

describe("OCREngine — tesseract.js v7 结构化输出", () => {
  it("recognize 以 { blocks: true } 请求并提取 v7 分层行", async () => {
    mock.module("tesseract.js", () => ({
      createWorker: async () => {
        const w = {
          recognize: async (_src: unknown, _opts: unknown, output: unknown) => {
            recognizeCalls.push(output);
            return v7Worker.recognize();
          },
          setParameters: v7Worker.setParameters,
          terminate: v7Worker.terminate,
        };
        return w;
      },
    }));

    const { getOCREngine, terminateOCREngine } = await import("../src/ocr/engine.js");
    const engine = await getOCREngine(["eng"]);
    const result = await engine.recognize("x.png");
    expect(recognizeCalls[0]).toEqual({ blocks: true });
    expect(result.text).toBe("Hello World\nSecond line");
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].text).toBe("Hello World");
    expect(result.blocks[0].confidence).toBe(95);
    expect(result.blocks[0].bbox).toEqual({ x0: 0, y0: 0, x1: 100, y1: 20 });
    await terminateOCREngine();
  });

  it("旧版 data.lines 兼容路径仍可用", async () => {
    mock.module("tesseract.js", () => ({
      createWorker: async () => legacyWorker,
    }));
    const { getOCREngine, terminateOCREngine } = await import("../src/ocr/engine.js");
    const engine = await getOCREngine(["eng"]);
    const result = await engine.recognize("y.png");
    expect(result.text).toBe("Legacy line");
    expect(result.blocks).toHaveLength(1);
    await terminateOCREngine();
  });
});
