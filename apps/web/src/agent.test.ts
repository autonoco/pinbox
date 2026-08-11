// The two ways this agent fails silently: it answers an event it should have ignored, or it
// answers one nobody authorised. Both look like a working demo until they aren't — a forged
// delivery makes the agent speak on a stranger's behalf, and a mis-parsed event posts a reply to
// the wrong pin. Everything else here is a network call.
import { describe, expect, test } from "bun:test";
import { parseDelivery, signatureValid } from "./agent.ts";
import { routeFor } from "./index.ts";

const SECRET = "shared-secret";

/** Sign a body exactly as the hub's webhook adapter does: HMAC over `${timestamp}.${body}`. */
async function sign(body: string, timestamp: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function delivery(headers: Record<string, string>): Request {
  return new Request("https://example.test/_pinbox-agent", { method: "POST", headers });
}

describe("signature", () => {
  const body = JSON.stringify({ event: { type: "pin.created" } });
  const at = "2026-08-11T00:00:00.000Z";

  test("accepts what the hub signed", async () => {
    const req = delivery({ "x-pinbox-timestamp": at, "x-pinbox-signature": await sign(body, at) });
    expect(await signatureValid(req, body, SECRET)).toBe(true);
  });

  test("rejects a body that changed after signing", async () => {
    const req = delivery({ "x-pinbox-timestamp": at, "x-pinbox-signature": await sign(body, at) });
    expect(await signatureValid(req, `${body} `, SECRET)).toBe(false);
  });

  test("rejects a signature made with a different secret", async () => {
    const forged = await sign(body, at, "not-the-secret");
    const req = delivery({ "x-pinbox-timestamp": at, "x-pinbox-signature": forged });
    expect(await signatureValid(req, body, SECRET)).toBe(false);
  });

  test("rejects a replay under a different timestamp", async () => {
    const req = delivery({
      "x-pinbox-timestamp": "2026-08-11T00:05:00.000Z",
      "x-pinbox-signature": await sign(body, at),
    });
    expect(await signatureValid(req, body, SECRET)).toBe(false);
  });

  test("rejects a delivery carrying no signature at all", async () => {
    expect(await signatureValid(delivery({}), body, SECRET)).toBe(false);
  });
});

describe("which events get answered", () => {
  const pin = (payload: unknown) => JSON.stringify({ event: { type: "pin.created", payload } });

  test("a new pin is answered, and names where it points", () => {
    expect(
      parseDelivery(pin({ id: "pin_a", text: "cut off", target: { selector: "button.pay" } })),
    ).toEqual({ pinId: "pin_a", text: "cut off", where: "button.pay" });
  });

  test("a pin with no target still gets answered", () => {
    expect(parseDelivery(pin({ id: "pin_a", text: "cut off" }))?.where).toBe("the page");
  });

  test("a human reply is answered on its own pin", () => {
    const body = JSON.stringify({
      event: { type: "thread.message", payload: { pinId: "pin_b", role: "human", text: "still?" } },
    });
    expect(parseDelivery(body)).toEqual({ pinId: "pin_b", text: "still?", where: "the page" });
  });

  test("the agent never answers itself", () => {
    // Without this the agent replies to its own reply, forever, on a public demo.
    const body = JSON.stringify({
      event: { type: "thread.message", payload: { pinId: "pin_b", role: "agent", text: "fixed" } },
    });
    expect(parseDelivery(body)).toBeNull();
  });

  test("events that are not a question get no reply", () => {
    expect(
      parseDelivery(JSON.stringify({ event: { type: "pin.resolved", payload: {} } })),
    ).toBeNull();
  });

  test("malformed or hostile bodies yield nothing rather than throwing", () => {
    expect(parseDelivery("not json")).toBeNull();
    expect(parseDelivery("{}")).toBeNull();
    expect(parseDelivery(pin(null))).toBeNull();
    expect(parseDelivery(pin({ id: 42, text: "x" }))).toBeNull();
    expect(parseDelivery(pin({ id: "pin_a" }))).toBeNull();
  });
});

describe("routing", () => {
  test("each surface goes to the one thing that serves it", () => {
    expect(routeFor("/_pinbox-agent")).toBe("agent");
    expect(routeFor("/_pinbox")).toBe("hub");
    expect(routeFor("/_pinbox/pins")).toBe("hub");
    expect(routeFor("/demo/")).toBe("demo");
    expect(routeFor("/demo")).toBe("demo");
    expect(routeFor("/")).toBe("asset");
    expect(routeFor("/styles/site.css")).toBe("asset");
  });

  test("a path that merely starts with the mount name is not the hub", () => {
    // `/_pinboxed` must not reach the hub, and `/_pinbox-agent` must not either — it is checked
    // first, but the prefix test has to be exact-segment regardless.
    expect(routeFor("/_pinboxed")).toBe("asset");
  });
});
