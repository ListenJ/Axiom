/**
 * PTY 交互终端审批门（R-024 长期缓解）—— 深模块
 *
 * 把 HITL ApprovalBridge 审批链接入交互式终端的"整行命令"输入：
 *   - 非回车字符实时透传 stdin（vi/less 等交互程序不受影响）；
 *   - 遇到行终止符（\r\n | \r | \n）才把当前行作为命令做判定；
 *   - AXIOM_PTY_APPROVAL_MODE=off|risky|strict（默认 off，保持现状向后兼容）：
 *       off    直接放行（现状）
 *       risky  sanitizeCommand 判定危险/白名单外才走审批（risk=destructive）
 *       strict 任意非空命令都走审批（危险命令 risk=destructive，其余 unknown）
 *   - 审批/缓冲期间后续输入进入有界队列：完整行按序审批；期间键入的部分字符
 *     在结算后统一冲刷（避免被拒绝时的 Ctrl-C 误清下一行）；
 *   - 拒绝时向 stdin 发 Ctrl-C 取消已键入行，并经 session.notify 向终端输出提示；
 *   - 无审批 handler 时 ApprovalBridge fail-closed 自动拒绝。
 *
 * 深模块设计：CommandGate 只暴露 write/isPending 小接口，行缓冲、队列、审批
 * 编排全部内聚在内部；调用方（terminal 路由）无需感知审批细节。
 */
import type { PtySession } from "./pty-session.js";
import { sanitizeCommand } from "../utils/command-safety.js";
import { getApprovalBridge, type ApprovalRisk } from "../utils/approval-bridge.js";
import { readString } from "../utils/env.js";
import { logger } from "../utils/logger.js";

export type PtyApprovalMode = "off" | "risky" | "strict";

/** 环境变量名：AXIOM_PTY_APPROVAL_MODE=off|risky|strict */
export const PTY_APPROVAL_MODE_ENV = "AXIOM_PTY_APPROVAL_MODE";

/** 审批桥的最小接口（真实 ApprovalBridge 结构兼容；测试可注入 fake） */
export interface ApprovalBridgeLike {
  request(
    tool: string,
    args: unknown,
    options?: { risk?: ApprovalRisk; timeoutMs?: number },
  ): Promise<boolean>;
}

export interface CommandGateOptions {
  /** 审批桥；默认进程级 getApprovalBridge() */
  bridge?: ApprovalBridgeLike;
  /** 模式；默认读 AXIOM_PTY_APPROVAL_MODE（未设置=off） */
  mode?: PtyApprovalMode;
  /** 审批/缓冲期间可积压的完整行上限，默认 32 */
  maxQueue?: number;
}

const TERM_RE = /^(?:\r\n|\r|\n)/;
/** 无终止符的部分行长度上限（超出视为交互程序输入/巨型粘贴，直接透传） */
const MAX_PARTIAL = 8192;
/** 单次终端命令审批超时（ApprovalBridge 最小值 1s，前端弹窗默认 15s 自动拒绝） */
const APPROVAL_TIMEOUT_MS = 30_000;
const DENIED_NOTICE = "\r\n[denied] command blocked by approval\r\n";
const DROP_NOTICE = "\r\n[pty] input dropped while approval queue is full\r\n";

interface LineItem {
  /** 完整命令行（不含终止符） */
  line: string;
  /** 行终止符（\r\n | \r | \n），审批通过后原样写入 */
  term: string;
  /** 行内容是否已写入会话 stdin（审批期间缓冲的行尚未写入，处理时先补写） */
  written: boolean;
}

/** 解析审批模式；未知值 fail-closed 按 strict 处理 */
export function parseApprovalMode(raw: string | undefined): PtyApprovalMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return "off";
  if (v === "risky") return "risky";
  if (v === "strict") return "strict";
  logger.warn(
    `[CommandGate] unknown ${PTY_APPROVAL_MODE_ENV}=${JSON.stringify(raw)}; treating as strict (fail-closed)`,
  );
  return "strict";
}

export class CommandGate {
  private readonly session: PtySession;
  private readonly bridge: ApprovalBridgeLike;
  private readonly mode: PtyApprovalMode;
  private readonly maxQueue: number;

  /** 当前部分行（尚未遇到终止符的输入） */
  private buf = "";
  /** buf 内容是否已写入会话（审批期间持有的部分字符尚未写入） */
  private bufWritten = true;
  /** 等待链上处理的完整行数（>0 时新输入需缓冲，避免与待结算行交错） */
  private inflight = 0;
  /** 正在等待用户决定的审批数 */
  private pendingApprovals = 0;
  /** 串行处理链：保证完整行按到达顺序逐条审批/透传 */
  private chain: Promise<void> = Promise.resolve();

