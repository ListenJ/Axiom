/**
 * S3 安全不变式门 —— 提权阻断的机器落点
 *
 * 命题来源：docs/superpowers/specs/2026-09-21-privilege-escalation-defense-design.md §4
 * 分工：tests/doc-contract.test.ts（D 系列）管文档与代码是否一致；本门管强制点本身是否成立。
 *
 * 写法约定：
 *   - 被测模块一律用动态 import，使"实现尚未落地"表现为单条红，而不是整文件加载失败。
 *   - 行为优先：能在公共接口上测的（safeFs / HttpRouter / 守卫 / 默认值）不用静态扫描；
 *     只有"某张表不得存在""某个清单不得有第二份"这类结构性命题才扫源码文本。
 *   - 文件系统用真实 tmpdir（含符号链接与 .. 变体），不 mock。
 */
import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(repoRoot, rel));
const existsIn = (abs: string) => fs.existsSync(abs) && fs.statSync(abs).isFile();

function walkTs(dir: string): string[] {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) out.push(...walkTs(rel));
    else if (ent.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** 取出 `.add({` 起、括号配平到闭合的整段字面量文本（跳过字符串与注释） */
function addLiterals(src: string): string[] {
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

// ─── 真实文件系统夹具 ────────────────────────────────────────────────────────
const originalCwd = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-cap-"));
// 上一次运行的沙箱此刻已可删（进程退出 ⇒ SQLite 句柄释放），但没人回收就会一直堆在
// %TEMP%（本机实测累积 22 个）。afterAll 里删不掉自己：`src/utils/cache.ts` 的模块级
// 单例在 chdir 之后打开了沙箱内 data/agent.db，句柄活到进程结束 —— 要根治得给该单例
// 加关闭出口，那是生产改动，不在本刀。这里只做 best-effort 回收：跳过当前沙箱，
// 删不掉就留着下次再试，绝不因此让门变红。
for (const stale of fs.readdirSync(os.tmpdir())) {
  if (!stale.startsWith("axiom-cap-")) continue;
  const p = path.join(os.tmpdir(), stale);
  if (p === sandbox) continue;
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 仍被占用，留待下次 */ }
}
fs.mkdirSync(path.join(sandbox, ".git/hooks"), { recursive: true });
fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
// 夹具内需要是一个"合法项目根"：模块级单例（如 src/utils/cache.ts 的 ./data/agent.db）
// 在本文件 chdir 之后才被 import，缺 data/ 会以 SQLITE_CANTOPEN 直接掀掉整条用例。
fs.mkdirSync(path.join(sandbox, "data"), { recursive: true });
fs.writeFileSync(path.join(sandbox, ".env"), "AXIOM_AUTH_TOKEN=fixture-not-a-real-token\n");
fs.writeFileSync(path.join(sandbox, "src/ok.ts"), "export const ok = 1;\n");
// 沙箱内的符号链接指向沙箱外：仅靠字符串前缀判定会被骗过。
// 目标必须由夹具自己造：原先指向 `~/.bashrc`，而本机（Windows）主目录里没有这个文件 ⇒
// 链接悬空 ⇒ existsSync("escape-link") 返 false，下面那条用例在 setup 处就断了，
// "越界链接被拒"这条不变式在 Windows 发行产物上其实从未执行过（Linux 上恰好存在该文件才显绿）。
const escapeRoot = `${sandbox}-escape`;
fs.mkdirSync(escapeRoot, { recursive: true });
const escapeTarget = path.join(escapeRoot, "outside-secret.txt");
fs.writeFileSync(escapeTarget, "outside-the-sandbox\n");

/**
 * E1 平台能力缺失（设计稿 §3）：Windows 默认（非开发者模式）无 `SeCreateSymbolicLinkPrivilege`，
 * `symlinkSync` 恒 EPERM —— POSIX 符号链接语义在 Windows 上原理上不可满足。
 *
 * 这一行是**模块作用域**执行：一次 EPERM 会让整文件 0 用例 + `1 fail / 1 error`
 * （2026-10-19 Windows 全量实测），比"跳过 3 条依赖链接的用例"代价大得多，且信号更差。
 * 故按平台门控建链 + 对依赖链接的用例 `it.skipIf` 显式跳过（标题带理由、报告可见）。
 * Linux 上仍强制建链：链接建不出来就红，不降级成静默忽略。
 */
const NO_SYMLINK = process.platform === "win32";
if (!NO_SYMLINK) {
  fs.symlinkSync(escapeTarget, path.join(sandbox, "escape-link"));
}
process.chdir(sandbox);

/** 删符号链接本身而不是它指向的内容：Windows 上 rmSync 对目录链接返 EFAULT，unlink 两端都可用。 */
function removeLink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* 链接没建成，无需回收 */ }
}

