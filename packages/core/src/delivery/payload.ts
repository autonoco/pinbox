// Shared event→payload builder for the spawn adapters (resume, openclaw). No Bun APIs —
// but its only importers are the Bun-only adapters, never router.ts (Workers-safety,
// the router stays free of anything on the spawn path).
import type { Pin } from "../schema.ts";
import { PinSchema, ThreadMessageSchema } from "../schema.ts";
import type { StoredEvent } from "../store.ts";
import { buildInjectionContext, buildReplyPrompt } from "./context.ts";

export type GetPin = (id: string) => Pin | null;

/**
 * Injection context for pin.created; the fenced reply prompt for thread.message.
 * A thread.message payload carries only pinId, but buildReplyPrompt needs the Pin —
 * the serve boot passes (id) => store.getPin(id) as getPin; without it, reply
 * deliveries fail (retryable) rather than ship a pinless payload.
 */
export function payloadForEvent(event: StoredEvent, adapter: string, getPin?: GetPin): string {
  if (event.type === "pin.created") {
    return buildInjectionContext([PinSchema.parse(event.payload)]);
  }
  if (event.type === "thread.message") {
    const message = ThreadMessageSchema.parse(event.payload);
    const pin = getPin?.(message.pinId) ?? null;
    if (pin === null) {
      throw new Error(
        `pin ${message.pinId} not found for ${adapter} payload (adapter needs opts.getPin)`,
      );
    }
    return buildReplyPrompt(pin, message);
  }
  throw new Error(`${adapter} adapter cannot deliver ${event.type}`);
}
