// @autono/pinbox-toolbar — thread card: part renderers
// Pure HTML builders for the card's memoized parts (header, link bar, loci,
// verify footer, composer row), split out of card.ts (file-size rule). Each
// returns a string; card.ts's setPart swaps it in only when it changed.
import type { Pin } from "@autono/pinbox-core/schema";
import type { UiStatus } from "../state.ts";
import { esc, pinNumber, safeUrl } from "./html.ts";

export const STATUS_LABEL: Record<UiStatus, string> = {
  open: "OPEN",
  waiting: "OPEN",
  replied: "REPLIED",
  resolved: "RESOLVED",
  verify: "VERIFY",
  note: "NOTE",
};

export type DraftKind = "note" | "comment";

const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
const X_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1"/></svg>';

export function hdHtml(
  n: number,
  targetLabel: string,
  status: string,
  resolvable: boolean,
  copyable: boolean,
): string {
  return (
    `<div class="meta"><span class="num">${pinNumber(n)}</span>` +
    `<span>${esc(targetLabel)}</span><span class="st">${esc(status)}</span></div>` +
    '<div style="display:flex;gap:2px">' +
    (copyable
      ? `<button type="button" class="pb-ico" data-action="copy" title="Copy this pin">${COPY_ICON}</button>`
      : "") +
    (resolvable
      ? `<button type="button" class="pb-ico ok" data-action="resolve" title="Resolve (R)">${CHECK_ICON}</button>`
      : "") +
    `<button type="button" class="pb-ico" data-action="close" title="Close (Esc)">${X_ICON}</button></div>`
  );
}

/** One name per locus: selector first, else anchor, else tag. */
function locusName(t: NonNullable<Pin["target"]>): string | undefined {
  return t.selector ?? t.anchor ?? t.tag?.toUpperCase();
}

/** The extra loci of a multi-target pin — the anchor leads, extras follow. */
export function lociHtml(pin: Pin | null): string {
  const target = pin?.target;
  const extras = target?.targets;
  if (target === undefined || extras === undefined || extras.length === 0) return "";
  const names = [target, ...extras].map((t) => esc(locusName(t) ?? "?"));
  return `<div class="pb-loci">${names.length} targets: ${names.join(" · ")}</div>`;
}

/** Link badge: pin.links[0] read-only — no picker, no unlink yet. */
export function linkHtml(pin: Pin | null): string {
  const link = pin?.links?.[0];
  if (!link) return "";
  return (
    `<div class="pb-linkbar"><span class="ch">${esc(link.connector)}</span>` +
    `<span class="mt">${esc(link.ref)}</span><span class="sp"></span>` +
    `<a class="pb-open" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer">OPEN</a></div>`
  );
}

/**
 * Who resolved the pin and what they said. The schema has carried `resolution.note` and
 * `.commit` since v1 (agents write them); the card never showed either, so a resolved pin
 * read as bare "RESOLVED" with the why one CLI call away.
 */
export function resolutionHtml(pin: Pin | null): string {
  const r = pin?.resolution;
  if (pin === null || r === undefined || pin.status !== "resolved") return "";
  const who = r.by === "agent" ? "agent" : "you";
  const note = r.note === undefined ? "" : ` · ${esc(r.note)}`;
  const commit =
    r.commit === undefined ? "" : ` <span class="hh">${esc(r.commit.slice(0, 7))}</span>`;
  return `<div class="pb-resnote">Resolved by ${who}${note}${commit}</div>`;
}

export function verifyHtml(status: UiStatus | null): string {
  if (status === "verify") {
    return (
      '<div class="pb-verify">' +
      '<button type="button" class="pb-bt-ok" data-action="verify-accept">Looks good</button>' +
      '<button type="button" class="pb-bt-ghost" data-action="verify-reopen">Reopen</button></div>'
    );
  }
  // A verified-resolved pin was previously a dead end (dogfood: "how would I
  // unresolve a resolved comment?"). Same wire call as Reopen — the hub flips
  // any resolved pin back to open — so the card offers it whenever resolved.
  if (status === "resolved") {
    return (
      '<div class="pb-verify">' +
      '<button type="button" class="pb-bt-ghost" data-action="verify-reopen">Unresolve</button></div>'
    );
  }
  return "";
}

/**
 * The composer row. A draft chooses what it is before it exists: "Ask agent" (the default —
 * a `note` pin an agent picks up) or "Note" (a `comment` pin, a remark for people that never
 * wakes an agent). A control on the draft, not a global toggle: a mode you set once and forget
 * makes the next pin silently the wrong kind.
 */
export function rowHtml(hasThread: boolean, isDraft: boolean, kind: DraftKind): string {
  const seg = isDraft
    ? '<div class="pb-seg" role="radiogroup" aria-label="Pin kind">' +
      `<button type="button" role="radio" aria-checked="${kind === "note"}" class="${kind === "note" ? "on" : ""}" data-kind="note" title="An agent picks this up">Ask agent</button>` +
      `<button type="button" role="radio" aria-checked="${kind === "comment"}" class="${kind === "comment" ? "on" : ""}" data-kind="comment" title="A remark for people; no agent acts on it">Note</button></div>`
    : "";
  const label = hasThread ? "Reply" : kind === "comment" ? "Leave note" : "Comment";
  return (
    `${seg}<div class="pb-kbd">⌘ ↵</div>` +
    `<button type="button" class="pb-bt-solid" data-action="send">${label}</button>`
  );
}
