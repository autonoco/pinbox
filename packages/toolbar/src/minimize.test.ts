// @autono/pinbox-toolbar — minimize controller tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
// All cases run reduced (instant swaps): the state machine, drag/tap
// discrimination, and persistence are what these tests pin down — the spring
// itself is covered in motion/spring.test.ts. The three named regression
// cases at the bottom each reproduce a real bug from the prototype.
import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createMinimize, type MinimizeHost } from "./minimize.ts";
import { memoryStorage, type StorageLike } from "./transport/mirror.ts";
import { createMinimizeUi, type MinimizeUi } from "./ui/puck.ts";

interface Harness {
  win: Window;
  bar: HTMLElement;
  ui: MinimizeUi;
  storage: StorageLike;
  settled: Array<{ minimized: boolean; keyboard: boolean }>;
  fanActions: string[];
  controller: ReturnType<typeof createMinimize>;
  pointer(type: string, x: number, y: number, button?: number): void;
}

function harness(overrides: Partial<MinimizeHost> = {}): Harness {
  const happy = new HappyWindow({ width: 1400, height: 900 });
  const win = happy as unknown as Window;
  const doc = happy.document as unknown as Document;
  const bar = doc.createElement("div");
  doc.body.appendChild(bar);
  const ui = createMinimizeUi(doc);
  doc.body.appendChild(ui.puck);
  doc.body.appendChild(ui.fan);
  doc.body.appendChild(ui.morphWrap);
  const storage = memoryStorage();
  const settled: Harness["settled"] = [];
  const fanActions: string[] = [];
  const controller = createMinimize({
    win,
    bar,
    ui,
    storage,
    storagePrefix: "pinbox:test",
    reduced: true,
    initialMinimized: false,
    onSettled: (minimized, keyboard) => settled.push({ minimized, keyboard }),
    onFanAction: (action) => fanActions.push(action),
    ...overrides,
  });
  const pointer = (type: string, x: number, y: number, button = 0): void => {
    const Ctor = (happy as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    ui.puck.dispatchEvent(
      new Ctor(type, { clientX: x, clientY: y, button, pointerId: 1, bubbles: true }),
    );
  };
  return { win, bar, ui, storage, settled, fanActions, controller, pointer };
}

describe("minimize/restore cycle", () => {
  test("minimize ghosts the bar, places the puck, persists, reports settle", () => {
    const h = harness();
    h.controller.minimize(false);
    expect(h.controller.mode()).toBe("puck");
    expect(h.bar.classList.contains("pb-ghost")).toBe(true);
    expect(h.ui.puck.classList.contains("pb-ghost")).toBe(false);
    expect(h.settled).toEqual([{ minimized: true, keyboard: false }]);
    expect(h.storage.getItem("pinbox:test:minimized")).toBe("1");
  });

  test("a clean tap opens the fan; EXPAND in the fan restores the bar", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 100, 100);
    h.pointer("pointerup", 101, 101);
    expect(h.controller.mode()).toBe("puck");
    expect(h.ui.fan.hidden).toBe(false);
    expect(h.ui.fan.classList.contains("on")).toBe(true);
    const expand = h.ui.fan.querySelector('[data-act="expand"]') as HTMLElement;
    expand.click();
    expect(h.controller.mode()).toBe("bar");
    expect(h.bar.classList.contains("pb-ghost")).toBe(false);
    expect(h.storage.getItem("pinbox:test:minimized")).toBe("0");
  });

  test("a second tap closes the fan without restoring", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 100, 100);
    h.pointer("pointerup", 100, 100);
    expect(h.ui.fan.classList.contains("on")).toBe(true);
    h.pointer("pointerdown", 100, 100);
    h.pointer("pointerup", 100, 100);
    expect(h.ui.fan.classList.contains("on")).toBe(false);
    expect(h.controller.mode()).toBe("puck");
  });

  test("fan actions delegate to the host without restoring", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 100, 100);
    h.pointer("pointerup", 100, 100);
    (h.ui.fan.querySelector('[data-act="pin"]') as HTMLElement).click();
    (h.ui.fan.querySelector('[data-act="inbox"]') as HTMLElement).click();
    expect(h.fanActions).toEqual(["pin", "inbox"]);
    expect(h.controller.mode()).toBe("puck");
  });

  test("minimize is a no-op unless the bar is resting", () => {
    const h = harness();
    h.controller.minimize(false);
    h.controller.minimize(false);
    expect(h.settled).toHaveLength(1);
  });
});

