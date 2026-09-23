/**
 * P0-1 read/write 工具路径围栏测试（审计 N-H1，2026-08-29）
 *
 * 语义对齐 src/mcp/tools/filesystem.ts isPathSafe 守卫：
 *   - cwd 限制（越界拒绝）
 *   - 沙箱内敏感区域拒绝（.env / .git / 运行时数据库）
 *   - symlink realpath 校验
 * 红线：cwd 内合法文件（含 vault 回退）读取不受影响
 */
import { describe, it, expect, afterEach, afterAll, spyOn } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

const LEGAL_DIR = ".tmp-tool-fence";
const LEGAL_FILE = `${LEGAL_DIR}/legal.txt`;
const ESCAPE_TMP = nodePath.join(os.tmpdir(), "fence-escape-probe.txt");
const FETCH_GUARD = `${LEGAL_DIR}/fetch-guard.txt`;

afterAll(async () => {
  await rm(LEGAL_DIR, { recursive: true, force: true });
  await rm(ESCAPE_TMP, { force: true });
});

// ========== [D-B] web 分支逐跳出网裁决 ==========

const REDIR = new Set([301, 302, 303, 307, 308]);
/** 桩自己的"传输层跳数上限"：未设 redirect:manual 的实现会让这里无限递归，必须先有个硬停 */
const TRANSPORT_HOP_CAP = 40;

/**
 * 重定向夹具必须模拟"传输层自己跟随跳转"，而不是只回一个 302。
 *
 * 只回 302 的桩会让漏洞路径不可达：旧实现拿到 302 后因 !res.ok 直接抛错，
 * 测试于是"修前也绿"，测的就不是那个洞。真实客户端的行为是自行跳到下一跳，
 * 而那一次跳转**没有经过任何裁决** —— 所以桩在未收到 redirect:"manual" 时
 * 递归发起下一跳并记录 URL，让"被拒的那一跳真的发出去了"可断言。
 */
function stubRedirects(chain: Record<string, { status: number; location?: string; body?: string }>) {
  const requested: string[] = [];
  const hop = async (url: string, init?: RequestInit): Promise<Response> => {
    requested.push(url);
    const step = chain[url];
    if (!step) throw new Error(`fixture has no route for ${url}`);
    const headers = new Headers({ "content-type": "text/plain" });
    if (step.location) headers.set("location", step.location);
    if (REDIR.has(step.status)) {
      if (init?.redirect === "manual") return new Response("", { status: step.status, headers });
      if (requested.length >= TRANSPORT_HOP_CAP) {
        throw new Error(`transport hop cap (${TRANSPORT_HOP_CAP}) exceeded — 实现未做逐跳上限`);
      }
      return hop(new URL(step.location!, url).href, init);
    }
    return new Response(step.body ?? "", { status: step.status, headers });
  };
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    ((input: RequestInfo | URL, init?: RequestInit) => hop(String(input), init)) as typeof fetch,
  );
  return { requested, spy };
}

async function readWeb(path: string) {
  const { readTool } = await import("../src/tools/read-tool.js");
  const { createToolContext } = await import("../src/tools/types.js");
  return readTool.execute({ payload: { source: "web", path }, context: createToolContext("db-web-read") });
}

describe("[D-B] readTool web 分支逐跳出网裁决", () => {
  afterEach(() => spyOn(globalThis, "fetch").mockRestore());

  const PUB = "https://example.com/doc";
  const PUB2 = "https://example.org/final";
  const METADATA = "http://169.254.169.254/latest/meta-data/iam";

  it("初始 URL 合法但 302 指向内网元数据：拒绝，且被拒那一跳根本没发出请求", async () => {
    const { requested, spy } = stubRedirects({
      [PUB]: { status: 302, location: METADATA },
      [METADATA]: { status: 200, body: "AKIA0123456789abcdef" },
    });
    await expect(readWeb(PUB)).rejects.toThrow(/denied|blocked|锚点|anchor/i);
    // 这一条才是修复的证据：只断言抛错会假绿（旧实现因 !ok 也抛错）
    expect(requested).toEqual([PUB]);
    expect(requested).not.toContain(METADATA);
    spy.mockRestore();
  });

  it("协议相对 Location（//内网IP/）先解析成绝对 URL 再裁决", async () => {
    const { requested, spy } = stubRedirects({
      [PUB]: { status: 302, location: "//169.254.169.254/latest/" },
      "https://169.254.169.254/latest/": { status: 200, body: "leaked" },
    });
    await expect(readWeb(PUB)).rejects.toThrow(/denied|blocked|锚点|anchor/i);
    expect(requested).toEqual([PUB]);
    spy.mockRestore();
  });

  it("公网 → 公网 的合法跳转不受影响（红线：不误伤正常网页读）", async () => {
    const { requested, spy } = stubRedirects({
      [PUB]: { status: 301, location: PUB2 },
      [PUB2]: { status: 200, body: "final-document-body" },
    });
    const res = await readWeb(PUB);
    expect(res.data.content).toContain("final-document-body");
    expect(requested).toEqual([PUB, PUB2]);
    spy.mockRestore();
  });

  it("跳转链超过上限即中止，不死循环", async () => {
    const mk = (i: number) => `https://h${i}.example.com/`;
    const chain: Record<string, { status: number; location?: string; body?: string }> = {};
    for (let i = 0; i < 9; i++) chain[mk(i)] = { status: 302, location: mk(i + 1) };
    chain[mk(9)] = { status: 200, body: "deep" };
    const { requested, spy } = stubRedirects(chain);
    await expect(readWeb(mk(0))).rejects.toThrow(/too many redirects|重定向|跳转/i);
    expect(requested.length).toBeLessThanOrEqual(10);
    spy.mockRestore();
  });

  it("相对 Location 按当前跳解析后仍在公网则放行", async () => {
    const { spy } = stubRedirects({
      [PUB]: { status: 302, location: "/moved" },
      "https://example.com/moved": { status: 200, body: "moved-body" },
    });
    const res = await readWeb(PUB);
    expect(res.data.content).toContain("moved-body");
    spy.mockRestore();
  });

  it("初始 URL 本身就是回环时仍拒绝（回归：不逐跳也不能漏首跳）", async () => {
    const { requested, spy } = stubRedirects({ "http://127.0.0.1:8788/x": { status: 200, body: "own" } });
    await expect(readWeb("http://127.0.0.1:8788/x")).rejects.toThrow(/denied|not in|AXIOM_NET_ALLOWLIST/i);
    expect(requested).toEqual([]);
    spy.mockRestore();
  });

  it("读文件围栏时不触碰网络（红线：web 守卫不外溢到 file 分支）", async () => {
    const { requested, spy } = stubRedirects({});
    await mkdir(LEGAL_DIR, { recursive: true });
    await writeFile(FETCH_GUARD, "no-network-here", "utf-8");
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const res = await readTool.execute({
      payload: { source: "file", path: FETCH_GUARD },
      context: createToolContext("db-file-read"),
    });
    expect(res.data.content).toBe("no-network-here");
    expect(requested).toEqual([]);
    spy.mockRestore();
  });
});

