import { expect, test } from "bun:test";
import type { ModelAnchor } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import { projectModelTarget, registerModelProjection } from "./model-target.ts";

const anchor: ModelAnchor = {
  modelId: "box",
  revision: "v1",
  partId: "knob",
  position: [1, 2, 3],
  units: "mm",
};
test("two viewers sharing one projector stay registered until both release it", () => {
  const win = new Window({ url: "https://example.com" }),
    doc = win.document as unknown as Document;
  const project = () => ({ x: 10, y: 20 });
  const first = registerModelProjection(doc, project);
  const second = registerModelProjection(doc, project);
  first();
  expect(projectModelTarget(doc, anchor)).toEqual({ x: 10, y: 20, width: 0, height: 0 });
  second();
  expect(projectModelTarget(doc, anchor)).toBeNull();
  win.happyDOM.abort();
});
