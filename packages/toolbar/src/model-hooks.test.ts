import { expect, test } from "bun:test";
import type { ModelAnchor, Pin } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import type { PinboxToolbarElement } from "./element.ts";
import { toggleToolbarCapture } from "./model-capture.ts";
import { attachModelViewer } from "./model-ui.ts";
import { createStore } from "./state.ts";

const anchor: ModelAnchor = {
  modelId: "box",
  revision: "v1",
  partId: "knob",
  position: [1, 2, 3],
  units: "mm",
};
const pin = { id: "pin_a", target: { model: anchor } } as Pin;
function setup() {
  const win = new Window({ url: "https://example.com" }),
    doc = win.document;
  const surface = doc.createElement("canvas") as unknown as HTMLElement;
  const toolbar = doc.createElement("div") as unknown as PinboxToolbarElement;
  Object.defineProperty(toolbar, "store", { value: createStore() });
  doc.body.append(surface as never, toolbar as never);
  return { win, surface, toolbar };
}
test("hover follows frame picking and clears on leave, mode exit and destroy", () => {
  const { win, surface, toolbar } = setup();
  let hit: ModelAnchor | null = anchor;
  const seen: (ModelAnchor | null)[] = [];
  const ui = attachModelViewer(toolbar, {
    surface,
    pick: () => hit,
    project: () => null,
    onHover: (a) => seen.push(a),
  });
  surface.dispatchEvent(
    new win.PointerEvent("pointermove", {
      bubbles: true,
      clientX: 10,
      clientY: 20,
    }) as unknown as Event,
  );
  ui.update();
  expect(seen).toEqual([]);
  toolbar.store.update({ mode: "placing" });
  ui.update();
  expect(seen.at(-1)).toBe(anchor);
  hit = null;
  ui.update();
  expect(seen.at(-1)).toBeNull();
  hit = anchor;
  ui.update();
  toolbar.store.update({ mode: "idle" });
  expect(seen.at(-1)).toBeNull();
  toolbar.store.update({ mode: "placing" });
  ui.update();
  surface.dispatchEvent(new win.PointerEvent("pointerleave") as unknown as Event);
  expect(seen.at(-1)).toBeNull();
  ui.destroy();
  const count = seen.length;
  ui.update();
  expect(seen.length).toBe(count);
  win.happyDOM.abort();
});
test("activation handles sidebar opens, repeated opens, filtered models and cancellation", async () => {
  const { win, surface, toolbar } = setup();
  const signals: AbortSignal[] = [];
  const ui = attachModelViewer(toolbar, {
    surface,
    pick: () => anchor,
    project: () => null,
    acceptsAnchor: (a) => a.modelId === "box",
    onActivate: (_a, _p, { signal }) => {
      signals.push(signal);
    },
  });
  toolbar.store.update({ pins: [pin] });
  await ui.openPin(pin.id);
  expect(signals.length).toBe(1);
  ui.update();
  expect(signals.length).toBe(1);
  await ui.openPin(pin.id);
  expect(signals.length).toBe(2);
  expect(signals[0]?.aborted).toBe(true);
  toolbar.store.update({ activePinId: null });
  expect(signals[1]?.aborted).toBe(true);
  toolbar.store.update({
    pins: [{ ...pin, target: { model: { ...anchor, modelId: "other" } } }],
    activePinId: pin.id,
  });
  expect(signals.length).toBe(2);
  ui.destroy();
  win.happyDOM.abort();
});
test("model camera ownership, duplicate suppression, errors and 2D fallback", async () => {
  const { win, surface, toolbar } = setup();
  let first = 0,
    second = 0,
    failures = 0,
    release = 0;
  let finish: (() => void) | undefined;
  const a = attachModelViewer(toolbar, {
    surface,
    pick: () => anchor,
    project: () => null,
    onCapture: () => {
      first++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  const other = win.document.createElement("canvas");
  win.document.body.append(other);
  const b = attachModelViewer(toolbar, {
    surface: other as unknown as HTMLElement,
    pick: () => anchor,
    project: () => null,
    onCapture: () => {
      second++;
      throw new Error("capture failed");
    },
    onError: () => {
      failures++;
    },
  });
  const capture = () =>
    toggleToolbarCapture(toolbar, "test", () => {
      release++;
    });
  capture();
  capture();
  expect(first).toBe(1);
  expect(toolbar.store.get().captureMode).toBe("dom");
  finish?.();
  await Promise.resolve();
  await Promise.resolve();
  other.dispatchEvent(new win.PointerEvent("pointermove", { bubbles: true }));
  capture();
  expect(second).toBe(1);
  expect(failures).toBe(1);
  b.destroy();
  a.destroy();
  expect(toolbar.store.get().captureLabel).toBeUndefined();
  capture();
  expect(toolbar.store.get().captureMode).toBe("tab");
  capture();
  expect(release).toBe(1);
  win.happyDOM.abort();
});
