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

// ===== S4: 声明式结构化断言层 =====

/** mustReturnNumber 数值断言选项 */
export interface NumberAssertion {
  min?: number; // 数值下限（含）
  max?: number; // 数值上限（含）
  positive?: boolean; // 要求提取值 > 0
}

/** outputLength 长度区间（测量基准 = text.trim().length，与 minLength 同口径） */
export interface OutputLengthBounds {
  min?: number; // 下限（含）；缺省不校验
  max?: number; // 上限（含）；缺省不校验
}

/**
 * 声明式结构化断言（可序列化、可被 validateTasks 内省）。
 * 组合语义：同 spec 内所有已设置字段全部通过才算过（AND）；按固定顺序短路，首个失败字段的 reason 即最终 reason。
 * 合法字段 1:1 忠实映射到既有验证器，迁移与新增任务时不产生语义漂移。
 */
export interface AssertionSpec {
  containsAll?: string[]; // → containsAll
  containsAny?: string[]; // → containsAny
  containsAllAny?: string[][]; // → containsAllAny（每组任一命中）
  notContains?: string[]; // → notContains
  matchesAll?: string[]; // → 正则源码串，编译后走 matchesAll（不带定界符、默认无 flag、大小写敏感）
  hasJSONKeys?: string[]; // → hasJSONKeys
  outputLength?: OutputLengthBounds; // → outputLength（新）
  mustReturnNumber?: NumberAssertion; // → mustReturnNumber（新）
}

/** 合法顶层字段集合（assertSpecErrors / validateTasks 做未知字段拒绝） */
export const ASSERTION_SPEC_KEYS: readonly string[] = [
  "containsAll",
  "containsAny",
  "containsAllAny",
  "notContains",
  "matchesAll",
  "hasJSONKeys",
  "outputLength",
  "mustReturnNumber",
];

/**
 * AssertionSpec 良构校验（compileAssertion 与 validateTasks 共用单一实现）。
 * 返回错误列表，空 = 合法。
 */
export function assertSpecErrors(spec: AssertionSpec): string[] {
  const errors: string[] = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return ["assert 必须是对象"];
  }
  const fieldCount = Object.keys(spec as Record<string, unknown>).length;
  if (fieldCount === 0) {
    errors.push("assert 为空（至少设置一个断言字段）");
    return errors;
  }
  const known = new Set<string>(ASSERTION_SPEC_KEYS);
  for (const key of Object.keys(spec as Record<string, unknown>)) {
    if (!known.has(key)) errors.push(`assert 包含未知字段: ${key}`);
  }

  const strArr = (key: string, value?: string[]) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`assert.${key} 必须是非空数组`);
      return;
    }
    if (value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
      errors.push(`assert.${key} 含空关键字`);
    }
  };
  strArr("containsAll", spec.containsAll);
  strArr("containsAny", spec.containsAny);
  strArr("notContains", spec.notContains);
  strArr("matchesAll", spec.matchesAll);
  strArr("hasJSONKeys", spec.hasJSONKeys);

  if (spec.containsAllAny !== undefined) {
    if (!Array.isArray(spec.containsAllAny) || spec.containsAllAny.length === 0) {
      errors.push("assert.containsAllAny 必须是非空分组数组");
    } else {
      const badGroup = spec.containsAllAny.find(
        (g) => !Array.isArray(g) || g.length === 0 || g.some((v) => typeof v !== "string" || v.trim().length === 0),
      );
      if (badGroup) errors.push("assert.containsAllAny 含空分组");
    }
  }

  if (spec.matchesAll !== undefined) {
    for (const p of spec.matchesAll) {
      try {
        new RegExp(p);
      } catch {
        errors.push(`assert.matchesAll 含无法编译的正则: ${p}`);
      }
    }
  }

  const boundsCheck = (field: string, v: { min?: number; max?: number }) => {
    if (v.min !== undefined && !Number.isFinite(v.min)) errors.push(`assert.${field}.min 必须是有限数字`);
    if (v.max !== undefined && !Number.isFinite(v.max)) errors.push(`assert.${field}.max 必须是有限数字`);
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
      errors.push(`assert.${field} min(${v.min}) > max(${v.max})`);
    }
  };

  if (spec.outputLength !== undefined) {
    if (spec.outputLength === null || typeof spec.outputLength !== "object" || Array.isArray(spec.outputLength)) {
      errors.push("assert.outputLength 必须是对象");
    } else {
      for (const k of Object.keys(spec.outputLength)) {
        if (k !== "min" && k !== "max") errors.push(`assert.outputLength 含未知字段: ${k}`);
      }
      if (spec.outputLength.min === undefined && spec.outputLength.max === undefined) {
        errors.push("assert.outputLength 需要 min 或 max");
      }
      if (spec.outputLength.min !== undefined && spec.outputLength.min < 0) {
        errors.push("assert.outputLength.min 不能为负");
      }
      boundsCheck("outputLength", spec.outputLength);
    }
  }

  if (spec.mustReturnNumber !== undefined) {
    if (spec.mustReturnNumber === null || typeof spec.mustReturnNumber !== "object" || Array.isArray(spec.mustReturnNumber)) {
      errors.push("assert.mustReturnNumber 必须是对象");
    } else {
      let hasAny = false;
      for (const k of Object.keys(spec.mustReturnNumber)) {
        if (k === "positive") {
          hasAny = true;
          if (typeof spec.mustReturnNumber.positive !== "boolean") errors.push("assert.mustReturnNumber.positive 必须是布尔");
        } else if (k === "min" || k === "max") {
          hasAny = true;
        } else {
          errors.push(`assert.mustReturnNumber 含未知字段: ${k}`);
        }
      }
      if (!hasAny) errors.push("assert.mustReturnNumber 需要 min/max/positive 至少一个");
      boundsCheck("mustReturnNumber", spec.mustReturnNumber);
    }
  }
  return errors;
}