describe("drag", () => {
  test("a real drag stays minimized and lands where released (free placement)", () => {
    const h = harness();
    h.controller.minimize(false);
    // Open the fan first: starting a drag must close it.
    h.pointer("pointerdown", 200, 200);
    h.pointer("pointerup", 200, 200);
    expect(h.ui.fan.classList.contains("on")).toBe(true);
    // Default dock clamps to (16,16) — happy-dom's bar rect is zero-sized.
    h.pointer("pointerdown", 200, 200);
    h.pointer("pointermove", 250, 230);
    h.pointer("pointermove", 300, 250);
    h.pointer("pointerup", 300, 250);
    expect(h.controller.mode()).toBe("puck");
    expect(h.ui.fan.classList.contains("on")).toBe(false);
    expect(h.ui.puck.style.transform).toBe("translate(116px, 66px)");
    const dock = JSON.parse(h.storage.getItem("pinbox:test:dock") ?? "{}") as {
      x: number;
      y: number;
    };
    expect(dock).toEqual({ x: 116, y: 66 });
  });

  test("drags clamp inside the viewport margins", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 200, 200);
    h.pointer("pointermove", 4000, -4000);
    h.pointer("pointerup", 4000, -4000);
    // width 1400 - margin 16 - puck 48 = 1336; y clamps to the 16px margin.
    expect(h.ui.puck.style.transform).toBe("translate(1336px, 16px)");
  });
});

describe("persistence", () => {
  test("applyInitial restores a persisted minimized state and dock", () => {
    const first = harness();
    first.controller.minimize(false);
    first.pointer("pointerdown", 200, 200);
    first.pointer("pointermove", 300, 300);
    first.pointer("pointerup", 300, 300);
    // Same storage, fresh controller — a reload.
    const second = harness({ storage: first.storage });
    second.controller.applyInitial();
    expect(second.controller.mode()).toBe("puck");
    expect(second.ui.puck.style.transform).toBe("translate(116px, 116px)");
    expect(second.settled).toEqual([{ minimized: true, keyboard: false }]);
  });

  test("applyInitial without persisted state follows initialMinimized", () => {
    const off = harness();
    off.controller.applyInitial();
    expect(off.controller.mode()).toBe("bar");
    const on = harness({ initialMinimized: true });
    on.controller.applyInitial();
    expect(on.controller.mode()).toBe("puck");
  });
});

describe("prototype regressions", () => {
  test("a non-primary-button press never starts a drag (right-click wedge)", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 200, 200, 2);
    h.pointer("pointermove", 300, 300, 2);
    expect(h.controller.mode()).toBe("puck");
    // The stray hover-move after the OS ate the pointerup must not drag either.
    h.pointer("pointermove", 400, 400);
    expect(h.controller.mode()).toBe("puck");
  });

  test("a keyboard restore mid-hold clears the pending drag (hijack)", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 200, 200);
    h.controller.restore(true);
    expect(h.controller.mode()).toBe("bar");
    // The still-held pointer wandering must not start a drag on the ghosted puck.
    h.pointer("pointermove", 260, 260);
    h.pointer("pointerup", 260, 260);
    expect(h.controller.mode()).toBe("bar");
  });

  test("a sloppy trackpad tap (under 12px total) is a tap — fan, not a scoot", () => {
    const h = harness();
    h.controller.minimize(false);
    h.pointer("pointerdown", 200, 200);
    // 9px of travel: past the 8px drag-start, under the 12px tap ceiling.
    h.pointer("pointermove", 206, 206);
    h.pointer("pointermove", 207, 206);
    h.pointer("pointerup", 207, 206);
    expect(h.controller.mode()).toBe("puck");
    expect(h.ui.fan.classList.contains("on")).toBe(true);
    // …while 13px+ of travel is a real drag: no fan, puck moves.
    h.controller.closeFan();
    h.pointer("pointerdown", 200, 200);
    h.pointer("pointermove", 210, 210);
    h.pointer("pointerup", 210, 210);
    expect(h.controller.mode()).toBe("puck");
    expect(h.ui.fan.classList.contains("on")).toBe(false);
  });
});
