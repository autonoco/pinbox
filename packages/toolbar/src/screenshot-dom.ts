// @autono/pinbox-toolbar — no-permission element snapshots.
// Dogfood: Chrome's tab-share prompt fired on every pin (fixed to once per page
// load in screenshot.ts), and a page load is not a session — reload, new tab or
// HMR re-prompted, and the browser offers no persistent grant. So the DEFAULT
// capture now asks nothing: the target element is cloned, its computed styles
// inlined, wrapped in an SVG <foreignObject> and drawn to a canvas. Good enough
// for "which button" context — the agent already has selector, rect and text —
// and zero prompts. Tab capture stays as the opt-in upgrade (state.captureMode).
//
// Limits, all deliberate: SVG-as-image loads with no external resources, so
// <img>/<video>/<canvas>/<iframe> become neutral boxes of their size (a
// data: URL image is kept); very large subtrees (> MAX_NODES) resolve null
// rather than freeze the page; output is capped to MAX_EDGE px on the long edge.
import { type CapturedImage, toBase64 } from "./screenshot.ts";

const MAX_NODES = 1500;
const MAX_EDGE = 1600;
const WEBP_QUALITY = 0.7;
const PLACEHOLDER_MAX = 32;
/** Elements SVG-as-image cannot render (external resources) — replaced by a same-size box. */
const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "OBJECT", "EMBED", "PICTURE"]);

/** The realm's constructors, read off the element's window (tests run per-window realms). */
type Realm = Window & { Image?: typeof Image; XMLSerializer?: typeof XMLSerializer };

function realmOf(el: Element): Realm | null {
  return el.ownerDocument.defaultView as Realm | null;
}

/** Copy every computed property onto the clone so it renders without the page's stylesheets. */
function inlineStyles(win: Window, source: Element, clone: Element): void {
  const cs = win.getComputedStyle(source);
  const style = (clone as HTMLElement).style;
  if (style === undefined) return;
  let css = "";
  for (let i = 0; i < cs.length; i += 1) {
    const prop = cs[i];
    if (prop === undefined) continue;
    css += `${prop}:${cs.getPropertyValue(prop)};`;
  }
  style.cssText = css;
}

/**
 * A same-size neutral box in place of an element the snapshot cannot draw. Keeps the layout
 * honest (the agent sees where the image sits) without a tainted or empty canvas.
 */
function placeholderFor(doc: Document, source: Element): HTMLElement {
  const r = source.getBoundingClientRect();
  const box = doc.createElement("span");
  box.style.cssText =
    `display:inline-block;width:${r.width}px;height:${r.height}px;` +
    "background:rgba(127,127,127,.25);border-radius:4px;vertical-align:top;";
  return box;
}

/**
 * Deep-clone `root` with computed styles inlined and un-renderable elements replaced.
 * Returns null when the subtree is too large to snapshot responsively.
 */
export function cloneForSnapshot(root: Element): Element | null {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (win === null) return null;
  const sources = [root, ...root.querySelectorAll("*")];
  if (sources.length > MAX_NODES) return null;
  const clone = root.cloneNode(true) as Element;
  const clones = [clone, ...clone.querySelectorAll("*")];
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i] as Element;
    const target = clones[i] as Element | undefined;
    if (target === undefined) break;
    const keepDataImage =
      source.tagName === "IMG" && (source.getAttribute("src") ?? "").startsWith("data:");
    if (REPLACED.has(source.tagName) && !keepDataImage) {
      target.replaceWith(placeholderFor(doc, source));
      continue;
    }
    inlineStyles(win, source, target);
  }
  for (const script of clone.querySelectorAll("script")) script.remove();
  return clone;
}

/** The SVG document that renders `clone` at the element's size. */
export function svgFor(clone: Element, width: number, height: number): string {
  const Serializer = realmOf(clone)?.XMLSerializer ?? XMLSerializer;
  const xhtml = new Serializer().serializeToString(clone);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${xhtml}</div>` +
    "</foreignObject></svg>"
  );
}

function loadImage(ImageCtor: typeof Image, url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new ImageCtor();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("snapshot image failed to load"));
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b === null ? reject(new Error("toBlob")) : resolve(b)), type, quality);
  });
}

async function rasterize(
  win: Window,
  img: HTMLImageElement,
  width: number,
  height: number,
): Promise<CapturedImage> {
  const scale = Math.min(win.devicePixelRatio || 1, 2, MAX_EDGE / Math.max(width, height));
  const canvas = win.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d context");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await toBlob(canvas, "image/webp", WEBP_QUALITY);
  const image: CapturedImage = { blob, width: canvas.width, height: canvas.height };
  const t = PLACEHOLDER_MAX / Math.max(canvas.width, canvas.height);
  const thumb = win.document.createElement("canvas");
  thumb.width = Math.max(1, Math.round(canvas.width * Math.min(t, 1)));
  thumb.height = Math.max(1, Math.round(canvas.height * Math.min(t, 1)));
  thumb.getContext("2d")?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const thumbBlob = await toBlob(thumb, "image/webp", 0.5);
  image.placeholder = `data:image/webp;base64,${toBase64(await thumbBlob.arrayBuffer())}`;
  return image;
}

/**
 * Snapshot `el` without any permission prompt. Resolves null whenever the environment cannot
 * (no canvas/Image, zero-size element, subtree too large, a tainted canvas) — never throws.
 */
export async function captureElementDom(el: Element): Promise<CapturedImage | null> {
  const win = realmOf(el);
  if (win === null || typeof win.Image !== "function" || typeof win.XMLSerializer !== "function") {
    return null;
  }
  const ImageCtor = win.Image;
  const r = el.getBoundingClientRect();
  const width = Math.ceil(r.width);
  const height = Math.ceil(r.height);
  if (width < 1 || height < 1) return null;
  const clone = cloneForSnapshot(el);
  if (clone === null) return null;
  const svg = svgFor(clone, width, height);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = await loadImage(ImageCtor, url);
    return await rasterize(win, img, width, height);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
