// @autono/pinbox-toolbar — shortcuts modal
// Ports the prototype's help overlay (docs/design/toolbar/v2-command-bar.html
// lines 314–319, 755–758): a scrim + card listing the keyboard map; any click
// on the scrim closes it.
import { ACTIONS, keyLabelOf } from "./actions.ts";
import { esc } from "./html.ts";

/** The action table's keyed entries, plus the composer chord the table cannot know about. */
const ROWS: [string, string][] = [
  ...ACTIONS.filter((a) => a.key !== undefined && a.help !== false).map((a): [string, string] => [
    a.label,
    keyLabelOf(a),
  ]),
  ["Send comment", "⌘ ↵"],
  ["Move toolbar", "DRAG ⋮"],
  ["Reset toolbar position", "2× GRIP"],
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
  root.innerHTML =
    `<div class="mx"><div class="mh">SHORTCUTS</div><div style="padding:8px 20px 18px">${rows}</div>` +
    '<div class="mf">Shortcuts need the page focused. Inside an embedded frame, click the page first.</div></div>';
  root.addEventListener("click", onClose);
  return {
    root,
    set(open) {
      root.hidden = !open;
    },
  };
}
