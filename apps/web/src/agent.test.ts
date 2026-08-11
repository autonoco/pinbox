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

  test("the element's own text reaches the agent, not just a selector", () => {
    // The bug this pins down: a pin on the element containing "1997" reached the model as a bare
    // CSS path, so "change this to 20 not 19" was unanswerable and the agent asked what was meant.
    const target = {
      selector: "body > div > div:nth-of-type(4) > div",
      tag: "div",
      context: { classes: ["m-metric__v"], nearbyText: "1997", styles: { "font-size": "34px" } },
    };
    const where = parseDelivery(pin({ id: "pin_a", text: "change to 20", target }))?.where ?? "";
    expect(where).toContain('"1997"');
    expect(where).toContain("m-metric__v");
    expect(where).toContain("font-size: 34px");
    expect(where).toContain("<div>");
  });

  test("a pin with only a selector still names where it points", () => {
    expect(
      parseDelivery(pin({ id: "pin_a", text: "cut off", target: { selector: "button.pay" } })),
    ).toEqual({ pinId: "pin_a", text: "cut off", where: "selector: button.pay" });
  });

  test("a pin with no target still gets answered", () => {
    expect(parseDelivery(pin({ id: "pin_a", text: "cut off" }))?.where).toBe("the page");
  });

  test("a reply carries no context of its own — it must be hydrated from the pin", () => {
    // The bug this pins down: "do it" reached the model as two words plus the string "the page",
    // so the only possible answer was "what would you like changed?". `where` is empty here on
    // purpose; handleDelivery fills it from the pin, its element, and the conversation so far.
    const body = JSON.stringify({
      event: { type: "thread.message", payload: { pinId: "pin_b", role: "human", text: "do it" } },
    });
    expect(parseDelivery(body)).toEqual({ pinId: "pin_b", text: "do it", where: "" });
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
