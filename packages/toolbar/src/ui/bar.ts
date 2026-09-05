// @autono/pinbox-toolbar — command bar
// PIN / INBOX·count / squares, with the armed state (v2 design). Ports the
// prototype's bar markup and render wiring (docs/design/toolbar/
// v2-command-bar.html lines 289–312, 686–699): armed state flips the label to
// CLICK TO PIN, lights the amber ring (via :host([data-placing]) in styles.ts)
// and marks the PIN button hot. Buttons come from the shared action table
// (ui/actions.ts) so the bar and the fan can never drift apart again. Keyed DOM
// from day one — patch, never rebuild.
import { openTaskCount, type ToolbarState } from "../state.ts";
import {
  ACTIONS,
  type ActionDef,
  type ActionId,
  EYE_GLYPH,
  EYE_OFF_GLYPH,
  icon,
  titleOf,
} from "./actions.ts";

const IDENT_ICON =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--pb-amber)" stroke-width="1.4"><rect x="2.5" y="1.5" width="11" height="7" rx="1"/><path d="M8 8.5v6"/><circle cx="8" cy="14.6" r=".9" fill="var(--pb-amber)" stroke="none"/></svg>';

export interface BarHandlers {
  /** A bar button was pressed; keyboard=true for synthesized (AT) clicks. */
  onAction(id: ActionId, keyboard: boolean): void;
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

/** `data-ref` per action: the element focuses "min" after a keyboard restore. */
function refOf(a: ActionDef): string {
  return a.id === "minimize" ? "min" : a.id;
}

function buttonHtml(a: ActionDef): string {
  const bar = a.bar as NonNullable<ActionDef["bar"]>;
  const glyph = a.glyph === undefined ? "" : icon(a.glyph, 14);
  const body = bar.count ? `${glyph}<span data-ref="count">0</span>` : `${glyph}${bar.text ?? ""}`;
  const square = bar.text === undefined && !bar.count;
  const aria = bar.ariaLabel === undefined ? "" : ` aria-label="${bar.ariaLabel}"`;
  return (
    `<button type="button" class="pb-tb${square ? " sq" : ""}" data-ref="${refOf(a)}" ` +
    `title="${titleOf(a)}"${aria}>${a.glyph === undefined ? (a.key ?? "") : body}</button>`
  );
}

export function createBar(doc: Document, on: BarHandlers): Bar {
  const root = doc.createElement("div");
  root.className = "pb-bar";
  const wide = ACTIONS.filter(
    (a) => a.bar !== undefined && (a.bar.text !== undefined || a.bar.count),
  );
  const squares = ACTIONS.filter((a) => a.bar !== undefined && !wide.includes(a));
  root.innerHTML =
    '<div class="armed-ring"></div>' +
    `<div class="ident">${IDENT_ICON}<span class="bl" data-ref="label">PINBOX</span></div>` +
    '<div class="div"></div>' +
    wide.map(buttonHtml).join("") +
    '<div class="div" style="margin:0 3px"></div>' +
    squares.map(buttonHtml).join("");

  const ref = (name: string): HTMLElement =>
    root.querySelector(`[data-ref="${name}"]`) as HTMLElement;
  const label = ref("label");
  const pinBtn = ref("pin");
  const inboxBtn = ref("inbox");
  const hideBtn = ref("hide");
  const count = ref("count");
  for (const a of [...wide, ...squares]) {
    // detail 0 = keyboard/AT-synthesized click — focus should follow the surface that remains.
    ref(refOf(a)).addEventListener("click", (e) => on.onAction(a.id, e.detail === 0));
  }
  /** Last-rendered hide state; the glyph is swapped only on change. */
  let hideShown: boolean | null = null;

  return {
    root,
    update(state) {
      const text = state.mode === "placing" ? "CLICK TO PIN" : CONNECTION_LABEL[state.connection];
      if (label.textContent !== text) label.textContent = text;
      pinBtn.classList.toggle("hot", state.mode === "placing");
      inboxBtn.classList.toggle("lit", state.inboxOpen);
      const open = String(openTaskCount(state.pins));
      if (count.textContent !== open) count.textContent = open;
      if (hideShown !== state.pinsHidden) {
        hideShown = state.pinsHidden;
        hideBtn.innerHTML = icon(state.pinsHidden ? EYE_GLYPH : EYE_OFF_GLYPH, 14);
        hideBtn.classList.toggle("lit", state.pinsHidden);
        hideBtn.title = state.pinsHidden ? "Show pins (H)" : "Hide pins (H)";
      }
    },
  };
}
