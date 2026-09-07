import { expect, test } from "bun:test";
import { pinsToMarkdown } from "./markdown.ts";
import { type ModelAnchor, PinInputSchema } from "./schema.ts";
import { openStore } from "./store.ts";

const model: ModelAnchor = {
  modelId: "monolith",
  revision: "rev-1",
  partId: "knob",
  position: [1, 2, 3],
  normal: [0, 0, 1],
  units: "mm",
};
test("3D anchors persist through storage and event replay with requester identity", () => {
  const store = openStore(":memory:");
  const pin = store.createPin(
    {
      text: "smaller",
      kind: "comment",
      author: { userId: "person@example.com" },
      target: { model },
    },
    {},
  );
  expect(store.getPin(pin.id)?.target?.model).toEqual(model);
  expect(JSON.stringify(store.eventsAfter(0))).toContain('"partId":"knob"');
  expect(pinsToMarkdown([pin], "standard")).toContain("knob");
  expect(pinsToMarkdown([pin], "standard")).toContain("rev-1");
  store.close();
});
test("malformed spatial targets are rejected instead of discarded", () => {
  for (const changed of [
    { position: [1, 2] },
    { position: [Infinity, 0, 0] },
    { partId: "" },
    { units: "pixels" },
    { normal: [0, 0, 0] },
    { revision: "" },
  ]) {
    expect(
      PinInputSchema.safeParse({
        text: "x",
        author: { userId: "x" },
        target: { model: { ...model, ...changed } },
      }).success,
    ).toBe(false);
  }
  expect(
    PinInputSchema.safeParse({
      text: "legacy",
      author: { userId: "x" },
      target: { selector: "button" },
    }).success,
  ).toBe(true);
});
