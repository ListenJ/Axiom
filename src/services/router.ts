/**
 * Router service — re-exports from router/ for the services layer.
 *
 * This breaks the circular import cycle agents→router by routing both
 * sides through the neutral services/ layer (see also services/execution.ts
 * and services/consciousness.ts which route the router→agents direction).
 */
export {
  router,
  type ChatMessage,
  type ChatStreamEvent,
  type SmartAssignmentResponse,
} from "../router/model-router.js";
export { toolPool } from "../router/tool-pool.js";
export { getTokenTracker } from "../router/token-tracker.js";
export { findModelsForRole } from "../router/model-capability-registry.js";
export { PROVIDER_CONFIG } from "../router/models.js";
export type { TaskRole } from "../router/model-capability-registry.js";
