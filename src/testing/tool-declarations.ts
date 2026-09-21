/**
 * 工具能力声明登记表（权威静态抽取）
 *
 * 为什么需要：`docs/SECURITY-MEASURES.md` 指向一张"逐条声明与判据"表，而手抄的表必然失真
 * （R0 起该文件长期是死链）。本模块把表的**唯一来源**变成代码：抽取器读注册字面量，
 * 渲染器输出 markdown，`tests/doc-contract.test.ts` 的 D10 门要求仓库里的文件与重生成结果逐字相等。
 *
 * 口径边界：
 *   - 只看 `.add({ … })` 且带 `handler:` 的字面量（`Set.add({…})` 之类同名方法不参与）；
 *   - 模板字符串名（外部 MCP 子进程 `mcp_${server}_${tool}`）标为 dynamic，单列到表尾，不混进逐条表；
 *   - 判据分档**不另立词表**：直接读 `CAPABILITY_PAYLOAD`，与派发前裁决同一个来源；
 *   - 不写行号（D9 禁手抄锚点：行号是最容易腐烂、也最难发现的引用形态）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_PAYLOAD } from "../utils/permissions.js";

export interface DeclarationRow {
  readonly name: string;
  /** literal = 名字是字符串字面量；dynamic = 由模板字符串/变量拼出（外部 MCP 包装） */
  readonly nameKind: "literal" | "dynamic";
  readonly file: string;
  readonly capability: readonly string[];
  readonly payloadFieldsText: string;
  /** null = schema 不是可静态枚举的对象字面量（不可静态核） */
  readonly inputFields: readonly string[] | null;
  readonly adjudication: readonly string[];
  /** 打包产物（单行压缩）内的注册：另属一份注册器副本，不进逐条表 */
  readonly bundle: boolean;
}

/** 取出 `.add({` 起、括号配平到闭合的整段字面量文本（跳过字符串与注释） */
export function addLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf(".add({"); i !== -1; i = src.indexOf(".add({", i + 1)) {
    let depth = 0;
    let j = i + 4;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '"' || ch === "'" || ch === "`") {
        j++;
        while (j < src.length && src[j] !== ch) {
          if (src[j] === "\\") j++;
          j++;
        }
        continue;
      }
      if (ch === "/" && src[j + 1] === "/") {
        while (j < src.length && src[j] !== "\n") j++;
        continue;
      }
      if (ch === "/" && src[j + 1] === "*") {
        j += 2;
        while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j++;
        continue;
      }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i, j + 1));
  }
  return out;
}

/** 字面量里某个属性值的原文（值到顶层的 `,` 或闭合括号为止；注释与字符串内的括号不算） */
function propertyText(literal: string, key: string): string | null {
  const at = literal.search(new RegExp(`\\b${key}\\s*:`));
  if (at < 0) return null;
  let j = literal.indexOf(":", at) + 1;
  let depth = 0;
  const start = j;
  for (; j < literal.length; j++) {
    const ch = literal[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      j++;
      while (j < literal.length && literal[j] !== ch) {
        if (literal[j] === "\\") j++;
        j++;
      }
      continue;
    }
    if (ch === "/" && literal[j + 1] === "/") {
      while (j < literal.length && literal[j] !== "\n") j++;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  return literal.slice(start, j).trim();
}

/** 剥掉注释（字符串内的 `//` 不受影响），供顶层切分使用 */
function stripComments(text: string): string {
  let out = "";
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      j++;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") {
          out += text[j] + (text[j + 1] ?? "");
          j++;
        } else out += text[j];
        j++;
      }
      out += text[j] ?? "";
      continue;
    }
    if (ch === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[j + 1] === "*") {
      j += 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      j++;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 顶层逗号切分（深度 0 才切） */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < body.length; j++) {
    const ch = body[j];
    if (ch === '"' || ch === "'" || ch === "`") {
      j++;
      while (j < body.length && body[j] !== ch) {
        if (body[j] === "\\") j++;
        j++;
      }
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, j));
      start = j + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * `inputSchema: { path: z.string(), ... }` 或 `z.object({ … })` → 顶层属性名。
 * 值不是可枚举对象（引用外部 schema、远端透传）⇒ null = 不可静态核。
 */
