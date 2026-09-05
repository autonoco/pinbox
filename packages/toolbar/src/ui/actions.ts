// @autono/pinbox-toolbar — the one action table.
// The command bar, the puck's fan menu, the keyboard map and the shortcuts modal
// are four densities of the same toolbar. Each used to hand-list its actions and
// they drifted (dogfood: the bar had COPY and ?, the fan had HIDE, neither had
// the other's). Every surface now renders from this table, so an action with a
// key is always in the help modal and a surface can never show a key the
// dispatcher does not handle.

export type ActionId =
  | "pin"
  | "inbox"
  | "copy"
  | "theme"
  | "hide"
  | "help"
  | "minimize"
  | "resolve"
  | "escape";

export interface ActionDef {
  readonly id: ActionId;
  /** Help-modal and fan label (the fan upper-cases it). */
  readonly label: string;
  /** `KeyboardEvent.key`, lower-cased, as the dispatcher sees it; absent = no shortcut. */
  readonly key?: string;
  /** How the key prints in titles and the help modal (defaults to the upper-cased key). */
  readonly keyLabel?: string;
  /** 16-unit stroke paths, wrapped by `icon()` at the surface's size. */
  readonly glyph?: string;
  /** Bar button: a text label (PIN) or a square icon-only button. */
  readonly bar?: { readonly text?: string; readonly count?: boolean; readonly ariaLabel?: string };
  /** Fan item; `act` overrides the `data-act` the minimize controller matches on. */
  readonly fan?: { readonly act?: string; readonly label?: string };
  /** Listed in the shortcuts modal. Default true when there is a key. */
  readonly help?: boolean;
}

// Glyphs are the 16×16 stroke paths only; `icon()` adds the frame at the caller's size.
const PIN_GLYPH = '<rect x="3" y="1.5" width="10" height="6.5" rx="1"/><path d="M8 8v6.5"/>';
const INBOX_GLYPH =
  '<path d="M1.8 8.5h3.4l1 2h3.6l1-2h3.4"/><path d="M2.6 3.2h10.8l1.2 5.3v4a1 1 0 01-1 1H2.4a1 1 0 01-1-1v-4z"/>';
// A crescent — the one shape everyone reads as "theme" (dogfood: the old
// half-filled circle went unrecognized).
const THEME_GLYPH = '<path d="M8 2a4 4 0 0 0 6 6 6 6 0 1 1-6-6z"/>';
const COPY_GLYPH =
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1"/>';
export const EYE_GLYPH =
  '<path d="M1.6 8S4 3.8 8 3.8 14.4 8 14.4 8 12 12.2 8 12.2 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.8"/>';
export const EYE_OFF_GLYPH =
  '<path d="M2.3 2.3l11.4 11.4"/><path d="M4.9 4.9C2.7 6.2 1.6 8 1.6 8s2.4 4.2 6.4 4.2c1.2 0 2.3-.3 3.1-.8M6.7 4c.4-.1.9-.2 1.3-.2 4 0 6.4 4.2 6.4 4.2s-.8 1.4-2.2 2.5"/>';
const MIN_GLYPH = '<path d="M6.5 2.5v4h-4"/><path d="M9.5 13.5v-4h4"/>';
export const EXPAND_GLYPH = '<path d="M9.5 6.5v-4h4"/><path d="M6.5 9.5v4h-4"/>';

/** Frame a glyph as an inline SVG at `size` px. */
export function icon(glyph: string, size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="1.4">${glyph}</svg>`
  );
}

/** Ordered as the bar and fan lay them out. */
export const ACTIONS: readonly ActionDef[] = [
  { id: "pin", label: "Drop a pin", key: "p", glyph: PIN_GLYPH, bar: { text: "PIN" }, fan: {} },
  { id: "inbox", label: "Open inbox", key: "i", glyph: INBOX_GLYPH, bar: { count: true }, fan: {} },
  { id: "copy", label: "Copy open pins", key: "c", glyph: COPY_GLYPH, bar: {}, fan: {} },
  { id: "theme", label: "Toggle theme", key: "d", glyph: THEME_GLYPH, bar: {}, fan: {} },
  {
    id: "hide",
    label: "Hide / show pins",
    key: "h",
    glyph: EYE_OFF_GLYPH,
    bar: {},
    // The fan item is stateful (puck.ts flips it to "Show pins"); this is its rest label.
    fan: { label: "Hide pins" },
  },
  // Discoverability for the bar; the fan shows key chips inline, so it is bar-only.
  { id: "help", label: "Shortcuts", key: "?", bar: {}, help: false },
  {
    id: "minimize",
    label: "Minimize toolbar",
    key: "m",
    glyph: MIN_GLYPH,
    bar: { ariaLabel: "Minimize toolbar" },
    fan: { act: "expand", label: "Expand" },
  },
  { id: "resolve", label: "Mark pin resolved", key: "r" },
  { id: "escape", label: "Cancel", key: "escape", keyLabel: "ESC" },
];

export function keyLabelOf(a: ActionDef): string {
  return a.keyLabel ?? (a.key ?? "").toUpperCase();
}

/** "Drop a pin (P)" — the bar's hover title. */
export function titleOf(a: ActionDef): string {
  return a.key === undefined ? a.label : `${a.label} (${keyLabelOf(a)})`;
}

/** Lower-cased `KeyboardEvent.key` → action. `?` keeps its case: it only exists shifted. */
export const ACTION_BY_KEY: ReadonlyMap<string, ActionId> = new Map(
  ACTIONS.filter((a) => a.key !== undefined).map((a) => [a.key as string, a.id]),
);
