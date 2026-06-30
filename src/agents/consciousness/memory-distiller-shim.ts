/**
 * MemoryDistiller shim — lazy accessor.
 *
 * Uses createLazySingleton to break circular imports and allow test mocking.
 *
 * DO NOT add business logic here. Just import + memoize.
 */
import { createRequire } from "module";
import type { MemoryDistiller } from "../../memory/distiller.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const _require = createRequire(import.meta.url);

const singleton = createLazySingleton<MemoryDistiller>(
  () => new (_require("../../memory/distiller.js").MemoryDistiller)()
);

export const getGlobalMemoryDistiller = singleton.get.bind(singleton);
export const setMemoryDistillerForTest = singleton.setForTest.bind(singleton);

/**
 * Type re-export for the small subset of methods we actually call.
 * MemoryCurator only ever invokes distillConversation / distillWebClip / distillManual.
 */
export type MemoryDistillerSubset = Pick<MemoryDistiller, "distillConversation" | "distillWebClip" | "distillManual">;
