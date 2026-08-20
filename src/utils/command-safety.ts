/**
 * 命令安全判定（R-005 防线重构抽取，2026-07-30 由 src/mcp/tools/terminal.ts 移入）。
 *
 * 单一实现：terminal_exec 工具与 PTY 交互终端审批门（R-024）共用同一套判定，
 * 避免两处逻辑漂移。深模块：小接口（sanitizeCommand）+ 大实现（白名单/黑名单/去混淆）。
 *
 * 两种模式：
 *   白名单（AXIOM_TERMINAL_WHITELIST=git,node,echo）：仅清单内二进制可执行，
 *     逐命令位 token 校验（管道/;/&&/|| 之后），并整体拒绝命令替换
 *     （$()/反引号），$(echo rm) -rf / 之类偷渡无从发生；
 *   黑名单（默认）：在原始串与"去混淆串"（去引号/字母转义、还原 $IFS）上
 *     双重匹配危险模式，并拦截 eval、解码管道执行（base64|sh 等）结构原语。
 */
import { readString } from "./env.js";

const DANGEROUS_PATTERNS = [
  /(?:^|\s|;|&&|\|\||\()\s*rm\s+(?:-\w*\s+)*(-rf|-fr|-r\s+-f|-f\s+-r)\s+/i,
  /(?:^|\s|;|&&|\|\||\()\s*mkfs\./i,
  /(?:^|\s|;|&&|\|\||\()\s*dd\s+if=/i,
  /(?:^|\s|;|&&|\|\||\()\s*fdisk\s+/i,
  /(?:^|\s|;|&&|\|\||\()\s*format\s+/i,
  />\s*\/dev\/[sh]d[a-z]/,
  /curl\s+.*\|\s*(ba)?sh/i,
  /wget\s+.*\|\s*(ba)?sh/i,
  /:\(\)\s*\{\s*:\|:\u0026\s*\};/,
  // Windows 危险：cmd /c 包装可绕过 Unix 前缀检测，需在原始串与去混淆串上双重拦截（H-02）
  /(?:^|\s|;|&&|\|\||\()\s*rd\s+\/s/i,
  /(?:^|\s|;|&&|\|\||\()\s*rmdir\s+\/s/i,
  /(?:^|\s|;|&&|\|\||\()\s*del\s+.*\/f/i,
  /(?:^|\s)shutdown\s+.*\/[sr]/i,
  /\bRemove-Item\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b.*(?:Remove-Item|EncodedCommand|Invoke-Expression)/i,
];

// 结构性原语：间接执行与解码-管道-执行，黑名单模式下无条件拦截
const STRUCTURAL_PATTERNS = [
  /(?:^|\s|;|&&|\|\||\()\s*eval\s/i,
  /\b(?:base64|openssl|xxd)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|c|da)?sh\b/i,
  /\b(?:python[0-9.]*|perl|ruby)\s+-\S*e\b[^|]*\|\s*(?:ba|z|c)?sh\b/i,
];

/** 去混淆：还原 $IFS、去字母转义（r\m→rm）、去引号（r"m"→rm），让黑名单看到真实拼写 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\$\{?IFS\}?/g, " ")
    .replace(/\\(?=[A-Za-z])/g, "")
    .replace(/["']/g, "");
}

/** 命令位 token：字符串起始及 ; & | ( ` $( 之后的第一个词（含管道下游命令） */
function extractCommandWords(command: string): string[] {
  const words: string[] = [];
  const re = /(?:^|[;&|()`]|\$\()\s*([^\s;|&()`$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    words.push(m[1]!);
  }
  return words;
}

/** 白名单：AXIOM_TERMINAL_WHITELIST=git,node,echo（逗号分隔二进制名，每次调用时读取） */
function parseWhitelist(): Set<string> | null {
  const raw = readString("AXIOM_TERMINAL_WHITELIST");
  if (!raw || !raw.trim()) return null;
  return new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

export function sanitizeCommand(command: string): { safe: boolean; error?: string } {
  const whitelist = parseWhitelist();
  if (whitelist) {
    if (whitelist.size === 0) {
      return { safe: false, error: "Terminal whitelist is empty: all commands blocked" };
    }
    // 命令替换的输出可成为被执行的命令本身，白名单模式下整体拒绝
    if (/\$\(|`/.test(command)) {
      return { safe: false, error: "Command substitution is not allowed in whitelist mode" };
    }
    for (const word of extractCommandWords(normalizeCommand(command))) {
      const base = word.split(/[\\/]/).pop()!.toLowerCase();
      if (!whitelist.has(base)) {
        return { safe: false, error: `Command "${base}" is not in the terminal whitelist` };
      }
    }
    return { safe: true };
  }

  // 黑名单：原始串 + 去混淆串双重匹配
  for (const target of [command, normalizeCommand(command)]) {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(target)) {
        return { safe: false, error: `Dangerous command blocked for safety` };
      }
    }
  }
  for (const pattern of STRUCTURAL_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, error: `Dangerous command blocked for safety` };
    }
  }
  return { safe: true };
}
