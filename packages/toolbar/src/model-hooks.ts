import type { Pin } from "@autono/pinbox-core/schema";
import type { PinboxToolbarElement } from "./element.ts";
import { registerModelCapture } from "./model-capture.ts";
import type { ModelViewerAdapter } from "./model-ui.ts";

/** Renderer callbacks stay separate from placement and marker projection. */
export function attachModelHooks(toolbar: PinboxToolbarElement, adapter: ModelViewerAdapter) {
  const surface = adapter.surface,
    win = surface.ownerDocument.defaultView;
  if (!win) throw new Error("The model surface must belong to a browser document");
  const error =
    adapter.onError ?? ((cause: unknown) => console.error("Pinbox model hook failed", cause));
  const capture = adapter.onCapture
    ? registerModelCapture(toolbar, adapter.onCapture, error)
    : undefined;
  let point: { x: number; y: number } | undefined,
    hovering = false,
    disposed = false;
  let active: string | null = null,
    controller: AbortController | undefined;
  let activation: Promise<void> = Promise.resolve();
  const clear = () => {
    point = undefined;
    if (hovering) {
      hovering = false;
      adapter.onHover?.(null);
    }
  };
  const move = (event: PointerEvent) => {
    if (!event.composedPath().includes(surface)) {
      clear();
      return;
    }
    point = { x: event.clientX, y: event.clientY };
    capture?.activate();
  };
  const focus = () => capture?.activate();
  const activate = (pin: Pin) => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal,
      anchor = pin.target?.model;
    if (!anchor || !adapter.onActivate || (adapter.acceptsAnchor && !adapter.acceptsAnchor(anchor)))
      return Promise.resolve();
    try {
      return Promise.resolve(adapter.onActivate(anchor, pin, { signal })).catch((cause) => {
        if (!signal.aborted) error(cause);
      });
    } catch (cause) {
      error(cause);
      return Promise.resolve();
    }
  };
  const unsubscribe = toolbar.store.subscribe((state) => {
    if (state.mode !== "placing" && hovering) {
      hovering = false;
      adapter.onHover?.(null);
    }
    if (active === state.activePinId) return;
    const pin = state.pins.find((p) => p.id === state.activePinId);
    if (state.activePinId && !pin) return;
    active = state.activePinId;
    controller?.abort();
    if (pin) activation = activate(pin);
  });
  win.addEventListener("pointermove", move, true);
  win.addEventListener("blur", clear);
  surface.addEventListener("pointerleave", clear);
  surface.addEventListener("pointerdown", focus, true);
  return {
    update() {
      if (disposed || !adapter.onHover || !point || toolbar.store.get().mode !== "placing") return;
      try {
        const anchor = adapter.pick(point.x, point.y);
        hovering = anchor !== null;
        adapter.onHover(anchor);
      } catch (cause) {
        clear();
        error(cause);
      }
    },
    async openPin(id: string) {
      if (disposed) return;
      const pin = toolbar.store.get().pins.find((p) => p.id === id);
      if (!pin) throw new Error("Pin not found.");
      if (active === id) activation = activate(pin);
      toolbar.store.update({ mode: "idle", activePinId: id, pinsHidden: false });
      await activation;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      controller?.abort();
      unsubscribe();
      clear();
      capture?.destroy();
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("blur", clear);
      surface.removeEventListener("pointerleave", clear);
      surface.removeEventListener("pointerdown", focus, true);
    },
  };
}
