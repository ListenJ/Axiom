/**
 * 前端视觉审核（Frontend Visual Review）— SenseNova 视觉模型
 *
 * 能力：对前端页面截图做结构化视觉审核：
 *   - 布局（重叠/溢出/截断/未对齐）
 *   - 可读性（对比度/字号/文字截断）
 *   - 交互（按钮/输入可见可点）
 *   - 一致性（间距/配色/字体）
 *   - 渲染错误（空白/破损/样式未加载）
 * 输出 JSON：verdict（pass/issues）+ findings（severity/area/description/suggestion）+ summary。
 *
 * 密钥读取（规则 11，凭据不入库）：env SENSENOVA_API_KEY → ~/.axiom/axiom-secrets/sensenova.credentials
 * 依赖注入 fetchImpl（测试零网络）。
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

export interface FrontendReviewOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** 截图 MIME（默认 image/png） */
  mimeType?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "info";
  area: "layout" | "contrast" | "interaction" | "consistency" | "rendering";
  description: string;
  suggestion?: string;
}

export interface FrontendReviewResult {
  verdict: "pass" | "issues";
  summary: string;
  findings: ReviewFinding[];
  model: string;
}

const REVIEW_SYSTEM = `你是 Axiom 的前端视觉审核员。基于页面截图评估质量，重点检查：
1. layout：元素重叠、溢出、截断、未对齐
2. contrast：文字与背景对比度不足、可读性差
3. interaction：按钮/输入框是否可见、可点击、无遮挡
4. consistency：间距、配色、字体不一致
5. rendering：空白区域、破损图片、样式未加载
只输出严格 JSON（不要其他文本）：
{"verdict":"pass"|"issues","summary":"一句话总结","findings":[{"severity":"critical"|"major"|"minor"|"info","area":"layout"|"contrast"|"interaction"|"consistency"|"rendering","description":"问题描述","suggestion":"建议"}],}`;

/** 解析 API Key：env → 本地凭据文件（规则 11） */
export function resolveSensenovaKey(): string {
  const fromEnv = readString("SENSENOVA_API_KEY", "");
  if (fromEnv) return fromEnv;
  try {
    const file = join(homedir(), ".axiom", "axiom-secrets", "sensenova.credentials");
    if (existsSync(file)) {
      const line = readFileSync(file, "utf8").split("\n").find((l) => l.startsWith("SENSENOVA_API_KEY="));
      if (line) return line.slice("SENSENOVA_API_KEY=".length).trim();
    }
  } catch {
    /* fallthrough */
  }
  return "";
}

/** 从模型回复中提取 JSON（支持 ```json 包裹） */
function extractJson<T>(text: string): T | null {
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = block ? block[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 对截图做前端视觉审核 */
export async function reviewFrontendScreenshot(
  imageBase64: string,
  opts: FrontendReviewOptions = {},
): Promise<FrontendReviewResult> {
  const apiKey = opts.apiKey ?? resolveSensenovaKey();
  if (!apiKey) throw new Error("SENSENOVA_API_KEY 未配置（env 或 ~/.axiom/axiom-secrets/sensenova.credentials）");
  const baseUrl = opts.baseUrl ?? readString("SENSENOVA_BASE_URL", "https://token.sensenova.cn/v1");
  const model = opts.model ?? readString("SENSENOVA_VISION_MODEL", "sensenova-6.8-flash-lite");
  const mimeType = opts.mimeType ?? "image/png";

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "请审核以下前端页面截图：" },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
  });
  if (!res.ok) throw new Error(`SenseNova review HTTP ${res.status}: ${await res.text().catch(() => "")}`);

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson<{ verdict?: string; summary?: string; findings?: ReviewFinding[] }>(content);
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const verdict = parsed?.verdict === "pass" ? "pass" : "issues";
  logger.info("[FrontendReview] done", { verdict, findings: findings.length, model });
  return {
    verdict,
    summary: parsed?.summary ?? content.slice(0, 200),
    findings,
    model,
  };
}

/** 对 URL 做前端视觉审核（CDP 截图 → SenseNova） */
export async function reviewFrontendUrl(url: string, opts: FrontendReviewOptions & { cdpUrl?: string } = {}): Promise<FrontendReviewResult> {
  const { captureScreenshot } = await import("../crawl/lightpanda-client.js");
  const ss = await captureScreenshot(url, opts.cdpUrl ?? "http://127.0.0.1:9222", { format: "png", timeout: 30000 });
  return reviewFrontendScreenshot(ss.base64, { ...opts, mimeType: "image/png" });
}
