// The worker template, exercised through the real `examples/worker` wrangler.jsonc
// (see the "template" project in vitest.config.ts): hub mounted under /_pinbox, the
// toolbar script route, and HTMLRewriter zero-touch staging injection.
//
// Origin stubbing: the plan calls for `fetchMock`, but @cloudflare/vitest-pool-workers
// 0.20.x no longer exports it from cloudflare:test. SELF's documented contract — "this
// `main` worker runs in the same isolate/context as tests, so any global mocks will
// apply to it too" — makes vi.stubGlobal("fetch", …) the supported replacement, and it
// additionally lets the origin stream delayed chunks (which fetchMock never could).
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type Envelope, makePost, pinInput } from "./fixtures/pin-fixtures.ts";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SNIPPET_SRC = "/_pinbox/pinbox.js";

async function hub(path: string, init?: RequestInit): Promise<{ status: number; body: Envelope }> {
  const res = await SELF.fetch(`https://staging.example/_pinbox${path}`, init as never);
  return { status: res.status, body: (await res.json()) as Envelope };
}

const post = makePost(AUTH);

// Stand-in origin server behind ORIGIN_URL: the template worker's injectToolbar uses
// the global fetch, which is shared with this isolate (see header comment).
function stubOrigin(handler: (req: Request) => Response | Promise<Response>): Request[] {
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push(req);
    return handler(req);
  });
  return seen;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// The core injection assertion: the snippet lands exactly once, inside <head>.
function expectInjectedOnceInHead(html: string): void {
  expect(countOf(html, SNIPPET_SRC)).toBe(1);
  expect(html.indexOf(SNIPPET_SRC)).toBeLessThan(html.indexOf("</head>"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hub mount under /_pinbox", () => {
  test("health is tokenless through the mount", async () => {
    const { status, body } = await hub("/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.["schemaVersion"]).toBe(1);
  });

  test("full product loop: create → list → reply → resolve → events", async () => {
    const created = await hub(...post("/pins", pinInput()));
    expect(created.status).toBe(201);
    const id = created.body.data?.id as string;
    expect(id).toMatch(/^pin_[a-z0-9]{10}$/);

    const listed = await hub("/pins", { headers: AUTH });
    expect(listed.status).toBe(200);
    expect((listed.body.data as unknown as unknown[]).length).toBe(1);

    const replied = await hub(...post(`/pins/${id}/thread`, { role: "human", text: "fix it" }));
    expect(replied.status).toBe(201);

    const resolved = await hub(...post(`/pins/${id}/resolve`, { by: "agent" }));
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.["status"]).toBe("resolved");

    const events = await hub("/events?after=0", { headers: AUTH });
    const types = (events.body.data as unknown as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(["pin.created", "thread.message", "pin.resolved"]);
  });

  test("wrong token through the mount is 401 E_AUTH", async () => {
    const { status, body } = await hub("/summary", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(status).toBe(401);
    expect(body.error?.code).toBe("E_AUTH");
  });

  test("/_pinbox/pinbox.js serves the toolbar script", async () => {
    const res = await SELF.fetch(`https://staging.example${SNIPPET_SRC}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toContain("pinbox");
  });
});

describe("zero-touch staging injection (HTMLRewriter)", () => {
  test("script tag lands exactly once before </head>; stale headers stripped", async () => {
    const requests = stubOrigin(
      () =>
        new Response("<html><head><title>app</title></head><body><h1>hi</h1></body></html>", {
          headers: {
            "content-type": "text/html; charset=utf-8",
            // workerd #5112: a decompressed pass-through keeps the stale header — the
            // template must strip both unconditionally on the rewritten path.
            "content-encoding": "gzip",
            "content-length": "9999",
          },
        }),
    );

    const res = await SELF.fetch("https://staging.example/some/page?x=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();

    const html = await res.text();
    expectInjectedOnceInHead(html);
    expect(html).toContain('data-pinbox-origin="https://origin.test"');

    // probe-found requirement: never let the origin compress what we must rewrite
    expect(requests.length).toBe(1);
    expect(requests[0]?.headers.get("accept-encoding")).toBe("identity");
    expect(new URL(requests[0]?.url ?? "").origin).toBe("https://origin.test");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/some/page");
  });

  test("a page that already mounts the toolbar is not double-mounted", async () => {
    stubOrigin(
      () =>
        new Response(
          `<html><head><script src="${SNIPPET_SRC}"></script></head><body>ok</body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
    );
    const res = await SELF.fetch("https://staging.example/already");
    const html = await res.text();
    expect(countOf(html, SNIPPET_SRC)).toBe(1);
  });

  test("non-HTML passes through byte-identical", async () => {
    const body = JSON.stringify({ ok: true, data: [1, 2, 3] });
    stubOrigin(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const res = await SELF.fetch("https://staging.example/api/data");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(body);
  });

  test("a chunked, delayed origin body is still injected (streaming rewriter)", async () => {
    // The case where Bun's rewriter yields zero chunks — proving we are on the right
    // runtime (HTMLRewriter is Worker-only; deep-dive §0).
    const encoder = new TextEncoder();
    stubOrigin(() => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("<html><head><title>slow"));
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue(encoder.encode("</title></head><body>late"));
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.enqueue(encoder.encode("</body></html>"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/html" } });
    });
    const res = await SELF.fetch("https://staging.example/slow");
    expectInjectedOnceInHead(await res.text());
  });

  test("a headless fragment still gets the snippet via the body/document ladder", async () => {
    stubOrigin(
      () => new Response("<p>bare fragment</p>", { headers: { "content-type": "text/html" } }),
    );
    const res = await SELF.fetch("https://staging.example/fragment");
    const html = await res.text();
    expect(countOf(html, SNIPPET_SRC)).toBe(1);
  });
});
