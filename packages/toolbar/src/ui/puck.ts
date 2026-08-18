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
// A crescent — the one shape everyone reads as "theme". The old half-filled
// circle went unrecognized in dogfood ("I didn't recognize it as an icon").
const FAN_THEME =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 2a4 4 0 0 0 6 6 6 6 0 1 1-6-6z"/></svg>';
const FAN_EYE =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.8"/></svg>';
const FAN_EYE_OFF =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.3 2.3l11.4 11.4"/><path d="M4.9 4.9C2.7 6.2 1.6 8 1.6 8s2.4 4.2 6.4 4.2c1.2 0 2.3-.3 3.1-.8M6.7 4c.4-.1.9-.2 1.3-.2 4 0 6.4 4.2 6.4 4.2s-.8 1.4-2.2 2.5"/></svg>';
const FAN_EXPAND =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.5 6.5v-4h4"/><path d="M6.5 9.5v4h-4"/></svg>';

/** Fan entries the controller delegates back to the element ("expand" it owns). */
export type FanAction = "pin" | "inbox" | "theme" | "hide" | "expand";

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
    fanItem("hide", 3, FAN_EYE_OFF, "Hide pins", "H") +
    fanItem("expand", 4, FAN_EXPAND, "Expand", "M");

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
  const hideItem = fan.querySelector('[data-act="hide"]') as HTMLElement;
  /** Last-rendered hide state; the item's markup is swapped only on change. */
  let hideShown: boolean | null = null;

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
      // The hide item is the fan's one stateful entry: icon and label flip
      // with the layer (eye-off ⇒ will hide; eye ⇒ will show them again).
      if (hideShown !== state.pinsHidden) {
        hideShown = state.pinsHidden;
        const label = state.pinsHidden ? "Show pins" : "Hide pins";
        hideItem.innerHTML =
          `${state.pinsHidden ? FAN_EYE : FAN_EYE_OFF}` +
          `<span class="fl">${label.toUpperCase()}<i>H</i></span>`;
        hideItem.setAttribute("aria-label", label);
        hideItem.classList.toggle("lit", state.pinsHidden);
      }
    },
  };
}
