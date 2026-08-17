// @autono/pinbox-toolbar — minimized state UI: the floating puck and the
// morph layer that liquid-animates between it and the command bar.
// The morph surface is styled *identically* to the bar (same translucent fill,
// blur, border, shadow — styles.ts), so both endpoint handoffs are
// pixel-invisible; the carrier holds the icon + badge that ride the surface
// while it is puck-shaped. Keyed DOM like ui/bar.ts — patch, never rebuild.
import type { ToolbarState } from "../state.ts";

/** The bar's ident mark, sized up for the 48px puck face. */
const PUCK_ICON =
  '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="1.5" width="11" height="7" rx="1"/><path d="M8 8.5v6"/><circle cx="8" cy="14.6" r=".9" fill="currentColor" stroke="none"/></svg>';

export interface MinimizeUi {
  /** The floating restore button. Starts ghosted; the controller reveals it. */
  readonly puck: HTMLButtonElement;
  /** Fixed full-viewport layer holding surface + carrier; hidden at rest. */
  readonly morphWrap: HTMLElement;
  /** The bar-styled surface the controller spring-animates. */
  readonly surface: HTMLElement;
  /** Icon + badge that ride the surface while it is puck-like. */
  readonly carrier: HTMLElement;
  update(state: ToolbarState): void;
}

export function createMinimizeUi(doc: Document): MinimizeUi {
  const puck = doc.createElement("button");
  puck.type = "button";
  puck.className = "pb-puck pb-ghost";
  puck.setAttribute("aria-label", "Restore Pinbox toolbar");
  puck.innerHTML = `<span class="in">${PUCK_ICON}</span><span class="badge" data-ref="count" hidden>0</span><span class="cdot"></span>`;

  const morphWrap = doc.createElement("div");
  morphWrap.className = "pb-morph-wrap";
  morphWrap.hidden = true;
  const surface = doc.createElement("div");
  surface.className = "pb-morph";
  const carrier = doc.createElement("div");
  carrier.className = "pb-carrier";
  carrier.innerHTML = `${PUCK_ICON}<span class="badge" data-ref="count" hidden>0</span>`;
  morphWrap.appendChild(surface);
  morphWrap.appendChild(carrier);

  const badges = [
    puck.querySelector('[data-ref="count"]') as HTMLElement,
    carrier.querySelector('[data-ref="count"]') as HTMLElement,
  ];

  return {
    puck,
    morphWrap,
    surface,
    carrier,
    update(state) {
      const open = String(state.pins.filter((p) => p.status !== "resolved").length);
      for (const badge of badges) {
        if (badge.textContent !== open) badge.textContent = open;
        badge.hidden = open === "0";
      }
      // The bar shows "· OFFLINE" as text; the puck has no room for words —
      // a small amber dot carries the same "degraded" signal.
      const degraded = state.connection === "offline" || state.connection === "incompatible";
      puck.classList.toggle("degraded", degraded);
    },
  };
}
