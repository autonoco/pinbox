// ui/bar-drag.ts — the movable command bar: drag, persist, clamp, reset.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { memoryStorage } from "../transport/mirror.ts";
import { createBar } from "./bar.ts";
import { createBarDrag } from "./bar-drag.ts";

function rig(storage = memoryStorage()) {
  const happy = new HappyWindow({ width: 1400, height: 900 });
  const win = happy as unknown as Window;
  const doc = happy.document as unknown as Document;
  const bar = createBar(doc, { onAction: () => {} });
  doc.body.appendChild(bar.root);
  const drag = createBarDrag({
    win,
    bar: bar.root,
    grip: bar.grip,
    storage,
    storagePrefix: "pinbox:t",
  });
  const pointer = (type: string, x: number, y: number): void => {
    const Ctor = (happy as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    bar.grip.dispatchEvent(
      new Ctor(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  };
  return { win, bar, drag, storage, pointer };
}

describe("movable bar", () => {
  test("dragging the grip frees the bar, clamps inside the viewport and persists", () => {
    const r = rig();
    expect(r.bar.root.classList.contains("free")).toBe(false);
    // happy-dom rects are zero-sized: the bar's origin reads (0,0) and clamps to the margin.
    r.pointer("pointerdown", 100, 100);
    r.pointer("pointermove", 300, 250);
    r.pointer("pointerup", 300, 250);
    expect(r.bar.root.classList.contains("free")).toBe(true);
    expect(r.bar.root.style.left).toBe("200px");
    expect(r.bar.root.style.top).toBe("150px");
    expect(r.drag.position()).toEqual({ x: 200, y: 150 });
    expect(JSON.parse(r.storage.getItem("pinbox:t:bar") ?? "{}")).toEqual({ x: 200, y: 150 });
    // Far off-screen release clamps to the 16px margin.
    r.pointer("pointerdown", 100, 100);
    r.pointer("pointermove", -900, -900);
    r.pointer("pointerup", -900, -900);
    expect(r.bar.root.style.left).toBe("16px");
    expect(r.bar.root.style.top).toBe("16px");
  });

  test("a tap-sized wobble snaps back; a persisted spot is applied on the next load", () => {
    const r = rig();
    r.pointer("pointerdown", 100, 100);
    r.pointer("pointermove", 107, 106); // started (≥8) but under the 12px tap ceiling
    r.pointer("pointerup", 107, 106);
    expect(r.bar.root.classList.contains("free")).toBe(false);
    expect(r.storage.getItem("pinbox:t:bar")).toBeNull();
    r.storage.setItem("pinbox:t:bar", JSON.stringify({ x: 5000, y: 40 }));
    const again = rig(r.storage);
    // Re-clamped on load: 1400 - 16 - 0 (zero-width bar) = 1384.
    expect(again.bar.root.style.left).toBe("1384px");
    expect(again.bar.root.style.top).toBe("40px");
  });

  test("double-clicking the grip resets to the default spot and forgets it; minimized bars do not drag", () => {
    const r = rig();
    r.pointer("pointerdown", 100, 100);
    r.pointer("pointermove", 300, 250);
    r.pointer("pointerup", 300, 250);
    r.bar.grip.dispatchEvent(
      new (r.win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("dblclick", {
        bubbles: true,
      }),
    );
    expect(r.bar.root.classList.contains("free")).toBe(false);
    expect(r.bar.root.style.left).toBe("");
    expect(r.storage.getItem("pinbox:t:bar")).toBeNull();
    r.bar.root.classList.add("pb-ghost");
    r.pointer("pointerdown", 100, 100);
    r.pointer("pointermove", 300, 250);
    r.pointer("pointerup", 300, 250);
    expect(r.bar.root.classList.contains("free")).toBe(false);
  });
});
