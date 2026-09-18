/**
 * Models module — barrel re-export.
 *
 * Imports can come from any of:
 *   - `./models/index.js` (this file) — pulls everything, preserved for
 *     convenience but not recommended for tree-shaking.
 *   - `./models/types.js` — pure type interfaces (zero runtime cost).
 *   - `./models/providers.js` — PROVIDER_CONFIG + configured-provider helpers.
 *   - `./models/registry.js` — UNIFIED_REGISTRY + lookup functions.
 *
 * The legacy `./models.js` import path is preserved by re-exporting this
 * module from `../models.js`.
 */

export type { ModelProvider, TaskRole, UnifiedModel, ProviderConfig } from "./types.js";

export {
  PROVIDER_CONFIG,
  isProviderConfigured,
  listConfiguredProviders,
} from "./providers.js";

export {
  UNIFIED_REGISTRY,
  getModel,
  getFallbackChain,
  listFreeModels,
  listAllModels,
  listAllRoles,
} from "./registry.js";