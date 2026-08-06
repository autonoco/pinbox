// @autono/pinbox-toolbar — DOM targeting adapter (default)
// Deepest-element hit-testing, devtools-style, with ancestry labels. Ports the
// prototype's nodeName/targetLabel (docs/design/toolbar/v2-command-bar.html
// lines 507–520) and its elementFromPoint hover filter (lines 521–536), with
// the page-specific ignore list generalized into a caller-supplied predicate.

/**
 * Deepest element under (clientX, clientY), or null when the hit is the page
 * chrome itself (html/body) or something the caller ignores (our own overlay).
 */
export function hitTest(
  doc: Document,
  x: number,
  y: number,
  ignore: (el: Element) => boolean,
): Element | null {
  const el = doc.elementFromPoint(x, y);
  if (!el || el === doc.body || el === doc.documentElement) return null;
  return ignore(el) ? null : el;
}

/** CLASS-or-TAG display name with a sibling index when needed (prototype nodeName). */
function nodeName(el: Element): string {
  const key = el.classList[0];
  let name = (key ?? el.tagName).toUpperCase();
  const parent = el.parentElement;
  if (parent) {
    const sibs = [...parent.children].filter(
      (c) => c.classList[0] === key && c.tagName === el.tagName,
    );
    if (sibs.length > 1) name += ` ${sibs.indexOf(el) + 1}`;
  }
  return name;
}

/**
 * Human label for a target: an explicit data-pb-el annotation wins; otherwise a
 * CLASS/TAG ancestry chain of at most 3 parts joined with ›, terminating early
 * at the first annotated ancestor.
 */
export function targetLabel(el: Element): string {
  const own = el.getAttribute("data-pb-el");
  if (own) return own;
  const parts = [nodeName(el)];
  const body = el.ownerDocument.body;
  let node = el.parentElement;
  while (node && node !== body && parts.length < 3) {
    const anchor = node.getAttribute("data-pb-el");
    if (anchor) {
      parts.unshift(anchor);
      break;
    }
    if (node.classList[0]) parts.unshift(nodeName(node));
    node = node.parentElement;
  }
  return parts.join(" › ");
}

const SAFE_ID = /^[A-Za-z][\w-]*$/;
/** Data attributes trusted as stable hooks, in priority order. */
const STABLE_DATA_ATTRS = ["data-pb-anchor", "data-pb-el", "data-testid"];

function attrSegment(el: Element, doc: Document): string | null {
  for (const attr of STABLE_DATA_ATTRS) {
    const value = el.getAttribute(attr);
    if (value === null || value.includes('"') || value.includes("\\")) continue;
    const selector = `${el.tagName.toLowerCase()}[${attr}="${value}"]`;
    if (doc.querySelectorAll(selector).length === 1) return selector;
  }
  return null;
}

function nthSegment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
  return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})` : tag;
}

/**
 * Stable CSS path for an element: ids > stable data attributes > an
 * nth-of-type chain. Guaranteed round-trip: querySelector(buildSelector(el)) === el.
 */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument;
  const segments: string[] = [];
  let node: Element | null = el;
  while (node && node !== doc.documentElement) {
    const id = node.getAttribute("id");
    if (id && SAFE_ID.test(id) && doc.querySelectorAll(`#${id}`).length === 1) {
      segments.unshift(`#${id}`);
      return segments.join(" > ");
    }
    const byAttr = attrSegment(node, doc);
    if (byAttr) {
      segments.unshift(byAttr);
      return segments.join(" > ");
    }
    segments.unshift(nthSegment(node));
    node = node.parentElement;
  }
  return segments.join(" > ");
}
