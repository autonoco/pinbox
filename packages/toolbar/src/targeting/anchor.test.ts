// @autono/pinbox-toolbar — anchor targeting tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { anchorTarget, listAnchors } from "./anchor.ts";

function docWith(html: string): { window: Window; doc: Document } {
  const window = new Window({ url: "http://localhost:5173/studio" });
  window.document.body.innerHTML = html;
  return { window, doc: window.document as unknown as Document };
}

describe("listAnchors", () => {
  test("finds data-pb-anchor elements in document order", () => {
    const { doc } = docWith(
      `<header data-pb-anchor="masthead">A</header>` +
        `<main><div data-pb-anchor="hero">B</div><div>plain</div>` +
        `<footer data-pb-anchor="legal">C</footer></main>`,
    );
    const anchors = listAnchors(doc, "data-pb-anchor");
    expect(anchors.map((a) => a.anchor)).toEqual(["masthead", "hero", "legal"]);
    expect(anchors[1]?.el.textContent).toBe("B");
  });

  test("supports a custom attribute name and skips empty values", () => {
    const { doc } = docWith(
      `<div data-comment-anchor="one">1</div><div data-comment-anchor>2</div>`,
    );
    expect(listAnchors(doc, "data-comment-anchor").map((a) => a.anchor)).toEqual(["one"]);
  });
});

describe("anchorTarget", () => {
  test("sets target.anchor and a via:'none' source", () => {
    const { doc } = docWith(`<div data-pb-anchor="hero">Hero</div>`);
    const el = doc.querySelector("[data-pb-anchor]") as Element;
    const res = anchorTarget("hero", el);
    expect(res.target.anchor).toBe("hero");
    expect(res.target.source?.via).toBe("none");
    expect(res.target.selector).toContain('data-pb-anchor="hero"');
    expect(res.env.viewport.w).toBeGreaterThan(0);
  });
});
