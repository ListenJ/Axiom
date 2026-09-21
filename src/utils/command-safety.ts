/**
 * 命令安全判定（R-005 防线重构抽取，2026-07-30 由 src/mcp/tools/terminal.ts 移入）。
 *
 * 单一实现：命令危险判据只有一份（`COMMAND_DANGER_RULES`）——terminal_exec 工具、PTY 交互
 * 终端审批门（R-024）与派发前裁决（`permissions.ts` 的 command 判决）都从这里取结论，
 * 避免三处逻辑漂移。深模块：小接口（sanitizeCommand / commandDanger）+ 大实现
 * （白名单/黑名单/去混淆）。
 *
 * 两种模式：
 *   白名单（AXIOM_TERMINAL_WHITELIST=git,node,echo）：仅清单内二进制可执行，
 *     逐命令位 token 校验（管道/;/&&/|| 之后），并整体拒绝命令替换
 *     （$()/反引号），$(echo rm) -rf / 之类偷渡无从发生；
 *   黑名单（默认）：在原始串与"去混淆串"（去引号/字母转义、还原 $IFS）上
 *     双重匹配危险模式，并拦截 eval、解码管道执行（base64|sh 等）结构原语。
 */
import { readString } from "./env.js";

/** 一条危险判据：模式 + 人类可读原因（两层的拒绝理由都由它派生，不再各写一份） */
export interface CommandDangerRule {
  readonly pattern: RegExp;
  readonly description: string;
}

