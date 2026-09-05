// @autono/pinbox-toolbar — movable command bar.
// Dogfood: only the collapsed puck could be moved; the open bar sat bottom-centre
// over whatever the page kept there. The bar's grip (ui/bar.ts) now drags with
// the puck's rules (motion/drag.ts): free placement, clamped 16px inside the
// viewport, remembered per endpoint beside the puck's dock, re-clamped on
// resize. Double-click the grip to go back to the default spot. The minimize
// morph measures the bar's live rect, so a moved bar needs nothing from it.
import { attachDrag, clampToViewport, type Point, readPoint } from "../motion/drag.ts";
import type { StorageLike } from "../transport/mirror.ts";

const MARGIN = 16;

export interface BarDragHost {
  win: Window;
  bar: HTMLElement;
  grip: HTMLElement;
  /** Same seam and prefix as minimize.ts; null degrades to session-only. */
  storage: StorageLike | null;
  storagePrefix: string;
}

export interface BarDrag {
  /** The remembered spot, or null for the CSS default (bottom-centre). */
  position(): Point | null;
  /** Back to the default spot; forgets the persisted one. */
  reset(): void;
  destroy(): void;
}

export function createBarDrag(host: BarDragHost): BarDrag {
  const { win, bar, grip } = host;
  const key = `${host.storagePrefix}:bar`;
  let pos: Point | null = readPoint(host.storage, key);
  /** Where the bar was when a press began, so a tap-sized wobble snaps back. */
  let before: Point | null = null;

  function persist(): void {
    try {
      if (pos === null) host.storage?.removeItem(key);
      else host.storage?.setItem(key, JSON.stringify(pos));
    } catch {
      // private mode / quota — the spot just does not survive a reload
    }
  }

  function box(): { w: number; h: number } {
    const r = bar.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  function apply(p: Point | null): void {
    pos = p;
    bar.classList.toggle("free", p !== null);
    bar.style.left = p === null ? "" : `${p.x}px`;
    bar.style.top = p === null ? "" : `${p.y}px`;
  }

  const drag = attachDrag(grip, {
    origin: () => {
      if (bar.classList.contains("pb-ghost")) return null; // minimized: nothing to move
      const r = bar.getBoundingClientRect();
      return { x: r.left, y: r.top };
    },
    canStart: () => !bar.classList.contains("pb-ghost"),
    onStart() {
      before = pos;
      bar.classList.add("dragging");
    },
    onMove(next) {
      apply(clampToViewport(next, win, box(), MARGIN));
    },
    onEnd({ dragged, started }) {
      bar.classList.remove("dragging");
      if (dragged) persist();
      else if (started) apply(before); // a wobble under the tap ceiling: put it back
    },
  });

  function reset(): void {
    apply(null);
    persist();
  }
  function onResize(): void {
    if (pos !== null) apply(clampToViewport(pos, win, box(), MARGIN));
  }

  grip.addEventListener("dblclick", reset);
  win.addEventListener("resize", onResize);
  if (pos !== null) apply(clampToViewport(pos, win, box(), MARGIN));

  return {
    position: () => pos,
    reset,
    destroy() {
      drag.destroy();
      grip.removeEventListener("dblclick", reset);
      win.removeEventListener("resize", onResize);
    },
  };
}
