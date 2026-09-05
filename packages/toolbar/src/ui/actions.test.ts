// ui/actions.ts — the table's invariants, and that the surfaces render from it.
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createStore } from "../state.ts";
import { ACTION_BY_KEY, ACTIONS, titleOf } from "./actions.ts";
import { createBar } from "./bar.ts";
import { createMinimizeUi } from "./puck.ts";

const win = new Window();
const doc = win.document as unknown as Document;

describe("action table", () => {
  test("keys are unique and every keyed action is dispatchable", () => {
    const keyed = ACTIONS.filter((a) => a.key !== undefined);
    expect(new Set(keyed.map((a) => a.key)).size).toBe(keyed.length);
    for (const a of keyed) expect(ACTION_BY_KEY.get(a.key as string)).toBe(a.id);
  });

  test("titles carry the key", () => {
    expect(titleOf(ACTIONS.find((a) => a.id === "pin") as (typeof ACTIONS)[number])).toBe(
      "Drop a pin (P)",
    );
  });

  test("the bar renders one button per bar action, with HIDE now present", () => {
    const bar = createBar(doc, { onAction: () => {} });
    const refs = [...bar.root.querySelectorAll("button[data-ref]")].map((b) =>
      b.getAttribute("data-ref"),
    );
    const expected = ACTIONS.filter((a) => a.bar !== undefined).map((a) =>
      a.id === "minimize" ? "min" : a.id,
    );
    expect(refs).toEqual(expected);
    expect(refs).toContain("hide");
  });

  test("the fan renders one item per fan action, with COPY now present", () => {
    const ui = createMinimizeUi(doc);
    const acts = [...ui.fan.querySelectorAll("[data-act]")].map((el) =>
      el.getAttribute("data-act"),
    );
    const expected = ACTIONS.filter((a) => a.fan !== undefined).map((a) => a.fan?.act ?? a.id);
    expect(acts).toEqual(expected);
    expect(acts).toContain("copy");
  });

  test("bar clicks report the action id; the hide button flips with the layer", () => {
    const seen: string[] = [];
    const bar = createBar(doc, { onAction: (id) => seen.push(id) });
    (bar.root.querySelector('[data-ref="hide"]') as HTMLElement).click();
    (bar.root.querySelector('[data-ref="min"]') as HTMLElement).click();
    expect(seen).toEqual(["hide", "minimize"]);
    const store = createStore();
    bar.update(store.get());
    const hide = bar.root.querySelector('[data-ref="hide"]') as HTMLElement;
    expect(hide.classList.contains("lit")).toBe(false);
    store.update({ pinsHidden: true });
    bar.update(store.get());
    expect(hide.classList.contains("lit")).toBe(true);
    expect(hide.title).toBe("Show pins (H)");
  });
});
