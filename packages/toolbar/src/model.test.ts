import { expect, test } from "bun:test";
import { resolveModelAnchor } from "./model.ts";

const anchor = {
  modelId: "box",
  revision: "r1",
  partId: "knob",
  position: [1, 2, 3] as [number, number, number],
  units: "mm" as const,
};
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
test("object-local point follows transforms including an exploded part", () => {
  expect(
    resolveModelAnchor(anchor, { modelId: "box", revision: "r1", partMatrix: () => matrix }),
  ).toEqual({ status: "visible", worldPosition: [11, 22, 33] });
});
test("changed revision and missing parts never get silently reattached", () => {
  expect(
    resolveModelAnchor(anchor, { modelId: "box", revision: "r2", partMatrix: () => matrix }).status,
  ).toBe("stale");
  expect(
    resolveModelAnchor(anchor, { modelId: "box", revision: "r1", partMatrix: () => undefined })
      .status,
  ).toBe("missing");
});
test("a transformed coordinate that overflows to Infinity is missing, not visible", () => {
  const huge = { ...anchor, position: [Number.MAX_VALUE, 0, 0] as [number, number, number] };
  const scale = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  expect(
    resolveModelAnchor(huge, { modelId: "box", revision: "r1", partMatrix: () => scale }).status,
  ).toBe("missing");
});
