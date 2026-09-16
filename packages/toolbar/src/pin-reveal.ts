import type { Pin } from "@autono/pinbox-core/schema";
import { cancelRevealSettle, settlePinReveal } from "./reveal-settle.ts";

/** Query ordering is not a view change; repeated parameter ordering remains intact. */
export function samePinView(win: Window, value?: string): boolean {
  if (!value) return true;
  try {
    const target = new URL(value, win.location.href);
    const current = new URL(win.location.href);
    target.searchParams.sort();
    current.searchParams.sort();
    return target.pathname === current.pathname && target.search === current.search;
  } catch {
    return true;
  }
}

function pagePin(pin: Pin): boolean {
  return pin.target?.selector === "html" || pin.target?.selector === "body";
}

/** Resolve before clipping: an offscreen row is precisely the target we need to scroll. */
export function scrollToPin(doc: Document, pin: Pin): boolean {
  if (pin.target?.model || pagePin(pin)) return false;
  const win = doc.defaultView;
  if (!win || !samePinView(win, pin.target?.url) || !pin.target?.selector) return false;
  try {
    const element = doc.querySelector(pin.target.selector);
    if (!element?.getClientRects().length) return false;
    // The platform scrolls all relevant ancestors, including chat panes. Instant scrolling
    // lets the card open beside its final anchor instead of briefly docking mid-screen.
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    return true;
  } catch {
    return false;
  }
}

const key = (endpoint: string) => `pinbox:${endpoint}:reveal`;
type Pending = { id: string; expires: number };

/** Returns true when leaving this document. Never navigates to a different origin. */
export function revealPin(doc: Document, pin: Pin, endpoint: string): boolean {
  cancelRevealSettle(doc);
  const win = doc.defaultView;
  if (!win) return false;
  try {
    win.sessionStorage.removeItem(key(endpoint));
  } catch {
    /* optional storage */
  }
  if (pagePin(pin) || pin.target?.model) return false;
  if (pin.target?.url && !samePinView(win, pin.target.url)) {
    try {
      const target = new URL(pin.target.url, win.location.href);
      if (target.origin !== win.location.origin || !["http:", "https:"].includes(target.protocol))
        return false;
      win.sessionStorage.setItem(
        key(endpoint),
        JSON.stringify({ id: pin.id, expires: Date.now() + 30000 }),
      );
      win.location.assign(target.href);
      return true;
    } catch {
      return false;
    }
  }
  scrollToPin(doc, pin);
  return false;
}

/** Called on pin updates and DOM changes: SPA content may arrive after the toolbar. */
export function pendingPinReveal(doc: Document, pins: Pin[], endpoint: string): string | null {
  const win = doc.defaultView;
  if (!win) return null;
  try {
    const raw = win.sessionStorage.getItem(key(endpoint));
    if (!raw) return null;
    const pending: Pending = JSON.parse(raw);
    if (
      typeof pending.id !== "string" ||
      !Number.isFinite(pending.expires) ||
      pending.expires < Date.now()
    ) {
      win.sessionStorage.removeItem(key(endpoint));
      return null;
    }
    const pin = pins.find((p) => p.id === pending.id);
    if (!pin || !scrollToPin(doc, pin)) return null;
    win.sessionStorage.removeItem(key(endpoint));
    settlePinReveal(doc, () => {
      scrollToPin(doc, pin);
    });
    return pin.id;
  } catch {
    return null;
  }
}
