// @autono/pinbox-toolbar — thread card tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, mock, test } from "bun:test";
import type { ThreadMessage } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import type { BrowserPin } from "../capture.ts";
import { initialState, type ToolbarState } from "../state.ts";
import { type CardActions, renderCard } from "./card.ts";

function shadowIn(): ShadowRoot {
  const window = new Window();
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  return host.attachShadow({ mode: "open" }) as unknown as ShadowRoot;
}

function makePin(id: string, overrides: Partial<BrowserPin> = {}): BrowserPin {
  return {
    id,
    schemaVersion: 1,
    status: "open",
    createdAt: "2026-08-04T00:00:00.000Z",
    text: "Break the headline onto two lines.",
    kind: "note",
    target: {
      url: "http://localhost:5173/",
      selector: "#hero",
      tag: "div",
      rect: { x: 100, y: 200, width: 50, height: 20 },
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

function makeMsg(
  id: string,
  pinId: string,
  role: ThreadMessage["role"],
  text: string,
): ThreadMessage {
  return { id, pinId, role, text, at: "2026-08-04T10:00:00.000Z" };
}

function stateWith(overrides: Partial<ToolbarState>): ToolbarState {
  return { ...initialState(), ...overrides };
}

function spyActions(): CardActions & {
  send: ReturnType<typeof mock>;
  verify: ReturnType<typeof mock>;
  resolve: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
} {
  return { send: mock(), verify: mock(), resolve: mock(), close: mock() };
}

const RESOLUTION = { by: "agent", at: "2026-08-04T11:00:00.000Z" } as const;
const VERIFICATION = { outcome: "accepted", at: "2026-08-04T12:00:00.000Z" } as const;

describe("renderCard thread patching", () => {
  test("appending a message keeps existing [data-iid] nodes identical", () => {
    const shadow = shadowIn();
    const pin = makePin("pin_aaaaaaaaaa");
    const thread = [
      makeMsg("msg_1111111111", pin.id, "human", "first"),
      makeMsg("msg_2222222222", pin.id, "agent", "second"),
    ];
    const threads = new Map([[pin.id, thread]]);
    const state = stateWith({ pins: [pin], activePinId: pin.id, threads });
    renderCard(shadow, state, spyActions());
    const before = [...shadow.querySelectorAll("[data-iid]")];
    // The pin's own text leads the thread, so a two-message thread draws three nodes.
    expect(before.map((n) => n.getAttribute("data-iid"))).toEqual([
      `pin:${pin.id}`,
      "msg_1111111111",
      "msg_2222222222",
    ]);
    thread.push(makeMsg("msg_3333333333", pin.id, "mirror", "third"));
    renderCard(shadow, state, spyActions());
    const after = [...shadow.querySelectorAll("[data-iid]")];
    expect(after.length).toBe(4);
    expect(after[0]).toBe(before[0] as Element); // node identity — patched, never rebuilt
    expect(after[1]).toBe(before[1] as Element);
    expect(after[2]).toBe(before[2] as Element);
    expect(after[3]?.getAttribute("data-iid")).toBe("msg_3333333333");
  });
});

describe("renderCard verify footer", () => {
  test("renders exactly when the pin is resolved and unverified", () => {
    const shadow = shadowIn();
    const pin = makePin("pin_aaaaaaaaaa", { status: "resolved", resolution: RESOLUTION });
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id }), spyActions());
    expect(shadow.querySelector('[data-action="verify-accept"]')).not.toBeNull();
    expect(shadow.querySelector('[data-action="verify-reopen"]')).not.toBeNull();
  });

  test("absent once the pin carries a verification", () => {
    const shadow = shadowIn();
    const pin = makePin("pin_aaaaaaaaaa", {
      status: "resolved",
      resolution: RESOLUTION,
      verification: VERIFICATION,
    });
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id }), spyActions());
    expect(shadow.querySelector('[data-action="verify-accept"]')).toBeNull();
  });

  test("absent for an open pin", () => {
    const shadow = shadowIn();
    const pin = makePin("pin_aaaaaaaaaa");
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id }), spyActions());
    expect(shadow.querySelector('[data-action="verify-accept"]')).toBeNull();
  });
});

