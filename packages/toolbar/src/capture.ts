// @autono/pinbox-toolbar — captureTarget: fills PinInput.target/env from a chosen
// element. Structured DOM capture is the primary evidence (spec: agents reproduce
// from url+selector; pixels are best-effort extras in screenshot.ts). The shapes
// are the pin schema verbatim.
import type { Pin } from "@autono/pinbox-core/schema";
import { buildSelector } from "./targeting/dom.ts";

/**
 * The full browser shapes. `Pin["target"]`/`Pin["env"]` are optional at v1 (core
 * schema.ts §"widened in place") because a terminal `pinbox pin` has no browser to
 * measure. A capture is the opposite case: it always has a window, so it always
 * produces every field. Narrowing here is what keeps every capture-side consumer
 * free of optional chaining — the widening only reaches code that reads pins back.
 */
type MaybeTarget = NonNullable<Pin["target"]>;
type MaybeEnv = NonNullable<Pin["env"]>;
/** The named keys become present-and-defined; everything else keeps its optionality. */
type Concrete<T, K extends keyof T> = T & { [P in K]-?: NonNullable<T[P]> };
export type BrowserTarget = Concrete<MaybeTarget, "url" | "selector" | "tag" | "rect" | "fixed">;
// branch/commit stay optional: the hub stamps those, not the browser.
export type BrowserEnv = Concrete<MaybeEnv, "viewport" | "browser" | "os" | "colorScheme">;

/** What a targeting adapter produces for a chosen element: the pin schema shapes. */
export interface CaptureResult {
  target: BrowserTarget;
  env: BrowserEnv;
}

/** A pin the toolbar itself created — a capture became its target/env. */
export type BrowserPin = Pin & CaptureResult;

type TargetContext = NonNullable<BrowserTarget["context"]>;
type BrowserWindow = Window & typeof globalThis;

/** Curated computed-style subset — enough to reconstruct layout intent, tiny on the wire. */
const STYLE_KEYS = [
  "display",
  "position",
  "font-size",
  "color",
  "background-color",
  "margin",
  "padding",
  "overflow",
] as const;

const NEARBY_TEXT_MAX = 160;

function styleSubset(win: BrowserWindow, el: Element): Record<string, string> | undefined {
  let cs: CSSStyleDeclaration;
  try {
    cs = win.getComputedStyle(el);
  } catch {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const key of STYLE_KEYS) {
    const value = cs.getPropertyValue(key);
    if (value !== "") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function ariaMap(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of el.getAttributeNames()) {
    if (name.startsWith("aria-")) out[name] = el.getAttribute(name) ?? "";
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function nearbyText(el: Element): string | undefined {
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text.slice(0, NEARBY_TEXT_MAX);
}

/** The user's selection, only when it intersects the captured element. */
function selectedText(win: BrowserWindow, el: Element): string | undefined {
  try {
    const sel = win.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return undefined;
    if (!sel.getRangeAt(0).intersectsNode(el)) return undefined;
    const text = sel.toString().trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined; // selection APIs vary; capture never fails over extras
  }
}

/** `fixed` detected via ancestry: any ancestor with computed position: fixed. */
function isFixed(win: BrowserWindow, el: Element): boolean {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    try {
      if (win.getComputedStyle(node).position === "fixed") return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Beyond this an element is not a thing you pinned, it is a region. Too many to rewrite as a set. */
const MAX_RUNS = 40;
const MAX_RUN_LENGTH = 200;

/** Text that is not content: a script body or a stylesheet is not something to rewrite. */
const NON_CONTENT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/**
 * The element's text, split the way the browser stores it: one entry per run of characters.
 *
 * This walks TEXT NODES, not elements, and that distinction is the whole point — it makes no
 * assumption about how a site is built. A heading is one run. A nav bar is one per link. A
 * paragraph with a bold word in the middle is three, in reading order, including the halves either
 * side of the bold. An earlier version keyed off "elements with no element children", which
 * quietly lost the "Hello " in `<p>Hello <b>world</b></p>` — text a person can obviously see and
 * would obviously expect to be able to change.
 *
 * `nearbyText` runs them all together, which is fine to read and useless to edit: it cannot tell
 * an agent that "work approach people contact" is four separate places. This can.
 */
function textRuns(el: Element): string[] | undefined {
  const runs: string[] = [];
  const walk = (node: Node): boolean => {
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? "").trim();
      if (text.length > 0) runs.push(text.slice(0, MAX_RUN_LENGTH));
      return runs.length <= MAX_RUNS;
    }
    if (node.nodeType !== 1 || NON_CONTENT.has((node as Element).tagName)) return true;
    for (const child of node.childNodes) if (!walk(child)) return false;
    return true;
  };
  // Over the cap we return nothing rather than a truncated list: a partial list cannot be applied
  // (the lengths would never line up) and offering one would only invite an edit that silently
  // does nothing.
  if (!walk(el) || runs.length === 0) return undefined;
  return runs;
}

function buildContext(win: BrowserWindow, el: Element): TargetContext | undefined {
  const context: TargetContext = {};
  if (el.classList.length > 0) context.classes = [...el.classList];
  const styles = styleSubset(win, el);
  if (styles !== undefined) context.styles = styles;
  const aria = ariaMap(el);
  if (aria !== undefined) context.aria = aria;
  const nearby = nearbyText(el);
  if (nearby !== undefined) context.nearbyText = nearby;
  const selected = selectedText(win, el);
  if (selected !== undefined) context.selectedText = selected;
  const runs = textRuns(el);
  if (runs !== undefined) context.textRuns = runs;
  return Object.keys(context).length > 0 ? context : undefined;
}

/** Fills PinInput.target/env from a chosen element (shapes come from the pin schema). */
export function captureTarget(
  el: Element,
  opts?: { anchor?: string; at?: { x: number; y: number } },
): CaptureResult {
  const doc = el.ownerDocument;
  const win = doc.defaultView as BrowserWindow;
  const r = el.getBoundingClientRect();
  const target: BrowserTarget = {
    url: win.location.href,
    selector: buildSelector(el),
    tag: el.tagName.toLowerCase(),
    // Rect is document-relative: client rect shifted by the scroll offset.
    rect: { x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height },
    fixed: isFixed(win, el),
  };
  if (opts?.anchor !== undefined) target.anchor = opts.anchor;
  // Where in the element you clicked, as a fraction of its box. Stored as a fraction rather than
  // pixels so it survives the element being resized or reflowed — the pin still binds to the
  // element, it just stops jumping to the middle of it.
  if (opts?.at !== undefined && r.width > 0 && r.height > 0) {
    const fx = (opts.at.x - (r.left + win.scrollX)) / r.width;
    const fy = (opts.at.y - (r.top + win.scrollY)) / r.height;
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) target.spot = { x: fx, y: fy };
  }
  const context = buildContext(win, el);
  if (context !== undefined) target.context = context;
  return {
    target,
    env: {
      viewport: { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio },
      browser: win.navigator.userAgent,
      os: win.navigator.platform || "unknown",
      colorScheme: win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    },
  };
}
