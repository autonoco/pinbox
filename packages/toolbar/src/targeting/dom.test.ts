// @autono/pinbox-toolbar — DOM targeting tests.
// happy-dom per-test instances: new Window() and pass window.document in —
// never GlobalRegistrator, which would clobber fetch for sibling hub tests.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { buildSelector, targetLabel } from "./dom.ts";

function dom(html: string): Document {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

describe("targetLabel", () => {
  test("data-pb-el wins outright", () => {
    const doc = dom(`<h1 class="headline" data-pb-el="HEADLINE">capital</h1>`);
    const el = doc.querySelector("h1") as Element;
    expect(targetLabel(el)).toBe("HEADLINE");
  });

  test("ancestry label joins at most 3 parts with ›", () => {
    const doc = dom(
      `<div class="page"><div class="wrap"><div class="hero"><div class="btns"><div class="btn-a">go</div></div></div></div></div>`,
    );
    const el = doc.querySelector(".btn-a") as Element;
    const label = targetLabel(el);
    expect(label).toBe("HERO › BTNS › BTN-A");
    expect(label.split(" › ").length).toBeLessThanOrEqual(3);
  });

  test("an ancestor data-pb-el terminates the ancestry walk", () => {
    const doc = dom(
      `<div class="btns" data-pb-el="BUTTONS"><div class="btn-a">The thesis</div></div>`,
    );
    const el = doc.querySelector(".btn-a") as Element;
    expect(targetLabel(el)).toBe("BUTTONS › BTN-A");
  });

  test("sibling disambiguation appends an index", () => {
    const doc = dom(
      `<div class="pillars"><div class="pillar">a</div><div class="pillar">b</div><div class="pillar">c</div></div>`,
    );
    const second = doc.querySelectorAll(".pillar")[1] as Element;
    expect(targetLabel(second)).toBe("PILLARS › PILLAR 2");
  });

  test("classless elements label by tag; classless ancestors are skipped", () => {
    const doc = dom(`<section><p>text</p></section>`);
    const el = doc.querySelector("p") as Element;
    expect(targetLabel(el)).toBe("P");
    const classed = dom(`<section class="pricing"><p>text</p></section>`);
    expect(targetLabel(classed.querySelector("p") as Element)).toBe("PRICING › P");
  });
});

describe("buildSelector", () => {
  test("round-trips an id'd element", () => {
    const doc = dom(`<div><section id="metrics"><span>x</span></section></div>`);
    const el = doc.querySelector("#metrics") as Element;
    const sel = buildSelector(el);
    expect(sel.startsWith("#metrics")).toBe(true);
    expect(doc.querySelector(sel)).toBe(el);
  });

  test("round-trips a descendant of an id'd element", () => {
    const doc = dom(`<div id="hero"><div><p>a</p><p>b</p></div></div>`);
    const el = doc.querySelectorAll("p")[1] as Element;
    expect(doc.querySelector(buildSelector(el))).toBe(el);
  });

  test("round-trips nested classless elements via nth-of-type", () => {
    const doc = dom(
      `<div><div><span>one</span><span>two</span><span>three</span></div><div><span>four</span></div></div>`,
    );
    const el = doc.querySelectorAll("div > div > span")[2] as Element;
    expect(doc.querySelector(buildSelector(el))).toBe(el);
  });

  test("round-trips a data-attributed element", () => {
    const doc = dom(
      `<div><nav data-pb-el="NAVIGATION"><a>work</a></nav><nav><a>other</a></nav></div>`,
    );
    const el = doc.querySelector("[data-pb-el]") as Element;
    expect(doc.querySelector(buildSelector(el))).toBe(el);
  });
});
