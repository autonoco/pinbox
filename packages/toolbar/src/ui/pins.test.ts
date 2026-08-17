// @autono/pinbox-toolbar — keyed pin layer tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import type { Pin } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import type { BrowserPin } from "../capture.ts";
import { initialState, type ToolbarState } from "../state.ts";
import { renderPins } from "./pins.ts";

// The window carries makePin's URL and a live `#hero` so the default fixtures
// pass the anchor gate; happy-dom rects have no layout (all zeros), so
// placement falls back to the stored rect unless a test fakes the live rect.
function layerIn(): HTMLElement {
  const window = new Window({ url: "http://localhost:5173/" });
  const hero = window.document.createElement("div");
  hero.id = "hero";
  window.document.body.appendChild(hero);
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

describe("anchor gating (dogfood #26: pins lingered over unrelated SPA views)", () => {
  test("a pin captured on another view draws no marker; ordinals keep counting", () => {
    const layer = layerIn();
    const base = makePin("pin_aaaaaaaaaa").target;
    const away = makePin("pin_othertabxx", {
      target: { ...base, url: "http://localhost:5173/?tab=review" },
    });
    const here = makePin("pin_thistabxxx");
    renderPins(layer, stateWith({ pins: [away, here] }));
    expect(layer.querySelector('[data-pin="pin_othertabxx"]')).toBeNull();
    const chip = layer.querySelector('[data-pin="pin_thistabxxx"] .pb-chipBtn');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("02"); // undrawn ≠ unnumbered
  });

  test("hash-only and origin-only URL differences do not gate", () => {
    const layer = layerIn();
    const base = makePin("pin_aaaaaaaaaa").target;
    const hash = makePin("pin_hashonlyxx", {
      target: { ...base, url: "http://localhost:5173/#section" },
    });
    const origin = makePin("pin_originonly", {
      target: { ...base, url: "https://larkhelps.dev/" },
    });
    renderPins(layer, stateWith({ pins: [hash, origin] }));
    expect(layer.querySelector('[data-pin="pin_hashonlyxx"]')).not.toBeNull();
    expect(layer.querySelector('[data-pin="pin_originonly"]')).not.toBeNull();
  });

  test("a pin whose selector no longer resolves draws no marker — until it returns", () => {
    const layer = layerIn();
    const base = makePin("pin_aaaaaaaaaa").target;
    const ghost = makePin("pin_ghostxxxxx", { target: { ...base, selector: "#gone" } });
    renderPins(layer, stateWith({ pins: [ghost] }));
    expect(layer.children.length).toBe(0);
    const doc = layer.ownerDocument;
    const el = doc.createElement("div");
    el.id = "gone";
    doc.body.appendChild(el);
    renderPins(layer, stateWith({ pins: [ghost] }));
    expect(layer.querySelector('[data-pin="pin_ghostxxxxx"]')).not.toBeNull();
  });

  test("a resolving selector with layout snaps the marker to the LIVE rect", () => {
    const layer = layerIn();
    const hero = layer.ownerDocument.querySelector("#hero") as HTMLElement;
    hero.getBoundingClientRect = () =>
      ({
        x: 300,
        y: 500,
        left: 300,
        top: 500,
        right: 340,
        bottom: 520,
        width: 40,
        height: 20,
      }) as DOMRect;
    renderPins(layer, stateWith({ pins: [makePin("pin_livesnapxx")] }));
    const node = layer.querySelector('[data-pin="pin_livesnapxx"]') as HTMLElement;
    expect(node.style.left).toBe("320px"); // live centre — not the stored rect's 125
    expect(node.style.top).toBe("510px");
  });

  test("a pin with no selector keeps its stored rect, as before", () => {
    const layer = layerIn();
    // BrowserPin captures always carry a selector; a hub Pin need not — build one.
    const { selector: _dropped, ...noSelector } = makePin("pin_aaaaaaaaaa").target;
    const pin: Pin = { ...makePin("pin_noselector"), target: noSelector };
    renderPins(layer, stateWith({ pins: [pin] }));
    const node = layer.querySelector('[data-pin="pin_noselector"]') as HTMLElement;
    expect(node.style.left).toBe("125px"); // stored-rect centre
  });
});

test("pinsHidden hides the layer whole; unhiding restores the same nodes", () => {
  const layer = layerIn();
  const state = stateWith({ pins: [makePin("pin_aaaaaaaaaa")] });
  renderPins(layer, state);
  const node = layer.querySelector('[data-pin="pin_aaaaaaaaaa"]');
  renderPins(layer, { ...state, pinsHidden: true });
  expect(layer.hidden).toBe(true);
  renderPins(layer, state);
  expect(layer.hidden).toBe(false);
  expect(layer.querySelector('[data-pin="pin_aaaaaaaaaa"]')).toBe(node as Element);
});

test("a pin lands on the point that was clicked, not the middle of the element", () => {
  const layer = layerIn();
  const rect = { x: 100, y: 200, width: 400, height: 40 };
  const base = makePin("pin_aaaaaaaaaa").target;
  const centred = makePin("pin_aaaaaaaaaa", { target: { ...base, rect } });
  const clicked = makePin("pin_bbbbbbbbbb", {
    target: { ...base, rect, spot: { x: 0.1, y: 0.5 } },
  });
  renderPins(layer, { ...initialState(), pins: [centred, clicked] } as ToolbarState);
  const nodes = [...layer.children] as HTMLElement[];
  expect(nodes[0]?.style.left).toBe("300px"); // no spot ⇒ centre, unchanged
  expect(nodes[1]?.style.left).toBe("140px"); // 10% across, where the click was
});
