// @autono/pinbox-toolbar — inbox drawer
// Ports the prototype's drawer (docs/design/toolbar/v2-command-bar.html lines
// 302–312, 675–698): OPEN/RESOLVED tabs with counts, item click activates the
// pin, the list is innerHTML-memoized, and closing plays the exit animation
// before unmount (hidden flips on animationend, exactly as prototyped).
//
// Dogfood: "failed pins can't be cleared". Resolve lived only on the card, the
// card only opens from a chip, and a pin whose anchor is gone draws no chip —
// so the drawer, the one place that lists everything, is where the actions
// have to be. Every row now carries Resolve (open) or Unresolve (resolved),
// and open pins linked to the same tracker item (pin.links[0]) group under a
// header with a two-click Resolve-group for "everything in PR #58 shipped".
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import { deriveUiStatus, type ToolbarState, type UiStatus } from "../state.ts";
import { esc, pinNumber, safeUrl } from "./html.ts";

const X_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';
const UNDO_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 7.5h6a3 3 0 010 6H6"/><path d="M6 4.5l-3 3 3 3"/></svg>';

/** How long a first click on Resolve-group waits for its confirming second click. */
const CONFIRM_MS = 3000;

const STATUS_TEXT: Record<UiStatus, string> = {
  open: "OPEN",
  waiting: "OPEN",
  replied: "REPLIED",
  resolved: "RESOLVED",
  verify: "VERIFY",
  note: "NOTE",
};

const STATUS_DOT: Record<UiStatus, string> = {
  open: "var(--pb-fg4)",
  waiting: "var(--pb-fg4)",
  replied: "var(--pb-info)",
  resolved: "var(--pb-ok)",
  verify: "var(--pb-amber)",
  note: "var(--pb-fg3)",
};

export interface DrawerHandlers {
  onActivate(pinId: string): void;
  onClose(): void;
  /** Row or group resolve; the group path passes a "shipped in …" note. */
  onResolve(pinId: string, note?: string): void;
  /** Same wire call as the card's Reopen/Unresolve. */
  onUnresolve(pinId: string): void;
}

export interface Drawer {
  readonly root: HTMLElement;
  update(state: ToolbarState): void;
}

/**
 * The place a row names. A browser pin has a selector; a terminal `pinbox pin` has a
 * source anchor instead; a pin created with no anchor at all names nowhere.
 */
function locusOf(pin: Pin): string {
  return pin.target?.selector ?? pin.target?.source?.file ?? "";
}

/** "github#58" — the same label `pinbox link` prints. */
function linkKey(pin: Pin): string | null {
  const link = pin.links?.[0];
  return link === undefined ? null : `${link.connector}#${link.ref}`;
}

function itemHtml(
  pin: Pin,
  n: number,
  active: boolean,
  thread: ThreadMessage[],
  queued: boolean,
): string {
  const status = deriveUiStatus(pin, thread);
  const link = pin.links?.[0];
  // A queued pin is not on the hub yet, so there is nothing to resolve until the flush.
  const act =
    pin.status === "resolved"
      ? `<button type="button" class="pb-ico" data-act="unresolve" title="Unresolve">${UNDO_ICON}</button>`
      : queued
        ? ""
        : `<button type="button" class="pb-ico ok" data-act="resolve" title="Resolve">${CHECK_ICON}</button>`;
  return (
    `<div class="pb-item${active ? " on" : ""}" data-item="${esc(pin.id)}">` +
    `<button type="button" class="pb-item-main" data-open="${esc(pin.id)}">` +
    `<span class="nn">${pinNumber(n)}</span><span class="cc">` +
    `<span class="tt">${esc(pin.text)}</span>` +
    `<span class="mm"><span class="sdot" style="background:${queued ? "var(--pb-amber)" : STATUS_DOT[status]}"></span>` +
    `<span>${queued ? "QUEUED" : STATUS_TEXT[status]}</span>` +
    (link ? `<span class="lk">${esc(link.connector)}</span>` : "") +
    `<span>${esc(locusOf(pin))}</span></span></span></button>` +
    `<span class="acts">${act}</span></div>`
  );
}

function groupHtml(key: string, pins: Pin[], confirming: boolean): string {
  const link = pins[0]?.links?.[0];
  const open = link
    ? `<a class="pb-open" href="${esc(safeUrl(link.url))}" target="_blank" rel="noreferrer">OPEN</a>`
    : "";
  const label = confirming ? "CONFIRM?" : `RESOLVE ${pins.length}`;
  return (
    `<div class="pb-group"><span class="gk">${esc(link?.connector ?? "")}</span>` +
    `<span class="gr">#${esc(link?.ref ?? "")}</span><span class="sp"></span>${open}` +
    `<button type="button" class="pb-gres${confirming ? " confirm" : ""}" data-group-resolve="${esc(key)}" ` +
    `title="Resolve every pin linked to ${esc(key)}">${label}</button></div>`
  );
}

/** Open pins split into the ungrouped list and one group per tracker item, in first-seen order. */
export function groupByLink(open: Pin[]): { loose: Pin[]; groups: Map<string, Pin[]> } {
  const loose: Pin[] = [];
  const groups = new Map<string, Pin[]>();
  for (const pin of open) {
    const key = linkKey(pin);
    if (key === null) loose.push(pin);
    else groups.set(key, [...(groups.get(key) ?? []), pin]);
  }
  return { loose, groups };
}

