/**
 * Self-evolve 模块类型定义（OpenRSI/RISE 思想的简约落地）。
 *
 * 设计原则（规则 8 深模块）：
 *   - 小接口：调用方只接触 selfThink / selfImprove / selfInduce / estimateConfidence；
 *   - 依赖注入：think / retrieve / store 全部可替换，模块自身不创建依赖；
 *   - 不写死：模型、密钥、检索器由调用方/默认工厂注入（router 动态分配）。
 */

/** 检索到的强背书资料 */
export interface EvidenceSource {
  title: string;
  url: string;
  snippet: string;
  /** 0-1 相关性 × 权威性，由检索器给出 */
  score: number;
  /** 来源类型：web / knowledge-base / self-evolve-memory 等 */
  provenance: string;
}

/** 针对性自我思考请求 */
export interface SelfThinkRequest {
  /** 用户输入 */
  input: string;
  /** 当前执行的项目上下文（可选） */
  project?: string;
}

/** 针对性自我思考结果 */
export interface SelfThought {
  /** 目标（一句话） */
  goal: string;
  /** 关键假设 */
  assumptions: string[];
  /** 执行计划 */
  plan: string[];
  /** 风险 */
  risks: string[];
  /** 置信度（estimateConfidence 的确定性精算值） */
  confidence: number;
  /** 用于支撑思考的强背书资料 */
  evidence: EvidenceSource[];
}

/** 一次执行反馈（沙箱/调用方提供） */
export interface ImproveFeedback {
  action: string;
  outcome: string;
  success: boolean;
  error?: string;
}

/** 自我改进请求 */
export interface ImproveRequest {
  task: string;
  feedback: ImproveFeedback;
}

/** 自我改进结果 */
export interface Improvement {
  revisedPlan: string[];
  /** 成功时提炼的教训；失败时为空字符串 */
  lesson: string;
  success: boolean;
}

/** 历史任务轨迹（用于 selfInduce 归纳） */
export interface TaskTrace {
  id: string;
  task: string;
  plan?: string[];
  success: boolean;
}

/** 归纳出的可复用模式 */
export interface Induction {
  pattern: string;
  /** 出现次数（支持度） */
  support: number;
  /** 成功率 0-1 */
  successRate: number;
  recommendation: string;
}

/** 最小消息形状（与 router ChatMessage 结构兼容） */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** 引擎依赖：全部可注入、可测试 */
export interface SelfEvolveDeps {
  /** LLM 调用：输入消息，输出文本 */
  think: (messages: Message[]) => Promise<string>;
  /** 外部强背书检索器（web / 向量 / 知识库）；可选，默认叠加自身教训检索 */
  retrieve?: (query: string) => Promise<EvidenceSource[]>;
  /** 知识库：写教训 + 读历史教训；可选 */
  store?: {
    write: (lesson: string) => Promise<void>;
    list: () => Promise<string[]>;
  };
}
