// @autono/pinbox-toolbar — shortcuts modal
// Ports the prototype's help overlay (docs/design/toolbar/v2-command-bar.html
// lines 314–319, 755–758): a scrim + card listing the keyboard map; any click
// on the scrim closes it.
import { esc } from "./html.ts";

const ROWS: [string, string][] = [
  ["Drop a pin", "P"],
  ["Open inbox", "I"],
  ["Toggle theme", "D"],
  ["Send comment", "⌘ ↵"],
  ["Mark pin resolved", "R"],
  ["Copy open pins", "C"],
  ["Cancel", "ESC"],
];

export interface ShortcutsModal {
  readonly root: HTMLElement;
  set(open: boolean): void;
}

export function createShortcutsModal(doc: Document, onClose: () => void): ShortcutsModal {
  const root = doc.createElement("div");
  root.className = "pb-modal";
  root.hidden = true;
  const rows = ROWS.map(
    ([what, key]) =>
      `<div class="mr"><span class="mw">${esc(what)}</span><span class="mk">${esc(key)}</span></div>`,
  ).join("");
  root.innerHTML = `<div class="mx"><div class="mh">SHORTCUTS</div><div style="padding:8px 20px 18px">${rows}</div></div>`;
  root.addEventListener("click", onClose);
  return {
    root,
    set(open) {
      root.hidden = !open;
    },
  };
}
