// @autono/pinbox-toolbar — keyed pin layer tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { BrowserPin } from "../capture.ts";
import { initialState, type ToolbarState } from "../state.ts";
import { renderPins } from "./pins.ts";

function layerIn(): HTMLElement {
  const window = new Window();
  const layer = window.document.createElement("div");
  window.document.body.appendChild(layer);
  return layer as unknown as HTMLElement;
}

function makePin(id: string, overrides: Partial<BrowserPin> = {}): BrowserPin {
  return {
    id,
    schemaVersion: 1,
    status: "open",
    createdAt: "2026-08-04T00:00:00.000Z",
    text: "note",
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

function stateWith(overrides: Partial<ToolbarState>): ToolbarState {
  return { ...initialState(), ...overrides };
}

describe("renderPins", () => {
  test("re-rendering the same pins mutates zero existing child nodes", () => {
    const layer = layerIn();
    const state = stateWith({ pins: [makePin("pin_aaaaaaaaaa"), makePin("pin_bbbbbbbbbb")] });
    renderPins(layer, state);
    expect(layer.children.length).toBe(2);
    const before = [...layer.children];
    const chipsBefore = before.map((n) => n.querySelector(".pb-chipBtn"));
    const chipHtmlBefore = chipsBefore.map((c) => c?.innerHTML);
    renderPins(layer, state);
    const after = [...layer.children];
    expect(after.length).toBe(2);
    for (let i = 0; i < before.length; i++) {
      expect(after[i]).toBe(before[i] as Element); // node identity — patched, never rebuilt
      expect(after[i]?.querySelector(".pb-chipBtn")).toBe(chipsBefore[i] as Element);
      expect(after[i]?.querySelector(".pb-chipBtn")?.innerHTML).toBe(chipHtmlBefore[i] as string);
    }
  });

  test("a resolved pin leaves the layer unless it is active", () => {
    const layer = layerIn();
    const open = makePin("pin_aaaaaaaaaa");
    const resolved = makePin("pin_bbbbbbbbbb", {
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T00:00:00.000Z" },
    });
    renderPins(layer, stateWith({ pins: [open, resolved] }));
    expect(layer.querySelector(`[data-pin="${open.id}"]`)).not.toBeNull();
    expect(layer.querySelector(`[data-pin="${resolved.id}"]`)).toBeNull();
    // active resolved pin stays visible
    renderPins(layer, stateWith({ pins: [open, resolved], activePinId: resolved.id }));
    expect(layer.querySelector(`[data-pin="${resolved.id}"]`)).not.toBeNull();
    // deactivate again — it leaves
    renderPins(layer, stateWith({ pins: [open, resolved] }));
    expect(layer.querySelector(`[data-pin="${resolved.id}"]`)).toBeNull();
  });

  test("a draft renders as a client-only pin node and discard removes it", () => {
    const layer = layerIn();
    const pin = makePin("pin_aaaaaaaaaa");
    const draft = {
      target: { target: pin.target, env: pin.env },
      placedAt: { x: 340, y: 160 },
    };
    renderPins(layer, stateWith({ pins: [pin], draft }));
    expect(layer.querySelector('[data-pin="draft"]')).not.toBeNull();
    renderPins(layer, stateWith({ pins: [pin], draft: null }));
    expect(layer.querySelector('[data-pin="draft"]')).toBeNull();
  });

  test("a queued pin is flagged until it leaves queuedIds", () => {
    const layer = layerIn();
    const pin = makePin("pin_localqueue");
    renderPins(layer, stateWith({ pins: [pin], queuedIds: new Set([pin.id]) }));
    const node = layer.querySelector(`[data-pin="${pin.id}"]`) as HTMLElement;
    expect(node.classList.contains("queued")).toBe(true);
    expect(node.querySelector(".pb-chipBtn")?.textContent).toContain("QUEUED");
    // reconnect flush replaces the queued set — the flag clears
    renderPins(layer, stateWith({ pins: [pin] }));
    expect(node.classList.contains("queued")).toBe(false);
    expect(node.querySelector(".pb-chipBtn")?.textContent).not.toContain("QUEUED");
  });

  test("chip carries the pin number and data-open id", () => {
    const layer = layerIn();
    const state = stateWith({ pins: [makePin("pin_aaaaaaaaaa"), makePin("pin_bbbbbbbbbb")] });
    renderPins(layer, state);
    const chip = layer
      .querySelector('[data-pin="pin_bbbbbbbbbb"]')
      ?.querySelector(".pb-chipBtn") as Element;
    expect(chip.getAttribute("data-open")).toBe("pin_bbbbbbbbbb");
    expect(chip.textContent).toContain("02");
  });
});
