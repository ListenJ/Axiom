/**
 * D-A 出网裸 fetch 棘轮门（设计方案：docs/superpowers/plans/2026-09-23-safefs-and-outbound-enforcement-design.md）
 *
 * 定位：这一步**不改任何运行时行为**，它做两件事 ——
 *   1) 把存量出网点冻结在册（config/outbound-fetch-baseline.json），新增即红；
 *   2) 把"哪些出网点的 URL 由模型/入站请求决定"盘成机器可读事实，供 D-B 定策略。
 *
 * 为什么用 AST 而不是 grep：实测 grep 口径 26 个文件里有 5 个是假阳性 ——
 * Bun.serve 的 fetch 处理器、名为 fetch 的方法声明、以及两处注释文本。
 * 判据若按 grep 写，会把"自家服务器收了个请求"当成出网点登记进册。
 *
 * 为什么必须扫 globalThis.fetch 的**引用**而不只是调用：provider-caller 先
 * `const fetchFn = globalThis.fetch` 再调用，frontend-review 先
 * `opts.fetchImpl ?? globalThis.fetch` 再调用 —— 只匹配 fetch( 的话，
 * frontend-review 整个文件对门是隐形的。这条由"扫描判据自证"那组用例反向锁住。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const fwd = (p: string): string => p.split(path.sep).join("/");

interface Site {
  file: string;
  direct: number;
  aliased: number;
  urlSource: string;
  guard: string;
  redirectPerHop: boolean;
  reachable: boolean;
  deadProofSymbol?: string;
  deadProofFiles?: number;
  endpoint: string;
  note: string;
}

const roster = JSON.parse(read("config/outbound-fetch-baseline.json")) as {
  scan: { root: string; excludeSuffixes: string[] };
  totals: { files: number; directCalls: number; globalThisFetchRefs: number };
  urlSourceValues: string[];
  guardValues: string[];
  policy: {
    modelControllableHostSites: string[];
    hostPathOnlySites: string[];
    operatorWritableHostSites: string[];
    inboundUrlSources: string[];
    guardWithRedirectGapMax: number;
    unreachableSitesMax: number;
  };
  sites: Site[];
};

/** 单文件的出网形态计数：direct = 裸 fetch(...) 调用，aliased = globalThis.fetch 的任意出现。 */
const isGlobalThisFetch = (n: ts.Node): boolean =>
  ts.isPropertyAccessExpression(n) && n.name.text === "fetch"
  && ts.isIdentifier(n.expression) && n.expression.text === "globalThis";

/** 该 fetch 调用是否显式要求"不要自动跟随跳转"（逐跳复查的必要机制）。 */
const FETCH_CALLEE_NAME = /^(?:fetch|fetchImpl|fetchFn)$/;
function isManualFetchCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || node.arguments.length < 2) return false;
  const callee = node.expression;
  const named = ts.isIdentifier(callee) ? callee.text : null;
  if (!((named !== null && FETCH_CALLEE_NAME.test(named)) || isGlobalThisFetch(callee))) return false;
  const init = node.arguments[1];
  if (!ts.isObjectLiteralExpression(init)) return false;
  return init.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === "redirect"
    && ts.isStringLiteral(p.initializer) && p.initializer.text === "manual",
  );
}

function hasManualRedirect(source: string): boolean {
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (isManualFetchCall(node)) found = true;
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return found;
}

function fetchForms(source: string): { direct: number; aliased: number } {
  const sf = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let direct = 0;
  let aliased = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "fetch") direct++;
      else if (isGlobalThisFetch(callee)) aliased++;
    } else if (isGlobalThisFetch(node)) {
      aliased++;
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return { direct, aliased };
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "_archive") continue;
    const rel = fwd(path.join(dir, e.name));
    if (e.isDirectory()) out.push(...walkTs(rel));
    else if (rel.endsWith(".ts") && !roster.scan.excludeSuffixes.some((s) => rel.endsWith(s))) out.push(rel);
  }
  return out;
}

/** 实际扫描结果：只保留有出网形态的文件。 */
function scanSites(): Map<string, { direct: number; aliased: number }> {
  const found = new Map<string, { direct: number; aliased: number }>();
  for (const rel of walkTs(roster.scan.root)) {
    const { direct, aliased } = fetchForms(read(rel));
    if (direct + aliased > 0) found.set(rel, { direct, aliased });
  }
  return found;
}

