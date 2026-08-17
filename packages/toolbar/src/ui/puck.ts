// @autono/pinbox-toolbar — minimized state UI: the floating puck, the fan
// menu that lets you WORK from it, and the morph layer that liquid-animates
// between it and the command bar.
// The morph surface is styled *identically* to the bar (same translucent fill,
// blur, border, shadow — styles.ts), so both endpoint handoffs are
// pixel-invisible; the carrier holds the icon + badge that ride the surface
// while it is puck-shaped. Tapping the puck fans a vertical quick-menu out of
// it (icon pill with slide-out labels + key chips); EXPAND is how the bar
// comes back. Keyed DOM like ui/bar.ts — patch, never rebuild.
import type { ToolbarState } from "../state.ts";

/** The bar's ident mark, sized up for the 48px puck face. */
const PUCK_ICON =
  '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="1.5" width="11" height="7" rx="1"/><path d="M8 8.5v6"/><circle cx="8" cy="14.6" r=".9" fill="currentColor" stroke="none"/></svg>';
const FAN_PIN =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="1.5" width="10" height="6.5" rx="1"/><path d="M8 8v6.5"/></svg>';
const FAN_INBOX =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 8.5h3.4l1 2h3.6l1-2h3.4"/><path d="M2.6 3.2h10.8l1.2 5.3v4a1 1 0 01-1 1H2.4a1 1 0 01-1-1v-4z"/></svg>';
const FAN_THEME =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.6a6.4 6.4 0 100 12.8A5 5 0 018 1.6z"/></svg>';
const FAN_EXPAND =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 6.5v-4h4"/><path d="M6.5 9.5v4h-4"/></svg>';

/** Fan entries the controller delegates back to the element ("expand" it owns). */
export type FanAction = "pin" | "inbox" | "theme" | "expand";

function fanItem(act: FanAction, index: number, icon: string, label: string, key: string): string {
  const badge = act === "inbox" ? '<span class="badge" data-ref="count" hidden>0</span>' : "";
  return (
    `<button type="button" class="pb-fan-item" data-act="${act}" style="--i:${index}" aria-label="${label}">` +
    `${icon}${badge}<span class="fl">${label.toUpperCase()}<i>${key}</i></span></button>`
  );
}

export interface MinimizeUi {
  /** The floating button. Starts ghosted; the controller reveals it. */
  readonly puck: HTMLButtonElement;
  /** The vertical quick-menu that fans out of the puck; hidden at rest. */
  readonly fan: HTMLElement;
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
  puck.setAttribute("aria-label", "Pinbox menu");
  puck.setAttribute("aria-haspopup", "menu");
  puck.innerHTML = `<span class="in">${PUCK_ICON}</span><span class="badge" data-ref="count" hidden>0</span><span class="cdot"></span>`;

  const fan = doc.createElement("div");
  fan.className = "pb-fan";
  fan.hidden = true;
  fan.setAttribute("role", "menu");
  fan.innerHTML =
    fanItem("pin", 0, FAN_PIN, "Drop a pin", "P") +
    fanItem("inbox", 1, FAN_INBOX, "Inbox", "I") +
    fanItem("theme", 2, FAN_THEME, "Theme", "D") +
    fanItem("expand", 3, FAN_EXPAND, "Expand", "M");

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
    fan.querySelector('[data-ref="count"]') as HTMLElement,
  ];

  return {
    puck,
    fan,
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
      // Placing armed from the fan: the bar's armed-ring is hidden with the
      // bar, so the puck carries the armed signal while minimized.
      puck.classList.toggle("armed", state.mode === "placing");
    },
  };
}
