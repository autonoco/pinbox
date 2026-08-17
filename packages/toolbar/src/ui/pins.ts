// @autono/pinbox-toolbar — needle pins
// Keyed pin layer: dot + hairline needle + numbered chip. Ports renderPins from
// docs/design/toolbar/v2-command-bar.html (lines 545–572): nodes are keyed by
// data-pin and patched in place — the layer is never rebuilt — and each chip's
// innerHTML is memoized (the prototype's `_h`) so unchanged chips are untouched.
import type { Pin, Rect } from "@autono/pinbox-core/schema";
import type { ToolbarState } from "../state.ts";
import { esc, pinNumber } from "./html.ts";

/** The prototype's `_h` innerHTML memo, kept off the DOM node. */
const chipMemo = new WeakMap<Element, string>();

/**
 * Does the pin's captured URL still describe the view on screen? Path + search
 * only — hashes are anchors, not views. An absent or unparseable URL never
 * gates: old pins (and CLI pins) keep rendering exactly as before.
 */
function sameView(win: Window, url: string | undefined): boolean {
  if (url === undefined) return true;
  try {
    const target = new URL(url, win.location.href);
    return target.pathname === win.location.pathname && target.search === win.location.search;
  } catch {
    return true;
  }
}

/**
 * Where the pin's anchor is NOW (dogfood #26: markers lingered over unrelated
 * views after SPA tab switches, because placement trusted the stored rect
 * forever). Re-resolve the captured selector on every render:
 *  - it resolves with layout → snap to the LIVE rect (also fixes drift);
 *  - it resolves without layout (test DOMs, display:none) → stored rect;
 *  - it does not resolve → no marker; the drawer stays the see-everything list.
 * A pin with no selector (terminal-adjacent) keeps its stored rect, as before.
 */
function anchorRect(layer: HTMLElement, pin: Pin): Rect | null {
  const stored = pin.target?.rect;
  if (stored === undefined) return null;
  const doc = layer.ownerDocument;
  const win = doc.defaultView;
  if (win === null) return stored;
  if (!sameView(win, pin.target?.url)) return null;
  const selector = pin.target?.selector;
  if (selector === undefined) return stored;
  let el: Element | null;
  try {
    el = doc.querySelector(selector);
  } catch {
    return stored; // a selector we cannot evaluate must not hide the pin forever
  }
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return stored;
  return { x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height };
}

/**
 * Where the needle lands: the point inside the element that was actually clicked, when the pin
 * recorded one, else the centre of its box.
 *
 * `spot` is a fraction of the element, so the pin still tracks the element when it moves or
 * resizes — it just stops sliding to the middle of a wide block the moment you commit it.
 */
function pinPoint(r: Rect, spot?: { x: number; y: number }): { x: number; y: number } {
  const fx = spot?.x ?? 0.5;
  const fy = spot?.y ?? 0.5;
  return { x: r.x + r.width * fx, y: r.y + r.height * fy };
}

/** Chip contents (prototype chipBtnInner, lines 546–550): number + linked-channel tag,
 * plus the queued badge while the pin waits in the outbox for the reconnect flush. */
function chipInner(n: number, pin: Pin | null, queued = false): string {
  const link = pin?.links?.[0];
  const badge = link ? `<span class="lk"><span>${esc(link.connector)}</span></span>` : "";
  const qd = queued ? '<span class="qd">QUEUED</span>' : "";
  return `<span>${pinNumber(n)}</span>${badge}${qd}`;
}

function ensureNode(layer: HTMLElement, key: string, fresh: boolean): HTMLElement {
  let node = layer.querySelector<HTMLElement>(`[data-pin="${key}"]`);
  if (!node) {
    node = layer.ownerDocument.createElement("div");
    node.className = "pb-pin";
    node.setAttribute("data-pin", key);
    // Static skeleton, built once per pin — entrance animations run exactly once.
    node.innerHTML =
      `${fresh ? '<div class="ring"></div>' : ""}<div class="dot"></div>` +
      `<div class="needle"></div><button type="button" class="pb-chipBtn" data-open="${esc(key)}"></button>`;
    layer.appendChild(node);
  }
  return node;
}

function patchNode(
  node: HTMLElement,
  at: { x: number; y: number },
  hot: boolean,
  inner: string,
): void {
  node.style.left = `${at.x}px`;
  node.style.top = `${at.y}px`;
  node.style.zIndex = hot ? "40" : "20";
  node.classList.toggle("hot", hot);
  const chip = node.querySelector(".pb-chipBtn");
  if (chip && chipMemo.get(chip) !== inner) {
    chip.innerHTML = inner;
    chipMemo.set(chip, inner);
  }
}

/**
 * Render the pin layer for a state snapshot. Visible pins are open pins, the
 * active pin regardless of status, and the client-only draft (key "draft").
 */
export function renderPins(layer: HTMLElement, state: ToolbarState): void {
  // Hidden: the layer vanishes whole; nodes stay put so unhiding is instant.
  layer.hidden = state.pinsHidden;
  if (state.pinsHidden) return;
  const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
  // A pin with no captured rect — a terminal `pinbox pin` — has no place on the
  // page, and a pin whose anchor is not on the CURRENT view (other URL, selector
  // gone) has no honest place either: the overlay draws no needle for it. Both
  // keep their ordinal — the drawer lists them.
  const placed: { pin: Pin; n: number; rect: Rect; spot?: { x: number; y: number } }[] = [];
  visible.forEach((pin, i) => {
    const rect = anchorRect(layer, pin);
    if (rect === null) return;
    const spot = pin.target?.spot;
    placed.push(spot === undefined ? { pin, n: i + 1, rect } : { pin, n: i + 1, rect, spot });
  });
  const keys = new Set(placed.map((entry) => entry.pin.id));
  if (state.draft) keys.add("draft");
  for (const node of [...layer.children]) {
    if (!keys.has(node.getAttribute("data-pin") ?? "")) node.remove();
  }
  for (const { pin, n, rect, spot } of placed) {
    const node = ensureNode(layer, pin.id, false);
    const hot = pin.id === state.activePinId;
    const queued = state.queuedIds.has(pin.id);
    node.classList.toggle("queued", queued);
    patchNode(node, pinPoint(rect, spot), hot, chipInner(n, pin, queued));
  }
  if (state.draft) {
    const node = ensureNode(layer, "draft", true);
    patchNode(node, state.draft.placedAt, true, chipInner(visible.length + 1, null));
  }
}