describe("renderCard actions", () => {
  test("resolve and close fire with the active pin id", () => {
    const shadow = shadowIn();
    const actions = spyActions();
    const pin = makePin("pin_aaaaaaaaaa");
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id }), actions);
    (shadow.querySelector('[data-action="resolve"]') as HTMLElement).click();
    expect(actions.resolve).toHaveBeenCalledWith(pin.id);
    (shadow.querySelector('[data-action="close"]') as HTMLElement).click();
    expect(actions.close).toHaveBeenCalled();
  });

  test("verify buttons fire with the right outcome", () => {
    const shadow = shadowIn();
    const actions = spyActions();
    const pin = makePin("pin_aaaaaaaaaa", { status: "resolved", resolution: RESOLUTION });
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id }), actions);
    (shadow.querySelector('[data-action="verify-accept"]') as HTMLElement).click();
    expect(actions.verify).toHaveBeenCalledWith(pin.id, "accepted");
    (shadow.querySelector('[data-action="verify-reopen"]') as HTMLElement).click();
    expect(actions.verify).toHaveBeenCalledWith(pin.id, "reopened");
  });

  test("reply send fires with the pin id and clears the composer", () => {
    const shadow = shadowIn();
    const actions = spyActions();
    const pin = makePin("pin_aaaaaaaaaa");
    const threads = new Map([[pin.id, [makeMsg("msg_1111111111", pin.id, "human", "hi")]]]);
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id, threads }), actions);
    const send = shadow.querySelector('[data-action="send"]') as HTMLElement;
    expect(send.textContent).toBe("Reply");
    const ta = shadow.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "tighter please";
    send.click();
    expect(actions.send).toHaveBeenCalledWith(pin.id, "tighter please");
    expect(ta.value).toBe("");
  });
});

describe("renderCard queued pin", () => {
  test("a queued pin's header shows QUEUED and hides resolve until the sync lands", () => {
    const shadow = shadowIn();
    const pin = makePin("pin_localqueue");
    const queuedState = stateWith({
      pins: [pin],
      activePinId: pin.id,
      queuedIds: new Set([pin.id]),
    });
    renderCard(shadow, queuedState, spyActions());
    expect(shadow.querySelector(".pb-hd .st")?.textContent).toBe("QUEUED");
    expect(shadow.querySelector('[data-action="resolve"]')).toBeNull(); // hub doesn't know it yet
    // flush replaces the queued set — the normal status returns
    renderCard(shadow, stateWith({ pins: [pin], activePinId: pin.id }), spyActions());
    expect(shadow.querySelector(".pb-hd .st")?.textContent).toBe("OPEN");
    expect(shadow.querySelector('[data-action="resolve"]')).not.toBeNull();
  });
});

describe("renderCard draft card", () => {
  test('shows Comment and sends send("draft", …)', () => {
    const shadow = shadowIn();
    const actions = spyActions();
    const pin = makePin("pin_aaaaaaaaaa");
    const draft = { target: { target: pin.target, env: pin.env }, placedAt: { x: 340, y: 160 } };
    renderCard(shadow, stateWith({ draft }), actions);
    const send = shadow.querySelector('[data-action="send"]') as HTMLElement;
    expect(send.textContent).toBe("Comment");
    const ta = shadow.querySelector("textarea") as HTMLTextAreaElement;
    ta.value = "What should change here?";
    send.click();
    expect(actions.send).toHaveBeenCalledWith("draft", "What should change here?");
    // empty text never sends
    send.click();
    expect(actions.send).toHaveBeenCalledTimes(1);
  });
});

describe("renderCard typing indicator", () => {
  test("shows while the agent owes a reply, and clears once it answers", () => {
    const shadow = shadowIn();
    const pin = makePin("pin_aaaaaaaaaa");
    const thread = [makeMsg("msg_1111111111", pin.id, "human", "first")];
    const threads = new Map([[pin.id, thread]]);
    const state = stateWith({ pins: [pin], activePinId: pin.id, threads });
    renderCard(shadow, state, spyActions());
    expect(shadow.querySelector('[data-iid="pb-typing"]')).not.toBeNull();

    thread.push(makeMsg("msg_2222222222", pin.id, "agent", "second"));
    renderCard(shadow, state, spyActions());
    expect(shadow.querySelector('[data-iid="pb-typing"]')).toBeNull();
  });
});
