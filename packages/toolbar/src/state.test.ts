// @autono/pinbox-toolbar — state store + status derivation tests.
import { describe, expect, test } from "bun:test";
import type { ThreadMessage } from "@autono/pinbox-core/schema";
import type { BrowserPin } from "./capture.ts";
import type { Draft } from "./state.ts";
import { applyHubEvent, createStore, deriveUiStatus } from "./state.ts";

function makePin(overrides: Partial<BrowserPin> = {}): BrowserPin {
  return {
    id: "pin_abcdefghij",
    schemaVersion: 1,
    status: "open",
    createdAt: "2026-08-04T00:00:00.000Z",
    text: "Break the headline onto two lines.",
    kind: "note",
    target: {
      url: "http://localhost:5173/",
      selector: "#hero > h1",
      tag: "h1",
      rect: { x: 40, y: 120, width: 600, height: 80 },
      fixed: false,
    },
    env: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      browser: "test",
      os: "test",
      colorScheme: "dark",
    },
    author: { userId: "u1" },
    ...overrides,
  };
}

function makeMessage(
  role: ThreadMessage["role"],
  overrides: Partial<ThreadMessage> = {},
): ThreadMessage {
  return {
    id: "msg_1",
    pinId: "pin_abcdefghij",
    role,
    text: "hello",
    at: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeDraft(): Draft {
  const pin = makePin();
  return { target: { target: pin.target, env: pin.env }, placedAt: { x: 340, y: 160 } };
}

describe("createStore", () => {
  test("notifies subscribers exactly once per update", () => {
    const store = createStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.update({ inboxOpen: true });
    expect(calls).toBe(1);
    expect(store.get().inboxOpen).toBe(true);
    store.update({ mode: "placing" });
    expect(calls).toBe(2);
    expect(store.get().mode).toBe("placing");
  });

  test("unsubscribe stops notifications", () => {
    const store = createStore();
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    off();
    store.update({ inboxOpen: true });
    expect(calls).toBe(0);
  });

  test("place() sets the draft and leaves placing mode", () => {
    const store = createStore();
    const draft = makeDraft();
    store.update({ mode: "placing" });
    store.place(draft);
    expect(store.get().draft).toBe(draft);
    expect(store.get().mode).toBe("idle");
  });

  test("place() unhides the pin layer — a fresh marker is never invisible", () => {
    const store = createStore();
    store.update({ pinsHidden: true });
    store.place(makeDraft());
    expect(store.get().pinsHidden).toBe(false);
  });

  test("discardDraft() clears the draft without touching pins", () => {
    const store = createStore();
    const pin = makePin();
    store.update({ pins: [pin] });
    store.place(makeDraft());
    store.discardDraft();
    expect(store.get().draft).toBeNull();
    expect(store.get().pins).toEqual([pin]);
  });

  test("commitDraft(pin) moves the draft into pins and activates it", () => {
    const store = createStore();
    const pin = makePin();
    store.place(makeDraft());
    store.commitDraft(pin);
    const state = store.get();
    expect(state.draft).toBeNull();
    expect(state.pins).toEqual([pin]);
    expect(state.activePinId).toBe(pin.id);
  });
});

describe("deriveUiStatus", () => {
  test("resolved without verification is 'verify'", () => {
    const pin = makePin({
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T00:00:00.000Z" },
    });
    expect(deriveUiStatus(pin, [makeMessage("human")])).toBe("verify");
  });

  test("resolved with verification is 'resolved'", () => {
    const pin = makePin({
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T00:00:00.000Z" },
      verification: { outcome: "accepted", at: "2026-08-04T00:01:00.000Z" },
    });
    expect(deriveUiStatus(pin, [makeMessage("human")])).toBe("resolved");
  });

  test("open with an empty thread or last-human message is 'waiting'", () => {
    const pin = makePin();
    expect(deriveUiStatus(pin, [])).toBe("waiting");
    expect(deriveUiStatus(pin, [makeMessage("agent"), makeMessage("human")])).toBe("waiting");
  });

  test("open with a last agent or mirror message is 'replied'", () => {
    const pin = makePin();
    expect(deriveUiStatus(pin, [makeMessage("human"), makeMessage("agent")])).toBe("replied");
    expect(deriveUiStatus(pin, [makeMessage("human"), makeMessage("mirror")])).toBe("replied");
  });
});

// Wire events mutate the store: payloads are the full post-mutation objects.
describe("applyHubEvent", () => {
  const at = "2026-08-04T00:00:00.000Z";

  test("pin.created upserts a new pin", () => {
    const store = createStore();
    const pin = makePin();
    applyHubEvent(store, { seq: 1, eventType: "pin.created", at, payload: pin });
    expect(store.get().pins).toEqual([pin]);
    applyHubEvent(store, { seq: 2, eventType: "pin.created", at, payload: pin });
    expect(store.get().pins).toHaveLength(1); // duplicate id replaces, never appends
  });

  test("pin.resolved and pin.verified replace the payload Pin", () => {
    const store = createStore();
    applyHubEvent(store, { seq: 1, eventType: "pin.created", at, payload: makePin() });
    const resolved = makePin({ status: "resolved", resolution: { by: "agent", at } });
    applyHubEvent(store, { seq: 2, eventType: "pin.resolved", at, payload: resolved });
    expect(store.get().pins).toEqual([resolved]);
    const verified = makePin({
      status: "resolved",
      resolution: { by: "agent", at },
      verification: { outcome: "accepted", at },
    });
    applyHubEvent(store, { seq: 3, eventType: "pin.verified", at, payload: verified });
    expect(store.get().pins).toEqual([verified]);
  });

  test("thread.message appends to the pin's thread, deduping by id", () => {
    const store = createStore();
    const msg = makeMessage("agent");
    applyHubEvent(store, { seq: 1, eventType: "thread.message", at, payload: msg });
    applyHubEvent(store, { seq: 2, eventType: "thread.message", at, payload: msg });
    expect(store.get().threads.get(msg.pinId)).toEqual([msg]);
  });
});