export function createDrawer(doc: Document, on: DrawerHandlers): Drawer {
  const root = doc.createElement("div");
  root.className = "pb-drawer";
  root.hidden = true;
  root.innerHTML =
    `<div class="dh"><span>INBOX</span><button type="button" class="pb-ico" data-ref="close" title="Close">${X_ICON}</button></div>` +
    '<div class="pb-tabs">' +
    '<button type="button" class="pb-tab on" data-tab="open">OPEN · 0</button>' +
    '<button type="button" class="pb-tab" data-tab="notes">NOTES · 0</button>' +
    '<button type="button" class="pb-tab" data-tab="resolved">RESOLVED · 0</button></div>' +
    '<div class="pb-items" data-ref="items"></div>';

  let tab: "open" | "notes" | "resolved" = "open";
  let last: ToolbarState | null = null;
  let itemsMemo = "";
  /** Group key awaiting its confirming click, if any. */
  let confirming: string | null = null;
  let confirmTimer = 0;
  const items = root.querySelector('[data-ref="items"]') as HTMLElement;
  const tabButtons = [...root.querySelectorAll<HTMLElement>("[data-tab]")];
  const win = doc.defaultView;

  root.querySelector('[data-ref="close"]')?.addEventListener("click", on.onClose);
  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      tab = btn.getAttribute("data-tab") as "open" | "notes" | "resolved";
      if (last) render(last);
    });
  }

  function setConfirming(key: string | null): void {
    confirming = key;
    win?.clearTimeout(confirmTimer);
    if (key !== null) {
      confirmTimer = win?.setTimeout(() => setConfirming(null), CONFIRM_MS) ?? 0;
    }
    if (last) render(last);
  }

  function resolveGroup(key: string): void {
    if (confirming !== key) {
      setConfirming(key);
      return;
    }
    setConfirming(null);
    const pins = last?.pins.filter((p) => p.status === "open" && linkKey(p) === key) ?? [];
    for (const pin of pins) on.onResolve(pin.id, `shipped in ${key}`);
  }

  items.addEventListener("click", (e) => {
    const target = e.target as Element;
    const act = target.closest?.("[data-act]");
    if (act) {
      const id = act.closest("[data-item]")?.getAttribute("data-item");
      if (!id) return;
      if (act.getAttribute("data-act") === "resolve") on.onResolve(id);
      else on.onUnresolve(id);
      return;
    }
    const group = target.closest?.("[data-group-resolve]")?.getAttribute("data-group-resolve");
    if (group) {
      resolveGroup(group);
      return;
    }
    const id = target.closest?.("[data-open]")?.getAttribute("data-open");
    if (id) on.onActivate(id);
  });

  const rowOf = (state: ToolbarState) => (p: Pin) =>
    itemHtml(
      p,
      p.n ?? state.pins.indexOf(p) + 1,
      p.id === state.activePinId,
      state.threads.get(p.id) ?? [],
      state.queuedIds.has(p.id),
    );

  function openHtml(state: ToolbarState, open: Pin[]): string {
    const row = rowOf(state);
    const { loose, groups } = groupByLink(open);
    let html = loose.map(row).join("");
    for (const [key, pins] of groups) {
      html += groupHtml(key, pins, confirming === key) + pins.map(row).join("");
    }
    return html;
  }

  function render(state: ToolbarState): void {
    // OPEN is work; NOTES are open comment pins (remarks, nobody owes a reply); RESOLVED is both.
    const open = state.pins.filter((p) => p.status === "open" && p.kind !== "comment");
    const notes = state.pins.filter((p) => p.status === "open" && p.kind === "comment");
    const resolved = state.pins.filter((p) => p.status === "resolved");
    const counts = { open, notes, resolved };
    for (const btn of tabButtons) {
      const key = btn.getAttribute("data-tab") as keyof typeof counts;
      btn.textContent = `${key.toUpperCase()} · ${counts[key].length}`;
      btn.classList.toggle("on", tab === key);
    }
    const list = counts[tab];
    const html = list.length
      ? tab === "open"
        ? openHtml(state, open)
        : list.map(rowOf(state)).join("")
      : '<div class="pb-empty">Nothing here yet.</div>';
    if (itemsMemo !== html) {
      items.innerHTML = html;
      itemsMemo = html;
    }
  }

  /** Show immediately; hide only after the closing animation ends (prototype rule). */
  function setVisible(open: boolean): void {
    if (open) {
      if (root.hidden || root.classList.contains("closing")) {
        root.classList.remove("closing");
        root.hidden = false;
      }
    } else if (!root.hidden && !root.classList.contains("closing")) {
      root.classList.add("closing");
      root.addEventListener(
        "animationend",
        (ev) => {
          if (ev.target === root && root.classList.contains("closing")) {
            root.hidden = true;
            root.classList.remove("closing");
          }
        },
        { once: true },
      );
    }
  }

  return {
    root,
    update(state) {
      last = state;
      setVisible(state.inboxOpen);
      if (state.inboxOpen) render(state);
    },
  };
}
