// @autono/pinbox-toolbar — placement reticle
// Crosshair + `x × y` readout (fixed, viewport space) and the amber outline that
// snaps to the hovered target with its label (absolute, page space). Ports the
// prototype's mousemove handler (docs/design/toolbar/v2-command-bar.html lines
// 521–543), including the no-transition first snap so the outline never tweens
// in from a stale position.
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Reticle {
  /** Fixed-position crosshair layer; visibility is driven by :host([data-placing]). */
  readonly crosshair: HTMLElement;
  /** Page-space outline element; append to the overlay layer. */
  readonly outline: HTMLElement;
  /** Track the pointer: crosshair follows clientX/Y, readout shows pageX × pageY. */
  move(pos: { clientX: number; clientY: number; pageX: number; pageY: number }): void;
  /** Snap the outline to a target's viewport rect (+ scroll offset) with its label. */
  snap(rect: RectLike, label: string, scroll: { x: number; y: number }): void;
  /** Hide the outline (no target under the pointer, or placing ended). */
  release(): void;
}

export function createReticle(doc: Document): Reticle {
  const crosshair = doc.createElement("div");
  crosshair.className = "pb-reticle";
  crosshair.innerHTML =
    '<div class="h"></div><div class="v"></div><div class="box"></div><div class="ro"></div>';
  const h = crosshair.querySelector(".h") as HTMLElement;
  const v = crosshair.querySelector(".v") as HTMLElement;
  const box = crosshair.querySelector(".box") as HTMLElement;
  const readout = crosshair.querySelector(".ro") as HTMLElement;

  const outline = doc.createElement("div");
  outline.className = "pb-outline";
  outline.innerHTML = '<span class="lab"></span>';
  const lab = outline.querySelector(".lab") as HTMLElement;

  function setOutlineRect(rect: RectLike, scroll: { x: number; y: number }): void {
    outline.style.left = `${rect.left + scroll.x - 5}px`;
    outline.style.top = `${rect.top + scroll.y - 5}px`;
    outline.style.width = `${rect.width + 10}px`;
    outline.style.height = `${rect.height + 10}px`;
  }

  return {
    crosshair,
    outline,
    move(pos) {
      h.style.top = `${pos.clientY}px`;
      v.style.left = `${pos.clientX}px`;
      box.style.left = `${pos.clientX}px`;
      box.style.top = `${pos.clientY}px`;
      readout.style.left = `${pos.clientX}px`;
      readout.style.top = `${pos.clientY}px`;
      readout.textContent = `${Math.round(pos.pageX)} × ${Math.round(pos.pageY)}`;
    },
    snap(rect, label, scroll) {
      if (!outline.classList.contains("on")) {
        // First snap after a gap: jump, don't tween from the stale position.
        outline.style.transition = "none";
        setOutlineRect(rect, scroll);
        void (outline as HTMLElement).offsetWidth;
        outline.style.transition = "";
      } else {
        setOutlineRect(rect, scroll);
      }
      lab.textContent = label;
      outline.classList.add("on");
    },
    release() {
      outline.classList.remove("on");
    },
  };
}
