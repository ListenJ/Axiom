/**
 * OCR 后处理完整性 —— 守卫测试（审计 C-04 / A6-1，2026-09-18）
 *
 * 缺陷：`COMMON_ERRORS` 含 **全局** `[O]→0` 与 `[l]→1` 替换（注释自承
 * "Only in numeric contexts would need smarter logic" 但从未实现），
 * 在默认路径上静默腐蚀所有图片摄取内容：`"Hello"` → `"He11o"`、
 * `"OCR"` → `"0CR"`，并写入知识库。
 *
 * 正确行为：字符纠错只作用于**数字上下文**（以数字开头且仅由数字/易混字符
 * 构成的 token），纯字母词必须原样保留。
 */
import { describe, it, expect } from "bun:test";
import { postProcessOCR } from "../../src/ocr/post-processor.js";

function mkResult(text: string) {
  return {
    text,
    language: "eng",
    confidence: 90,
    blocks: [
      {
        text,
        confidence: 90,
        bbox: { x0: 0, y0: 0, x1: 100, y1: 20 },
      },
    ],
  } as never;
}

describe("C-04: OCR 字符纠错不得腐蚀纯字母词", () => {
  it("普通英文单词原样保留（O/l 不被替换）", () => {
    const out = postProcessOCR(mkResult("Hello World OCR Order"));
    const md = out.markdown;
    expect(md).toContain("Hello World OCR Order");
    expect(md).not.toContain("He11o");
    expect(md).not.toContain("0CR");
  });

  it("含 O/l 的单词不被数字替换", () => {
    const out = postProcessOCR(mkResult("Template Order Local"));
    expect(out.markdown).toContain("Template Order Local");
  });

  it("以字母开头的 token（如 l2 / O2）不被误改", () => {
    const out = postProcessOCR(mkResult("L2 cache and O2 molecule"));
    expect(out.markdown).toContain("L2 cache and O2 molecule");
  });

  it("数字上下文中的易混字符仍被纠正", () => {
    const out = postProcessOCR(mkResult("total 1O0 units and 12l items"));
    expect(out.markdown).toContain("100 units");
    expect(out.markdown).toContain("121 items");
  });
});
