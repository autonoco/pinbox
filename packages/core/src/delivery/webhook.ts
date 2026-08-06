// @autono/pinbox-core/delivery/webhook — outbound HMAC-signed webhook adapter, the
// catch-all last in preference order (agents nothing else reaches, incl. embedded-SDK
// hosts that resume their own sessions on delivery).
//
// Workers-COMPATIBLE: fetch + WebCrypto HMAC via crypto.subtle — NEVER Bun.CryptoHasher.
// The Worker adapter set is [webhook], so this is the
// one adapter that MUST run on workerd; crypto.subtle works identically on Bun.
//
// Receiver verification: recompute sha256 HMAC(secret, `${x-pinbox-timestamp}.${body}`)
// and compare against x-pinbox-signature ("sha256=<hex>"). Retries ride the deliveries
// queue (due_at backoff, terminal E_DELIVERY after 5 attempts); the deliveries table IS
// the delivery log (attempts, last_error, updated_at).
import type { Session } from "../sessions.ts";
import type { StoredEvent } from "../store.ts";
import type { DeliveryAdapter } from "./router.ts";

export type WebhookConfig = { url: string; secret: string };

export function createWebhookAdapter(config: WebhookConfig): DeliveryAdapter {
  return {
    name: "webhook",
    matches(): boolean {
      return true; // the catch-all — reachability is the receiver's problem, retried on failure
    },
    async deliver(event: StoredEvent, session: Session): Promise<void> {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        event,
        session: { id: session.id, agent: session.agent, key: session.key },
      });
      const signature = await hmacHex(config.secret, `${timestamp}.${body}`);
      let response: Response;
      try {
        response = await fetch(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-pinbox-timestamp": timestamp,
            "x-pinbox-event": event.type,
            "x-pinbox-signature": `sha256=${signature}`,
          },
          body,
        });
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`webhook POST ${config.url} failed: ${detail}`);
      }
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined); // release the connection
        throw new Error(`webhook POST ${config.url} returned ${response.status}`);
      }
    },
  };
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
