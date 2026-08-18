// @autono/pinbox-toolbar — screenshot tests: guards + geometry
// only. Canvas paths need a real browser; the demo page checklist covers them.
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureElement, releaseCapture, uploadAttachment, visibleCropRect } from "./screenshot.ts";

function elementIn(html: string): { window: Window; el: Element } {
  const window = new Window({ url: "http://localhost:5173/" });
  window.document.body.innerHTML = html;
  return { window, el: window.document.body.firstElementChild as unknown as Element };
}

interface RectSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

function stubRect(el: object, r: RectSpec): void {
  (el as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    x: r.x,
    y: r.y,
    left: r.x,
    top: r.y,
    width: r.width,
    height: r.height,
    right: r.x + r.width,
    bottom: r.y + r.height,
  });
}

describe("captureElement", () => {
  test("resolves null (never throws) when no capture source exists", async () => {
    // Bun has no OffscreenCanvas/createImageBitmap and happy-dom no getDisplayMedia:
    // exactly the unsupported environment the guard must absorb.
    const { el } = elementIn(`<div class="hero">Hi</div>`);
    stubRect(el, { x: 10, y: 10, width: 100, height: 50 });
    await expect(captureElement(el)).resolves.toBeNull();
  });
});

describe("visibleCropRect", () => {
  test("clamps the element rect to the viewport", () => {
    const { window, el } = elementIn(`<div>big</div>`);
    stubRect(el, { x: -50, y: 100, width: 200, height: 900 });
    expect(visibleCropRect(el)).toEqual({
      x: 0,
      y: 100,
      width: 150,
      height: window.innerHeight - 100,
    });
  });

  test("fully visible rect passes through; off-screen yields null", () => {
    const { el } = elementIn(`<div>a</div>`);
    stubRect(el, { x: 20, y: 30, width: 100, height: 40 });
    expect(visibleCropRect(el)).toEqual({ x: 20, y: 30, width: 100, height: 40 });
    stubRect(el, { x: -500, y: -500, width: 100, height: 40 });
    expect(visibleCropRect(el)).toBeNull();
  });
});

describe("uploadAttachment", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("posts raw bytes with authorization + content-type and unwraps data.attachment", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const attachment = { id: "att_0000000001", kind: "screenshot", path: "/tmp/att.webp" };
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(JSON.stringify({ ok: true, data: { attachment } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" });
    const got = await uploadAttachment("http://127.0.0.1:4141", "tok123", {
      blob,
      width: 100,
      height: 50,
    });

    expect(got).toEqual(attachment as never);
    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe("http://127.0.0.1:4141/attachments?kind=screenshot");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok123");
    expect(headers["content-type"]).toBe("image/webp");
    expect(call.init.body).toBe(blob);
  });

  test("surfaces the hub error envelope on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error: { code: "E_ATTACHMENT", message: "too large" } }),
        { status: 413, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const blob = new Blob([new Uint8Array([1])], { type: "image/webp" });
    await expect(
      uploadAttachment("http://127.0.0.1:4141", "tok123", { blob, width: 1, height: 1 }),
    ).rejects.toThrow(/E_ATTACHMENT.*too large/);
  });
});

describe("releaseCapture", () => {
  test("is idempotent with nothing cached", () => {
    releaseCapture();
    releaseCapture();
  });
});
