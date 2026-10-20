// @smoke
/**
 * 多运行时边界契约测试（2026-10-13 新增）
 *
 * 把 src/ 已证明的"机器检查纪律"延伸到 runtime-go / runtime-embed 边界：
 * - Go 侧：编译通过 + go.mod 有效
 * - Python 侧：server.py 语法有效 + pyproject.toml 存在
 * - TS↔运行时边界：src/ 中 :9001 仅出现在可覆盖默认值或错误消息中（非硬编码墙）
 *
 * 这不是功能测试——是存在性 + 编译性 + 边界卫生门禁。
 * 对应架构评估缺口 #2：多运行时边界未受同一门禁治理。
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { hasCommand, classifyGoBuildError } from "./helpers/env-probe";

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");
const runtimeGoDir = path.join(repoRoot, "runtime-go");
const runtimeEmbedDir = path.join(repoRoot, "runtime-embed");

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "_archive" && entry.name !== "node_modules") {
      results.push(...walkTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

/** 判断一行是否为注释行 */
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** 判断 :9001 出现是否为"可接受的默认值/错误消息"而非硬编码墙 */
function isAcceptableDefault(line: string, trimmed: string): boolean {
  // 注释行：可接受
  if (isCommentLine(trimmed)) return true;
  // 错误消息（throw new Error / Error( 中包含 :9001 的字符串）：可接受
  if (/throw\s+new\s+Error|new\s+Error\(/.test(line)) return true;
  // 默认值赋值（变量名含 DEFAULT 或默认）：可接受
  if (/DEFAULT.*=\s*["'`].*:9001/.test(line)) return true;
  // 配置对象的 baseURL 字段（可经 env 覆盖）：可接受
  if (/baseURL.*:9001/.test(line)) return true;
  // 跨行错误消息中的字符串参数（含 CJK 字符 = 描述性文本，非 URL 赋值）：可接受
  if (/[\u4e00-\u9fff]/.test(line)) return true;
  return false;
}

/**
 * go build 探测结果（2026-10-19 环境依赖用例门控设计 §4.2）：
 * - `ok`：编译通过；
 * - `skip`：环境不可用（E1 无 go / E2 GOPROXY 或网络不可达），报告里必须是**可见 skip**；
 * - `error`：环境可用但结果不对（编译错误 / 无法分类的失败），**必须红**，不能被 skip 掩盖。
 */
type GoBuildProbe = { ok: true } | { skip: string } | { error: Error };

/**
 * 在测试收集期探测一次 `go build ./...` 并缓存判定（记忆化由 env-probe 负责 E1 部分）。
 * 只有明确的模块下载错误（`classifyGoBuildError` → "network"）才允许跳过；
 * 编译错误与空 stderr（"unknown"）一律抛出，让用例变红。
 *
 * **必须在收集期调用，不能挪进 `beforeAll`**：bun 的 `it.skipIf(condition)`
 * 在注册测试时就对 boolean 求值（`node_modules/bun-types/test.d.ts` 签名为
 * `skipIf(condition: boolean)`）。若在 `beforeAll` 里「先探测、再 skipIf」，
 * skipIf 早已按旧值注册完毕，探测结果永远不生效，跳过会静默退化为「不跳过」。
 * 故只能在 describe 回调内、`it.skipIf` 之前同步探测一次。
 *
 * 超时 120s（原 30s）的原因：CI 上该用例的历史失败形态是 **bun 层 30s 超时**
 * （stderr 为空 → "unknown" → 红，无法回答「网络还是代码」）。旧实现把 build
 * 放在 test body 里，bun 会先按 30s 判红；现在 build 在收集期执行——实测收集期
 * 阻塞不受 per-test timeout 约束（6s 收集期阻塞在默认 5s 超时下仍 pass）——
 * 因此真正兜底的是 `execSync` 的 120s：让 go 有机会自己打印
 * `dial tcp ... i/o timeout` 等网络错误 → "network" → 可见 skip；若 120s 内
 * 仍无可用输出 → "unknown" → 红（异常静默超时不得假装成环境缺失）。
 *
 * 注意：`it` 的 120_000 只是安全网。**若将来有人把探测挪回 test body，必须保证
 * `execSync` 超时严格小于 bun 超时**：实测两者同为 2000ms 时 bun 先判 "timed out"
 * 且测试必红（catch 到的分类结果被吞）；execSync=1500 / bun=3000 才会走正常分类。
 */
function probeGoBuild(): GoBuildProbe {
  if (!hasCommand("go")) {
    return { skip: "未安装 go（E1 能力缺失）" };
  }

  try {
    // execSync 在成功时不抛异常；失败时抛异常
    execSync("go build ./...", {
      cwd: runtimeGoDir,
      stdio: "pipe",
      timeout: 120_000,
    });
    return { ok: true };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; killed?: boolean; signal?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
    const kind = classifyGoBuildError(stderr);

    if (kind === "network") {
      return { skip: "GOPROXY/网络不可达，无法拉取 go 模块依赖（E2）" };
    }

    const detail =
      stderr.trim() === ""
        ? `（stderr 为空，无法分类为 network；killed=${String(e.killed)} signal=${String(e.signal)}）`
        : stderr.slice(0, 800);
    return { error: new Error(`go build 失败（分类：${kind}），stderr 前 800 字符：\n${detail}`) };
  }
}

describe("多运行时边界契约", () => {

  describe("runtime-go（Go 高并发侧）", () => {
    it("go.mod 存在且有效", () => {
      const goMod = path.join(runtimeGoDir, "go.mod");
      expect(fs.existsSync(goMod)).toBe(true);
      const content = fs.readFileSync(goMod, "utf-8");
      expect(content).toContain("module ");
      expect(content).toContain("go ");
    });

    // 探测一次并缓存判定：环境缺失 → 可见 skip（标题带理由）；编译错误 → 红。
    // 必须收集期同步算完（skipIf 在注册时求值），不能挪进 beforeAll。
    const goBuild = probeGoBuild();

    it.skipIf("skip" in goBuild)(
      `go build ./... 编译通过${"skip" in goBuild ? `（跳过：${goBuild.skip}）` : ""}`,
      () => {
        if ("error" in goBuild) throw goBuild.error;
        expect(goBuild).toEqual({ ok: true });
      },
      120_000,
    );

    it("至少有 cmd/ 入口或 internal/ 包", () => {
      const hasCmd = fs.existsSync(path.join(runtimeGoDir, "cmd"));
      const hasInternal = fs.existsSync(path.join(runtimeGoDir, "internal"));
      expect(hasCmd || hasInternal).toBe(true);
    });
  });

  describe("runtime-embed（Python 本地 embedding 侧）", () => {
    it("server.py 存在且 Python 语法有效", () => {
      const serverPy = path.join(runtimeEmbedDir, "server.py");
      expect(fs.existsSync(serverPy)).toBe(true);

      let pyAvailable = false;
      try { execSync("python3 --version", { stdio: "pipe" }); pyAvailable = true; } catch { /* not available */ }
      if (!pyAvailable) return;

      execSync(`python3 -c "import ast; ast.parse(open('${serverPy}').read())"`, {
        stdio: "pipe",
        timeout: 10_000,
      });
      expect(true).toBe(true);
    }, 15_000);

    it("pyproject.toml 存在", () => {
      const pyproject = path.join(runtimeEmbedDir, "pyproject.toml");
      expect(fs.existsSync(pyproject)).toBe(true);
    });
  });

  describe("TS↔运行时边界卫生", () => {
    it("src/ 中 :9001 仅出现在可覆盖默认值或错误消息中（非硬编码墙）", () => {
      const files = walkTsFiles(srcDir);
      const violations: string[] = [];

      for (const file of files) {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // 检查 :9001 是否出现
          if (!/127\.0\.0\.1:9001|localhost:9001/.test(line)) continue;

          // 判断是否为可接受的默认值/错误消息
          if (isAcceptableDefault(line, trimmed)) continue;

          // 到这里说明 :9001 出现在非注释、非默认值、非错误消息的代码中
          violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${trimmed}`);
        }
      }

      expect(violations).toEqual([]);
    });

    it("src/ 中无硬编码 runtime-go/runtime-embed 路径引用", () => {
      const files = walkTsFiles(srcDir);
      const violations: string[] = [];

      for (const file of files) {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          if (isCommentLine(trimmed)) continue;

          if (/(?:^|["'`])runtime-(?:go|embed)\//.test(line) && !line.includes("import.meta")) {
            violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${trimmed}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
