// @autono/pinbox-toolbar — aiming a pin without a mouse.
//
// The crosshair in reticle.ts follows `mousemove`. On a phone that event never fires, so there is
// no crosshair, no highlight of what you are about to pin, and no way to see where the pin will
// land — the whole placement affordance is simply absent on touch.
//
// This is the design's answer, and it is a better one than "make tap work": a reticle you DRAG.
// It appears in the middle of the screen, you drag it onto the thing you mean, and what is under
// it highlights as you go. Then you confirm. A tap cannot do that — your finger covers the target
// and you get no preview before committing.
//
// Placement is deliberately two steps here. Tapping to place would fire on every scroll-stopping
// tap and on every link you meant to follow, and you would never see what you hit until after.
export interface AimHandlers {
  /** The reticle moved: probe this viewport point and highlight what is under it. */
  onAim(clientX: number, clientY: number): void;
  /** Commit a pin at the reticle's current point. */
  onConfirm(): void;
  /** Leave placement without pinning anything. */
  onCancel(): void;
}

export interface Aim {
  /** Overlay layer: crosshair, drag handle and the confirm bar. Append to the shadow root. */
  readonly root: HTMLElement;
  /** Where the reticle sits, in viewport coordinates. */
  readonly point: { x: number; y: number };
  /** Place the reticle and show the layer. */
  show(x: number, y: number): void;
  hide(): void;
  /** What the reticle is currently over, shown on the confirm bar. */
  setLabel(label: string): void;
  /** Drop the window listeners. */
  destroy(): void;
}

/**
 * True when aiming has to be done by dragging rather than by pointing.
 *
 * Two independent reasons, either of which is sufficient. A coarse pointer means there is no
 * hover to follow at all — the mouse crosshair cannot work, whatever the screen size. The width
 * check is the design's own rule (720px) and catches the case a media query cannot: a device that
 * reports a fine pointer but is being used at phone width.
 */
export function needsDragAim(win: Window): boolean {
  const coarse = win.matchMedia?.("(pointer: coarse)").matches === true;
  return coarse || win.innerWidth < 720;
}

/**
 * Where the reticle starts.
 *
 * Slightly above centre: the confirm bar owns the bottom of the screen, and a reticle that opens
 * underneath your own thumb is one you have to move before you can even see it.
 */
export function startPoint(win: Window): { x: number; y: number } {
  return { x: win.innerWidth / 2, y: win.innerHeight * 0.42 };
}

// Not `role="slider"`: a slider reports one value on one axis, and this moves on two with no
// value to report. A plain focusable control with a name is the honest description. The label is
// a live region so a screen reader hears what the reticle is over as it moves — otherwise aiming
// is the one thing here you could only do by sight.
const MARKUP =
  '<div class="h"></div><div class="v"></div>' +
  '<div class="grip" aria-label="Pin position — arrow keys to aim" tabindex="0"><i></i></div>' +
  '<div class="bar"><span class="lab" role="status" aria-live="polite"></span>' +
  '<button type="button" class="cancel" data-aim="cancel">CANCEL</button>' +
  '<button type="button" class="ok" data-aim="confirm">PIN IT HERE</button></div>';

export function createAim(doc: Document, handlers: AimHandlers): Aim {
  const win = doc.defaultView as Window;
  const root = doc.createElement("div");
  root.className = "pb-aim";
  root.innerHTML = MARKUP;
  const h = root.querySelector(".h") as HTMLElement;
  const v = root.querySelector(".v") as HTMLElement;
  const grip = root.querySelector(".grip") as HTMLElement;
  const label = root.querySelector(".lab") as HTMLElement;

  const point = { x: 0, y: 0 };
  /** Grab offset, so the reticle does not jump to your fingertip when you take hold of it. */
  let grab: { dx: number; dy: number } | null = null;

  function put(x: number, y: number): void {
    // Clamped to the viewport: a reticle dragged off-screen is unreachable, and on a phone there
    // is no way to scroll it back.
    point.x = Math.max(0, Math.min(win.innerWidth, x));
    point.y = Math.max(0, Math.min(win.innerHeight, y));
    h.style.top = `${point.y}px`;
    v.style.left = `${point.x}px`;
    grip.style.left = `${point.x}px`;
    grip.style.top = `${point.y}px`;
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (grab === null) return;
    // The page must not scroll under the drag. Needs a non-passive listener to hold.
    e.preventDefault();
    put(e.clientX + grab.dx, e.clientY + grab.dy);
    handlers.onAim(point.x, point.y);
  };

  const onPointerUp = (): void => {
    grab = null;
  };

  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    grab = { dx: point.x - e.clientX, dy: point.y - e.clientY };
    // Keeps the drag alive when the finger leaves the grip, which it does immediately.
    grip.setPointerCapture?.(e.pointerId);
  });

  // Arrow keys, for anyone aiming from a keyboard rather than a finger.
  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 20 : 2;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = by[e.key];
    if (!delta) return;
    e.preventDefault();
    put(point.x + delta[0], point.y + delta[1]);
    handlers.onAim(point.x, point.y);
  });

  root.addEventListener("click", (e) => {
    const action = (e.target as Element).closest?.("[data-aim]")?.getAttribute("data-aim");
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "confirm") handlers.onConfirm();
    else handlers.onCancel();
  });

  win.addEventListener("pointermove", onPointerMove, { passive: false });
  win.addEventListener("pointerup", onPointerUp);
  win.addEventListener("pointercancel", onPointerUp);

  return {
    root,
    point,
    show(x, y) {
      put(x, y);
      root.classList.add("on");
    },
    hide() {
      grab = null;
      root.classList.remove("on");
    },
    setLabel(text) {
      label.textContent = text;
    },
    destroy() {
      win.removeEventListener("pointermove", onPointerMove);
      win.removeEventListener("pointerup", onPointerUp);
      win.removeEventListener("pointercancel", onPointerUp);
    },
  };
}
