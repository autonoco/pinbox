// @autono/pinbox-toolbar — drag-to-aim, the way a pin is placed without a mouse.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { createAim, needsDragAim, startPoint } from "./aim.ts";

/** happy-dom's Window is structurally close to the DOM lib's, not identical; the cast is the seam. */
function windowAt(
  width: number,
  height = 800,
  coarse = false,
): Window & {
  PointerEvent: typeof PointerEvent;
  dispatchEvent: (e: Event) => boolean;
  document: Document;
} {
  const window = new HappyWindow({ width, height });
  (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({
    matches: coarse && q.includes("coarse"),
  });
  return window as unknown as Window & {
    PointerEvent: typeof PointerEvent;
    dispatchEvent: (e: Event) => boolean;
    document: Document;
  };
}

describe("when a pin has to be aimed by dragging", () => {
  test("a phone-width viewport", () => {
    expect(needsDragAim(windowAt(390))).toBe(true);
  });

  test("a touch screen, even a wide one — there is no hover to follow", () => {
    expect(needsDragAim(windowAt(1024, 768, true))).toBe(true);
  });

  test("not a desktop with a mouse: the crosshair still follows the pointer", () => {
    expect(needsDragAim(windowAt(1440))).toBe(false);
  });
});

describe("the reticle", () => {
  test("opens above centre, clear of the confirm bar and your thumb", () => {
    const point = startPoint(windowAt(390, 844));
    expect(point.x).toBe(195);
    expect(point.y).toBeLessThan(422); // above the middle
  });

  test("dragging moves it and re-probes what is underneath", () => {
    const window = windowAt(390, 844, true);
    const aimed: Array<[number, number]> = [];
    const aim = createAim(window.document, {
      onAim: (x, y) => aimed.push([x, y]),
      onConfirm: () => {},
      onCancel: () => {},
    });
    aim.show(100, 100);
    const grip = aim.root.querySelector(".grip") as HTMLElement;

    grip.dispatchEvent(
      new window.PointerEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }),
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 160, clientY: 240 }));

    expect(aimed).toEqual([[160, 240]]);
    expect(aim.point).toEqual({ x: 160, y: 240 });
  });

  test("stays on screen — dragged off, it would be unreachable on a phone", () => {
    const window = windowAt(390, 844, true);
    const aim = createAim(window.document, {
      onAim: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    aim.show(100, 100);
    const grip = aim.root.querySelector(".grip") as HTMLElement;
    grip.dispatchEvent(
      new window.PointerEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }),
    );
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 9999, clientY: 9999 }));
    expect(aim.point).toEqual({ x: 390, y: 844 });
  });

  test("a drag that never started moves nothing", () => {
    const window = windowAt(390, 844, true);
    const aim = createAim(window.document, {
      onAim: () => {},
      onConfirm: () => {},
      onCancel: () => {},
    });
    aim.show(100, 100);
    window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 300, clientY: 300 }));
    expect(aim.point).toEqual({ x: 100, y: 100 });
  });

  test("confirm and cancel are the only way to leave", () => {
    const window = windowAt(390, 844, true);
    const seen: string[] = [];
    const aim = createAim(window.document, {
      onAim: () => {},
      onConfirm: () => seen.push("confirm"),
      onCancel: () => seen.push("cancel"),
    });
    (aim.root.querySelector('[data-aim="confirm"]') as HTMLElement).click();
    (aim.root.querySelector('[data-aim="cancel"]') as HTMLElement).click();
    expect(seen).toEqual(["confirm", "cancel"]);
  });
});
