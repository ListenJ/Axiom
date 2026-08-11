/**
 * 内部视觉审核工具 — 用配置的 GLM 免费视觉模型（默认 glm-4v-flash）审核截图。
 *
 * 用法:
 *   bun run scripts/visual-audit.ts --image <png 路径> [--prompt <审核要求>]
 *
 * 配置（.env / 环境变量，不写死）:
 *   ZHIPU_API_KEY         智谱 API Key（glm-4v-flash 免费视觉模型需要）
 *   GLM_VISION_MODEL      视觉模型名（默认 glm-4v-flash，免费）
 *   GLM_VISION_BASE_URL   视觉端点（默认 https://open.bigmodel.cn/api/paas/v4）
 *
 * 输出：模型返回的审核文本（建议 prompt 要求输出 JSON 便于程序化处理）。
 */
import fs from "node:fs";
import path from "node:path";
import { readString } from "../src/utils/env.js";

function usage(): never {
  console.error("用法: bun run scripts/visual-audit.ts --image <png 路径> [--prompt <审核要求>]");
  process.exit(1);
}

const args = process.argv.slice(2);
const imgIdx = args.indexOf("--image");
const promptIdx = args.indexOf("--prompt");
if (imgIdx === -1 || !args[imgIdx + 1]) usage();

const imagePath = path.resolve(args[imgIdx + 1]);
if (!fs.existsSync(imagePath)) {
  console.error(`图片不存在: ${imagePath}`);
  process.exit(1);
}

const prompt =
  promptIdx !== -1 && args[promptIdx + 1]
    ? args[promptIdx + 1]
    : '请审核这张截图：整体审美（视觉层次/排版/布局/暗色质量/组件/现代感）、可读性、空态引导。只输出 JSON：{"scores":{"hierarchy":0,"typography":0,"layout":0,"darkTheme":0,"components":0,"modernity":0},"problems":[{"severity":"P0|P1|P2","issue":"...","where":"..."}],"overall":0,"summary":"..."}';

const model = readString("GLM_VISION_MODEL", "glm-4v-flash");
const base = readString("GLM_VISION_BASE_URL", "https://open.bigmodel.cn/api/paas/v4");
const apiKey = readString("ZHIPU_API_KEY");
if (!apiKey) {
  console.error("缺少 ZHIPU_API_KEY：请在 .env 配置（GLM 免费视觉模型 glm-4v-flash 需要）");
  process.exit(1);
}

const b64 = fs.readFileSync(imagePath).toString("base64");
const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  }),
});
if (!res.ok) {
  console.error(`GLM 视觉模型调用失败（HTTP ${res.status}）：${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
console.log(data.choices?.[0]?.message?.content ?? "（无输出）");
