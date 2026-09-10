/**
 * knowledge/vision — glm-4.6v-flash 图/视频自动理解分支测试。
 *
 * Contract:
 *   - extractMediaReferences：解析 markdown 中的 ![]() 与 ![[ ]] 媒体引用；
 *   - understandImageFile：读图片 → base64 → GLM 视觉（mock fetch 验证请求）；
 *   - describeMediaInMarkdown：媒体引用 → 视觉描述追加到 markdown，失败不阻塞。
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractMediaReferences,
  understandImageFile,
  describeMediaInMarkdown,
} from "../../src/knowledge/vision.js";

const SAVED: Record<string, string | undefined> = {};
for (const k of ["ZHIPU_API_KEY", "GLM_VISION_MODEL", "GLM_VISION_BASE_URL"]) {
  SAVED[k] = process.env[k];
}
beforeEach(() => {
  process.env.ZHIPU_API_KEY = "test-key";
  process.env.GLM_VISION_MODEL = "glm-4.6v-flash";
  process.env.GLM_VISION_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("extractMediaReferences", () => {
  test("parses markdown image links and obsidian embeds", () => {
    const md = "# 标题\n\n![架构图](img/arch.png)\n\n视频：![[demo.mp4]]\n\n![](https://example.com/a.jpg)\n";
    const refs = extractMediaReferences(md);
    expect(refs.length).toBe(3);
    expect(refs[0].kind).toBe("image");
    expect(refs[0].ref).toBe("img/arch.png");
    expect(refs[1].kind).toBe("video");
    expect(refs[1].ref).toBe("demo.mp4");
    expect(refs[2].kind).toBe("image");
    expect(refs[2].ref).toBe("https://example.com/a.jpg");
  });

  test("ignores media in code blocks", () => {
    const md = "```\n![](not-real.png)\n```\n正文";
    expect(extractMediaReferences(md)).toHaveLength(0);
  });
});

describe("understandImageFile", () => {
  test("sends base64 image to glm-4.6v-flash and returns description", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vis-test-"));
    const png = path.join(tmp, "a.png");
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000", "hex"));
    let captured = "";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = String((init?.body as string) ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "图片描述：架构图" } }] }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const desc = await understandImageFile(png, "描述这张图");
      expect(desc).toContain("架构图");
      expect(captured).toContain('"model":"glm-4.6v-flash"');
      expect(captured).toContain("data:image/png;base64,");
      expect(captured).toContain("描述这张图");
    } finally {
      fetchSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns null when API fails (no throw)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vis-test-"));
    const png = path.join(tmp, "a.png");
    fs.writeFileSync(png, "x", "utf8");
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("rate limited");
    }) as unknown as typeof fetch);
    try {
      expect(await understandImageFile(png)).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("describeMediaInMarkdown", () => {
  test("enriches markdown with vision descriptions without blocking", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vis-md-"));
    const png = path.join(tmp, "arch.png");
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000", "hex"));
    const md = "# 标题\n\n![架构图](arch.png)\n";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "视觉描述：包含服务架构图" } }] }), { status: 200 })
    ) as unknown as typeof fetch);
    try {
      const out = await describeMediaInMarkdown(md, tmp);
      expect(out.mediaCount).toBe(1);
      expect(out.described).toBe(1);
      expect(out.markdown).toContain("视觉描述：包含服务架构图");
      expect(out.markdown).toContain("![架构图](arch.png)");
    } finally {
      fetchSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("video without ffmpeg is skipped gracefully", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vis-md-"));
    const md = "# 标题\n\n![[demo.mp4]]\n";
    const out = await describeMediaInMarkdown(md, tmp);
    expect(out.mediaCount).toBe(1);
    expect(out.described).toBe(0);
    expect(out.markdown).toBe(md);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
