/**
 * Runtime — 通用 Agent 运行时类型定义
 *
 * 第三方 Agent 实现 AgentAdapter 接口即可运行于 RuntimeHost。
 * RuntimeContext 由 Host 构造并注入，提供日志 / 调度 / 能力 / 知识 / 事件能力。
 *
 * 设计原则:
 * - 接口最小化: 第三方只需实现 6 个方法即可接入
 * - 能力契约化: Agent 声明 capabilities，Host 按 task.type 路由
 * - 错误隔离: Host 包装所有 Agent 调用，单 Agent 异常不波及其他 Agent
 */

/** 任务优先级 (与 DRE scheduler 对齐，去除 background) */
export type TaskPriority = "critical" | "high" | "normal" | "low";

/** Agent 状态机 */
export type AgentState = "uninitialized" | "initialized" | "running" | "stopped" | "error";

/** 健康状态 */
export interface HealthStatus {
  healthy: boolean;
  details?: Record<string, unknown>;
}

/** 运行时任务 — Host 分发给 Agent 的执行单元 */
export interface RuntimeTask {
  id: string;
  /** 任务类型，用于匹配 Agent 的 capabilities */
  type: string;
  input: unknown;
  /** 超时 (ms)，超时后 dispatchTask 返回错误结果 */
  timeout?: number;
  priority?: TaskPriority;
}

/** 任务执行结果 */
export interface RuntimeResult {
  taskId: string;
  success: boolean;
  output?: unknown;
  error?: { code: string; message: string };
  /** 执行耗时 (ms) */
  durationMs: number;
}

/**
 * 运行时上下文 — Host 注入给 Agent 的能力集合。
 * Agent 通过此上下文访问日志、调度、能力注册表、知识库与事件总线，
 * 而无需直接依赖具体实现。
 */
export interface RuntimeContext {
  /** 结构化日志 (info / warn / error) */
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
  /** 任务调度器 — Agent 可提交子任务 */
  scheduler: {
    submit(task: {
      name: string;
      priority: TaskPriority;
      payload: unknown;
      maxRetries: number;
      dependencies: string[];
    }): { id: string };
    getNext(): { id: string; name: string } | null;
    complete(id: string, result: unknown): void;
  };
  /** 能力注册表 — 按契约选择 Provider 并记录调用结果 */
  capabilityRegistry: {
    select(contract: string): { id: string } | null;
    recordResult(id: string, success: boolean): void;
  };
  /** 知识库 — 查询与存储 */
  knowledge: {
    query(q: string): Promise<unknown[]>;
    store(item: unknown): Promise<void>;
  };
  /** 事件发射 — Agent 可发布自定义事件 */
  emit(event: string, data: unknown): void;
}

/**
 * Agent 接入接口 — 第三方 Agent 实现此接口即可运行于 Runtime。
 *
 * 最少需实现 6 个方法: initialize / start / stop / handleTask
 * (healthCheck 与 destroy 为可选)。
 *
 * capabilities 含义: Agent 声明可处理的任务类型 (能力契约)；
 * RuntimeHost.dispatchTask 按 task.type 匹配此列表进行路由。
 */
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** 声明可处理的能力契约；dispatchTask 按 task.type 匹配此列表 */
  readonly capabilities: string[];

  // ─── 生命周期 ──────────────────────────────────────────────
  /** 初始化 (加载配置 / 建立连接) */
  initialize(ctx: RuntimeContext): Promise<void>;
  /** 启动 (开始接收任务) */
  start(ctx: RuntimeContext): Promise<void>;
  /** 停止 (停止接收任务，释放活跃资源) */
  stop(ctx: RuntimeContext): Promise<void>;
  /** 销毁 (可选，最终资源清理) */
  destroy?(): Promise<void>;

  // ─── 执行 ──────────────────────────────────────────────────
  /** 处理任务 — 必须返回 RuntimeResult，不应抛出异常 */
  handleTask(task: RuntimeTask, ctx: RuntimeContext): Promise<RuntimeResult>;

  // ─── 健康检查 (可选) ───────────────────────────────────────
  healthCheck?(): Promise<HealthStatus>;
}