afterAll(() => {
  process.chdir(originalCwd);
  // 清理钩子不是断言 —— 它失败只说明"沙箱没删掉"，不代表任何不变式被违反。
  // Windows 上本文件把 cwd chdir 进沙箱，且沙箱内 `data/agent.db` 被模块级单例打开过，
  // 句柄未释放时 rmSync 直接 EBUSY ⇒ 制造一条与判据无关的 `(fail) (unnamed)`，
  // 并把临时沙箱留在 %TEMP%（本机实测已堆到 19 个 axiom-cap-*）。
  // 处置：重试若干次；仍失败就明确报泄漏，而不是让门去断言"我删不掉自己的临时目录"。
  let lastErr: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
      fs.rmSync(escapeRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      const until = Date.now() + 200 * (i + 1);
      while (Date.now() < until) { /* 等句柄释放 */ }
    }
  }
  console.warn(
    `[capability-invariants] 沙箱清理失败（非判据失败），临时目录泄漏：${sandbox} —— ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
});

// ─── S-1 守卫按能力推导，不按工具名查表 ──────────────────────────────────────
describe("S-1 能力驱动筛查（封堵 L4/L5）", () => {
  it("risk-monitor 中不存在以工具名为键的守卫表", () => {
    const src = read("src/agents/risk-monitor.ts");
    expect(src).not.toContain("SCREENED_TOOLS");
    expect(src).not.toMatch(/Record<\s*string\s*,\s*\{\s*kind:\s*PayloadKind/);
  });

  it("全新工具名只要声明 proc.exec，高危命令仍被升级到审批", async () => {
    const { screenToolCall } = await import("../src/agents/risk-monitor.js");
    let screened = "";
    const verdict = await screenToolCall(
      { capabilities: ["proc.exec"], args: { command: "rm -rf /usr" } },
      {
        screen: async (payload) => {
          screened = payload;
          return { risk: "high", reason: "fixture" };
        },
        review: async () => ({ dangerous: true, reason: "fixture" }),
      },
    );
    expect(screened).toBe("rm -rf /usr");
    expect(verdict).toBe("require-approval");
  });

  it("internal 能力（无特权 I/O）不进入筛查", async () => {
    const { screenToolCall } = await import("../src/agents/risk-monitor.js");
    let called = 0;
    const verdict = await screenToolCall(
      { capabilities: ["internal"], args: { path: "/etc/passwd" } },
      {
        screen: async () => {
          called++;
          return { risk: "high", reason: "fixture" };
        },
        review: async () => ({ dangerous: true, reason: "fixture" }),
      },
    );
    expect(called).toBe(0);
    expect(verdict).toBe("pass");
  });

  it("fs.write 能力的 path 负载与 proc.exec 同样进入初筛", async () => {
    const { screenToolCall } = await import("../src/agents/risk-monitor.js");
    const seen: string[] = [];
    await screenToolCall(
      { capabilities: ["fs.write"], args: { path: "/root/.ssh/authorized_keys", content: "x" } },
      {
        screen: async (payload) => {
          seen.push(payload);
          return { risk: "low", reason: "fixture" };
        },
        review: async () => null,
      },
    );
    expect(seen).toEqual(["/root/.ssh/authorized_keys"]);
  });
});

// ─── S-2 无声明不可注册（I1）────────────────────────────────────────────────
describe("S-2 注册即声明能力（I1，封堵 L4）", () => {
  it("未声明 capability 的注册在 add() 即抛错", async () => {
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const registry = new ToolRegistry({ guard: async () => {} });
    expect(() =>
      registry.add({
        name: "no_capability_declared",
        description: "fixture",
        inputSchema: {},
        handler: async () => ({}),
      } as never),
    ).toThrow(/capability/);
  });

  it("capability 为空数组同样拒绝（不得用空声明蒙过）", async () => {
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const registry = new ToolRegistry({ guard: async () => {} });
    expect(() =>
      registry.add({
        name: "empty_capability",
        description: "fixture",
        inputSchema: {},
        capability: [],
        handler: async () => ({}),
      }),
    ).toThrow(/capability/);
  });

  it("声明内部能力的注册通过且元数据可见", async () => {
    const { ToolRegistry } = await import("../src/mcp/tool-registry.js");
    const registry = new ToolRegistry({ guard: async () => {} });
    registry.add({
      name: "declared",
      description: "fixture",
      inputSchema: {},
      capability: ["internal"],
      handler: async () => ({}),
    });
    expect(registry.getCapabilities("declared")).toEqual(["internal"]);
  });

  it("源码与内置插件的每一处 registry.add({…}) 字面量都带 capability", () => {
    const offenders: string[] = [];
    // plugins/ 不在 tsconfig include 内（无类型强制），只能靠这里扫到
    for (const rel of [...walkTs("src"), ...walkTs("plugins")]) {
      // 只看 ToolDef 字面量（必带 handler）；Set.add({…}) 之类的同名方法不参与
      addLiterals(read(rel))
        .filter((lit) => /\bhandler\s*:/.test(lit))
        .forEach((lit, i) => {
          if (!/\bcapability\s*:/.test(lit)) offenders.push(`${rel} #${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  // 显式预算：本条走遍 src/ + plugins/ 全部 .ts 源码文本，本机并行实测 4.8s，已逼近
  // bun 默认的 5s 单用例超时；`.ci/run.sh` 用的正是裸 `bun test`。沿用本仓既有写法
  // （benchmark / code-analysis-shell-safety 等自报预算）。
  }, 30_000);

  it("adaptTool 把 Tool.capability 透传到 ToolDef，src/tools 每个工具都声明", async () => {
    const src = read("src/mcp/adapt-tool.ts");
    expect(src).toMatch(/\bcapability\s*:/);
    const missing: string[] = [];
    for (const rel of walkTs("src/tools")) {
      if (rel.endsWith("types.ts") || rel.endsWith("pipeline.ts")) continue;
      const text = read(rel);
      if (/export const \w+Tool\b/.test(text) && !/\bcapability\s*:/.test(text)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});

// ─── S-3 强制点在实际 I/O 那一行（I2）──────────────────────────────────────
describe("S-3 safeFs 在 I/O 点强制（封堵 L1/L2）", () => {
  const deniedTargets = [
    [".git/hooks/pre-commit", "git hook"],
    ["/etc/sudoers.d/axiom", "sudoers"],
    [path.join(os.homedir(), ".bashrc"), "shell rc"],
    [path.join(os.homedir(), ".ssh/authorized_keys"), "authorized_keys"],
    ["/etc/crontab", "crontab"],
    [path.join(os.homedir(), ".config/systemd/user/evil.service"), "systemd unit"],
    [".env", "密钥文件"],
  ] as const;

  for (const [target, label] of deniedTargets) {
    it(`写${label}被拒且目标内容不变`, async () => {
      const safeFs = await import("../src/utils/safe-fs.js");
      const abs = path.isAbsolute(target) ? target : path.join(sandbox, target);
      const before = existsIn(abs) ? fs.readFileSync(abs, "utf8") : null;
      let err: Error | null = null;
      try {
        await safeFs.writeFile(target, "escalation fixture");
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message.toLowerCase()).toContain("denied");
      const after = existsIn(abs) ? fs.readFileSync(abs, "utf8") : null;
      expect(after).toBe(before);
    });
  }

  it("沙箱内普通文件可写可读", async () => {
    const safeFs = await import("../src/utils/safe-fs.js");
    await safeFs.writeFile("src/new-file.ts", "export const added = 2;\n");
    const back = await safeFs.readFile("src/new-file.ts");
    expect(back.toString()).toContain("added");
  });

  it.skipIf(NO_SYMLINK)("沙箱内符号链接指向沙箱外时拒绝（字符串前缀判定会被骗过）（skip：Windows 无符号链接权限）", async () => {
    const safeFs = await import("../src/utils/safe-fs.js");
    expect(fs.existsSync("escape-link")).toBe(true);
    // 夹具自证：链接必须**不悬空**且确实指向沙箱外 —— 上一版因目标不存在而在这里就红，
    // 于是守卫从未被执行，红的是夹具、看起来却像"平台不支持符号链接"。
    const escaped = fs.realpathSync("escape-link");
    expect(fs.existsSync(escaped)).toBe(true);
    expect(escaped.startsWith(fs.realpathSync(sandbox) + path.sep)).toBe(false);
    let err: Error | null = null;
    try {
      await safeFs.readFile("escape-link");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message.toLowerCase()).toContain("denied");
  });

  it.skipIf(NO_SYMLINK)("沙箱内符号链接指向沙箱外的执行锚点时同样拒绝（点开头目录不得被跳过）（skip：Windows 无符号链接权限）", async () => {
    const safeFs = await import("../src/utils/safe-fs.js");
    const link = "src/link-to-env";
    try {
      fs.symlinkSync(path.join(sandbox, ".env"), link);
      let err: Error | null = null;
      try {
        await safeFs.readFile(link);
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message.toLowerCase()).toContain("denied");
    } finally {
      removeLink(link);
    }
  });

  it.skipIf(NO_SYMLINK)("沙箱内目录符号链接指向锚点目录：不得把新文件写进锚点目录（skip：Windows 无符号链接权限）", async () => {
    const safeFs = await import("../src/utils/safe-fs.js");
    const link = "src/link-to-hooks";
    const landed = path.join(sandbox, ".git/hooks/injected");
    try {
      fs.symlinkSync(path.join(sandbox, ".git/hooks"), link, "dir");
      let err: Error | null = null;
      try {
        await safeFs.writeFile(`${link}/injected`, "escalation fixture");
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message.toLowerCase()).toContain("denied");
      expect(fs.existsSync(landed)).toBe(false);
    } finally {
      removeLink(link);
      fs.rmSync(landed, { force: true });
    }
  });

  it("readDir 逐项判定：目录可读，.env 内容不外泄", async () => {
    const safeFs = await import("../src/utils/safe-fs.js");
    const entries = await safeFs.readDir(".");
    const names = entries.map((e) => e.name);
    expect(names).toContain("src");
    const leaked = names.filter((n) => n === ".env");
    expect(leaked).toEqual([]);
  });

  it("路径字符串守卫不得作为唯一判定（.. 归一后仍受控）", async () => {
    const safeFs = await import("../src/utils/safe-fs.js");
    let err: Error | null = null;
    try {
      await safeFs.readFile("src/../../etc/passwd");
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message.toLowerCase()).toContain("denied");
  });

  it("承载工具写入的目录不再直接调用裸文件系统 I/O", () => {
    const offenders: string[] = [];
    const bare = [
      /(?:^|[^.\w])fs(?:Sync)?\.(readFile|writeFile|appendFile|readdir|rm|unlink|rename|mkdir)(Sync)?\s*\(/,
      /await import\(\s*["']fs\/promises["']\s*\)/,
    ];
    // 写侧名单单独扩：skill 落盘由模型可触达（skill_create），写入穿过符号链接就是提权落点。
    // src/self-evolve 与 src/agents/consciousness 的同型裸写（skill-quality.ts 的持久化、
    // skill-promotion.ts 与 skill-promoter.ts 的落盘）尚未并入：它们的目标根可能是
    // cwd 之外的 axiom home，扩名单前要先定沙箱根策略（R3 条目，见 operations-log）。
    const writeOnly = /(?:^|[^.\w])fs(?:Sync)?\.(writeFile|appendFile|rm|unlink|rename|mkdir)(Sync)?\s*\(/;
    const scope: Array<[string, RegExp[]]> = [
      ["src/tools", bare],
      ["src/mcp/tools", bare],
      ["src/skills", [writeOnly]],
    ];
    for (const [dir, patterns] of scope) {
      for (const rel of walkTs(dir)) {
        if (rel.endsWith("safe-fs.ts")) continue;
        read(rel).split("\n").forEach((line, i) => {
          if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
          if (patterns.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─── S-5 执行锚点清单单一来源 ────────────────────────────────────────────────
describe("S-5 执行锚点清单唯一权威", () => {
  it("锚点清单只有一个导出点", () => {
    const defs = walkTs("src").filter((rel) => /export const EXECUTION_ANCHORS\b/.test(read(rel)));
    expect(defs).toEqual(["src/utils/permissions.ts"]);
  });

  it("清单覆盖提权落点类别", async () => {
    const { EXECUTION_ANCHORS } = await import("../src/utils/permissions.js");
    const labels = EXECUTION_ANCHORS.map((a) => a.label).join("|");
    for (const needle of ["shell rc", "hook", "cron", "systemd", "sudoers", "authorized_keys"]) {
      expect(labels.toLowerCase()).toContain(needle);
    }
  });

  it("文件系统工具不再自带第二份黑名单", () => {
    expect(read("src/mcp/tools/filesystem.ts")).not.toContain("DENIED_SEGMENTS");
  });
});

// ─── S-4 鉴权先于缓存（I3）──────────────────────────────────────────────────
describe("S-4 缓存不得成为鉴权之外的第二条通道（I3，封堵 L7）", () => {
  const makeCtx = (method: string, p: string, headers: Record<string, string> = {}) =>
    ({
      url: new URL(`http://localhost${p}`),
      req: new Request(`http://localhost${p}`, { method, headers }),
      vault: null,
      db: null as never,
      pipeline: null as never,
      healthMonitor: null as never,
      fileWatcher: null,
      startupTime: Date.now(),
      baseHeaders: {},
      jsonResponse: (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status }),
    }) as never;

  it("GET 默认可缓存 ⇒ 必须显式声明才缓存", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter({ cacheMaxSize: 20, cacheTtlMs: 60_000 });
    let calls = 0;
    router.register({
      method: "GET",
      path: "/probe/no-cache",
      handler: async () => new Response(`v${++calls}`),
    });
    await router.execute(makeCtx("GET", "/probe/no-cache"));
    const second = await router.execute(makeCtx("GET", "/probe/no-cache"));
    expect(await second!.text()).toBe("v2");
    expect(calls).toBe(2);
  });

  it("显式 cacheable 的路由仍然命中缓存（性能不回退到零）", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter({ cacheMaxSize: 20, cacheTtlMs: 60_000 });
    let calls = 0;
    router.register({
      method: "GET",
      path: "/probe/cached",
      meta: { cacheable: true },
      handler: async () => new Response(`v${++calls}`),
    });
    await router.execute(makeCtx("GET", "/probe/cached"));
    const second = await router.execute(makeCtx("GET", "/probe/cached"));
    expect(await second!.text()).toBe("v1");
    expect(calls).toBe(1);
  });

  it("缓存键含身份维度：不同 principal 不得互相取回响应", async () => {
    const { HttpRouter } = await import("../src/core/http-router.js");
    const router = new HttpRouter({
      cacheMaxSize: 20,
      cacheTtlMs: 60_000,
      principalOf: (ctx: { req: Request }) => (ctx.req.headers.get("x-api-key") ? "credentialed" : "anonymous"),
    });
    let calls = 0;
    router.register({
      method: "GET",
      path: "/probe/identity",
      meta: { cacheable: true },
      handler: async () => new Response(`v${++calls}`),
    });
    await router.execute(makeCtx("GET", "/probe/identity", { "x-api-key": "fixture-token" }));
    const anon = await router.execute(makeCtx("GET", "/probe/identity"));
    expect(calls).toBe(2);
    expect(await anon!.text()).toBe("v2");
  });

  it("缓存查询不得出现在路由匹配之前", () => {
    const src = read("src/core/http-router.ts");
    const execute = src.slice(src.indexOf("async execute("));
    const body = execute.slice(0, execute.indexOf("\n  }\n"));
    expect(body.indexOf("this.cache.get(")).toBeGreaterThan(body.indexOf("this.match("));
  });
});

// ─── S-6 审批/豁免开关默认安全侧 ─────────────────────────────────────────────
describe("S-6 安全开关默认值（封堵 L6/L8）", () => {
  it("PTY 审批模式缺配置不再是 off", async () => {
    const { parseApprovalMode } = await import("../src/terminal/command-gate.js");
    expect(parseApprovalMode(undefined)).toBe("risky");
    expect(parseApprovalMode("")).toBe("risky");
    expect(parseApprovalMode("off")).toBe("off");
  });

  it("回环免鉴权默认关闭，显式 =1 才开", async () => {
    const { localBypassEnabled } = await import("../src/utils/security-defaults.js");
    expect(localBypassEnabled({})).toBe(false);
    expect(localBypassEnabled({ AXIOM_ALLOW_LOCAL_BYPASS: "0" })).toBe(false);
    expect(localBypassEnabled({ AXIOM_ALLOW_LOCAL_BYPASS: "1" })).toBe(true);
  });

  it("main.ts 不再把 true 作为该开关的默认值", () => {
    expect(read("src/main.ts")).not.toMatch(/readBool\(\s*"AXIOM_ALLOW_LOCAL_BYPASS"\s*,\s*true\s*\)/);
  });

  it("代码默认值与 config/security-defaults.json 登记一致", async () => {
    const { SECURITY_DEFAULTS } = await import("../src/utils/security-defaults.js");
    expect(exists("config/security-defaults.json")).toBe(true);
    const registered = JSON.parse(read("config/security-defaults.json")) as {
      switches: Array<{ env: string; secureDefault: string | boolean }>;
    };
    expect(registered.switches.length).toBeGreaterThan(1);
    for (const sw of registered.switches) {
      expect([true, false, "off", "risky", "strict"]).toContain(SECURITY_DEFAULTS[sw.env]);
      expect(String(SECURITY_DEFAULTS[sw.env])).toBe(String(sw.secureDefault));
    }
  });

  // ─── S-6 完备性（2026-10-14 全仓审核发现 2）──────────────────────────
  // 此前 S-6 只校验"已登记项一致"，未登记的开关对门禁完全不可见 —— 于是
  // 4 个 fail-open 安全开关（ENFORCE_MODE_APPROVAL / SECOND_FACTOR_TOKEN /
  // EDGE_RISK_FAIL_CLOSED / ALLOW_REMOTE_CDP）长期静默存在。以下断言扫描
  // 源码中全部安全语义开关，未登记（SECURITY_DEFAULTS ∪ SECURITY_GAPS）即红。
  it("安全语义开关必须全部登记：未登记即红（防静默缺口）", async () => {
    const { SECURITY_DEFAULTS, SECURITY_GAPS } = await import("../src/utils/security-defaults.js");
    const known = new Set([...Object.keys(SECURITY_DEFAULTS), ...Object.keys(SECURITY_GAPS)]);

    // 安全语义命名模式：审批/豁免/强制/失败侧/第二因子/远程放行
    const SECURITY_NAME = /(ENFORCE|APPROVAL|BYPASS|FAIL_CLOSED|FAILCLOSED|SECOND_FACTOR|ALLOW_REMOTE)/;
    const found = new Set<string>();
    for (const rel of walkTs("src")) {
      if (rel.endsWith(".test.ts")) continue;
      const src = read(rel);
      // 形态 1：字面量读取 readBool/readString/readInt("NAME")
      for (const m of src.matchAll(/read(?:Bool|String|Int)\(\s*"([A-Z0-9_]+)"/g)) {
        if (SECURITY_NAME.test(m[1])) found.add(m[1]);
      }
      // 形态 2：常量定义式 export const X_ENV = "NAME"（如 LOCAL_BYPASS_ENV，
      // 经 localBypassEnabled() 读取，不出现字面量 readBool 调用）
      for (const m of src.matchAll(/(?:const|let)\s+\w*_ENV\s*=\s*"([A-Z0-9_]+)"/g)) {
        if (SECURITY_NAME.test(m[1])) found.add(m[1]);
      }
    }
    // 自检：两种形态都必须能命中已知开关，否则"零命中"是假绿
    expect(found.has("AXIOM_ENFORCE_MODE_APPROVAL"), "字面量形态扫描应命中").toBe(true);
    expect(found.has("AXIOM_ALLOW_LOCAL_BYPASS"), "常量定义形态扫描应命中").toBe(true);

    const unregistered = [...found].filter((v) => !known.has(v)).sort();
    expect(unregistered, `以下安全开关未登记（加入 SECURITY_DEFAULTS 或 SECURITY_GAPS）：\n${unregistered.join("\n")}`).toEqual([]);
  });

  it("SECURITY_GAPS 登记项必须带非空说明且确实存在于源码", async () => {
    const { SECURITY_GAPS } = await import("../src/utils/security-defaults.js");
    const allSrc = walkTs("src").filter((r) => !r.endsWith(".test.ts")).map(read).join("\n");
    for (const [env, why] of Object.entries(SECURITY_GAPS)) {
      expect(why.length, `${env} 的缺口说明不得为空`).toBeGreaterThan(10);
      // 登记了源码里根本不存在的开关 = 错登记，会掩盖真实缺口
      expect(allSrc.includes(env), `${env} 应在源码中被实际读取`).toBe(true);
    }
  });

  it("缺口声明侧（config/security-defaults.json gaps）与代码侧 SECURITY_GAPS 一致", async () => {
    const { SECURITY_GAPS } = await import("../src/utils/security-defaults.js");
    const cfg = JSON.parse(read("config/security-defaults.json")) as {
      gaps?: Array<{ env: string; currentDefault: boolean | string; secureDefault: boolean | string; impact: string }>;
    };
    expect(Array.isArray(cfg.gaps), "config 应含 gaps 章节").toBe(true);
    const cfgEnvs = (cfg.gaps ?? []).map((g) => g.env).sort();
    const codeEnvs = Object.keys(SECURITY_GAPS).sort();
    expect(cfgEnvs, "两侧登记的缺口开关集合必须一致").toEqual(codeEnvs);
    for (const g of cfg.gaps ?? []) {
      expect(g.impact.length, `${g.env} 应说明影响`).toBeGreaterThan(10);
      expect(typeof g.currentDefault, `${g.env} 应记录当前实际默认值`).not.toBe("undefined");
    }
  });

  it("回环豁免与网络暴露叠加时启动留痕（不静默）", async () => {
    const { bypassExposureWarning } = await import("../src/utils/security-defaults.js");
    expect(bypassExposureWarning(false, "0.0.0.0")).toBeNull();
    expect(bypassExposureWarning(true, "127.0.0.1")).toBeNull();
    expect(bypassExposureWarning(true, "localhost")).toBeNull();
    expect(bypassExposureWarning(true, "0.0.0.0")).toInclude("AXIOM_ALLOW_LOCAL_BYPASS");
    // 判定必须真的接在网关启动路径上，否则只是躺着没人调的纯函数
    expect(read("src/main.ts")).toMatch(/bypassExposureWarning\(/);
  });

  it("回环豁免只有一个开关来源：并列入口不得无条件信任本机", () => {
    // 网关默认值收紧后，MCP HTTP 等第二处服务端若直接把 isLocalAddress() 当作
    // isLocal 传给鉴权函数，就等于换了个地方继续放行本机请求（L6 未封堵）。
    const offenders = walkTs("src")
      .filter((rel) => rel !== "src/utils/auth-check.ts") // 定义处不参与
      .filter((rel) => /isLocalAddress\(/.test(read(rel)) && !/localBypassEnabled\(/.test(read(rel)));
    expect(offenders).toEqual([]);
  });
});

// ─── S-7 跨调用序列复核不因回环而豁免（I4）──────────────────────────────────
describe("S-7 链路组合可见（I4）", () => {
  it("同一 principal 连续多次特权调用被升级到审批", async () => {
    const { reviewSequence, resetSequences } = await import("../src/agents/risk-monitor.js");
    resetSequences();
    const call = { capabilities: ["fs.write" as const], args: { path: "src/a.ts" } };
    let escalated = false;
    for (let i = 0; i < 12; i++) {
      if ((await reviewSequence(call, { onEscalate: () => (escalated = true) })) === "require-approval") {
        escalated = true;
        break;
      }
    }
    expect(escalated).toBe(true);
    resetSequences();
  });

  it("审批通道不得引用回环地址作为豁免依据", () => {
    const src = read("src/utils/approval-bridge.ts");
    expect(src).not.toMatch(/isLocalAddress|requestIP|127\.0\.0\.1/);
  });

  it("主体标签不得由调用方指定：轮转未被校验的 Authorization 不得重置 I4 计数", async () => {
    // 症状复现（R3-①）：x-api-key 携带有效 token 即过鉴权（`checkApiKey` 的 `||` 短路使
    // Authorization 从不参与比较），而主体标签若优先取 Authorization，调用方就能用一次
    // 随机字符串换一个 sequences 桶 —— burst 与 CHAIN_PAIRS 都只在桶内查（`reviewSequence`
    // 内 `sequences.get(principal)`）。
    const { reviewSequence, resetSequences, SEQUENCE_BURST_LIMIT } = await import(
      "../src/agents/risk-monitor.js"
    );
    const { credentialPrincipal } = await import("../src/utils/call-context.js");
    resetSequences();
    const principalOf = (n: number) =>
      credentialPrincipal(
        new Headers({ "x-api-key": "valid-token", authorization: `Bearer rotate-${n}` }),
      );
    expect(new Set([1, 2, 3].map(principalOf)).size).toBe(1); // 前提：轮转不换身份
    let escalated = false;
    for (let i = 0; i < SEQUENCE_BURST_LIMIT + 4; i++) {
      const call = {
        capabilities: ["fs.write" as const],
        args: { path: "src/a.ts" },
        principal: principalOf(i),
      };
      if ((await reviewSequence(call, { onEscalate: () => (escalated = true) })) === "require-approval") {
        escalated = true;
        break;
      }
    }
    expect(escalated).toBeTrue();
    resetSequences();
  });
});

// ─── S-8 命令类目标必须声明（R2-D）──────────────────────────────────────────
describe("S-8 命令类负载只认声明，不认形态猜测", () => {
  const procExecLiterals = () => {
    const out: Array<{ rel: string; index: number; literal: string }> = [];
    for (const rel of [...walkTs("src"), ...walkTs("plugins")]) {
      addLiterals(read(rel))
        .filter((lit) => /\bhandler\s*:/.test(lit))
        .forEach((literal, i) => {
          const caps = literal.match(/\bcapability\s*:\s*\[[^\]]*\]/);
          if (caps && /["']proc\.exec["']/.test(caps[0])) {
            out.push({ rel, index: i + 1, literal });
          }
        });
    }
    return out;
  };
  const hasDeclaration = (lit: string) =>
    /\bpayloadFields\s*:\s*\{[^}]*["']proc\.exec["']/.test(lit);

  // 显式预算：这几条要走遍 src/ + plugins/ 的源码文本。本机并行下实测 2.1–4.8s，
  // 已是 bun 默认 5s 单用例超时的九成 —— 而 `.ci/run.sh` 用的正是裸 `bun test`，
  // 差一点就变成一条与判据无关的 CI 超时红。沿用本仓既有写法（benchmark、
  // code-analysis-shell-safety 等都自报预算）。
  it("每一处 proc.exec 注册都声明了 payloadFields['proc.exec']", () => {
    const offenders = procExecLiterals()
      .filter(({ literal }) => !hasDeclaration(literal))
      .map(({ rel, index }) => `${rel} #${index}`);
    expect(offenders).toEqual([]);
  }, 30_000);

  it("扫描确实覆盖到生产注册（正向对照，防零命中假绿）", () => {
    const hits = procExecLiterals().filter(({ rel, literal }) =>
      rel === "src/mcp/register-external-tools.ts" && hasDeclaration(literal) && /terminal_exec/.test(literal),
    );
    expect(hits.length).toBe(1);
  }, 30_000);
});

// ─── S-9 命令危险判据单源（R3-B，§2.7.4 第 1 条）─────────────────────────────
describe("S-9 命令危险判据只有一个定义点", () => {
  it("危险判据清单只有一个导出点", () => {
    const defs = walkTs("src").filter((rel) => /export const COMMAND_DANGER_RULES\b/.test(read(rel)));
    expect(defs).toEqual(["src/utils/command-safety.ts"]);
  });

  it("派发前与执行点都调用同一个判定入口，且没有别处再立模式清单", () => {
    // 行为等值由 tests/command-danger-single-source.test.ts 锁；这里锁"没有第二份清单"这个结构
    const pre = read("src/utils/permissions.ts");
    expect(pre).toContain("commandDanger(");
    expect(pre).not.toMatch(/HIGH_RISK_PATTERNS\s*=\s*\[/);
    const exec = read("src/utils/command-safety.ts");
    expect(exec).toContain("if (commandDanger(command))");
    const offenders = walkTs("src")
      .filter((rel) => rel !== "src/utils/command-safety.ts")
      .filter((rel) => /(const|let)\s+\w*(HIGH_RISK|DANGEROUS|STRUCTURAL)_PATTERNS\s*=/.test(read(rel)));
    expect(offenders).toEqual([]);
  });
});

// ─── S-10 序列复核的主体由调用上下文供给（R3-③，I4 的身份维度）───────────────
describe("S-10 工具执行边界必须标注调用主体", () => {
  // 能拿到请求对象、又会执行已注册工具的边界。新增此类边界必须同时登记并接线。
  const BOUNDARIES = [
    "src/core/http-router.ts",
    "src/mcp/server.ts",
    "src/mcp/dre-backend.ts",
    "src/mcp/kb-backend.ts",
  ];

  it("守卫从当次调用的上下文读主体，并把主体交给序列复核", () => {
    const src = read("src/mcp/tool-registry.ts");
    expect(src).toContain("callPrincipalOr(");
    expect(/const call = \{[^}]*\bprincipal\b[^}]*\}/.test(src)).toBeTrue();
  });

  it("每条可识别调用方的执行边界都出现在已标注清单里", () => {
    for (const rel of BOUNDARIES) expect(read(rel)).toContain("runAsCallPrincipal(");
    const wired = walkTs("src")
      .filter((rel) => rel !== "src/utils/call-context.ts")
      .filter((rel) => /\brunAsCallPrincipal\s*\(/.test(read(rel)))
      .sort();
    expect(wired).toEqual([...BOUNDARIES].sort());
  });

  it("缺省主体桶只有一个常量，别处不得再写字面量", () => {
    const defs = walkTs("src").filter((rel) => /export const UNATTRIBUTED_PRINCIPAL\b/.test(read(rel)));
    expect(defs).toEqual(["src/utils/call-context.ts"]);
    const offenders = walkTs("src")
      .filter((rel) => rel !== "src/utils/call-context.ts")
      .filter((rel) => /[=?:]\s*["']unassigned["']/.test(read(rel)));
    expect(offenders).toEqual([]);
  });
});

// ─── S-11 响应缓存只能按路由显式开启（R4，I3 的默认值维度）────────────────────
describe("S-11 生产路由的响应缓存开启清单", () => {
  // 缓存一份响应 = 把它交给后来的调用方读。开哪条路由是逐条裁决（该响应是否与调用方
  // 无关、能否容忍 TTL 内陈旧），不是随手加的一个字段 —— 所以新增声明必须同时出现在
  // 这份清单里，使"偷偷开始缓存"成为一次必须被看见的改动。
  // 当前生产面无人开启：默认关闭是行为基线，其行为面由 S-4 锁。
  const CACHEABLE_ROUTES: string[] = [];

  it("src 内声明 cacheable: true 的文件与本清单一致", () => {
    const hits = walkTs("src")
      .filter((rel) => /cacheable\s*:\s*true/.test(read(rel)))
      .sort();
    expect(hits).toEqual([...CACHEABLE_ROUTES].sort());
  });
});

// ─── S-12 凭证提取只有一个定义点（R3-①，身份口径不得有第二份）──────────────────
describe("S-12 凭证提取只有一个定义点", () => {
  // 动因（R3-① 实测；"收口前"指本门落地前的状态）：同一个"取 x-api-key 还是 Authorization、
  // 去不去 Bearer 前缀"的表达式散落在 8 个文件的 9 处提取点，其中 `credentialPrincipal` 一处
  // 反向优先取 `authorization` 且不剥前缀 —— 于是"鉴权采用哪份凭证"与"主体按哪份凭证归因"分家。
  // 携带有效 x-api-key 的请求里 Authorization 从不被比较（`checkApiKey` 的 `||`），却决定主体标签；
  // 而 risk-monitor 的 sequences 只按 principal 分桶（`reviewSequence` 取 `sequences.get(principal)`，无全局兜底），
  // 轮转这个从不校验的头即每问一个新计数器 ⇒ I4 的 burst 与链路配对检测同时失效。
  // 出网点（`Authorization: \`Bearer ${key}\`` 之类）是**写入**请求头，不是提取，不得被本判据命中。
  const EXTRACT = /headers\.get\(\s*["'](?:authorization|x-api-key)["']\s*\)/i;
  const HOME = "src/utils/call-context.ts";

  it("凭证头提取表达式只在单源函数里出现（别处一律调用 callerCredential）", () => {
    const offenders = walkTs("src")
      .filter((rel) => rel !== HOME)
      .filter((rel) => EXTRACT.test(read(rel)))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("判据自检：单源函数确实含提取表达式，且鉴权与限流都改经它（门不得对自己免检）", () => {
    // 正向对照：若提取写法整体改名，offenders 会静默变成空清单而恒绿 —— 本条就是为此准备的。
    expect(EXTRACT.test(read(HOME))).toBeTrue();
    const DELEGATES = /callerCredential\(|credentialDigest\(/;
    const notDelegating = ["src/utils/auth-check.ts", "src/utils/rate-limiter.ts", "src/main.ts", HOME]
      .filter((rel) => !DELEGATES.test(read(rel)));
    expect(notDelegating).toEqual([]);
    // 主体标签必须由该摘要派生，不得在 credentialPrincipal 里再读一次头
    const principalBody = read(HOME).split("function credentialPrincipal")[1] ?? "";
    expect(principalBody.slice(0, 220)).toContain("credentialDigest(headers)");
    expect(principalBody.slice(0, 220)).not.toContain("headers.get(");
  });
});
