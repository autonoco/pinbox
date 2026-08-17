// @autono/pinbox-toolbar — minimized-state UI tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import type { Pin } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import { initialState, type ToolbarState } from "../state.ts";
import { createMinimizeUi } from "./puck.ts";

function ui() {
  const window = new Window();
  return createMinimizeUi(window.document as unknown as Document);
}

function stateWith(overrides: Partial<ToolbarState>): ToolbarState {
  return { ...initialState(), ...overrides };
}

const pin = (id: string, status: "open" | "resolved"): Pin => ({ id, status }) as unknown as Pin;

describe("createMinimizeUi", () => {
  test("badge shows the open-pin count on puck and carrier, hidden at zero", () => {
    const u = ui();
    u.update(stateWith({ pins: [pin("a", "open"), pin("b", "resolved"), pin("c", "open")] }));
    const puckBadge = u.puck.querySelector('[data-ref="count"]') as HTMLElement;
    const carrierBadge = u.carrier.querySelector('[data-ref="count"]') as HTMLElement;
    expect(puckBadge.textContent).toBe("2");
    expect(carrierBadge.textContent).toBe("2");
    expect(puckBadge.hidden).toBe(false);

    u.update(stateWith({ pins: [pin("b", "resolved")] }));
    expect(puckBadge.textContent).toBe("0");
    expect(puckBadge.hidden).toBe(true);
    expect(carrierBadge.hidden).toBe(true);
  });

  test("degraded connection shows the amber dot; live hides it", () => {
    const u = ui();
    u.update(stateWith({ connection: "offline" }));
    expect(u.puck.classList.contains("degraded")).toBe(true);
    u.update(stateWith({ connection: "incompatible" }));
    expect(u.puck.classList.contains("degraded")).toBe(true);
    u.update(stateWith({ connection: "live" }));
    expect(u.puck.classList.contains("degraded")).toBe(false);
  });

  test("starts ghosted with the morph layer hidden", () => {
    const u = ui();
    expect(u.puck.classList.contains("pb-ghost")).toBe(true);
    expect(u.morphWrap.hidden).toBe(true);
  });
});