describe("D-A 在册清单自洽", () => {
  it("totals 与逐行加和一致（清单自身不得自相矛盾）", () => {
    const direct = roster.sites.reduce((a, s) => a + s.direct, 0);
    const aliased = roster.sites.reduce((a, s) => a + s.aliased, 0);
    expect(roster.sites.length).toBe(roster.totals.files);
    expect(direct).toBe(roster.totals.directCalls);
    expect(aliased).toBe(roster.totals.globalThisFetchRefs);
  });

  it("枚举字段取值合法、文件不重复", () => {
    const files = roster.sites.map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
    for (const s of roster.sites) {
      expect(roster.urlSourceValues).toContain(s.urlSource);
      expect(roster.guardValues).toContain(s.guard);
      expect(s.note.length).toBeGreaterThan(0);
    }
  });
});

describe("D-A 棘轮：存量在册，只拦增量", () => {
  const scanned = scanSites();

  it("扫描到的文件集 == 在册文件集（新增文件必须先登记再合并）", () => {
    const registered = new Set(roster.sites.map((s) => s.file));
    const added = [...scanned.keys()].filter((f) => !registered.has(f));
    const stale = [...registered].filter((f) => !scanned.has(f));
    expect({ added, stale }).toEqual({ added: [], stale: [] });
  });

  it("每个文件的 direct 与 aliased 计数与在册完全相等（棘轮只允许同步变短）", () => {
    const drift: string[] = [];
    for (const s of roster.sites) {
      const got = scanned.get(s.file);
      if (!got) continue; // 上一条已报失效
      if (got.direct !== s.direct) drift.push(`${s.file} direct 在册=${s.direct} 实测=${got.direct}`);
      if (got.aliased !== s.aliased) drift.push(`${s.file} aliased 在册=${s.aliased} 实测=${got.aliased}`);
    }
    expect(drift).toEqual([]);
  });
});

describe("D-A 扫描判据自证（防门被改宽或改窄后安静失效）", () => {
  it("四种形态各自落到正确的桶", () => {
    const fixture = [
      "const a = await fetch('https://example.com');",
      "const f = globalThis.fetch;",
      "await f('https://example.com');",
      "Bun.serve({ async fetch(req) { return new Response('ok'); } });",
      "// 旧实现直接 fetch(path) 可打回环",
      "class C { protected async fetch(u: string) { return u; } }",
      "const g: Record<string, (r: Request) => void> = { fetch(r) { void r; } };"
    ].join("\n");
    const got = fetchForms(fixture);
    // 直连 fetch(...) 1 次；globalThis.fetch 出现 1 次（赋值右侧）；
    // 别名调用 f(...) 不在两个桶里 —— 这正是清单必须按文件登记、而不是只数调用点的原因。
    expect(got).toEqual({ direct: 1, aliased: 1 });
  });

  it("Bun.serve 处理器与方法声明不得被计为出网点", () => {
    expect(fetchForms("Bun.serve({ async fetch(req) { return new Response('ok'); } });")).toEqual({ direct: 0, aliased: 0 });
    expect(fetchForms("class C { protected async fetch(u: string) { return u; } }")).toEqual({ direct: 0, aliased: 0 });
    expect(fetchForms("const g = { fetch(r: Request) { void r; } };")).toEqual({ direct: 0, aliased: 0 });
  });

  it("注释里的 fetch 字样不得被计为出网点", () => {
    expect(fetchForms("// 旧实现直接 fetch(path) 可打回环\n/* globalThis.fetch */")).toEqual({ direct: 0, aliased: 0 });
  });

  it("逐跳机制判据自证：只有显式 manual 才算，注释与 follow 都不算", () => {
    expect(hasManualRedirect('await fetch(u, { redirect: "manual", signal: s });')).toBe(true);
    expect(hasManualRedirect('await globalThis.fetch(u, { redirect: "manual" });')).toBe(true);
    expect(hasManualRedirect("await fetch(u, { signal: s });")).toBe(false);
    expect(hasManualRedirect('await fetch(u, { redirect: "follow" });')).toBe(false);
    // 注释里写着 redirect:"manual" 不算证据（B3-Medium 的历史注释就有这句话）
    expect(hasManualRedirect('// 改为 redirect:"manual" + 循环\nawait fetch(u);')).toBe(false);
    // 别名形态：document-ingest 调的是 fetchImpl，不是 fetch
    expect(hasManualRedirect('const f = opts.fetchImpl ?? globalThis.fetch;\nawait f(u, { redirect: "manual" });')).toBe(false);
    expect(hasManualRedirect('const fetchImpl = globalThis.fetch;\nawait fetchImpl(u, { redirect: "manual" });')).toBe(true);
    // 名字里带 fetch 但语义无关的调用不算（宁可漏报成红，也不自动放行）
    expect(hasManualRedirect('await fetchData(u, { redirect: "manual" });')).toBe(false);
  });

  it("grep 口径会多报的文件确实不含出网调用（口径差的依据）", () => {
    for (const rel of ["src/mcp/server.ts", "src/mcp/dre-backend.ts", "src/mcp/kb-backend.ts", "src/utils/proxy-fetch.ts"]) {
      expect(fetchForms(read(rel)).direct).toBe(0);
    }
    // 自家服务器收请求的 fetch 处理器 与 注释文本，都不算出网点
    expect(read("src/crawl/search-engines.ts").includes("protected async fetch(")).toBe(true);
    expect(fetchForms(read("src/crawl/search-engines.ts")).direct).toBe(0);
  });
});

