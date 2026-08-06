import { describe, expect, test } from "bun:test";
import { verifyCustom, verifyNone, verifyToken } from "./verify.ts";

const TOKEN = "s3cret-token";

function req(authorization?: string): Request {
  return new Request(
    "http://hub/summary",
    authorization === undefined ? {} : { headers: { authorization } },
  );
}

describe("verifyToken", () => {
  test("accepts the exact token", async () => {
    const verify = verifyToken(TOKEN);
    expect(await verify(req(`Bearer ${TOKEN}`))).toEqual({ userId: "token" });
  });

  test("rejects a wrong token", async () => {
    const verify = verifyToken(TOKEN);
    expect(await verify(req("Bearer nope"))).toBeNull();
  });

  test("rejects a missing Authorization header", async () => {
    const verify = verifyToken(TOKEN);
    expect(await verify(req())).toBeNull();
  });

  test("rejects a header without the Bearer prefix", async () => {
    const verify = verifyToken(TOKEN);
    expect(await verify(req(TOKEN))).toBeNull();
  });

  test("rejects a near-miss differing in the last byte", async () => {
    const verify = verifyToken(TOKEN);
    expect(await verify(req(`Bearer ${TOKEN.slice(0, -1)}m`))).toBeNull();
  });
});

describe("verifyNone", () => {
  test("returns the anonymous identity for a bare request", async () => {
    const verify = verifyNone();
    expect(await verify(req())).toEqual({ userId: "anonymous" });
  });
});

describe("verifyCustom", () => {
  test("passes the supplied function through unchanged", async () => {
    const fn = async () => ({ userId: "custom" });
    const verify = verifyCustom(fn);
    expect(verify).toBe(fn);
    expect(await verify(req())).toEqual({ userId: "custom" });
  });
});