/**
 * 把 AssertionSpec 编译成同步 verify 闭包。
 * 运行期逐 step 短路 AND；畸形 spec 返回 fail-closed 桩（不 throw——模块加载期 throw 会让
 * tasks.ts import 失败，validateTasks 无法给出友好错误），task.assert 原文保留供内省。
 */
export function compileAssertion(spec: AssertionSpec): (response: string) => VerifyResult {
  const errors = assertSpecErrors(spec);
  if (errors.length > 0) {
    const reason = `断言配置非法: ${errors.join("; ")}`;
    return () => ({ passed: false, reason });
  }
  const steps: Array<(t: string) => VerifyResult> = [];
  if (spec.mustReturnNumber) steps.push((t) => mustReturnNumber(t, spec.mustReturnNumber!));
  if (spec.containsAllAny) steps.push((t) => containsAllAny(t, spec.containsAllAny!));
  if (spec.containsAll) steps.push((t) => containsAll(t, spec.containsAll!));
  if (spec.containsAny) steps.push((t) => containsAny(t, spec.containsAny!));
  if (spec.notContains) steps.push((t) => notContains(t, spec.notContains!));
  if (spec.matchesAll) steps.push((t) => matchesAll(t, spec.matchesAll!.map((p) => new RegExp(p))));
  if (spec.hasJSONKeys) steps.push((t) => hasJSONKeys(t, spec.hasJSONKeys!));
  if (spec.outputLength) steps.push((t) => outputLength(t, spec.outputLength!));
  return (text) => {
    for (const step of steps) {
      const r = step(text);
      if (!r.passed) return r; // 短路 AND：首败 reason 即最终 reason
    }
    return { passed: true };
  };
}

/** 从文本中提取最后一个数值 token；无数字返回 null。支持整数/小数/负数（小数分隔符仅 "."） */
export function extractLastNumber(text: string): number | null {
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  return Number(matches[matches.length - 1]);
}

/** 数值断言：无数字 →「未找到数字」；positive 违反 →「数值非正」；越界 →「数值越界」。reason 不带 [ERROR] 前缀（S3 聚类归"其他"桶）。 */
export function mustReturnNumber(text: string, opts: NumberAssertion): VerifyResult {
  const value = extractLastNumber(text);
  if (value === null) {
    return fail("未找到数字: 需要返回一个数值（如 3.5），但响应中没有数字");
  }
  if (opts.positive === true && value <= 0) {
    return fail(`数值非正: ${value} 应 > 0`);
  }
  if (opts.min !== undefined && value < opts.min) {
    return fail(`数值越界: ${value} 不在 [${opts.min}, ${opts.max ?? "∞"}] 区间内`);
  }
  if (opts.max !== undefined && value > opts.max) {
    return fail(`数值越界: ${value} 不在 [${opts.min ?? "-∞"}, ${opts.max}] 区间内`);
  }
  return pass();
}

/** 长度区间：min 越界复用 minLength 文案，max 越界新增「响应过长」。 */
export function outputLength(text: string, bounds: OutputLengthBounds): VerifyResult {
  const len = text.trim().length;
  if (bounds.min !== undefined && len < bounds.min) return fail(`响应过短（${len} < ${bounds.min}）`);
  if (bounds.max !== undefined && len > bounds.max) return fail(`响应过长（${len} > ${bounds.max}）`);
  return pass();
}
