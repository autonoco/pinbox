// screenshot-dom.ts — the snapshot's DOM preparation (happy-dom has getComputedStyle and
// XMLSerializer; it has no canvas or Image, so the rasterize path resolves null here — the
// demo page checklist covers pixels).
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureElementDom, cloneForSnapshot, svgFor } from "./screenshot-dom.ts";

function elementIn(html: string): Element {
  const window = new Window({ url: "http://localhost:5173/" });
  window.document.body.innerHTML = html;
  return window.document.body.firstElementChild as unknown as Element;
}

describe("cloneForSnapshot", () => {
  test("inlines computed styles, boxes out images, keeps data: images, drops scripts", () => {
    const el = elementIn(
      '<section style="color: rgb(1, 2, 3)"><img src="https://cdn.example/x.png">' +
        '<img src="data:image/png;base64,AAAA"><script>alert(1)</script><p>hi</p></section>',
    );
    const clone = cloneForSnapshot(el) as HTMLElement;
    expect(clone).not.toBeNull();
    expect(clone.style.cssText).toContain("color");
    expect(clone.querySelectorAll("img").length).toBe(1);
    expect(clone.querySelector("img")?.getAttribute("src")).toStartWith("data:");
    expect(clone.querySelector("script")).toBeNull();
    expect(clone.querySelectorAll("span").length).toBe(1); // the placeholder box
    // The source is untouched.
    expect(el.querySelectorAll("img").length).toBe(2);
    expect(el.querySelector("script")).not.toBeNull();
  });

  test("refuses a subtree too large to snapshot responsively", () => {
    const el = elementIn(`<div>${"<i></i>".repeat(1600)}</div>`);
    expect(cloneForSnapshot(el)).toBeNull();
  });
});

describe("svgFor", () => {
  test("wraps the serialized clone in a sized foreignObject", () => {
    const el = elementIn("<b>x</b>");
    const svg = svgFor(cloneForSnapshot(el) as Element, 120, 40);
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">');
    expect(svg).toContain("<foreignObject");
    expect(svg).toContain("x</b>");
  });
});

describe("captureElementDom", () => {
  test("resolves null (never throws) where there is no Image/canvas", async () => {
    const el = elementIn("<div>hi</div>");
    await expect(captureElementDom(el)).resolves.toBeNull();
  });
});
