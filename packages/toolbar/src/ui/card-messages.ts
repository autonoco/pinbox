// @autono/pinbox-toolbar — thread card: message rendering
// The card's thread body, split out of card.ts (file-size rule): message rows,
// attachment thumbnails, the agent-identity label, keyed [data-iid] patching
// with the prototype's per-node `_h` memo so entrance animations run exactly
// once, and the THINKING row. stepsHtml/diffHtml port the prototype's
// activity-steps and change sub-renderers as pure functions — they render
// nothing until the event vocabulary lands — presentational and data-starved
// by design.
import type { Attachment, ThreadMessage } from "@autono/pinbox-core/schema";
import { esc, safeUrl } from "./html.ts";

const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
/** The prototype's `_h` innerHTML memo, kept off the DOM node. */
const nodeMemo = new WeakMap<Element, string>();

/* ── ported pure sub-renderers (an event vocabulary feeds these; nothing calls them yet) ── */

export interface ActivityStep {
  label: string;
  done: boolean;
}

/** Prototype's agent activity steps (lines 604–611), as a pure HTML function. */
export function stepsHtml(steps: ActivityStep[]): string {
  return steps
    .map(
      (s) =>
        `<div class="pb-step" style="color:${s.done ? "var(--pb-ok)" : "var(--pb-fg3)"}">` +
        `<span class="g">${s.done ? "✓" : "◇"}</span><span class="l">${esc(s.label)}</span></div>`,
    )
    .join("");
}

export interface DiffCard {
  file: string;
  minus: string;
  plus: string;
  hash?: string;
  applied?: boolean;
}

/** Prototype's change card (changeInner, lines 583–592) minus its interactive footer. */
export function diffHtml(d: DiffCard): string {
  const applied = d.applied
    ? `<div class="ft"><span class="applied">${CHECK_ICON}<span>APPLIED</span>` +
      `${d.hash ? `<span class="hh">${esc(d.hash)}</span>` : ""}</span></div>`
    : "";
  return (
    `<div class="pb-change"><div class="fh"><span>${esc(d.file)}</span></div>` +
    `<div class="code"><div class="mi">${esc(d.minus)}</div><div class="pl">${esc(d.plus)}</div></div>${applied}</div>`
  );
}

/* ── message rendering ── */

