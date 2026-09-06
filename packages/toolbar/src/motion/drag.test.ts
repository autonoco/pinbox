// motion/drag.ts — the shared drag/tap rules, driven with synthetic pointer events.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { attachDrag, clampToViewport, type DragHandlers } from "./drag.ts";

function rig(overrides: Partial<DragHandlers> = {}) {
  const happy = new HappyWindow({ width: 1000, height: 800 });
  const doc = happy.document as unknown as Document;
  const el = doc.createElement("div");
  doc.body.appendChild(el);
  const log: string[] = [];
  let canStart = true;
  const drag = attachDrag(el, {
    origin: () => ({ x: 100, y: 100 }),
    canStart: () => canStart,
    onStart: (o) => log.push(`start ${o.x},${o.y}`),
    onMove: (p) => log.push(`move ${p.x},${p.y}`),
    onEnd: (r) =>
      log.push(`end dragged=${r.dragged} started=${r.started} ${r.target.x},${r.target.y}`),
    ...overrides,
  });
  const pointer = (type: string, x: number, y: number, button = 0): void => {
    const Ctor = (happy as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    el.dispatchEvent(
      new Ctor(type, { clientX: x, clientY: y, button, pointerId: 1, bubbles: true }),
    );
  };
  return { drag, log, pointer, setCanStart: (v: boolean) => (canStart = v) };
}

describe("attachDrag", () => {
  test("a real drag: start after 8px, moves as origin+delta, ends dragged", () => {
    const r = rig();
    r.pointer("pointerdown", 10, 10);
    r.pointer("pointermove", 13, 13); // under the threshold: nothing yet
    r.pointer("pointermove", 30, 20);
    r.pointer("pointerup", 30, 20);
    expect(r.log).toEqual([
      "start 100,100",
      "move 120,110",
      "end dragged=true started=true 120,110",
    ]);
  });

  test("a sloppy tap under 12px total is not a drag, even if it started", () => {
    const r = rig();
    r.pointer("pointerdown", 10, 10);
    r.pointer("pointermove", 16, 16); // 8.5px: started
    r.pointer("pointermove", 17, 16);
    r.pointer("pointerup", 17, 16); // 9.2px total
    expect(r.log.at(-1)).toBe("end dragged=false started=true 107,106");
  });

  test("a clean click ends as an un-started tap", () => {
    const r = rig();
    r.pointer("pointerdown", 10, 10);
    r.pointer("pointerup", 10, 10);
    expect(r.log).toEqual(["end dragged=false started=false 100,100"]);
  });

  test("non-primary buttons never start; canStart flipping mid-hold abandons it", () => {
    const r = rig();
    r.pointer("pointerdown", 10, 10, 2);
    r.pointer("pointermove", 200, 200, 2);
    r.pointer("pointerup", 200, 200, 2);
    expect(r.log).toEqual([]);
    r.pointer("pointerdown", 10, 10);
    r.setCanStart(false);
    r.pointer("pointermove", 200, 200);
    r.pointer("pointerup", 200, 200);
    expect(r.log).toEqual([]);
  });

  test("cancel() drops a pending hold; destroy() stops listening", () => {
    const r = rig();
    r.pointer("pointerdown", 10, 10);
    r.drag.cancel();
    r.pointer("pointermove", 200, 200);
    r.pointer("pointerup", 200, 200);
    expect(r.log).toEqual([]);
    r.drag.destroy();
    r.pointer("pointerdown", 10, 10);
    r.pointer("pointerup", 10, 10);
    expect(r.log).toEqual([]);
  });
});

describe("release without capture", () => {
  test("a pointerup that lands on the document, not the element, still ends the drag", () => {
    const happy = new HappyWindow({ width: 1000, height: 800 });
    const doc = happy.document as unknown as Document;
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const log: string[] = [];
    attachDrag(el, {
      origin: () => ({ x: 0, y: 0 }),
      canStart: () => true,
      onStart: () => log.push("start"),
      onMove: () => {},
      onEnd: (r) => log.push(`end dragged=${r.dragged}`),
    });
    const Ctor = (happy as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    const fire = (target: EventTarget, type: string, x: number, y: number): void => {
      target.dispatchEvent(
        new Ctor(type, { clientX: x, clientY: y, button: 0, pointerId: 7, bubbles: true }),
      );
    };
    fire(el, "pointerdown", 10, 10);
    fire(doc.body, "pointermove", 60, 60); // the element never sees this
    fire(doc.body, "pointerup", 60, 60);
    expect(log).toEqual(["start", "end dragged=true"]);
    // Another pointer's events are not ours.
    fire(el, "pointerdown", 10, 10);
    el.dispatchEvent(
      new Ctor("pointerup", { clientX: 10, clientY: 10, button: 0, pointerId: 9, bubbles: true }),
    );
    expect(log).toHaveLength(2);
    fire(doc.body, "pointerup", 10, 10);
    expect(log).toHaveLength(3);
  });

  test("losing the window ends a hold", () => {
    const happy = new HappyWindow({ width: 1000, height: 800 });
    const doc = happy.document as unknown as Document;
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const log: string[] = [];
    attachDrag(el, {
      origin: () => ({ x: 0, y: 0 }),
      canStart: () => true,
      onStart: () => log.push("start"),
      onMove: () => {},
      onEnd: (r) => log.push(`end dragged=${r.dragged}`),
    });
    const Ctor = (happy as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent;
    el.dispatchEvent(
      new Ctor("pointerdown", { clientX: 10, clientY: 10, button: 0, pointerId: 1, bubbles: true }),
    );
    el.dispatchEvent(
      new Ctor("pointermove", { clientX: 80, clientY: 80, button: 0, pointerId: 1, bubbles: true }),
    );
    (happy as unknown as EventTarget).dispatchEvent(
      new (happy as unknown as { Event: typeof Event }).Event("blur"),
    );
    expect(log).toEqual(["start", "end dragged=true"]);
  });
});

describe("clampToViewport", () => {
  test("keeps the box a margin inside, and never inverts on a tiny viewport", () => {
    const win = { innerWidth: 1000, innerHeight: 800 } as Window;
    expect(clampToViewport({ x: -50, y: 5000 }, win, { w: 48, h: 48 }, 16)).toEqual({
      x: 16,
      y: 736,
    });
    const tiny = { innerWidth: 40, innerHeight: 40 } as Window;
    expect(clampToViewport({ x: 30, y: 30 }, tiny, { w: 400, h: 46 }, 16)).toEqual({
      x: 16,
      y: 16,
    });
  });
});