function topLevelSchemaKeys(valueText: string | null): string[] | null {
  if (!valueText) return null;
  const trimmed = stripComments(valueText).trim();
  let body: string | null = null;
  if (trimmed.startsWith("{")) body = trimmed.slice(1, trimmed.lastIndexOf("}"));
  else if (/^z\.object\s*\(/.test(trimmed)) {
    const inner = trimmed.slice(trimmed.indexOf("(") + 1, trimmed.lastIndexOf(")")).trim();
    body = inner.startsWith("{") ? inner.slice(1, inner.lastIndexOf("}")) : null;
  }
  if (body === null) return null;
  const keys: string[] = [];
  for (const part of splitTopLevel(body)) {
    const m = part.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

function capabilityList(valueText: string | null): string[] {
  if (!valueText) return [];
  return [...valueText.matchAll(/["']([a-z][a-z0-9.]*)["']/g)].map((m) => m[1]);
}

/** `payloadFields: { "proc.exec": ["command"], "db.write": "fixed" }` → `proc.exec→["command"] db.write→fixed` */
function payloadFieldsText(valueText: string | null): string {
  if (!valueText) return "—";
  const entries = [...valueText.matchAll(/["']([a-z][a-z0-9.]*)["']\s*:\s*(\[[^\]]*\]|"fixed")/g)];
  if (entries.length === 0) return "—";
  return entries
    .map((m) => `${m[1]}→${m[2].replace(/"fixed"/, "fixed").replace(/\s+/g, "")}`)
    .join(" ");
}

function declaredFieldsOf(payload: string, capability: string): string[] {
  const m = payload.match(new RegExp(`${capability.replace(/\./g, "\\.")}→\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => s.length > 0);
}

/** 派发前可裁决性分档：只读 `CAPABILITY_PAYLOAD`，与守卫同一份口径 */
function tiersFor(
  capability: readonly string[],
  payload: string,
  inputFields: readonly string[] | null,
): string[] {
  return capability.map((cap) => {
    if (cap === "internal") return "internal：无外部副作用，不进入裁决";
    const spec = CAPABILITY_PAYLOAD[cap as keyof typeof CAPABILITY_PAYLOAD];
    if (!spec) return `${cap}：档位未登记 ⇒ 裁决 fail-closed 拒绝`;
    if (!spec.preDispatch) return `${cap}：派发前不裁决（远端形状未知，交复核层与出网执行点）`;
    if (payload.includes(`${cap}→fixed`)) return `${cap}：目标由实现固定 ⇒ 不取入参负载，由执行点判定`;
    if (inputFields === null) return `${cap}：schema 不可静态核 ⇒ 入参可裁决性未核对`;
    const declared = declaredFieldsOf(payload, cap);
    const candidates = new Set([...declared, ...spec.fields, ...spec.acceleratorFields]);
    const hits = inputFields.filter((f) => candidates.has(f));
    if (hits.length > 0) return `${cap}：入参可裁决（${hits.join("/")} ⇒ 完整裁决）`;
    if (spec.shapeAdjudicable) return `${cap}：仅形态认领 ⇒ 只裁锚点，越界由实际 I/O 点裁`;
    return `${cap}：入参里没有可裁决对象 ⇒ 由执行点与 I4 序列复核兜底`;
  });
}

function walkSourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "_archive" || e.name.startsWith(".")) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSourceFiles(abs));
    else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(abs);
  }
  return out.sort();
}

/** 抽取仓库内所有工具注册点的声明（src + plugins，按文件路径排序保证输出确定） */
export function collectToolDeclarations(root: string = process.cwd()): DeclarationRow[] {
  const rows: DeclarationRow[] = [];
  for (const dir of ["src", "plugins"]) {
    for (const abs of walkSourceFiles(join(root, dir))) {
      const rel = abs.slice(root.length + 1).replace(/\\/g, "/");
      let src: string;
      try {
        src = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (!src.includes(".add({")) continue;
      // 打包产物判据：存在极长的单行（压缩后无换行）。手写 `.js` 插件不会被误判。
      const bundle = src.length > 100_000 && src.split("\n").some((l) => l.length > 20_000);
      for (const literal of addLiterals(src)) {
        if (!/\bhandler\s*:/.test(literal)) continue;
        const rawName = propertyText(literal, "name") ?? "";
        const literalName = rawName.match(/^"([^"]+)"$/);
        const capability = capabilityList(propertyText(literal, "capability"));
        const payload = payloadFieldsText(propertyText(literal, "payloadFields"));
        const inputFields = topLevelSchemaKeys(propertyText(literal, "inputSchema"));
        rows.push({
          name: literalName ? literalName[1] : rawName.replace(/\s+/g, " ") || "(无名)",
          nameKind: literalName ? "literal" : "dynamic",
          file: rel,
          capability,
          payloadFieldsText: payload,
          inputFields,
          adjudication: tiersFor(capability, payload, inputFields),
          bundle,
        });
      }
    }
  }
  return rows;
}

const LEGEND = `| 分档 | 含义 |
|---|---|
| 入参可裁决 | 目标字段在声明/规范/加速器清单里，派发前做**完整**裁决（越界 + 锚点） |
| 仅形态认领 | 字段名不在任何清单里，由值形态认领 ⇒ 只做锚点裁决，越界留给实际 I/O 点（I2） |
| 目标由实现固定 | 注册处声明 \`fixed\`：入参里没有可裁决对象，判定落在执行点 |
| 派发前不裁决 | 该档位按设计不在派发前取负载（外部 MCP 的参数形状由远端决定） |
| 无可裁决对象 | 声明字段与形态都不命中 ⇒ 由执行点与 I4 序列复核兜底（已登记，见 §2.7.5） |
| schema 不可静态核 | 入参 schema 是引用或远端透传，本表不声称已核对 |`;

/** 渲染登记表 markdown（不含时间戳：D10 要求逐字可重生成） */
export function renderDeclarationsDoc(rows: readonly DeclarationRow[]): string {
  const bundled = new Set(rows.filter((r) => r.bundle).map((r) => r.file));
  const literal = rows.filter((r) => r.nameKind === "literal" && !r.bundle);
  const dynamic = rows.filter((r) => r.nameKind === "dynamic" && !r.bundle);
  const byFile = new Map<string, DeclarationRow[]>();
  for (const r of literal) {
    const list = byFile.get(r.file) ?? [];
    list.push(r);
    byFile.set(r.file, list);
  }
  const withExec = literal.filter((r) => r.capability.includes("proc.exec"));
  const fixed = withExec.filter((r) => r.payloadFieldsText.includes("fixed"));
  const noCapability = literal.filter((r) => r.capability.length === 0);
  const bundleRows = [...bundled].sort().map((file) => ({
    file,
    addCount: rows.filter((r) => r.file === file && r.bundle).length,
    declared: rows.filter((r) => r.file === file && r.bundle && r.capability.length > 0).length,
  }));

  const out: string[] = [];
  out.push("# 工具能力声明登记表");
  out.push("");
  out.push("**本文件由代码生成，禁止手改**：重生成 `bun run scripts/gen-capability-declarations.mjs --write`；");
  out.push("一致性由 `tests/doc-contract.test.ts` 的 D10 门逐字校验；抽取器与渲染器在 `src/testing/tool-declarations.ts`。");
  out.push("");
  out.push(
    `口径 = 经 \`src/mcp/tool-registry.ts\` 注册的执行面。固定名注册 **${literal.length}** 处、动态名 **${dynamic.length}** 处、` +
      `打包产物内注册 **${bundleRows.reduce((n, b) => n + b.addCount, 0)}** 处（另列，见末节）；` +
      `声明 \`proc.exec\` 的 **${withExec.length}** 处，其中目标由实现固定 **${fixed.length}** 处、声明目标入参 **${withExec.length - fixed.length}** 处；` +
      `未声明能力 **${noCapability.length}** 处。`,
  );
  out.push("");
  out.push(
    "本表按**注册点**计数，与 `src/testing/tool-count.ts` 的**去重工具数**不是同一口径" +
      "（后者按字面名去重、含 `adaptTool` 注册的基础工具，也不看打包产物），两个数各自成立，不能互相顶替。",
  );
  out.push("");
  out.push("## 判据分档");
  out.push("");
  out.push(LEGEND);
  out.push("");
  for (const [file, list] of [...byFile.entries()].sort()) {
    out.push(`## ${file}`);
    out.push("");
    out.push("| 工具 | 声明能力 | 目标入参声明 | 入参数 | 派发前裁决分档 |");
    out.push("|---|---|---|---|---|");
    for (const r of list) {
      out.push(
        [
          "",
          `\`${r.name}\``,
          r.capability.map((c) => `\`${c}\``).join(" ") || "**缺声明**",
          r.payloadFieldsText === "—" ? "—" : `\`${r.payloadFieldsText}\``,
          r.inputFields === null ? "**不可静态核**" : String(r.inputFields.length),
          r.adjudication.join("；") || "—",
          "",
        ].join(" | "),
      );
    }
    out.push("");
  }
  if (dynamic.length > 0) {
    out.push("## 不可静态核的注册（动态名 / 远端形状）");
    out.push("");
    out.push("| 位置 | 名字来源 | 声明能力 | 说明 |");
    out.push("|---|---|---|---|");
    for (const r of dynamic) {
      out.push(
        [
          "",
          `\`${r.file}\``,
          r.name,
          r.capability.map((c) => `\`${c}\``).join(" ") || "**缺声明**",
          "名字由运行时拼出（外部 MCP 子进程包装）；能力仍按注册处声明判定，逐个工具的入参形状不在本表声称已核对",
          "",
        ].join(" | "),
      );
    }
    out.push("");
  }
  if (bundleRows.length > 0) {
    out.push("## 打包产物内的注册面（不在本表口径内）");
    out.push("");
    out.push("| 产物 | 内含注册 | 其中带能力声明 |");
    out.push("|---|---|---|");
    for (const b of bundleRows) {
      out.push(`| \`${b.file}\` | ${b.addCount} | ${b.declared} |`);
    }
    out.push("");
    out.push(
      "这两个产物是提交进仓库的压缩文件（存在超长单行），由 `plugins/dre-dsh/package.json` 与 " +
        "`plugins/kb-dsh/package.json` 的 `build:backend` 从 `src/mcp/dre-backend.ts` / `src/mcp/kb-backend.ts` 打包，" +
        "里面是那一份注册器的**编译副本**。因此本表不声称它们的派发经过 `src/mcp/tool-registry.ts` 的守卫。",
    );
    out.push("");
    out.push(
      "「其中带能力声明」一列为 0 时，说明该副本早于能力内核（源码注册点逐个带 `capability`，" +
        "如 `src/mcp/server/dre-tools.ts`）：里面生效的是按工具名/字段名正则的旧守卫，重建产物后此列才会随源码变化。" +
        "风险登记见 `docs/SECURITY-MEASURES.md` §2.7.5。",
    );
    out.push("");
  }
  out.push("## 这张表不证明什么");
  out.push("");
  out.push("- 它只登记**声明与派发前可达性**，不证明执行点判定已接线：`safeFs`（I2）与出网执行点各自另有门。");
  out.push("- 「目标由实现固定」的真实性由人保证：机器只核「声明的字段名确实存在于 schema」与「缺声明即不可注册」（S-8），逐条证据在提交说明与 `docs/operations-log.md`。");
  out.push("- \`db.write\` 的判据是 filesystem：\`sql\`/\`query\`/\`statement\` 里的 SQL 文本按路径裁决，既不构成有效防护也可能误伤 ⇒ 已登记债（\`docs/SECURITY-MEASURES.md\` §2.7.5），本表如实显示为「可裁决」而不声称已防护。");
  out.push("- 未出现在本表的执行面（运行期由远端 `listTools()` 决定的外部工具、未走 `add()` 的调用面）不冒充已核对。");
  out.push("");
  return out.join("\n");
}
