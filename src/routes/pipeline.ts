/**
 * Pipeline SSE — Real-time agent pipeline execution progress
 */
import type { RouteContext } from "./types.js";
import { eventBus, type RuntimeEvent } from "../dre/runtime/event-bus.js";
import { worldState } from "../dre/runtime/world-state.js";

const COGNITIVE_EVENT_TYPES = [
  "cognitive.step.classify",
  "cognitive.step.knowledge",
  "cognitive.step.reasoning",
  "cognitive.step.constraint",
  "cognitive.step.action",
  "cognitive.step.reflection",
  "cognitive.pipeline.completed",
  "cognitive.pipeline.fallback",
];

export async function handlePipelineStream(ctx: RouteContext): Promise<Response | null> {
  if (ctx.url.pathname !== "/pipeline/stream" || ctx.req.method !== "GET") return null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const currentStep = worldState.get("cognitive.pipeline.lastStep") as string || "idle";
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "step", stage: currentStep, progress: 0 })}\n\n`));

      const subs: string[] = [];
      for (const eventType of COGNITIVE_EVENT_TYPES) {
        const id = eventBus.subscribe(eventType, (event: RuntimeEvent) => {
          if (event.type.startsWith("cognitive.step.")) {
            const stage = event.type.replace("cognitive.step.", "");
            const data = (event.data ?? {}) as Record<string, unknown>;
            const progress = (data.step as number) ?? 0;
            const message = (data.output as string) ?? "";
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "step", stage, progress, message })}\n\n`));
          }
          if (event.type === "cognitive.pipeline.completed" || event.type === "cognitive.pipeline.fallback") {
            const data = (event.data ?? {}) as Record<string, unknown>;
            const result = (data.conclusion as string) ?? (data.reason as string) ?? "";
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done", stage: "complete", result })}\n\n`));
            for (const sub of subs) eventBus.unsubscribe(sub);
            controller.close();
          }
        });
        subs.push(id);
      }

      setTimeout(() => {
        try {
          for (const sub of subs) eventBus.unsubscribe(sub);
          controller.close();
        } catch {}
      }, 300_000);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...ctx.baseHeaders,
    },
  });
}
