// @autono/pinbox-core — connector-link route module: POST /pins/:id/links · GET /pins/:id/links.
// Mounts in hub.ts's ROUTES array. Connectors are host-injected via HubOptions.connectors
// The transport is host-injected: gh CLI shell-out locally, App-token fetch on the Worker; absent or
// unknown-name ⇒ 502 E_CONNECTOR — the hub itself never learns transport details.
import { z } from "zod";
import { POLL_OPEN_MS } from "./connectors/poll.ts";
import type { RouteModule } from "./hub.ts";
import { err, match, mustGetPin, ok, readJson } from "./hub.ts";
import type { Link } from "./schema.ts";

const LinkPostSchema = z.object({ connector: z.string() });

export const routeLinks: RouteModule = async (req, url, opts) => {
  const pinId = match(url.pathname, /^\/pins\/([a-z0-9_]+)\/links$/);
  if (pinId === null) return null;
  const { store } = opts;

  if (req.method === "GET") {
    mustGetPin(store, pinId);
    return ok(200, store.links.forPin(pinId));
  }
  if (req.method !== "POST") return null;

  const pin = mustGetPin(store, pinId);
  const body = LinkPostSchema.parse(await readJson(req));
  const connector = opts.connectors?.find((c) => c.name === body.connector);
  if (connector === undefined) {
    return err(502, "E_CONNECTOR", `no connector available: ${body.connector}`, {
      hint: "run `pinbox doctor` to see which connectors this hub can reach",
    });
  }

  let link: Link;
  try {
    link = await connector.createItem(pin, store.getThread(pinId));
  } catch (cause) {
    // Transport/remote failure ⇒ 502; message from the cause, hint preserved when it carries one.
    const message = cause instanceof Error ? cause.message : "connector request failed";
    const hint =
      cause instanceof Error && "hint" in cause && typeof cause.hint === "string"
        ? cause.hint
        : undefined;
    return err(502, "E_CONNECTOR", message, hint === undefined ? undefined : { hint });
  }

  const updated = store.addLink(pinId, link);
  // Arm the inbound-poll deadline at the open cadence — mirroring reconciles on due_at.
  store.setDueAt(pinId, new Date(Date.now() + POLL_OPEN_MS).toISOString());
  return ok(201, updated);
};
