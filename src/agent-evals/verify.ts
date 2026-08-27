/**
 * 确定性验证器工具 — Agent 评测任务的最小规则集。
 * 全部纯函数，无 API 依赖，便于单测与离线运行。
 */
export interface VerifyResult {
  passed: boolean;
  reason?: string;
}

function fail(reason: string): VerifyResult {
  return { passed: false, reason };
}
function pass(): VerifyResult {
  return { passed: true };
}

/** 响应必须包含所有给定子串（大小写不敏感）。 */
export function containsAll(text: string, needles: string[]): VerifyResult {
  const lower = text.toLowerCase();
  const missing = needles.filter((n) => !lower.includes(n.toLowerCase()));
  if (missing.length > 0) return fail(`缺少关键内容: ${missing.join(", ")}`);
  return pass();
}

/** 响应必须包含任一给定子串。 */
export function containsAny(text: string, needles: string[]): VerifyResult {
  const lower = text.toLowerCase();
  if (!needles.some((n) => lower.includes(n.toLowerCase()))) {
    return fail(`未提及任何期望内容: ${needles.join(" / ")}`);
  }
  return pass();
}

/** 响应必须匹配所有正则。 */
export function matchesAll(text: string, patterns: RegExp[]): VerifyResult {
  const missed = patterns.filter((p) => !p.test(text));
  if (missed.length > 0) return fail(`未匹配模式: ${missed.map(String).join(", ")}`);
  return pass();
}

/** 响应不得包含给定子串（如危险指令/错误结论）。 */
export function notContains(text: string, banned: string[]): VerifyResult {
  const lower = text.toLowerCase();
  const hit = banned.filter((b) => lower.includes(b.toLowerCase()));
  if (hit.length > 0) return fail(`包含不应出现的内容: ${hit.join(", ")}`);
  return pass();
}

/** 从文本中提取第一个 JSON 对象（含代码块包裹）。 */
export function extractJSON(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const m = candidate.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** 响应应包含一个 JSON 对象且包含指定键。 */
export function hasJSONKeys(text: string, keys: string[]): VerifyResult {
  const obj = extractJSON(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return fail("未找到有效 JSON 对象");
  }
  const missing = keys.filter((k) => !(k in (obj as Record<string, unknown>)));
  if (missing.length > 0) return fail(`JSON 缺少键: ${missing.join(", ")}`);
  return pass();
}

/** 多组同义词验证：每一组至少命中一个（组内任一子串命中即可，大小写不敏感）。 */
export function containsAllAny(text: string, groups: string[][]): VerifyResult {
  const lower = text.toLowerCase();
  const missed = groups.filter((g) => !g.some((n) => lower.includes(n.toLowerCase())));
  if (missed.length > 0) return fail(`缺少任一概念: ${missed.map((g) => g.join("/")).join("; ")}`);
  return pass();
}

/** 响应长度下限（避免空答/敷衍）。 */
export function minLength(text: string, min: number): VerifyResult {
  if (text.trim().length < min) return fail(`响应过短（${text.trim().length} < ${min}）`);
  return pass();
}
