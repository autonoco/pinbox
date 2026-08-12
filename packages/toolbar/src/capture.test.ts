// @autono/pinbox-toolbar — captureTarget tests.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureTarget } from "./capture.ts";

function page(html: string): Window {
  const window = new Window({ url: "http://localhost:5173/pricing" });
  window.document.body.innerHTML = html;
  return window;
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

describe("captureTarget", () => {
  test("selector + rect round-trip on a nested tree", () => {
    const w = page(
      `<main><section class="plans"><div class="plan"><button>Buy</button></div>` +
        `<div class="plan"><button>Buy pro</button></div></section></main>`,
    );
    const el = w.document.querySelectorAll("button")[1] as unknown as Element;
    stubRect(el, { x: 40, y: 300, width: 120, height: 32 });

    const res = captureTarget(el);
    expect(w.document.querySelector(res.target.selector) as unknown as Element).toBe(el);
    expect(res.target.rect).toEqual({ x: 40, y: 300, width: 120, height: 32 });
    expect(res.target.tag).toBe("button");
    expect(res.target.url).toBe("http://localhost:5173/pricing");
    expect(res.target.fixed).toBe(false);
    expect(res.target.anchor).toBeUndefined();
  });

  test("fixed: true when an ancestor has position: fixed", () => {
    const w = page(`<div class="nav" style="position: fixed"><a href="/docs">Docs</a></div>`);
    const el = w.document.querySelector("a") as unknown as Element;
    expect(captureTarget(el).target.fixed).toBe(true);
  });

  test("aria map picks up aria-label; curated style subset only", () => {
    const w = page(
      `<button aria-label="Send" aria-pressed="false" style="display: inline-flex">Go</button>`,
    );
    const el = w.document.querySelector("button") as unknown as Element;
    const ctx = captureTarget(el).target.context;
    expect(ctx?.aria).toEqual({ "aria-label": "Send", "aria-pressed": "false" });
    const allowed = new Set([
      "display",
      "position",
      "font-size",
      "color",
      "background-color",
      "margin",
      "padding",
      "overflow",
    ]);
    for (const key of Object.keys(ctx?.styles ?? {})) expect(allowed.has(key)).toBe(true);
    expect(ctx?.styles?.["display"]).toBe("inline-flex");
  });

  test("nearbyText collapses whitespace and truncates at 160", () => {
    const w = page(`<p>  ${"word ".repeat(80)} </p>`);
    const el = w.document.querySelector("p") as unknown as Element;
    const text = captureTarget(el).target.context?.nearbyText;
    expect(text).toBeDefined();
    expect((text as string).length).toBe(160);
    expect((text as string).startsWith("word word")).toBe(true);
  });

  test("env carries viewport {w,h,dpr} + colorScheme from matchMedia", () => {
    const w = page(`<div class="hero">Hi</div>`);
    (w as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({
      matches: q.includes("dark"),
    });
    const el = w.document.querySelector("div") as unknown as Element;
    const env = captureTarget(el).env;
    expect(env.viewport).toEqual({ w: w.innerWidth, h: w.innerHeight, dpr: w.devicePixelRatio });
    expect(env.colorScheme).toBe("dark");
    expect(typeof env.browser).toBe("string");
    expect(typeof env.os).toBe("string");
  });

  test("opts.anchor lands on target.anchor", () => {
    const w = page(`<div data-pb-anchor="hero">Hi</div>`);
    const el = w.document.querySelector("div") as unknown as Element;
    expect(captureTarget(el, { anchor: "hero" }).target.anchor).toBe("hero");
  });
});

describe("the text a pin can offer up for editing", () => {
  function runsFor(html: string): string[] | undefined {
    const window = new Window();
    window.document.body.innerHTML = html;
    const el = window.document.body.firstElementChild as unknown as Element;
    return captureTarget(el).target.context?.textRuns;
  }

  test("a plain element is one run", () => {
    expect(runsFor("<h1>capital, deployed</h1>")).toEqual(["capital, deployed"]);
  });

  test("a group is one run per piece of text in it", () => {
    expect(runsFor("<nav><a>work</a><a>approach</a><a>people</a></nav>")).toEqual([
      "work",
      "approach",
      "people",
    ]);
  });

  test("text either side of an inline element survives", () => {
    // The case the old element-based walk dropped: "Hello" was invisible to it, so it could
    // never be edited and the agent was never told it existed.
    expect(runsFor("<p>Hello <b>world</b> again</p>")).toEqual(["Hello", "world", "again"]);
  });

  test("scripts and styles are not content", () => {
    expect(
      runsFor("<div>real<script>var x = 1;</script><style>a{color:red}</style></div>"),
    ).toEqual(["real"]);
  });

  test("a region too large to rewrite as a set offers nothing", () => {
    const many = Array.from({ length: 60 }, (_, i) => `<span>${i}</span>`).join("");
    expect(runsFor(`<div>${many}</div>`)).toBeUndefined();
  });
});