  constructor(session: PtySession, options: CommandGateOptions = {}) {
    this.session = session;
    this.bridge = options.bridge ?? getApprovalBridge();
    this.mode = options.mode ?? parseApprovalMode(readString(PTY_APPROVAL_MODE_ENV));
    this.maxQueue = options.maxQueue ?? 32;
  }

  /** 是否有待用户决定的审批（前端提示/审计用） */
  get isPending(): boolean {
    return this.pendingApprovals > 0;
  }

  /**
   * 写入终端输入。返回的 Promise 在该输入触发的完整行处理完毕（含审批决定）后
   * resolve；调用方可 fire-and-forget（内部链吞掉异常）。
   */
  write(input: string): Promise<void> {
    const items = this.extract(input);
    if (items.length === 0) return Promise.resolve();
    const accepted = items.slice(0, Math.max(0, this.maxQueue - this.inflight));
    if (accepted.length < items.length) {
      this.session.notify(DROP_NOTICE);
    }
    if (accepted.length === 0) return Promise.resolve();
    this.inflight += accepted.length;
    const task = this.chain.then(async () => {
      try {
        for (const item of accepted) {
          await this.handleItem(item);
        }
      } finally {
        this.inflight -= accepted.length;
      }
    });
    this.chain = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  // ----- 内部实现 -----

  /** 拆分输入：部分字符实时透传（或审批期间持有），完整行产出 LineItem */
  private extract(input: string): LineItem[] {
    const items: LineItem[] = [];
    let rest = input;
    while (rest.length > 0) {
      const m = TERM_RE.exec(rest);
      if (m) {
        const term = m[0];
        rest = rest.slice(term.length);
        items.push({ line: this.buf, term, written: this.bufWritten });
        this.buf = "";
        this.bufWritten = true;
        continue;
      }
      const idx = rest.search(/[\r\n]/);
      const head = idx === -1 ? rest : rest.slice(0, idx);
      if (head.length > 0) {
        if (this.buf.length + head.length > MAX_PARTIAL) {
          // 超长部分行（交互程序输入/巨型粘贴）：整体透传，不参与命令判定
          this.session.write(this.buf + head);
          this.buf = "";
          this.bufWritten = true;
        } else if (this.inflight > 0) {
          // 有未结算的审批/缓冲行：持有部分字符，结算后统一冲刷，
          // 避免被当前行拒绝时的 Ctrl-C 一并清掉
          this.buf += head;
          this.bufWritten = false;
        } else {
          this.buf += head;
          this.session.write(head);
          this.bufWritten = true;
        }
        rest = rest.slice(head.length);
      } else {
        rest = rest.slice(1); // 防御：单字符终止符已在分支一处理
      }
    }
    return items;
  }

  /** 处理一条完整行：透传 / 审批 / 拒绝 */
  private async handleItem(item: LineItem): Promise<void> {
    if (!item.written) {
      this.session.write(item.line);
    }
    if (item.line.trim() === "") {
      // 空行（裸回车）直接透传，不打扰审批
      this.session.write(item.term);
      return;
    }
    let needsApproval = false;
    let risk: ApprovalRisk = "unknown";
    if (this.mode === "strict") {
      needsApproval = true;
      if (!sanitizeCommand(item.line).safe) risk = "destructive";
    } else if (this.mode === "risky") {
      const safety = sanitizeCommand(item.line);
      if (!safety.safe) {
        needsApproval = true;
        risk = "destructive";
      }
    }
    if (!needsApproval) {
      this.session.write(item.term);
      return;
    }
    this.pendingApprovals += 1;
    try {
      const approved = await this.bridge.request(
        "pty_terminal_input",
        { command: item.line },
        { risk, timeoutMs: APPROVAL_TIMEOUT_MS },
      );
      if (approved) {
        this.session.write(item.term);
      } else {
        this.deny();
      }
    } catch {
      // 超时 / 无 handler：fail-closed 拒绝
      this.deny();
    } finally {
      this.pendingApprovals -= 1;
      this.flushHeld();
    }
  }

  private deny(): void {
    this.session.write("\x03");
    this.session.notify(DENIED_NOTICE);
  }

  /** 审批结算后冲刷审批期间持有的部分字符（原样出现在新提示符前） */
  private flushHeld(): void {
    if (!this.bufWritten && this.buf.length > 0) {
      this.session.write(this.buf);
      this.bufWritten = true;
    }
  }
}
