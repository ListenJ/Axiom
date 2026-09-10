/**
 * 端口协议模块入口
 *
 * 推理引擎与知识库的标准化通信层：
 * - types.ts: 类型定义（PortRequest/PortResponse/PortError/RetryConfig）
 * - knowledge-port.ts: 接口实现（KnowledgePort/LocalKnowledgePort/RemoteKnowledgePort）
 */

export type {
  PortMethod,
  PortRequest,
  PortResponse,
  PortError,
  PortErrorCode,
  WriteParams,
  WriteResult,
  ReadParams,
  SearchParams,
  DeleteParams,
  GetRevisionsParams,
  HealthResult,
  RetryConfig,
} from "./types.js";

export {
  DEFAULT_RETRY_CONFIG,
  computeBackoff,
  generateRequestId,
  okResponse,
  errorResponse,
  toPortError,
} from "./types.js";

export {
  type KnowledgePort,
  BaseKnowledgePort,
  LocalKnowledgePort,
  RemoteKnowledgePort,
  PortException,
  createLocalPort,
  createRemotePort,
} from "./knowledge-port.js";
