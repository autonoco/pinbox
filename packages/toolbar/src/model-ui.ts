import type { ModelAnchor } from "@autono/pinbox-core/schema";
import { captureTarget } from "./capture.ts";
import type { PinboxToolbarElement } from "./element.ts";
import { type ModelProjection, registerModelProjection } from "./model-target.ts";
export type ModelViewerAdapter = {
  /** Canvas or element containing the model. DOM pins outside it keep working. */
  surface: HTMLElement;
  /** Raycast a viewport point; return a part-local anchor, or null for empty space. */
  pick: (clientX: number, clientY: number) => ModelAnchor | null;
  /** Project to viewport CSS pixels. Null for a stale, hidden or occluded anchor. */
  project: ModelProjection;
};
/** Connect the real Pinbox toolbar, draft card and needle markers to a 3D viewer.
 * Call update() after rendering a frame. Destroy before removing the viewer. */
export function attachModelViewer(toolbar: PinboxToolbarElement, adapter: ModelViewerAdapter) {
  const doc = adapter.surface.ownerDocument,
    win = doc.defaultView;
  if (!win) throw new Error("The model surface must belong to a browser document");
  const unregister = registerModelProjection(doc, adapter.project);
  let down: { x: number; y: number } | undefined;
  const pointerDown = (e: PointerEvent) => {
    if (e.composedPath().includes(adapter.surface)) down = { x: e.clientX, y: e.clientY };
  };
  const click = (e: MouseEvent) => {
    if (
      toolbar.store.get().mode !== "placing" ||
      e.composedPath().includes(toolbar) ||
      !e.composedPath().includes(adapter.surface)
    )
      return;
    // Intercept before the toolbar's document listener can create a DOM canvas pin.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) {
      down = undefined;
      return;
    }
    down = undefined;
    const model = adapter.pick(e.clientX, e.clientY);
    if (!model) return;
    const at = { x: e.clientX + win.scrollX, y: e.clientY + win.scrollY };
    const captured = captureTarget(adapter.surface, { at });
    captured.target.model = model;
    captured.target.anchor = `3D · ${model.partId}`;
    delete captured.target.spot;
    toolbar.store.place({ target: captured, placedAt: at });
  };
  win.addEventListener("pointerdown", pointerDown, true);
  win.addEventListener("click", click, true);
  let destroyed = false;
  return {
    update() {
      if (destroyed || !toolbar.isConnected) return;
      const s = toolbar.store.get();
      if (s.pins.some((p) => p.target?.model) || s.draft?.target.target.model)
        toolbar.store.update({ clock: s.clock });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unregister();
      win.removeEventListener("pointerdown", pointerDown, true);
      win.removeEventListener("click", click, true);
    },
  };
}