describe("D-A 产出：谁能决定目的主机 —— 三分名单（D-B 的输入）", () => {
  const P = roster.policy;
  const byFile = new Map(roster.sites.map((s) => [s.file, s]));
  const listed = [...P.modelControllableHostSites, ...P.hostPathOnlySites, ...P.operatorWritableHostSites];
  // 「能被源码树之外的输入决定目的主机」的可测量代理：URL 来自入站请求或由调用方传入，
  // 且该点在 src/ 内真的有生产调用方 —— 两条死路径不在此列，它们由可达性那条用例单独看着。
  const externallyInfluenceable = roster.sites
    .filter((s) => s.reachable && ["inbound-request", "mixed", "caller-param"].includes(s.urlSource))
    .map((s) => s.file)
    .sort();

  it("三份名单互斥且都在册", () => {
    expect(new Set(listed).size).toBe(listed.length);
    for (const f of listed) expect(byFile.has(f)).toBe(true);
  });

  it("名单完备：受外部影响的可达出网点必须归入其一（新增点未归类即红）", () => {
    expect([...listed].sort()).toEqual(externallyInfluenceable);
  });

  it("模型/入站可选主机的点全部已挂守卫（该预算不得上调）", () => {
    const unguarded = P.modelControllableHostSites.filter((f) => byFile.get(f)!.guard === "none");
    expect(unguarded).toEqual([]);
  });

  it("挂了守卫但逐跳不复查的点数量 == 在册预算（修好一个就下调）", () => {
    const gap = P.modelControllableHostSites.filter((f) => !byFile.get(f)!.redirectPerHop);
    expect(gap.length).toBe(P.guardWithRedirectGapMax);
    expect(gap).toEqual([]);
  });

  it("在册的 redirectPerHop 必须与源码事实一致（不得凭清单自称已逐跳复查）", () => {
    // 上两条用例读的是 JSON 里的声明值 —— 只改清单就能把预算"下调"到 0，
    // 那样的门会说谎。这里把声明回扣到 AST 可见的机制证据上。
    for (const s of roster.sites) {
      if (s.redirectPerHop !== hasManualRedirect(read(s.file))) {
        throw new Error(
          `${s.file}: 清单声明 redirectPerHop=${s.redirectPerHop}，但源码里`
          + `${hasManualRedirect(read(s.file)) ? "有" : "没有"} redirect:\"manual\" 的 fetch 实参`,
        );
      }
    }
  });

  it("无生产调用方的出网点：可达性结论必须可机器复查（接上调用方即红）", () => {
    const dead = roster.sites.filter((s) => !s.reachable);
    expect(dead.length).toBeLessThanOrEqual(roster.policy.unreachableSitesMax);
    for (const s of dead) {
      if (typeof s.deadProofSymbol !== "string") throw new Error(`${s.file} 缺 deadProofSymbol`);
      if (typeof s.deadProofFiles !== "number") throw new Error(`${s.file} 缺 deadProofFiles`);
      const symbol = s.deadProofSymbol;
      const files = walkTs("src").filter((f) => read(f).includes(symbol));
      // 在册数 = 定义处 + re-export 桶文件。有人真的调用它，这个数就会变，
      // 迫使改动者重新判定该点的 URL 来源与守卫，而不是让 reachable:false 悄悄变成假事实。
      expect(files.length).toBe(s.deadProofFiles);
    }
  });

  it("来源分布汇总与清单一致（防改分类时只改文案不改数）", () => {
    const bySource = new Map<string, number>();
    for (const s of roster.sites) bySource.set(s.urlSource, (bySource.get(s.urlSource) ?? 0) + 1);
    expect(Object.fromEntries(bySource)).toEqual({
      hardcoded: 9, env: 8, "caller-param": 5, "inbound-request": 2,
    });
  });
});
