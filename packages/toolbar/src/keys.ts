// @autono/pinbox-toolbar — keyboard shortcut dispatch.
// Pure: a KeyboardEvent goes in, an ActionId (or null) comes out. The element
// owns the listener and runs the action. Dogfood: "shortcuts unreliable". The
// old dispatcher was a bubble-phase document listener keyed on `e.key` alone:
// host hotkeys swallowed it on some pages, ⌘P armed placing while opening the
// print dialog, a held H toggled hide on every key repeat. The rules here are
// the fix; the element listens in the capture phase on window so it sees the
// event first, and stops it only when an action actually ran.
import { ACTION_BY_KEY, type ActionId } from "./ui/actions.ts";

/**
 * "all": every shortcut. "escape-only": Esc still dismisses, letters are the
 * host's. "off": the toolbar never looks at the keyboard. For hosts whose own
 * hotkeys collide.
 */
export type ShortcutsMode = "all" | "escape-only" | "off";

/** Hosts mark a subtree the toolbar must ignore keys from (custom editors, games). */
export const IGNORE_KEYS_ATTR = "data-pinbox-ignore-keys";

const TEXT_TAGS = new Set(["TEXTAREA", "INPUT", "SELECT"]);
const TEXT_ROLES = ["textbox", "combobox", "searchbox", "spinbutton"];
const TEXT_ROLE_SELECTOR = TEXT_ROLES.map((r) => `[role="${r}"]`).join(",");

/**
 * Is the key going into a text control? `INPUT`/`TEXTAREA`/contentEditable, plus
 * the things the old check missed: `<select>`, ARIA text roles on custom editors,
 * and any ancestor flagged with `data-pinbox-ignore-keys`.
 */
export function isTextEntry(target: EventTarget | undefined | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | undefined | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (TEXT_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable === true) return true;
  // Ancestors too: the focused node inside a role="textbox" editor is rarely the role holder.
  if (el.closest?.(TEXT_ROLE_SELECTOR) != null) return true;
  return el.closest?.(`[${IGNORE_KEYS_ATTR}]`) != null;
}

/**
 * Which action, if any, a keydown asks for.
 *
 * Modifier chords are never ours (⌘P is print, ⌃I is italics, ⌥ types
 * characters); Shift is allowed because `?` needs it. Repeats and IME
 * composition are ignored so a held key acts once and a composing keyboard is
 * left alone.
 */
export function shortcutFor(e: KeyboardEvent, mode: ShortcutsMode = "all"): ActionId | null {
  if (mode === "off") return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return null;
  if (isTextEntry(e.composedPath()[0] ?? e.target)) return null;
  const key = e.key === "?" ? "?" : e.key.toLowerCase();
  const id = ACTION_BY_KEY.get(key);
  if (id === undefined) return null;
  if (mode === "escape-only" && id !== "escape") return null;
  return id;
}
