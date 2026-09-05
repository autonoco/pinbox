// @autono/pinbox-toolbar — shift+click accumulation mark tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderMultiMarks } from "./multimarks.ts";

function layerIn(): HTMLElement {
  const window = new Window();
  const layer = window.document.createElement("div");
  window.document.body.appendChild(layer);
  return layer as unknown as HTMLElement;
}

test("marks mirror the target set: numbered, positioned, replaced on re-render", () => {
  const layer = layerIn();
  renderMultiMarks(layer, [
    { rect: { x: 10, y: 20, width: 100, height: 30 } },
    { rect: { x: 10, y: 60, width: 100, height: 30 } },
  ]);
  const marks = [...layer.querySelectorAll(".pb-multi-mark")] as HTMLElement[];
  expect(marks.length).toBe(2);
  expect(marks[0]?.style.top).toBe("20px");
  expect(marks[0]?.textContent).toBe("1");
  expect(marks[1]?.textContent).toBe("2");
  // re-render with one target replaces, never appends
  renderMultiMarks(layer, [{ rect: { x: 0, y: 0, width: 5, height: 5 } }]);
  expect(layer.querySelectorAll(".pb-multi-mark").length).toBe(1);
  renderMultiMarks(layer, []);
  expect(layer.querySelectorAll(".pb-multi-mark").length).toBe(0);
});

test("marks shift by the scroll offset: captured rects are document-space, the layer is not", () => {
  const layer = layerIn();
  renderMultiMarks(layer, [{ rect: { x: 110, y: 220, width: 10, height: 10 } }], { x: 10, y: 20 });
  const mark = layer.querySelector(".pb-multi-mark") as HTMLElement;
  expect(mark.style.left).toBe("100px");
  expect(mark.style.top).toBe("200px");
});

test("a target with no rect draws nothing but keeps later numbering honest", () => {
  const layer = layerIn();
  renderMultiMarks(layer, [{}, { rect: { x: 1, y: 2, width: 3, height: 4 } }]);
  const marks = [...layer.querySelectorAll(".pb-multi-mark")];
  expect(marks.length).toBe(1);
  expect(marks[0]?.textContent).toBe("2"); // its index in the set, not in the drawn list
});
