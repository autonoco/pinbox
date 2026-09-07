import { expect, test } from "bun:test";
import type { ModelAnchor, Pin } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import type { PinboxToolbarElement } from "./element.ts";
import { attachModelViewer } from "./model-ui.ts";
import { createStore } from "./state.ts";
import { targetRect } from "./ui/pins.ts";

const anchor: ModelAnchor = {
  modelId: "box",
  revision: "v1",
  partId: "knob",
  position: [1, 2, 3],
  units: "mm",
};
test("real toolbar draft stores a 3D point; projected markers follow movement and never fall back to canvas rect", () => {
  const win = new Window({ url: "https://example.com" }),
    doc = win.document;
  const canvas = doc.createElement("canvas");
  doc.body.append(canvas);
  const toolbar = doc.createElement("div") as unknown as PinboxToolbarElement;
  Object.defineProperty(toolbar, "store", { value: createStore() });
  doc.body.append(toolbar as never);
  let x = 10,
    visible = true;
  const model = attachModelViewer(toolbar, {
    surface: canvas as unknown as HTMLElement,
    pick: () => anchor,
    project: () => (visible ? { x, y: 20 } : null),
  });
  toolbar.store.update({ mode: "placing" });
  canvas.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 }));
  expect(toolbar.store.get().draft?.target.target.model).toEqual(anchor);
  const target: Pin["target"] = {
    model: anchor,
    rect: { x: 999, y: 999, width: 100, height: 100 },
  };
  expect(targetRect(doc as unknown as Document, target)).toEqual({
    x: 10,
    y: 20,
    width: 0,
    height: 0,
  });
  x = 200;
  model.update();
  expect(targetRect(doc as unknown as Document, target)?.x).toBe(200);
  visible = false;
  expect(targetRect(doc as unknown as Document, target)).toBeNull();
  model.destroy();
  expect(targetRect(doc as unknown as Document, target)).toBeNull();
  win.happyDOM.abort();
});
test("orbit drags and empty space never create a canvas pin", () => {
  const win = new Window({ url: "https://example.com" }),
    canvas = win.document.createElement("canvas");
  win.document.body.append(canvas);
  const toolbar = win.document.createElement("div") as unknown as PinboxToolbarElement;
  Object.defineProperty(toolbar, "store", { value: createStore() });
  win.document.body.append(toolbar as never);
  const model = attachModelViewer(toolbar, {
    surface: canvas as unknown as HTMLElement,
    pick: () => null,
    project: () => null,
  });
  toolbar.store.update({ mode: "placing" });
  canvas.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  expect(toolbar.store.get().draft).toBeNull();
  model.destroy();
  win.happyDOM.abort();
});
