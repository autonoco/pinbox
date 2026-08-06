// @autono/pinbox-toolbar — inbox drawer
// Ports the prototype's drawer (docs/design/toolbar/v2-command-bar.html lines
// 302–312, 675–698): OPEN/RESOLVED tabs with counts, item click activates the
// pin, the list is innerHTML-memoized, and closing plays the exit animation
// before unmount (hidden flips on animationend, exactly as prototyped).
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import { deriveUiStatus, type ToolbarState, type UiStatus } from "../state.ts";
import { esc, pinNumber } from "./html.ts";

const X_ICON =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

const STATUS_TEXT: Record<UiStatus, string> = {
  open: "OPEN",
  waiting: "OPEN",
  replied: "REPLIED",
  resolved: "RESOLVED",
  verify: "VERIFY",
};

const STATUS_DOT: Record<UiStatus, string> = {
  open: "var(--pb-fg4)",
  waiting: "var(--pb-fg4)",
  replied: "var(--pb-info)",
  resolved: "var(--pb-ok)",
  verify: "var(--pb-amber)",
};

export interface DrawerHandlers {
  onActivate(pinId: string): void;
  onClose(): void;
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

function itemHtml(
  pin: Pin,
  n: number,
  active: boolean,
  thread: ThreadMessage[],
  queued: boolean,
): string {
  const status = deriveUiStatus(pin, thread);
  const link = pin.links?.[0];
  return (
    `<button type="button" class="pb-item${active ? " on" : ""}" data-item="${esc(pin.id)}">` +
    `<span class="nn">${pinNumber(n)}</span><span class="cc">` +
    `<span class="tt">${esc(pin.text)}</span>` +
    `<span class="mm"><span class="sdot" style="background:${queued ? "var(--pb-amber)" : STATUS_DOT[status]}"></span>` +
    `<span>${queued ? "QUEUED" : STATUS_TEXT[status]}</span>` +
    (link ? `<span class="lk">${esc(link.connector)}</span>` : "") +
    `<span>${esc(locusOf(pin))}</span></span></span></button>`
  );
}

export function createDrawer(doc: Document, on: DrawerHandlers): Drawer {
  const root = doc.createElement("div");
  root.className = "pb-drawer";
  root.hidden = true;
  root.innerHTML =
    `<div class="dh"><span>INBOX</span><button type="button" class="pb-ico" data-ref="close" title="Close">${X_ICON}</button></div>` +
    '<div class="pb-tabs">' +
    '<button type="button" class="pb-tab on" data-tab="open">OPEN · 0</button>' +
    '<button type="button" class="pb-tab" data-tab="resolved">RESOLVED · 0</button></div>' +
    '<div class="pb-items" data-ref="items"></div>';

  let tab: "open" | "resolved" = "open";
  let last: ToolbarState | null = null;
  let itemsMemo = "";
  const items = root.querySelector('[data-ref="items"]') as HTMLElement;
  const tabButtons = [...root.querySelectorAll<HTMLElement>("[data-tab]")];

  root.querySelector('[data-ref="close"]')?.addEventListener("click", on.onClose);
  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      tab = btn.getAttribute("data-tab") as "open" | "resolved";
      if (last) render(last);
    });
  }
  items.addEventListener("click", (e) => {
    const id = (e.target as Element).closest?.("[data-item]")?.getAttribute("data-item");
    if (id) on.onActivate(id);
  });

  function render(state: ToolbarState): void {
    const open = state.pins.filter((p) => p.status === "open");
    const resolved = state.pins.filter((p) => p.status === "resolved");
    const [openTab, doneTab] = tabButtons;
    if (openTab) {
      openTab.textContent = `OPEN · ${open.length}`;
      openTab.classList.toggle("on", tab === "open");
    }
    if (doneTab) {
      doneTab.textContent = `RESOLVED · ${resolved.length}`;
      doneTab.classList.toggle("on", tab === "resolved");
    }
    const list = tab === "open" ? open : resolved;
    const html = list.length
      ? list
          .map((p) =>
            itemHtml(
              p,
              state.pins.indexOf(p) + 1,
              p.id === state.activePinId,
              state.threads.get(p.id) ?? [],
              state.queuedIds.has(p.id),
            ),
          )
          .join("")
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
