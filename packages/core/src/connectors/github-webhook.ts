// @autono/pinbox-core/connectors — GitHub webhook receiver for the GitHub connector.
// The cloud hub's inbound half without waiting for the poll: GitHub POSTs `issues` and
// `issue_comment` events as they happen; this verifies the HMAC signature, finds the pin
// linked to that issue, and feeds the event through the same §7 mirror sinks the poll
// uses — so a comment mirrored here is recognised (and not mirrored again) when the poll
// next replays the issue's comment list. The poll stays on as the safety net for anything
// a webhook missed; this route only makes the common path immediate.
//
// The signature IS the authentication: this route sits outside the hub's bearer/JWT gate
// (GitHub cannot present our credential), and a request with a bad or missing
// `X-Hub-Signature-256` is 401 regardless of its body. No Bun.* here — runs on workerd.
import type { Link } from "../schema.ts";
import type { PinStore } from "../store.ts";
import { inboundEvents } from "./inbound.ts";
import type { ConnectorEvents } from "./types.ts";

export type GithubWebhookOptions = {
  /** The webhook secret configured on the App — HMAC-SHA256 key for the signature. */
  secret: string;
  /** "owner/name": events for any other repository are acknowledged and ignored. */
  repo: string;
};

/** Trailer marking bodies pinbox itself wrote (github.ts); never mirror those back in. */
const PINBOX_TRAILER = "— pinbox";

type Delivery = { applied: number; ignored: string | null };

/**
 * Handle one webhook delivery. Returns the hub's machine envelope: 200 with
 * `{ applied, ignored }`, 401 `E_AUTH` on a signature failure, 400 `E_INVALID_INPUT` on a
 * body GitHub would never send.
 */
export async function handleGithubWebhook(
  req: Request,
  store: PinStore,
  opts: GithubWebhookOptions,
): Promise<Response> {
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!(await signatureValid(opts.secret, raw, signature))) {
    return envelope(401, {
      code: "E_AUTH",
      message: "webhook signature missing or invalid",
      hint: "the App's webhook secret must equal GITHUB_WEBHOOK_SECRET on the hub",
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return envelope(400, { code: "E_INVALID_INPUT", message: "webhook body is not JSON" });
  }
  const event = req.headers.get("x-github-event") ?? "";
  const result = await apply(store, opts.repo, event, payload);
  return envelope(200, undefined, result);
}

async function apply(
  store: PinStore,
  repo: string,
  event: string,
  payload: unknown,
): Promise<Delivery> {
  if (event === "ping") return { applied: 0, ignored: "ping" };
  if (event !== "issues" && event !== "issue_comment") {
    return { applied: 0, ignored: `event ${event}` };
  }
  const body = payload as WebhookBody;
  const fullName = body.repository?.full_name;
  if (typeof fullName !== "string" || fullName.toLowerCase() !== repo.toLowerCase()) {
    return { applied: 0, ignored: `repository ${fullName ?? "?"}` };
  }
  const number = body.issue?.number;
  if (typeof number !== "number") return { applied: 0, ignored: "no issue" };
  const row = store.links
    .all()
    .find((r) => r.link.connector === "github" && r.link.ref === String(number));
  if (row === undefined) return { applied: 0, ignored: `issue #${number} is not linked` };
  const { events } = inboundEvents(store, row.pinId, "github", false);
  return event === "issue_comment"
    ? applyComment(body, row.link, events)
    : applyStatus(body, row.link, events);
}

async function applyComment(
  body: WebhookBody,
  link: Link,
  events: ConnectorEvents,
): Promise<Delivery> {
  if (body.action !== "created") return { applied: 0, ignored: `issue_comment ${body.action}` };
  const comment = body.comment;
  const text = comment?.body ?? "";
  // Our own mirrors come back to us too: the trailer marks them, and the App's bot login
  // is the belt to that brace.
  if (isOwnMirror(text) || comment?.user?.type === "Bot") {
    return { applied: 0, ignored: "own mirror" };
  }
  await events.onRemoteComment(link, {
    origin: `github:${comment?.user?.login ?? "ghost"}`,
    text,
    at: comment?.created_at ?? new Date().toISOString(),
  });
  return { applied: 1, ignored: null };
}

async function applyStatus(
  body: WebhookBody,
  link: Link,
  events: ConnectorEvents,
): Promise<Delivery> {
  if (body.action === "closed") {
    await events.onRemoteStatus(link, "closed");
    return { applied: 1, ignored: null };
  }
  if (body.action === "reopened") {
    await events.onRemoteStatus(link, "open");
    return { applied: 1, ignored: null };
  }
  return { applied: 0, ignored: `issues ${body.action}` };
}

type WebhookBody = {
  action?: string;
  repository?: { full_name?: string };
  issue?: { number?: number };
  comment?: {
    body?: string | null;
    created_at?: string;
    user?: { login?: string; type?: string } | null;
  };
};

function isOwnMirror(text: string): boolean {
  const lastLine = text.trimEnd().split("\n").at(-1) ?? "";
  return lastLine.startsWith(PINBOX_TRAILER);
}

/* ── signature ────────────────────────────────────────────────────────────────────── */

/** `sha256=<hex hmac>` over the raw body, compared in constant time. */
export async function signatureValid(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (header === null || !header.startsWith("sha256=")) return false;
  const expected = await hmacHex(secret, rawBody);
  return timingSafeEqual(header.slice("sha256=".length), expected);
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  let hex = "";
  for (const b of sig) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── envelope (the hub's machine contract, built here to keep connectors below hub.ts) ── */

function envelope(
  status: number,
  error: { code: string; message: string; hint?: string } | undefined,
  data?: unknown,
): Response {
  const body = error === undefined ? { ok: true, data } : { ok: false, error };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
