/**
 * 前端视觉审核测试（SenseNova 视觉模型）— mock fetch 验证请求与解析
 */
import { describe, it, expect } from "bun:test";
import { reviewFrontendScreenshot, resolveSensenovaKey } from "../src/computer-use/frontend-review.js";

function mockReviewFetch(choices: Array<{ message: { content: string } }>): { fetchImpl: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    bodies.push(JSON.parse((init as { body: string }).body));
    return new Response(JSON.stringify({ choices }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

describe("reviewFrontendScreenshot", () => {
  it("构造 OpenAI 多模态请求（图片 base64 + 审核 system）并解析 findings", async () => {
    const { fetchImpl, bodies } = mockReviewFetch([
      {
        message: {
          content: JSON.stringify({
            verdict: "issues",
            summary: "发现 2 处问题",
            findings: [
              { severity: "major", area: "layout", description: "按钮被遮挡", suggestion: "增加 z-index" },
              { severity: "minor", area: "contrast", description: "对比度不足" },
            ],
          }),
        },
      },
    ]);
    const result = await reviewFrontendScreenshot("aGVsbG8=", { apiKey: "test-key", baseUrl: "https://x/v1", model: "m", fetchImpl });

    expect(result.verdict).toBe("issues");
    expect(result.findings.length).toBe(2);
    expect(result.findings[0].severity).toBe("major");
    expect(result.findings[0].area).toBe("layout");
    expect(result.model).toBe("m");

    // 请求体校验
    const body = bodies[0] as { model: string; messages: Array<{ role: string; content: unknown }> };
    expect(body.model).toBe("m");
    const user = body.messages[1];
    const parts = user.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === "text")).toBe(true);
    const img = parts.find((p) => p.type === "image_url")!;
    expect(img.image_url!.url).toBe("data:image/png;base64,aGVsbG8=");
  });

  it("verdict=pass 且无 findings", async () => {
    const { fetchImpl } = mockReviewFetch([{ message: { content: JSON.stringify({ verdict: "pass", summary: "页面正常", findings: [] }) } }]);
    const r = await reviewFrontendScreenshot("eA==", { apiKey: "k", baseUrl: "https://x/v1", model: "m", fetchImpl });
    expect(r.verdict).toBe("pass");
    expect(r.findings).toEqual([]);
  });

  it("模型返回 ```json 包裹时仍能解析", async () => {
    const { fetchImpl } = mockReviewFetch([{ message: { content: "```json\n{\"verdict\":\"issues\",\"summary\":\"s\",\"findings\":[{\"severity\":\"info\",\"area\":\"rendering\",\"description\":\"d\"}]}\n```" } }]);
    const r = await reviewFrontendScreenshot("eA==", { apiKey: "k", baseUrl: "https://x/v1", model: "m", fetchImpl });
    expect(r.findings[0].area).toBe("rendering");
  });

  it("无 API Key 时抛错（不静默）", async () => {
    const { fetchImpl } = mockReviewFetch([{ message: { content: "{}" } }]);
    // 通过显式空 key 触发（resolve 失败）
    await expect(reviewFrontendScreenshot("eA==", { apiKey: "", fetchImpl })).rejects.toThrow(/SENSENOVA_API_KEY/);
  });
});

describe("resolveSensenovaKey", () => {
  it("返回字符串（env 或本地凭据文件），不抛错", () => {
    const k = resolveSensenovaKey();
    expect(typeof k).toBe("string");
  });
});