function timeOf(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function isImage(att: Attachment): boolean {
  if (att.contentType?.startsWith("image/")) return true;
  return /\.(png|webp|jpe?g|gif)$/i.test(att.url ?? att.path ?? "");
}

function fileName(att: Attachment): string {
  const source = att.url ?? att.path ?? att.id;
  return source.split("/").pop() ?? source;
}

/** Thumbnail when the attachment is an image; the error listener degrades it to a chip. */
function attachmentsHtml(m: ThreadMessage): string {
  if (!m.attachments?.length) return "";
  const items = m.attachments.map((att) =>
    isImage(att)
      ? `<span class="pb-att"><img src="${esc(safeUrl(att.url ?? att.path ?? ""))}" alt="${esc(fileName(att))}" loading="lazy"></span>`
      : `<span class="pb-att-chip">${esc(fileName(att))}</span>`,
  );
  return `<div class="atts">${items.join("")}</div>`;
}

/** "claude:lark-mac-agent" → "Claude · lark-mac-agent"; other shapes verbatim. */
function agentName(origin: string): string {
  const idx = origin.indexOf(":");
  if (idx <= 0) return origin;
  const agent = origin.slice(0, idx);
  return `${agent.charAt(0).toUpperCase()}${agent.slice(1)} · ${origin.slice(idx + 1)}`;
}

function messageHtml(m: ThreadMessage): string {
  if (m.role === "agent") {
    // Dogfood: "Which agent is replying to me?" — a REST watcher can identify
    // itself via the message's origin ("claude:lark-mac-agent"); anonymous
    // agent posts keep the generic label.
    const who = m.origin === undefined ? "Agent" : agentName(m.origin);
    return (
      `<div class="pb-msg"><div class="pb-av agent">AI</div><div class="col">` +
      `<div class="line"><span class="who">${esc(who)}</span><span class="tm">${esc(timeOf(m.at))}</span></div>` +
      `<div class="txt">${esc(m.text)}</div>${attachmentsHtml(m)}</div></div>`
    );
  }
  // human and mirror share the "you" row; mirror rows carry their origin via-badge.
  const mirror = m.role === "mirror";
  const origin = mirror ? (m.origin ?? "mirror") : null;
  const who = origin ? (origin.split(":")[1] ?? origin) : "You";
  const initials = who.slice(0, 2).toUpperCase();
  const via = origin ? `<span class="via-tag"><span>${esc(origin)}</span></span>` : "";
  return (
    `<div class="pb-msg you"><div class="pb-av${mirror ? " via" : ""}">${esc(initials)}</div><div class="col">` +
    `<div class="line"><span class="who">${esc(who)}</span><span class="tm">${esc(timeOf(m.at))}</span>${via}</div>` +
    `<div class="txt">${esc(m.text)}</div>${attachmentsHtml(m)}</div></div>`
  );
}

/** The agent has the message and has not answered yet. Its own node, so patching never rebuilds. */
const PENDING_HTML: Record<"thinking" | "waiting", string> = {
  thinking:
    '<div class="pb-typing"><div class="pb-av agent">AI</div>' +
    '<div class="dots"><i></i><i></i><i></i></div><div class="lbl">THINKING</div></div>',
  // Past the first 90 s the dots would be a lie; a still row says the truth: it is queued.
  waiting:
    '<div class="pb-typing quiet"><div class="pb-av agent">AI</div>' +
    '<div class="lbl">WAITING FOR AGENT</div></div>',
};

/**
 * Show, restyle or hide the "working on it" row.
 *
 * Without it the card sits silent from the moment you comment until the answer lands, which reads
 * as nothing happening — the single most common report on the demo. With it forever, a pin nobody
 * answers "thinks" for two weeks (dogfood) — so the row has stages, and "stale"/"none" remove it
 * (the stale footer takes over, card-parts.ts).
 */
export function patchPending(
  threadEl: HTMLElement,
  kind: "thinking" | "waiting" | "stale" | "none",
): void {
  const existing = threadEl.querySelector<HTMLElement>('[data-iid="pb-typing"]');
  if (kind === "none" || kind === "stale") {
    existing?.remove();
    return;
  }
  const html = PENDING_HTML[kind];
  if (existing) {
    if (nodeMemo.get(existing) !== html) {
      existing.innerHTML = html;
      nodeMemo.set(existing, html);
    }
    threadEl.appendChild(existing); // stay last as messages arrive
    return;
  }
  const node = threadEl.ownerDocument.createElement("div");
  node.className = "pb-msg-w";
  node.setAttribute("data-iid", "pb-typing");
  node.innerHTML = html;
  nodeMemo.set(node, html);
  threadEl.appendChild(node);
  threadEl.scrollTop = threadEl.scrollHeight;
}

/** Keyed thread patching: appends/patches [data-iid] nodes only, never rebuilds. */
export function patchThread(threadEl: HTMLElement, messages: ThreadMessage[]): void {
  let appended = false;
  for (const m of messages) {
    let node = threadEl.querySelector<HTMLElement>(`[data-iid="${m.id}"]`);
    const html = messageHtml(m);
    if (!node) {
      node = threadEl.ownerDocument.createElement("div");
      node.className = "pb-msg-w";
      node.setAttribute("data-iid", m.id);
      node.innerHTML = html;
      nodeMemo.set(node, html);
      threadEl.appendChild(node);
      appended = true;
    } else if (nodeMemo.get(node) !== html) {
      node.innerHTML = html;
      nodeMemo.set(node, html);
    }
  }
  if (appended) threadEl.scrollTop = threadEl.scrollHeight;
}
