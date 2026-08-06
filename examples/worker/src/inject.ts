// HTMLRewriter zero-touch staging injection — Worker-only, per the research: the
// streaming rewriter cannot run under Bun (deep-dive §0; the local proxy is the CLI's
// stream scanner instead). Proxies ORIGIN_URL and stamps the toolbar snippet into HTML.
//
// The five probe-found binding rules, plus the ladder:
//   1. injection targets head → fallback body → fallback document end, guarded by a
//      per-request closure flag (never module state — Workers handle concurrent requests)
//   2. idempotency: a page that already mounts a pinbox script is not double-mounted
//   3. strip content-length AND content-encoding unconditionally on the rewritten path
//      (workerd #5112 leaves a stale content-encoding on decompressed pass-throughs)
//   4. send `accept-encoding: identity` upstream — never rewrite compressed bytes
//   5. gate on content-type text/html; everything else passes through untouched
// Workers-subset constraint: only a Response goes into transform(), only a string into
// append()/before().

type InjectEnv = { ORIGIN_URL?: string };

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

// The snippet stamps the hub URL (/_pinbox) and NEVER a token (deep-dive §2.3 — the
// page is untrusted; auth is the hub's job). The proxied origin rides along as
// data-pinbox-origin so the toolbar can rewrite target.url back to the real origin.
function toolbarSnippet(originUrl: string): string {
  const origin = escapeAttribute(originUrl);
  return `<script src="/_pinbox/pinbox.js" data-pinbox-hub="/_pinbox" data-pinbox-origin="${origin}" defer></script>`;
}

export async function injectToolbar(req: Request, env: InjectEnv): Promise<Response> {
  const url = new URL(req.url);
  const upstreamUrl = new URL(url.pathname + url.search, env.ORIGIN_URL);
  const headers = new Headers(req.headers);
  headers.set("accept-encoding", "identity"); // rule 4
  const upstream = await fetch(upstreamUrl.toString(), {
    method: req.method,
    headers,
    body: req.body,
    redirect: "manual",
  });

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return upstream; // rule 5

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-length"); // rule 3
  outHeaders.delete("content-encoding");
  const response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });

  // rule 1: per-request closure flags, never module state
  let injected = false;
  let alreadyMounted = false;
  const snippet = toolbarSnippet(env.ORIGIN_URL ?? "");
  const inject = (end: { before(content: string, options?: { html: boolean }): unknown }) => {
    if (!injected && !alreadyMounted) end.before(snippet, { html: true });
    injected = true;
  };
  return new HTMLRewriter()
    .on('script[src*="pinbox"]', {
      element() {
        alreadyMounted = true; // rule 2 — the page mounts the toolbar itself
      },
    })
    .on("head", {
      element(element) {
        element.onEndTag(inject);
      },
    })
    .on("body", {
      element(element) {
        element.onEndTag(inject);
      },
    })
    .onDocument({
      end(end) {
        if (!injected && !alreadyMounted) end.append(snippet, { html: true });
      },
    })
    .transform(response);
}
