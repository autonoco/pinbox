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
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import { deriveUiStatus, type ToolbarState, type UiStatus } from "../state.ts";
import { patchThread, patchTyping } from "./card-messages.ts";
import { hdHtml, linkHtml, lociHtml, rowHtml, STATUS_LABEL, verifyHtml } from "./card-parts.ts";
import { esc } from "./html.ts";
import { nextOrdinal } from "./pins.ts";

export interface CardActions {
  /** draft ⇒ createPin; else thread reply. */
  send(pinId: string | "draft", text: string): void;
  verify(pinId: string, outcome: "accepted" | "reopened"): void;
  resolve(pinId: string): void;
  /** Copy THIS pin's markdown block (the bar's C copies every open pin). */
  copy(pinId: string): void;
  close(): void;
}
interface CardCtx {
  pid: string | null;
  parts: Record<string, string>;
  actions: CardActions;
}

const ctxByCard = new WeakMap<Element, CardCtx>();

/* ── shell, click delegation, placement ── */

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
    else if (action === "copy") {
      ctx.actions.copy(ctx.pid);
      // A moment of green on the button is the whole receipt — there is no
      // toast layer, and the header part-memo never resets a class toggle.
      const btn = (e.target as Element).closest?.('[data-action="copy"]');
      if (btn) {
        btn.classList.add("ok");
        card.ownerDocument.defaultView?.setTimeout(() => btn.classList.remove("ok"), 900);
      }
    } else if (action === "verify-accept") ctx.actions.verify(ctx.pid, "accepted");
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
    '<div data-ref="loci"></div>' +
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

/** The pin's hub-born number; visible-index only for pre-`n` pins, drafts next up. */
function ordinalOf(state: ToolbarState, pin: Pin | null): number {
  if (pin === null) return nextOrdinal(state.pins);
  if (pin.n !== undefined) return pin.n;
  const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
  return visible.indexOf(pin) + 1;
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
/**
 * The pin's own text, as the first message in its thread.
 *
 * A pin stores what you wrote on the pin itself, not in the thread — so a card that renders only
 * `thread` shows an empty box the moment you hit Comment, and your words look lost. They are not
 * lost; they were never drawn.
 */
function pinAsMessage(pin: Pin): ThreadMessage {
  return {
    id: `pin:${pin.id}`,
    pinId: pin.id,
    role: "human",
    text: pin.text,
    at: pin.createdAt,
  };
}

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
    // A committed pin always has at least its own message, so the thread area always exists.
    buildSkeleton(card, ctx, view.pid === "draft", view.pin !== null || view.thread.length > 0);
  }
  card.hidden = false;
  // Outbox-queued pin: pending sync — labeled QUEUED, unresolvable until the hub knows it.
  const queued = view.pin !== null && state.queuedIds.has(view.pin.id);
  const statusLabel = queued ? "QUEUED" : view.status ? STATUS_LABEL[view.status] : "NEW";
  const resolvable = view.pin?.status === "open" && !queued;
  // A draft has nothing committed to copy; every real pin does.
  setPart(card, ctx, "hd", hdHtml(view.n, view.label, statusLabel, resolvable, view.pin !== null));
  setPart(card, ctx, "link", linkHtml(view.pin));
  setPart(card, ctx, "loci", lociHtml(view.pin));
  setPart(card, ctx, "verify", verifyHtml(view.status));
  const messages = view.pin === null ? view.thread : [pinAsMessage(view.pin), ...view.thread];
  setPart(card, ctx, "row", rowHtml(messages.length > 0));
  const threadEl = card.querySelector<HTMLElement>('[data-ref="thread"]');
  if (threadEl) {
    patchThread(threadEl, messages);
    // Pending exactly when the last word is yours and the pin is still open — the same condition
    // that makes the status "waiting", so the chip and the row can never disagree.
    patchTyping(threadEl, !queued && view.pin?.status === "open" && view.status === "waiting");
  }
  position(card, view.at);
}
