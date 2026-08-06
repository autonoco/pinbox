import { expect, test } from "bun:test";
import { newId } from "./id.ts";

test("ids have prefix, fixed length, and are unique", () => {
  const a = newId("pin");
  const b = newId("pin");
  expect(a).toMatch(/^pin_[a-z0-9]{10}$/);
  expect(a).not.toBe(b);
  expect(newId("msg")).toMatch(/^msg_[a-z0-9]{10}$/);
});
