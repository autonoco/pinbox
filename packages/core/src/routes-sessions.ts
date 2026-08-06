// @autono/pinbox-core/routes-sessions — agent session registry + hook-pull routes.
// Mounted at its pinned slot in hub.ts's ROUTES
// array; the /sessions/ regex namespace belongs to this module alone, so no route
// collision is possible.
import { buildInjectionContext } from "./delivery/context.ts";
import type { HubOptions } from "./hub.ts";
import { match, ok, readJson } from "./hub.ts";
import type { Pin } from "./schema.ts";
import { SessionRefSchema } from "./schema.ts";
import type { Session, SessionStore } from "./sessions.ts";
import type { DeliveryRow, PinStore } from "./store.ts";
import { NotFoundError } from "./store.ts";

export async function routeSessions(
  req: Request,
  url: URL,
  opts: HubOptions,
): Promise<Response | null> {
  const { store } = opts;
  const { sessions } = store;

  if (url.pathname === "/sessions") {
    if (req.method === "POST") {
      const ref = SessionRefSchema.parse(await readJson(req));
      const existing = sessions.findByRef(ref);
      // 201 when the (agent, key) pair is new, 200 when the upsert refreshed.
      return ok(existing === null ? 201 : 200, sessions.register(ref));
    }
    if (req.method === "GET") return ok(200, sessions.list()); // most recently seen first
    return null;
  }

  // A4 — POST /sessions/:id/inject: the UserPromptSubmit hook's pull.
  const injectId = match(url.pathname, /^\/sessions\/([a-z0-9_]+)\/inject$/);
  if (injectId !== null && req.method === "POST") return inject(store, injectId);

  // A4 — GET /sessions/:id/pending: the Stop hook's read-only gate.
  const pendingId = match(url.pathname, /^\/sessions\/([a-z0-9_]+)\/pending$/);
  if (pendingId !== null && req.method === "GET") return pending(store, pendingId);

  const sessionId = match(url.pathname, /^\/sessions\/([a-z0-9_]+)$/);
  if (sessionId !== null && req.method === "DELETE") {
    sessions.end(sessionId); // @throws NotFoundError → 404
    return ok(200, mustGetSession(sessions, sessionId));
  }

  return null;
}

/**
 * The hook pull: touch the session, flip its pending delivery rows to delivered, and
 * ALSO claim unassigned pending rows (assign → deliver — rule 1's "the next session to
 * register receives all unassigned pins", satisfied at first pull). The context always
 * carries ALL open pins: re-injection every turn is the delivery model that made
 * attachments path-only.
 */
function inject(store: PinStore, id: string): Response {
  const session = mustGetSession(store.sessions, id);
  const { deliveries } = store;
  store.sessions.touch(session.id);
  let delivered = 0;
  for (const row of deliveries.pendingForSession(session.id)) {
    deliveries.markDelivered(row.id);
    delivered += 1;
  }
  for (const row of deliveries.unassigned()) {
    deliveries.assign(row.id, session.id);
    deliveries.markDelivered(row.id);
    delivered += 1;
  }
  const pins = store.listPins({ status: "open" });
  return ok(200, { context: buildInjectionContext(pins), pins, delivered });
}

/**
 * Read-only Stop-hook gate: the OPEN pins referenced by this session's pending
 * delivery rows. Rows whose pin has since been resolved do not hold the agent —
 * `count` is the count of actionable pins, not of ledger rows.
 */
function pending(store: PinStore, id: string): Response {
  const session = mustGetSession(store.sessions, id);
  const pins = openPinsFor(store, store.deliveries.pendingForSession(session.id));
  return ok(200, { count: pins.length, pins });
}

function openPinsFor(store: PinStore, rows: DeliveryRow[]): Pin[] {
  const seen = new Set<string>();
  const pins: Pin[] = [];
  for (const row of rows) {
    const event = store.eventsAfter(row.eventSeq - 1)[0];
    if (event === undefined || event.seq !== row.eventSeq) continue;
    const pinId = pinIdOf(event.payload);
    if (pinId === null || seen.has(pinId)) continue;
    seen.add(pinId);
    const pin = store.getPin(pinId);
    if (pin?.status === "open") pins.push(pin);
  }
  return pins;
}

/** pin.created payloads are the Pin (`id`); thread.message payloads carry `pinId`. */
function pinIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const id = "pinId" in record ? record["pinId"] : record["id"];
  return typeof id === "string" && id.startsWith("pin_") ? id : null;
}

function mustGetSession(sessions: SessionStore, id: string): Session {
  const session = sessions.get(id);
  if (!session) throw new NotFoundError(`session not found: ${id}`);
  return session;
}
