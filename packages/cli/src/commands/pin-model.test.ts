import { expect, test } from "bun:test";
import type { ModelAnchor } from "@autono/pinbox-core/schema";
import { buildPinInput } from "./pin.ts";

const model: ModelAnchor = {
  modelId: "box",
  revision: "r1",
  partId: "shell",
  position: [0, 0, 0],
  units: "mm",
};
test("CLI accepts spatial anchor and explicitly supplied upstream identity", async () => {
  const input = await buildPinInput(
    "round this",
    {
      modelAnchor: JSON.stringify(model),
      authorJson: JSON.stringify({ userId: "u", email: "u@example.com" }),
    },
    process.cwd(),
  );
  expect(input.target?.model).toEqual(model);
  expect(input.author.userId).toBe("u");
});
test("CLI rejects invalid JSON and invalid dimensions", async () => {
  await expect(buildPinInput("x", { modelAnchor: "{" }, process.cwd())).rejects.toThrow();
  await expect(
    buildPinInput("x", { modelAnchor: JSON.stringify({ ...model, position: [0] }) }, process.cwd()),
  ).rejects.toThrow();
});
