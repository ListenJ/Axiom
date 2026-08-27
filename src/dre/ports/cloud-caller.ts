/**
 * L1 端口：DRE 云端降级调用器。
 *
 * 依赖倒置：src/dre 核心只依赖本端口；具体 provider 调用由上层适配器
 * （src/router/provider-caller.ts 的 createDreCloudAdapter）在组合根装配注入，
 * 从而解除 dre→router 反向依赖（架构完整性断言见 tests/architecture-integrity.test.ts L1）。
 */

export interface DreCloudCallInput {
  /** 决策系统提示词 */
  system: string;
  /** 观察内容（user 消息） */
  user: string;
  timeoutMs: number;
  temperature: number;
}

export interface DreCloudCaller {
  call(input: DreCloudCallInput): Promise<{ content: string }>;
}
