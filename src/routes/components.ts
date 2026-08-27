import type { RouteContext } from "./types.js";
import { getComponentKernel } from "../components/kernel.js";

const NATIVE_AGENT_IDS = [
  "native-general",
  "native-code",
  "native-research",
];

export async function handleComponentsStatus(
  ctx: RouteContext,
): Promise<Response | null> {
  if (ctx.url.pathname !== "/components" || ctx.req.method !== "GET") {
    return null;
  }
  const kernel = getComponentKernel();
  const components = await kernel.healthAll();
  return ctx.jsonResponse(
    {
      components,
      total: components.length,
      ready: components.filter((component) => component.ready).length,
    },
    200,
    ctx.baseHeaders,
  );
}

export async function handleNativeAgentStatus(
  ctx: RouteContext,
): Promise<Response | null> {
  if (ctx.url.pathname !== "/agents/native/status" || ctx.req.method !== "GET") {
    return null;
  }
  const kernel = getComponentKernel();
  const agents = await Promise.all(
    NATIVE_AGENT_IDS.map(async (id) => {
      if (!kernel.get(id)) {
        return {
          id,
          ready: false,
          optional: true,
          reason: "native component not registered",
        };
      }
      return kernel.health(id);
    }),
  );
  return ctx.jsonResponse({ native: true, agents }, 200, ctx.baseHeaders);
}
