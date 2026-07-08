/**
 * Consciousness service — re-exports from agents/consciousness/ for the
 * services layer. This breaks the circular import cycle
 * memory/file-watcher → agents/consciousness by routing through the
 * neutral services/ layer.
 */
export { getConsciousness } from "../agents/consciousness/index.js";
