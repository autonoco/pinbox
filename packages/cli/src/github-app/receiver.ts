// pinbox CLI — the loopback receiver for the GitHub App manifest round trip.
// Serves the self-submitting manifest form at `/` and waits for GitHub's redirect to
// `/callback?code=…&state=…`. Bound to 127.0.0.1 on an ephemeral port; lives for one code.
import { donePageHtml } from "./manifest.ts";

export interface Receiver {
  /** `http://127.0.0.1:<port>` — the page to open, and the base of the redirect URL. */
  readonly origin: string;
  /** Resolves with GitHub's one-time code once a redirect carrying our `state` arrives. */
  waitForCode(state: string, timeoutMs: number): Promise<string>;
  close(): void;
}

/** `formHtml` is computed lazily so the redirect URL (which needs the port) can be part of it. */
export function startReceiver(formHtml: (origin: string) => string): Receiver {
  let resolveCode: ((code: string) => void) | null = null;
  let expectedState = "";
  let origin = ""; // known once the port is assigned, below
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(formHtml(origin), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const ok = code !== null && url.searchParams.get("state") === expectedState;
        if (ok && resolveCode !== null) resolveCode(code);
        return new Response(donePageHtml(ok), {
          status: ok ? 200 : 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    waitForCode(state, timeoutMs) {
      expectedState = state;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for GitHub to redirect back")),
          timeoutMs,
        );
        resolveCode = (code) => {
          clearTimeout(timer);
          resolve(code);
        };
      });
    },
    close() {
      server.stop(true);
    },
  };
}
