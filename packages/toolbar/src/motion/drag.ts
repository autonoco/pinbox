// @autono/pinbox-toolbar — pointer drag controller.
// The puck's drag/tap discrimination, extracted so the command bar can move
// with the same rules (dogfood: "the open toolbar should be movable too").
// Three regressions this file must never reintroduce (each hit for real in the
// v3 prototype, each pinned in minimize.test.ts):
//   - a non-primary-button press must not start a drag (macOS right-click
//     never delivers pointerup — the pending drag wedged the UI)
//   - a hold whose owner stopped being draggable mid-hold is abandoned, not
//     resumed by the next pointermove (keyboard restore hijacked the morph)
//   - a release under TAP_MAX total travel is a tap — trackpad clicks wander
//     several pixels, and treating them as drags read as "not responding"
//   - the release must never depend on pointer capture succeeding. Move/up
//     listeners live on the DOCUMENT for the life of a hold, so a pointerup
//     that lands anywhere ends the drag; capture is requested as a nicety
//     only. A drag whose pointerup was lost left the puck ghosted behind the
//     morph surface for good (dogfood: "click does nothing, won't drag").
//     Losing the window (blur) ends a hold the same way.

/** Movement that begins a drag… */
const DRAG_START = 8;
/** …but a release under this much TOTAL travel is still a tap. */
const TAP_MAX = 12;

export interface Point {
  x: number;
  y: number;
}

export interface DragHandlers {
  /** Where the dragged thing is when the press lands; null refuses the press. */
  origin(): Point | null;
  /** Re-checked on every move before the drag starts: false abandons the hold. */
  canStart(): boolean;
  /** Travel crossed DRAG_START: the drag is on. */
  onStart(origin: Point): void;
  /** Every move while dragging: origin + delta, unclamped. */
  onMove(next: Point): void;
  /**
   * Release. `dragged` is the whole verdict (moved AND ≥ TAP_MAX total travel); `started` says
   * whether onStart ran, so a drag that visually began but ended as a tap can be put back.
   */
  onEnd(result: { dragged: boolean; started: boolean; origin: Point; target: Point }): void;
}

export interface Drag {
  /** Drop any pending hold (a programmatic move/restore ran mid-press). */
  cancel(): void;
  destroy(): void;
}

interface Hold {
  pointerId: number;
  px: number;
  py: number;
  origin: Point;
  lx: number;
  ly: number;
  started: boolean;
}

/**
 * Attach the drag rules to `el`. The press is read on `el`; move/up/cancel are read on its
 * document while a hold is live, so the release cannot be lost to a failed capture. Pointer
 * capture is still requested (it keeps moves flowing when the pointer leaves the window);
 * `touch-action: none` on the element is the caller's job.
 */
export function attachDrag(el: HTMLElement, on: DragHandlers): Drag {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  let hold: Hold | null = null;

  function listen(active: boolean): void {
    const method = active ? "addEventListener" : "removeEventListener";
    doc[method]("pointermove", onPointerMove as EventListener, true);
    doc[method]("pointerup", onPointerUp as EventListener, true);
    doc[method]("pointercancel", onPointerUp as EventListener, true);
    win?.[method]("blur", onBlur);
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || hold !== null) return;
    const origin = on.origin();
    if (origin === null) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer events have no capturable pointer; the document listeners carry on
    }
    hold = {
      pointerId: e.pointerId,
      px: e.clientX,
      py: e.clientY,
      origin,
      lx: e.clientX,
      ly: e.clientY,
      started: false,
    };
    listen(true);
  }

  function onPointerMove(e: PointerEvent): void {
    if (hold === null || e.pointerId !== hold.pointerId) return;
    hold.lx = e.clientX;
    hold.ly = e.clientY;
    const dx = e.clientX - hold.px;
    const dy = e.clientY - hold.py;
    if (!hold.started) {
      if (!on.canStart()) {
        release(); // the owner changed under the held pointer — abandon
        return;
      }
      if (Math.hypot(dx, dy) < DRAG_START) return;
      hold.started = true;
      on.onStart(hold.origin);
    }
    on.onMove({ x: hold.origin.x + dx, y: hold.origin.y + dy });
  }

  function release(): void {
    hold = null;
    listen(false);
  }

  /** The window lost focus mid-hold: whatever the pointer does next, we will not see it. */
  function onBlur(): void {
    if (hold !== null) onPointerUp();
  }

  function onPointerUp(e?: PointerEvent): void {
    if (hold === null || (e !== undefined && e.pointerId !== hold.pointerId)) return;
    const h = hold;
    release();
    const total = Math.hypot(h.lx - h.px, h.ly - h.py);
    on.onEnd({
      dragged: h.started && total >= TAP_MAX,
      started: h.started,
      origin: h.origin,
      target: { x: h.origin.x + (h.lx - h.px), y: h.origin.y + (h.ly - h.py) },
    });
  }

  el.addEventListener("pointerdown", onPointerDown);

  return {
    cancel: release,
    destroy() {
      release();
      el.removeEventListener("pointerdown", onPointerDown);
    },
  };
}

/** Keep a top-left corner of a `size`-square (or w×h box) `margin` px inside the viewport. */
export function clampToViewport(
  p: Point,
  win: Window,
  box: { w: number; h: number },
  margin: number,
): Point {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  return {
    x: clamp(p.x, margin, Math.max(margin, win.innerWidth - margin - box.w)),
    y: clamp(p.y, margin, Math.max(margin, win.innerHeight - margin - box.h)),
  };
}

/** A persisted `{x,y}` (mirror convention: reads never throw upward); null when absent or malformed. */
export function readPoint(
  storage: { getItem(key: string): string | null } | null,
  key: string,
): Point | null {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}
