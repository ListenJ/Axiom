/**
 * Knowledge Vision — glm-4.6v-flash 图/视频自动理解分支。
 *
 * 深模块（小接口）：
 *   - extractMediaReferences(markdown)     解析 ![]() 与 ![[ ]] 媒体引用
 *   - understandImageFile(filePath)        读图 → base64 → GLM 视觉 → 描述（失败/限流返回 null）
 *   - describeMediaInMarkdown(markdown)    媒体引用 → 视觉描述追加到 markdown（视频尽力抽帧）
 *
 * 配置（.env 模板，不写死）：ZHIPU_API_KEY / GLM_VISION_MODEL（默认 glm-4.6v-flash）/
 * GLM_VISION_BASE_URL（默认智谱 v4）。所有失败均降级返回，绝不阻塞知识管线。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { readString } from "../utils/env.js";

export type MediaKind = "image" | "video";

export interface MediaReference {
  kind: MediaKind;
  ref: string;
}

export interface MediaEnrichResult {
  markdown: string;
  mediaCount: number;
  described: number;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "avi"]);

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

function extOf(name: string): string {
  return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

function kindOf(name: string): MediaKind | null {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

/**
 * 解析 markdown 中的媒体引用（自动跳过代码块；支持标准链接与 Obsidian 嵌入）。
 */
export function extractMediaReferences(markdown: string): MediaReference[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const refs: MediaReference[] = [];
  const seen = new Set<string>();

  // 单遍交替正则，按文档出现顺序收集（支持 ![](path) 与 ![[name.ext|alt]]）
  const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutCode)) !== null) {
    if (m[1] !== undefined) {
      // Obsidian 嵌入
      const ref = m[1].trim().split("|")[0].trim();
      const kind = kindOf(ref);
      if (kind && !seen.has(ref)) {
        seen.add(ref);
        refs.push({ kind, ref });
      }
    } else if (m[2] !== undefined) {
      // 标准 markdown 链接
      const ref = m[2].trim();
      if (!ref || ref.startsWith("data:")) continue;
      const kind = kindOf(ref);
      if (kind && !seen.has(ref)) {
        seen.add(ref);
        refs.push({ kind, ref });
      }
    }
  }

  return refs;
}

/** 将图片文件发送给 glm-4.6v-flash 视觉模型，返回描述文本；失败/限流返回 null。 */
export async function understandImageFile(
  filePath: string,
  prompt = "请描述这张图片的内容与要点，200 字以内。",
): Promise<string | null> {
  const apiKey = readString("ZHIPU_API_KEY");
  if (!apiKey) return null;
  if (!fs.existsSync(filePath)) return null;

  const model = readString("GLM_VISION_MODEL", "glm-4.6v-flash");
  const base = readString("GLM_VISION_BASE_URL", "https://open.bigmodel.cn/api/paas/v4");
  const ext = extOf(filePath);
  const mime = MIME[ext] ?? "image/png";

  const b64 = fs.readFileSync(filePath).toString("base64");
  const buildRequest = () => ({
    method: "POST" as const,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  // 免费模型限流（429/1305）常态：退避重试 3 次（2s/4s/8s）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/chat/completions`, buildRequest());
      if (res.status === 429 || res.status === 1305) {
        const delayMs = 2000 * Math.pow(2, attempt);
        logger.warn(`[KnowledgeVision] GLM vision rate-limited (${res.status}), retry in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (!res.ok) {
        logger.warn(`[KnowledgeVision] GLM vision returned ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data?.choices?.[0]?.message?.content?.trim();
      return content && content.length > 0 ? content : null;
    } catch (err) {
      logger.warn(`[KnowledgeVision] GLM vision failed: ${(err as Error).message}`);
      return null;
    }
  }
  logger.warn("[KnowledgeVision] GLM vision rate-limited after 3 retries");
  return null;
}

/**
 * 尽力用 ffmpeg 对视频做多帧采样并拼成 2x2 网格（每 2 秒一帧），
 * 单次视觉调用即可理解视频关键画面（省配额）；网格失败时回退首帧。
 * 无 ffmpeg/失败返回 null。返回的临时文件由调用方清理。
 */
async function extractVideoFrames(videoPath: string): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vis-vframes-"));
  const grid = path.join(dir, "grid.png");
  try {
    const proc = Bun.spawn(
      ["ffmpeg", "-y", "-i", videoPath, "-vf", "fps=1/2,scale=320:-1,tile=2x2", "-frames:v", "1", grid],
      { stdout: "ignore", stderr: "ignore" },
    );
    const code = await proc.exited;
    if (code === 0 && fs.existsSync(grid)) return grid;
  } catch {
    /* fall through to single frame */
  }
  // 回退：单首帧
  const single = path.join(dir, "frame.png");
  try {
    const p2 = Bun.spawn(
      ["ffmpeg", "-y", "-i", videoPath, "-vframes", "1", "-f", "image2", single],
      { stdout: "ignore", stderr: "ignore" },
    );
    const c2 = await p2.exited;
    if (c2 === 0 && fs.existsSync(single)) return single;
  } catch {
    /* ignore */
  }
  return null;
}

function resolveMediaPath(ref: string, baseDir?: string): string | null {
  if (/^https?:\/\//.test(ref)) return null; // 远程 URL：不下载，跳过
  if (path.isAbsolute(ref)) return fs.existsSync(ref) ? ref : null;
  const base = baseDir ?? process.cwd();
  const joined = path.join(base, ref);
  if (fs.existsSync(joined)) return joined;
  // Obsidian 嵌入可能不带子路径：在 baseDir 下递归查找同名文件（限制深度 3）
  const name = path.basename(ref);
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const found = walk(path.join(dir, e.name), depth + 1);
          if (found) return found;
        } else if (e.name === name) {
          return path.join(dir, e.name);
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  };
  return walk(base, 0);
}

/**
 * 媒体引用 → 视觉描述追加到 markdown 末尾（图片直接视觉；视频尽力抽帧后视觉）。
 * 任何失败均降级：返回原 markdown，不抛错。
 */
export async function describeMediaInMarkdown(
  markdown: string,
  baseDir?: string,
): Promise<MediaEnrichResult> {
  const refs = extractMediaReferences(markdown);
  if (refs.length === 0) return { markdown, mediaCount: 0, described: 0 };

  const descriptions: string[] = [];
  let described = 0;

  for (const ref of refs) {
    const filePath = resolveMediaPath(ref.ref, baseDir);
    if (!filePath) continue;
    let imagePath: string | null = null;

    const fromVideo = ref.kind === "video";
    if (fromVideo) {
      imagePath = await extractVideoFrames(filePath);
    } else {
      imagePath = filePath;
    }

    if (!imagePath) continue;
    const desc = await understandImageFile(
      imagePath,
      fromVideo
        ? "请描述这组视频关键帧（2x2 网格，时间顺序）的内容与要点，200 字以内。"
        : "请描述这张图片的内容与要点，200 字以内。",
    );
    // 清理视频抽帧产生的临时文件
    if (fromVideo && imagePath.startsWith(os.tmpdir())) {
      try {
        fs.rmSync(path.dirname(imagePath), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (!desc) continue;

    descriptions.push(`- ${ref.ref} → ${desc}`);
    described++;
  }

  if (described === 0) return { markdown, mediaCount: refs.length, described: 0 };

  const enriched = `${markdown.trimEnd()}\n\n## 媒体视觉理解（glm-4.6v-flash）\n${descriptions.join("\n")}\n`;
  return { markdown: enriched, mediaCount: refs.length, described };
}
