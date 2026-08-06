// buildBootstrap — the dev-served module source: side-effect import, hub + token
// attributes, and idempotency across HMR re-runs (the file-header rule).
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { buildBootstrap } from "./snippet.ts";

/** Strip the bare side-effect import (unresolvable outside a bundler) and run the rest. */
function runSnippet(source: string, document: unknown): void {
  const body = source.replace(/^import [^\n]+\n/m, "");
  new Function("document", body)(document);
}

function freshDocument(): { document: Document; fire: () => void } {
  const win = new Window();
  const document = win.document as unknown as Document;
  // happy-dom starts documents at readyState "complete" in this construction path, but
  // the snippet must handle both branches — fire covers the "loading" one when taken.
  const fire = () => {
    document.dispatchEvent(new win.Event("DOMContentLoaded") as unknown as Event);
  };
  return { document, fire };
}

describe("buildBootstrap", () => {
  test("contains the side-effect import of the toolbar package", () => {
    const source = buildBootstrap("http://127.0.0.1:4242", "tok_1");
    expect(source).toContain('import "@autono/pinbox-toolbar";');
  });

  test("mounts one element with hub and token attributes", () => {
    const { document, fire } = freshDocument();
    runSnippet(buildBootstrap("http://127.0.0.1:4242", "tok_abc"), document);
    fire();
    const els = document.querySelectorAll("pinbox-toolbar");
    expect(els.length).toBe(1);
    expect(els[0]?.getAttribute("hub")).toBe("http://127.0.0.1:4242");
    expect(els[0]?.getAttribute("token")).toBe("tok_abc");
  });

  test("omits the token attribute when no token is available", () => {
    const { document, fire } = freshDocument();
    runSnippet(buildBootstrap("http://127.0.0.1:4242"), document);
    fire();
    const el = document.querySelector("pinbox-toolbar");
    expect(el).not.toBeNull();
    expect(el?.hasAttribute("token")).toBe(false);
  });

  test("is idempotent across re-runs: one element, attributes refreshed", () => {
    const { document, fire } = freshDocument();
    runSnippet(buildBootstrap("http://127.0.0.1:4242", "tok_old"), document);
    fire();
    runSnippet(buildBootstrap("http://127.0.0.1:5353", "tok_new"), document);
    fire();
    const els = document.querySelectorAll("pinbox-toolbar");
    expect(els.length).toBe(1);
    expect(els[0]?.getAttribute("hub")).toBe("http://127.0.0.1:5353");
    expect(els[0]?.getAttribute("token")).toBe("tok_new");
  });

  test("re-run without a token clears a previously set one", () => {
    const { document, fire } = freshDocument();
    runSnippet(buildBootstrap("http://127.0.0.1:4242", "tok_old"), document);
    fire();
    runSnippet(buildBootstrap("http://127.0.0.1:4242"), document);
    fire();
    expect(document.querySelector("pinbox-toolbar")?.hasAttribute("token")).toBe(false);
  });
});