const DANGEROUS_RULES: readonly CommandDangerRule[] = [
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*rm\s+(?:-\w*\s+)*(-rf|-fr|-r\s+-f|-f\s+-r)\s+/i, description: "Recursive force delete" },
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*mkfs/i, description: "Filesystem format" },
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*dd\s+if=/i, description: "Raw device read/write" },
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*fdisk/i, description: "Disk partition manipulation" },
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*format\s+/i, description: "Volume format" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, description: "Redirect into raw block device" },
  { pattern: /curl\s+.*\|\s*(ba)?sh/i, description: "Piped shell execution from URL" },
  { pattern: /wget\s+.*\|\s*(ba)?sh/i, description: "Piped shell execution from URL" },
  { pattern: /:\(\)\s*\{\s*:\|:\u0026\s*\};/, description: "Fork bomb" },
  // Windows 危险：cmd /c 包装可绕过 Unix 前缀检测，需在原始串与去混淆串上双重拦截（H-02）
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*rd\s+\/s/i, description: "Windows recursive directory delete" },
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*rmdir\s+\/s/i, description: "Windows recursive directory delete" },
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*del\s+.*\/f/i, description: "Windows forced file delete" },
  { pattern: /(?:^|\s)shutdown\s+.*\/[sr]/i, description: "Windows shutdown/restart" },
  { pattern: /\bRemove-Item\b/i, description: "PowerShell delete" },
  { pattern: /\b(?:powershell|pwsh)(?:\.exe)?\b.*(?:Remove-Item|EncodedCommand|Invoke-Expression)/i, description: "PowerShell destructive/encoded execution" },
  // S3 审计加固（2026-08-25）：$()/反引号命令替换与 %VAR% 扩展在双引号内仍然生效，
  // 引号转义无法中和 → 黑名单字符串通道无条件拒绝（args 数组通道不经 shell，不受影响）。
  { pattern: /\$\(/, description: "Command substitution in string channel" },
  { pattern: /`/, description: "Backtick command substitution in string channel" },
  { pattern: /%[A-Za-z_]\w*%/, description: "%VAR% expansion in string channel" },
];

// 结构性原语：间接执行与解码-管道-执行，黑名单模式下无条件拦截
const STRUCTURAL_RULES: readonly CommandDangerRule[] = [
  { pattern: /(?:^|\s|;|&&|\|\||\()\s*eval\s/i, description: "Indirect execution via eval" },
  { pattern: /\b(?:base64|openssl|xxd)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|c|da)?sh\b/i, description: "Decode-then-pipe-to-shell" },
  { pattern: /\b(?:python[0-9.]*|perl|ruby)\s+-\S*e\b[^|]*\|\s*(?:ba|z|c)?sh\b/i, description: "Interpreter one-liner piped to shell" },
];

/**
 * 提权与账号/系统状态类判据 —— R3-B 之前是 `permissions.ts` 里另一份 `HIGH_RISK_PATTERNS`，
 * 于是"派发前"与"执行点"两层对同一条命令可以给出相反结论（`reboot` 一层拒一层放，
 * `rm${IFS}-rf /` 反过来）。这里并入同一份清单，两层共用：清单只有一份，分歧就没有藏身处。
 */
const ESCALATION_RULES: readonly CommandDangerRule[] = [
  { pattern: /chmod\s+777/, description: "Overly permissive file mode" },
  { pattern: /shutdown/, description: "System shutdown" },
  { pattern: /reboot/, description: "System reboot" },
  { pattern: /passwd/, description: "Password change" },
  { pattern: /useradd/, description: "User creation" },
  { pattern: /deluser|userdel/, description: "User deletion" },
  { pattern: /sudo\s+rm/, description: "Root-level deletion" },
  { pattern: /wget.*\.sh\s*\|/, description: "Piped shell execution from URL" },
  { pattern: /drop\s+table/i, description: "Database table deletion" },
  { pattern: /truncate\s+table/i, description: "Database table truncation" },
  { pattern: /delete\s+from/i, description: "Database mass deletion" },
];

/** 命令危险判据的唯一一份清单（两层都从这里取，禁止在别处另立第二份） */
export const COMMAND_DANGER_RULES: readonly CommandDangerRule[] = [
  ...DANGEROUS_RULES,
  ...STRUCTURAL_RULES,
  ...ESCALATION_RULES,
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

/**
 * 命令危险判定的唯一入口（R3-B / §2.7.4 第 1 条）：派发前裁决（`permissions.ts`）与
 * 执行点（本文件 `sanitizeCommand`）都调它，所以同一条命令不可能在两处得到相反结论。
 *
 * 匹配目标三份：原始串防归一意外掩盖模式，换行归一串让换行分隔的子命令都被看到，
 * 去混淆串（还原 `$IFS`、去字母转义与引号）防 `rm${IFS}-rf` / `r\m` 换写法脱管。
 */
export function commandDanger(command: string): string | null {
  const normalized = command.replace(/\r?\n/g, "; ");
  for (const target of [command, normalized, normalizeCommand(normalized)]) {
    for (const rule of COMMAND_DANGER_RULES) {
      if (rule.pattern.test(target)) return rule.description;
    }
  }
  return null;
}

export function sanitizeCommand(command: string): { safe: boolean; error?: string } {
  // N-H3 修复（2026-08-29）：换行归一为分号语句。多行命令在 sh -c / cmd /c 下本就是
  // 顺序执行，归一后语义等价；白名单命令位提取（; 为分隔符）与黑名单危险模式
  // 因此都能看到换行分隔的每条子命令，`git status\nrm -rf /` 之类的偷渡被拒。
  const normalized = command.replace(/\r?\n/g, "; ");
  const whitelist = parseWhitelist();
  if (whitelist) {
    if (whitelist.size === 0) {
      return { safe: false, error: "Terminal whitelist is empty: all commands blocked" };
    }
    // 命令替换的输出可成为被执行的命令本身，白名单模式下整体拒绝
    if (/\$\(|`/.test(normalized)) {
      return { safe: false, error: "Command substitution is not allowed in whitelist mode" };
    }
    for (const word of extractCommandWords(normalizeCommand(normalized))) {
      const base = word.split(/[\\/]/).pop()!.toLowerCase();
      if (!whitelist.has(base)) {
        return { safe: false, error: `Command "${base}" is not in the terminal whitelist` };
      }
    }
    return { safe: true };
  }

  // 黑名单：判据取自 commandDanger（与派发前同一份清单，不再各写一份）
  if (commandDanger(command)) {
    return { safe: false, error: `Dangerous command blocked for safety` };
  }
  return { safe: true };
}
