// @autono/pinbox-toolbar — element lifecycle tests: the late-config rescue.
//
// The element reads its config in connectedCallback. These tests pin the rescue
// contract for hosts that append FIRST and set attributes after (the order the
// dev-plugin snippet once used): the transport must start when the config first
// completes, exactly once, with the WHOLE config — a start at the first
// attribute fragment would connect token-less and drop the token forever.
//
// element.ts captures its base class from `globalThis.HTMLElement` at import
// (its SSR guard) and touches `document`/`window` at runtime, so a happy-dom
// realm is installed on globalThis BEFORE the dynamic import and restored in
// afterAll — the same technique build.test.ts uses for the IIFE bundle, held
// for the file's lifetime because the lifecycle under test runs against it.
// `new Window()` per file, never GlobalRegistrator (the file-header rule).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/** Inert WebSocket stand-in: records constructions, never connects, fires nothing. */
class RecordingSocket {
  static opened: Array<{ url: string; protocols: string[] }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string, protocols: string[] = []) {
    RecordingSocket.opened.push({ url, protocols });
  }
  send(): void {}
  close(): void {}
}

interface ToolbarInstance extends HTMLElement {
  actions: { send?: unknown };
  store: { get(): { connection: string } };
}

const win = new Window({ url: "http://127.0.0.1:5173/" });
// Lib-DOM view of the happy-dom realm, the snippet.test.ts casting convention:
// the tests speak standard DOM types; the realm underneath is happy-dom's.
const doc = win.document as unknown as Document;
const registry = win.customElements as unknown as CustomElementRegistry;
const GLOBALS: Record<string, unknown> = {
  HTMLElement: win.HTMLElement,
  document: win.document,
  window: win,
  customElements: win.customElements,
  WebSocket: RecordingSocket,
};
const prior = new Map<string, unknown>();

let create: () => ToolbarInstance;

beforeAll(async () => {
  for (const [name, value] of Object.entries(GLOBALS)) {
    prior.set(name, Reflect.get(globalThis, name));
    Reflect.set(globalThis, name, value);
  }
  const { PinboxToolbarElement } = await import("./element.ts");
  registry.define(
    PinboxToolbarElement.tagName,
    PinboxToolbarElement as unknown as CustomElementConstructor,
  );
  create = () => doc.createElement(PinboxToolbarElement.tagName) as unknown as ToolbarInstance;
});

afterAll(async () => {
  for (const name of prior.keys()) {
    const value = prior.get(name);
    if (value === undefined) Reflect.deleteProperty(globalThis, name);
    else Reflect.set(globalThis, name, value);
  }
  await win.happyDOM.close();
});

/** The rescue defers to end-of-tick; one macrotask hop is past every microtask. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("late-config rescue", () => {
  test("appended bare, the element stays unstarted — no config, no transport", async () => {
    RecordingSocket.opened = [];
    const el = create();
    doc.body.appendChild(el);
    await settle();
    expect(el.actions.send).toBeUndefined();
    expect(RecordingSocket.opened.length).toBe(0);
    el.remove();
  });

  test("attributes set after append start ONE transport carrying the full config", async () => {
    RecordingSocket.opened = [];
    const el = create();
    // The legacy order the snippet used: insert first, configure after. Both
    // attribute callbacks land in one tick; the deferred start must read the
    // finished config — hub-first must not connect token-less.
    doc.body.appendChild(el);
    el.setAttribute("hub", "http://127.0.0.1:4319");
    el.setAttribute("token", "tok_rescue");
    await settle();
    expect(typeof el.actions.send).toBe("function");
    expect(RecordingSocket.opened.length).toBe(1);
    expect(RecordingSocket.opened[0]?.protocols).toEqual(["pinbox.token.tok_rescue"]);
    el.remove();
  });

  test("attributes-before-append (the fixed snippet order) also starts exactly once", async () => {
    RecordingSocket.opened = [];
    const el = create();
    el.setAttribute("hub", "http://127.0.0.1:4319");
    el.setAttribute("token", "tok_upfront");
    doc.body.appendChild(el);
    await settle();
    expect(typeof el.actions.send).toBe("function");
    expect(RecordingSocket.opened.length).toBe(1);
    expect(RecordingSocket.opened[0]?.protocols).toEqual(["pinbox.token.tok_upfront"]);
    el.remove();
  });

  test("configure() after append rescues the programmatic path too", async () => {
    RecordingSocket.opened = [];
    const el = create();
    doc.body.appendChild(el);
    (el as unknown as { configure(c: { endpoint: string; token: string }): void }).configure({
      endpoint: "http://127.0.0.1:4319",
      token: "tok_cfg",
    });
    await settle();
    expect(typeof el.actions.send).toBe("function");
    expect(RecordingSocket.opened.length).toBe(1);
    el.remove();
  });

  test("a start spanning a remove does not connect a detached element", async () => {
    RecordingSocket.opened = [];
    const el = create();
    doc.body.appendChild(el);
    el.setAttribute("hub", "http://127.0.0.1:4319");
    el.setAttribute("token", "tok_gone");
    // Removed in the same tick: the deferred start's lifetime check must bail.
    el.remove();
    await settle();
    expect(el.actions.send).toBeUndefined();
    expect(RecordingSocket.opened.length).toBe(0);
  });
});
