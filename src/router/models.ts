/**
 * src/router/models.ts — backward-compatible shim.
 *
 * The 1128-line monolith was split into src/router/models/{types,providers,registry,index}.ts
 * for maintainability (Phase B.3). All existing imports of `from "./models.js"`
 * keep working via this re-export.
 *
 * New code SHOULD prefer importing from `./models/{types,providers,registry}.js`
 * directly to avoid pulling the full registry data when only types are needed.
 */
export * from "./models/index.js";