// keys.ts — the shortcut rules, against a happy-dom realm so composedPath and
// contentEditable behave. `new Window()` per file, never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { IGNORE_KEYS_ATTR, isTextEntry, shortcutFor } from "./keys.ts";
import { ACTIONS } from "./ui/actions.ts";

const realm = new Window();
const win = realm as unknown as EventTarget;
const doc = realm.document as unknown as Document;
const KE = realm.KeyboardEvent as unknown as typeof KeyboardEvent;

function key(
  k: string,
  init: Partial<KeyboardEventInit> & { target?: Element; composing?: boolean } = {},
): KeyboardEvent {
  const target = init.target ?? doc.body;
  const { target: _t, composing: _c, ...rest } = init;
  const e = new KE("keydown", { key: k, bubbles: true, composed: true, ...rest });
  if (init.composing) Object.defineProperty(e, "isComposing", { value: true });
  let seen: KeyboardEvent | null = null;
  const capture = (ev: Event): void => {
    seen = ev as KeyboardEvent;
    ev.stopPropagation();
  };
  win.addEventListener("keydown", capture, true);
  target.dispatchEvent(e);
  win.removeEventListener("keydown", capture, true);
  return seen ?? e;
}

describe("shortcutFor", () => {
  test("every keyed action in the table dispatches", () => {
    for (const a of ACTIONS) {
      if (a.key === undefined) continue;
      const k = a.key === "escape" ? "Escape" : a.key === "?" ? "?" : a.key.toUpperCase();
      expect(shortcutFor(key(k))).toBe(a.id);
    }
  });

  test("modifier chords belong to the host: ⌘P never arms placing", () => {
    expect(shortcutFor(key("p", { metaKey: true }))).toBeNull();
    expect(shortcutFor(key("i", { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key("d", { altKey: true }))).toBeNull();
    // Shift is fine — `?` only exists shifted.
    expect(shortcutFor(key("?", { shiftKey: true }))).toBe("help");
  });

  test("a held key acts once: repeats are ignored", () => {
    expect(shortcutFor(key("h", { repeat: true }))).toBeNull();
  });

  test("IME composition is left alone", () => {
    expect(shortcutFor(key("p", { composing: true }))).toBeNull();
  });

  test("unknown keys return null", () => {
    expect(shortcutFor(key("x"))).toBeNull();
    expect(shortcutFor(key("Enter"))).toBeNull();
  });

  test("escape-only keeps Esc and drops the letters; off drops everything", () => {
    expect(shortcutFor(key("Escape"), "escape-only")).toBe("escape");
    expect(shortcutFor(key("p"), "escape-only")).toBeNull();
    expect(shortcutFor(key("Escape"), "off")).toBeNull();
  });

  test("keys typed into a text control are the control's", () => {
    const ta = doc.createElement("textarea");
    doc.body.appendChild(ta);
    expect(shortcutFor(key("p", { target: ta }))).toBeNull();
    ta.remove();
  });
});

describe("isTextEntry", () => {
  test("covers select, ARIA text roles and the opt-out attribute, not plain divs", () => {
    const sel = doc.createElement("select");
    const box = doc.createElement("div");
    box.setAttribute("role", "textbox");
    const boxChild = doc.createElement("span");
    box.appendChild(boxChild);
    const editor = doc.createElement("div");
    editor.setAttribute(IGNORE_KEYS_ATTR, "");
    const inner = doc.createElement("span");
    editor.appendChild(inner);
    doc.body.append(sel, box, editor);
    expect(isTextEntry(sel)).toBe(true);
    expect(isTextEntry(box)).toBe(true);
    expect(isTextEntry(boxChild)).toBe(true); // nested in the role holder
    expect(isTextEntry(inner)).toBe(true);
    expect(isTextEntry(doc.createElement("div"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    sel.remove();
    box.remove();
    editor.remove();
  });
});
