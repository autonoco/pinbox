// @autono/pinbox-toolbar — command bar
// PIN / INBOX·count / theme / shortcuts with the armed state (v2 design). Ports
// the prototype's bar markup and render wiring (docs/design/toolbar/
// v2-command-bar.html lines 289–312, 686–699): armed state flips the label to
// CLICK TO PIN, lights the amber ring (via :host([data-placing]) in styles.ts)
// and marks the PIN button hot. Keyed DOM from day one — patch, never rebuild.
import type { ToolbarState } from "../state.ts";

const PIN_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="1.5" width="10" height="6.5" rx="1"/><path d="M8 8v6.5"/></svg>';
const INBOX_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 8.5h3.4l1 2h3.6l1-2h3.4"/><path d="M2.6 3.2h10.8l1.2 5.3v4a1 1 0 01-1 1H2.4a1 1 0 01-1-1v-4z"/></svg>';
const THEME_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.6a6.4 6.4 0 100 12.8A5 5 0 018 1.6z"/></svg>';
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1"/></svg>';
const IDENT_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--pb-amber)" stroke-width="1.4"><rect x="2.5" y="1.5" width="11" height="7" rx="1"/><path d="M8 8.5v6"/><circle cx="8" cy="14.6" r=".9" fill="var(--pb-amber)" stroke="none"/></svg>';
const MIN_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6.5 2.5v4h-4"/><path d="M9.5 13.5v-4h4"/></svg>';

export interface BarHandlers {
  onPin(): void;
  onInbox(): void;
  onTheme(): void;
  onHelp(): void;
  /** "Copy open pins" — the markdown offline-fallback affordance. */
  onCopy(): void;
  /** Collapse to the floating puck; keyboard=true for synthesized (AT) clicks. */
  onMinimize(keyboard: boolean): void;
}

export interface Bar {
  readonly root: HTMLElement;
  update(state: ToolbarState): void;
}

const CONNECTION_LABEL: Record<ToolbarState["connection"], string> = {
  connecting: "PINBOX",
  live: "PINBOX",
  offline: "PINBOX · OFFLINE",
  incompatible: "PINBOX · UPDATE NEEDED",
};

export function createBar(doc: Document, on: BarHandlers): Bar {
  const root = doc.createElement("div");
  root.className = "pb-bar";
  root.innerHTML =
    '<div class="armed-ring"></div>' +
    `<div class="ident">${IDENT_ICON}<span class="bl" data-ref="label">PINBOX</span></div>` +
    '<div class="div"></div>' +
    `<button type="button" class="pb-tb" data-ref="pin" title="Pin (P)">${PIN_ICON}PIN</button>` +
    `<button type="button" class="pb-tb" data-ref="inbox" title="Inbox (I)">${INBOX_ICON}<span data-ref="count">0</span></button>` +
    '<div class="div" style="margin:0 3px"></div>' +
    `<button type="button" class="pb-tb sq" data-ref="copy" title="Copy open pins (C)">${COPY_ICON}</button>` +
    `<button type="button" class="pb-tb sq" data-ref="theme" title="Theme (D)">${THEME_ICON}</button>` +
    '<button type="button" class="pb-tb sq" data-ref="help" title="Shortcuts (?)">?</button>' +
    `<button type="button" class="pb-tb sq" data-ref="min" title="Minimize (M)" aria-label="Minimize toolbar">${MIN_ICON}</button>`;

  const ref = (name: string): HTMLElement =>
    root.querySelector(`[data-ref="${name}"]`) as HTMLElement;
  const label = ref("label");
  const pinBtn = ref("pin");
  const inboxBtn = ref("inbox");
  const count = ref("count");
  pinBtn.addEventListener("click", on.onPin);
  inboxBtn.addEventListener("click", on.onInbox);
  ref("copy").addEventListener("click", on.onCopy);
  ref("theme").addEventListener("click", on.onTheme);
  ref("help").addEventListener("click", on.onHelp);
  // detail 0 = keyboard/AT-synthesized click — focus should follow the puck.
  ref("min").addEventListener("click", (e) => on.onMinimize(e.detail === 0));

  return {
    root,
    update(state) {
      const text = state.mode === "placing" ? "CLICK TO PIN" : CONNECTION_LABEL[state.connection];
      if (label.textContent !== text) label.textContent = text;
      pinBtn.classList.toggle("hot", state.mode === "placing");
      inboxBtn.classList.toggle("lit", state.inboxOpen);
      const open = String(state.pins.filter((p) => p.status !== "resolved").length);
      if (count.textContent !== open) count.textContent = open;
    },
  };
}
