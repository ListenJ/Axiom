/**
 * Execution & constitution service — re-exports from agents/ for the
 * services layer. This breaks the circular import cycle
 * router/task-orchestrator → agents/ by routing through the neutral
 * services/ layer instead.
 */
export { executionMode } from "../agents/execution-mode.js";
export {
  getConstitutionForMode,
  injectConstitution,
} from "../agents/constitution.js";