describe("[P0-1] readTool 路径围栏", () => {
  it("读 cwd 内 .env 被拒（错误含敏感语义，内容不外泄）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-env-read");
    await expect(
      readTool.execute({ payload: { source: "file", path: ".env" }, context: ctx }),
    ).rejects.toThrow(/denied area|sensitive|blocked|密钥/i);
  });

  it("读 cwd 内 .env.* 变体被拒", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-env-variant");
    await expect(
      readTool.execute({ payload: { source: "file", path: ".env.local" }, context: ctx }),
    ).rejects.toThrow(/denied area|sensitive|blocked|密钥/i);
  });

  it("读 cwd 外相对路径（../ 穿越）被拒（path outside workspace 语义）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-traversal");
    await expect(
      readTool.execute({ payload: { source: "file", path: "../../etc/passwd" }, context: ctx }),
    ).rejects.toThrow(/escapes working directory|outside|denied/i);
  });

  it("读 cwd 内合法临时文件通过（红线：合法读不误伤）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    await mkdir(LEGAL_DIR, { recursive: true });
    await writeFile(LEGAL_FILE, "legal-content-marker", "utf-8");
    const ctx = createToolContext("fence-legal-read");
    const result = await readTool.execute({
      payload: { source: "file", path: LEGAL_FILE },
      context: ctx,
    });
    expect(result.data.content).toContain("legal-content-marker");
  });

  it("cwd 内 vault 回退读不被围栏误伤（红线）", async () => {
    const { readTool } = await import("../src/tools/read-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-vault-read");
    ctx.localStore.set("vaultManager", {
      readNote: (p: string) => ({ content: `vault-note:${p}`, frontmatter: {} }),
    });
    const result = await readTool.execute({
      payload: { source: "file", path: "axiom-memory/fence-nonexistent-note.md" },
      context: ctx,
    });
    expect(result.data.content).toContain("vault-note:");
  });
});

describe("[P0-1] writeTool 路径围栏", () => {
  it("写 cwd 外绝对路径被拒（不落盘）", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-escape-write");
    await expect(
      writeTool.execute({
        payload: { target: "file", path: ESCAPE_TMP, content: "should-not-exist" },
        context: ctx,
      }),
    ).rejects.toThrow(/escapes working directory|outside|denied/i);
  });

  it("写 cwd 内合法路径通过（红线：合法写不误伤）", async () => {
    const { writeTool } = await import("../src/tools/write-tool.js");
    const { createToolContext } = await import("../src/tools/types.js");
    const ctx = createToolContext("fence-legal-write");
    const result = await writeTool.execute({
      payload: { target: "file", path: `${LEGAL_DIR}/written.txt`, content: "ok" },
      context: ctx,
    });
    expect(result.data.bytesWritten).toBe(2);
  });
});

describe("[P0-1] permissions 敏感路径拦截纳入 read", () => {
  it("read .env 被拦（连读都拒）", async () => {
    const { checkFilePermission } = await import("../src/utils/permissions.js");
    const check = checkFilePermission(".env", "read");
    expect(check.allowed).toBeFalse();
    // 口径变更（S3）：读被拒的落点是"执行锚点"表，不再是旧的"敏感路径"措辞
    expect(check.reason).toMatch(/sensitive|敏感|execution anchor|锚点/i);
  });

  it("read 合法路径不受影响", async () => {
    const { checkFilePermission } = await import("../src/utils/permissions.js");
    expect(checkFilePermission("src/app.ts", "read").allowed).toBeTrue();
    expect(checkFilePermission("data/notes.md", "read").allowed).toBeTrue();
  });

  it("write/delete 敏感路径拦截保持不变（回归）", async () => {
    const { checkFilePermission } = await import("../src/utils/permissions.js");
    expect(checkFilePermission(".env", "write").allowed).toBeFalse();
    expect(checkFilePermission(".ssh/id_rsa", "delete").allowed).toBeFalse();
  });
});
