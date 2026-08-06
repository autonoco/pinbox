// @autono/pinbox-toolbar — thread card
// Ports the prototype's renderCard/patchThread (docs/design/toolbar/
// v2-command-bar.html lines 588–668): the card shell is rebuilt only when the
// active pin changes; header/link/row parts are innerHTML-memoized; thread
// messages are keyed [data-iid] nodes with a per-node `_h` memo so entrance
// animations run exactly once. Viewport-aware placement is ported verbatim
// (lines 660–668). The verify footer renders exactly when deriveUiStatus is
// "verify". stepsHtml/diffHtml port the prototype's activity-steps and change
// sub-renderers as pure functions — they render nothing until the event
// vocabulary lands — presentational and data-starved by design.
import type { Attachment, Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import { deriveUiStatus, type ToolbarState, type UiStatus } from "../state.ts";
import { esc, pinNumber, safeUrl } from "./html.ts";

export interface CardActions {
  /** draft ⇒ createPin; else thread reply. */
  send(pinId: string | "draft", text: string): void;
  verify(pinId: string, outcome: "accepted" | "reopened"): void;
  resolve(pinId: string): void;
  close(): void;
}

const STATUS_LABEL: Record<UiStatus, string> = {
  open: "OPEN",
  waiting: "OPEN",
  replied: "REPLIED",
  resolved: "RESOLVED",
  verify: "VERIFY",
};

const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
const X_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

interface CardCtx {
  pid: string | null;
  parts: Record<string, string>;
  actions: CardActions;
}

const ctxByCard = new WeakMap<Element, CardCtx>();
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

function messageHtml(m: ThreadMessage): string {
  if (m.role === "agent") {
    return (
      `<div class="pb-msg"><div class="pb-av agent">AI</div><div class="col">` +
      `<div class="line"><span class="who">Agent</span><span class="tm">${esc(timeOf(m.at))}</span></div>` +
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

/** Keyed thread patching: appends/patches [data-iid] nodes only, never rebuilds. */
function patchThread(threadEl: HTMLElement, messages: ThreadMessage[]): void {
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

/* ── shell, parts, placement ── */

function ensureShell(root: ShadowRoot): HTMLElement {
  let card = root.querySelector<HTMLElement>(".pb-card");
  if (!card) {
    card = root.ownerDocument.createElement("div");
    card.className = "pb-card";
    card.hidden = true;
    root.appendChild(card);
  }
  if (!ctxByCard.has(card)) {
    const ctx: CardCtx = { pid: null, parts: {}, actions: null as unknown as CardActions };
    ctxByCard.set(card, ctx);
    card.addEventListener("click", (e) => onCardClick(card as HTMLElement, ctx, e));
  }
  return card;
}

function submit(card: HTMLElement, ctx: CardCtx): void {
  const ta = card.querySelector("textarea");
  const text = ta?.value.trim();
  if (!ta || !text || !ctx.pid) return;
  ctx.actions.send(ctx.pid === "draft" ? "draft" : ctx.pid, text);
  ta.value = "";
}

function onCardClick(card: HTMLElement, ctx: CardCtx, e: Event): void {
  const action = (e.target as Element).closest?.("[data-action]")?.getAttribute("data-action");
  if (!action || !ctx.pid) return;
  if (action === "send") submit(card, ctx);
  else if (action === "close") ctx.actions.close();
  else if (ctx.pid !== "draft") {
    if (action === "resolve") ctx.actions.resolve(ctx.pid);
    else if (action === "verify-accept") ctx.actions.verify(ctx.pid, "accepted");
    else if (action === "verify-reopen") {
      // reopen flips the pin open and focuses the composer (the sticky-session rule
      // makes the follow-up reply route to the same session; here it is a thread POST).
      ctx.actions.verify(ctx.pid, "reopened");
      card.querySelector("textarea")?.focus();
    }
  }
}

function buildSkeleton(
  card: HTMLElement,
  ctx: CardCtx,
  isDraft: boolean,
  hasThread: boolean,
): void {
  card.innerHTML =
    '<div class="in">' +
    '<div class="pb-hd" data-ref="hd"></div>' +
    '<div data-ref="link"></div>' +
    '<div class="pb-thread" data-ref="thread"></div>' +
    '<div data-ref="verify"></div>' +
    '<div class="pb-composer"><textarea rows="2"></textarea><div class="row" data-ref="row"></div></div>' +
    "</div>";
  const ta = card.querySelector("textarea") as HTMLTextAreaElement;
  ta.placeholder = hasThread ? "Ask a question or request a change…" : "What should change here?";
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(card, ctx);
    } else if (e.key === "Escape") ctx.actions.close(); // discards a draft upstream
  });
  const threadEl = card.querySelector<HTMLElement>('[data-ref="thread"]');
  // Broken image (missing file, CORS pre-Task-4) degrades to a filename chip.
  threadEl?.addEventListener(
    "error",
    (e) => {
      const img = e.target as HTMLElement;
      const wrap = img.tagName === "IMG" ? img.closest(".pb-att") : null;
      if (wrap) {
        wrap.outerHTML = `<span class="pb-att-chip">${esc(img.getAttribute("alt") ?? "attachment")}</span>`;
      }
    },
    true,
  );
  if (isDraft) ta.focus();
}

function hdHtml(n: number, targetLabel: string, status: string, resolvable: boolean): string {
  return (
    `<div class="meta"><span class="num">${pinNumber(n)}</span>` +
    `<span>${esc(targetLabel)}</span><span class="st">${esc(status)}</span></div>` +
    '<div style="display:flex;gap:2px">' +
    (resolvable
      ? `<button type="button" class="pb-ico ok" data-action="resolve" title="Resolve (R)">${CHECK_ICON}</button>`
      : "") +
    `<button type="button" class="pb-ico" data-action="close" title="Close (Esc)">${X_ICON}</button></div>`
  );
}

/** Link badge: pin.links[0] read-only — no picker, no unlink yet. */
function linkHtml(pin: Pin | null): string {
  const link = pin?.links?.[0];
  if (!link) return "";
  return (
    `<div class="pb-linkbar"><span class="ch">${esc(link.connector)}</span>` +
    `<span class="mt">${esc(link.ref)}</span><span class="sp"></span>` +
    `<a class="pb-open" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer">OPEN</a></div>`
  );
}

function verifyHtml(status: UiStatus | null): string {
  if (status !== "verify") return "";
  return (
    '<div class="pb-verify">' +
    '<button type="button" class="pb-bt-ok" data-action="verify-accept">Looks good</button>' +
    '<button type="button" class="pb-bt-ghost" data-action="verify-reopen">Reopen</button></div>'
  );
}

function rowHtml(hasThread: boolean): string {
  return (
    '<div class="pb-kbd">⌘ ↵</div>' +
    `<button type="button" class="pb-bt-solid" data-action="send">${hasThread ? "Reply" : "Comment"}</button>`
  );
}

/**
 * Viewport-aware placement, ported verbatim (prototype lines 660–668): measure
 * the rendered card, flip left when it would overflow right, clamp between
 * scrollY + margin and the command-bar clearance — never off-screen.
 */
function position(card: HTMLElement, at: { x: number; y: number }): void {
  const win = card.ownerDocument.defaultView;
  if (!win) return;
  const W = 344;
  const m = 12;
  const barClear = 84;
  let left = at.x + 22;
  if (left + W > win.scrollX + win.innerWidth - m) left = at.x - W - 22;
  left = Math.max(win.scrollX + m, left);
  const h = card.querySelector<HTMLElement>(".in")?.offsetHeight ?? 0;
  const minTop = win.scrollY + m;
  const maxTop = win.scrollY + win.innerHeight - h - barClear;
  card.style.left = `${left}px`;
  card.style.top = `${Math.max(minTop, Math.min(at.y - 60, maxTop))}px`;
}

function setPart(card: HTMLElement, ctx: CardCtx, ref: string, html: string): void {
  if (ctx.parts[ref] === html) return;
  const el = card.querySelector<HTMLElement>(`[data-ref="${ref}"]`);
  if (el) {
    el.innerHTML = html;
    ctx.parts[ref] = html;
  }
}

/** Everything the card renders, resolved from a state snapshot. */
interface CardView {
  pid: string;
  pin: Pin | null;
  thread: ThreadMessage[];
  n: number;
  status: UiStatus | null;
  label: string;
  at: { x: number; y: number };
}

function activePin(state: ToolbarState): Pin | null {
  if (!state.activePinId) return null;
  return state.pins.find((p) => p.id === state.activePinId) ?? null;
}

/** Ordinal among visible pins (resolved pins hide unless active); drafts number last. */
function ordinalOf(state: ToolbarState, pin: Pin | null): number {
  const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
  return pin ? visible.indexOf(pin) + 1 : visible.length + 1;
}

function anchorOf(pin: Pin | null, draft: ToolbarState["draft"]): { x: number; y: number } {
  // No pin, or a terminal `pinbox pin` with no captured rect: the card is not
  // tethered to anything on the page, so it falls back to the draft placement.
  const r = pin?.target?.rect;
  if (!r) return draft?.placedAt ?? { x: 0, y: 0 };
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * The card's heading. A terminal `pinbox pin` has no anchor and no tag, so "PIN"
 * labels the card without claiming an element that was never captured.
 */
function labelOf(target: Pin["target"]): string {
  return target?.anchor ?? target?.tag?.toUpperCase() ?? "PIN";
}

function viewOf(state: ToolbarState): CardView | null {
  const pin = activePin(state);
  const pid = pin?.id ?? (state.draft ? "draft" : null);
  if (!pid) return null;
  const thread = pin ? (state.threads.get(pin.id) ?? []) : [];
  return {
    pid,
    pin,
    thread,
    n: ordinalOf(state, pin),
    status: pin ? deriveUiStatus(pin, thread) : null,
    label: labelOf(pin?.target ?? state.draft?.target.target),
    at: anchorOf(pin, state.draft),
  };
}

/** Render the thread card for a state snapshot: the active pin, or the draft. */
export function renderCard(root: ShadowRoot, state: ToolbarState, actions: CardActions): void {
  const card = ensureShell(root);
  const ctx = ctxByCard.get(card) as CardCtx;
  ctx.actions = actions;
  const view = viewOf(state);
  if (!view) {
    card.hidden = true;
    ctx.pid = null;
    return;
  }
  if (ctx.pid !== view.pid) {
    ctx.pid = view.pid;
    ctx.parts = {};
    buildSkeleton(card, ctx, view.pid === "draft", view.thread.length > 0);
  }
  card.hidden = false;
  // Outbox-queued pin: pending sync — labeled QUEUED, unresolvable until the hub knows it.
  const queued = view.pin !== null && state.queuedIds.has(view.pin.id);
  const statusLabel = queued ? "QUEUED" : view.status ? STATUS_LABEL[view.status] : "NEW";
  const resolvable = view.pin?.status === "open" && !queued;
  setPart(card, ctx, "hd", hdHtml(view.n, view.label, statusLabel, resolvable));
  setPart(card, ctx, "link", linkHtml(view.pin));
  setPart(card, ctx, "verify", verifyHtml(view.status));
  setPart(card, ctx, "row", rowHtml(view.thread.length > 0));
  const threadEl = card.querySelector<HTMLElement>('[data-ref="thread"]');
  if (threadEl) patchThread(threadEl, view.thread);
  position(card, view.at);
}
