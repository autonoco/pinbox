// @autono/pinbox-toolbar — minimized state UI: the floating puck, the fan
// menu that lets you WORK from it, and the morph layer that liquid-animates
// between it and the command bar.
// The morph surface is styled *identically* to the bar (same translucent fill,
// blur, border, shadow — styles.ts), so both endpoint handoffs are
// pixel-invisible; the carrier holds the icon + badge that ride the surface
// while it is puck-shaped. Tapping the puck fans a vertical quick-menu out of
// it (icon pill with slide-out labels + key chips); EXPAND is how the bar
// comes back. Keyed DOM like ui/bar.ts — patch, never rebuild.
import { openTaskCount, type ToolbarState } from "../state.ts";
import {
  ACTIONS,
  type ActionDef,
  EXPAND_GLYPH,
  EYE_GLYPH,
  EYE_OFF_GLYPH,
  icon,
  keyLabelOf,
} from "./actions.ts";

/** The bar's ident mark, sized up for the 48px puck face. */
const PUCK_ICON =
  '<svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="1.5" width="11" height="7" rx="1"/><path d="M8 8.5v6"/><circle cx="8" cy="14.6" r=".9" fill="currentColor" stroke="none"/></svg>';

/** Fan entries the controller delegates back to the element ("expand" it owns). */
export type FanAction = "pin" | "inbox" | "copy" | "theme" | "hide" | "expand";

/** Everything in the action table that asked for a fan item, in table order. */
const FAN_ACTIONS = ACTIONS.filter((a) => a.fan !== undefined);

function fanItem(a: ActionDef, index: number): string {
  const act = a.fan?.act ?? a.id;
  const label = a.fan?.label ?? a.label;
  const glyph = act === "expand" ? EXPAND_GLYPH : (a.glyph ?? "");
  const badge = a.id === "inbox" ? '<span class="badge" data-ref="count" hidden>0</span>' : "";
  return (
    `<button type="button" class="pb-fan-item" data-act="${act}" style="--i:${index}" aria-label="${label}">` +
    `${icon(glyph, 15)}${badge}<span class="fl">${label.toUpperCase()}<i>${keyLabelOf(a)}</i></span></button>`
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
  fan.innerHTML = FAN_ACTIONS.map(fanItem).join("");

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
      const open = String(openTaskCount(state.pins));
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
          icon(state.pinsHidden ? EYE_GLYPH : EYE_OFF_GLYPH, 15) +
          `<span class="fl">${label.toUpperCase()}<i>H</i></span>`;
        hideItem.setAttribute("aria-label", label);
        hideItem.classList.toggle("lit", state.pinsHidden);
      }
    },
  };
}
