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

/** Needle anchor point for a committed pin: center of the captured target rect. */
function pinPoint(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
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
  const visible = state.pins.filter((p) => p.status !== "resolved" || p.id === state.activePinId);
  // A pin with no captured rect — a terminal `pinbox pin` — has no place on the page,
  // so the overlay draws no needle for it. It keeps its ordinal (the drawer lists it).
  const placed: { pin: Pin; n: number; rect: Rect }[] = [];
  visible.forEach((pin, i) => {
    const rect = pin.target?.rect;
    if (rect !== undefined) placed.push({ pin, n: i + 1, rect });
  });
  const keys = new Set(placed.map((entry) => entry.pin.id));
  if (state.draft) keys.add("draft");
  for (const node of [...layer.children]) {
    if (!keys.has(node.getAttribute("data-pin") ?? "")) node.remove();
  }
  for (const { pin, n, rect } of placed) {
    const node = ensureNode(layer, pin.id, false);
    const hot = pin.id === state.activePinId;
    const queued = state.queuedIds.has(pin.id);
    node.classList.toggle("queued", queued);
    patchNode(node, pinPoint(rect), hot, chipInner(n, pin, queued));
  }
  if (state.draft) {
    const node = ensureNode(layer, "draft", true);
    patchNode(node, state.draft.placedAt, true, chipInner(visible.length + 1, null));
  }
}
