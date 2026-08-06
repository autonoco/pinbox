// @autono/pinbox-toolbar — anchor targeting adapter.
// Spec: anchor mode for hosts rendering content in sandboxed cross-origin iframes
// (e.g. buttons studio) — targeting is list-driven from data-* anchor attributes
// and pins render as an overlay/rail outside the frame. target.anchor carries the id.
import { type CaptureResult, captureTarget } from "../capture.ts";

/** All anchored elements in document order, keyed by their attribute value. */
export function listAnchors(doc: Document, attribute: string): { anchor: string; el: Element }[] {
  const out: { anchor: string; el: Element }[] = [];
  for (const el of doc.querySelectorAll(`[${attribute}]`)) {
    const anchor = el.getAttribute(attribute);
    if (anchor !== null && anchor !== "") out.push({ anchor, el });
  }
  return out;
}

/** Capture via an anchor id. via "none": the id, not a source file, locates the target. */
export function anchorTarget(anchor: string, el: Element): CaptureResult {
  const result = captureTarget(el, { anchor });
  result.target.source = { file: "", via: "none" };
  return result;
}
