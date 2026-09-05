// @autono/pinbox-toolbar — inbox drawer tests: row actions and link groups.
// happy-dom per-test instances: new Window(); never GlobalRegistrator.
import { describe, expect, mock, test } from "bun:test";
import type { Pin } from "@autono/pinbox-core/schema";
import { Window } from "happy-dom";
import { initialState, type ToolbarState } from "../state.ts";
import { createDrawer, type DrawerHandlers, groupByLink } from "./drawer.ts";

function docIn(): Document {
  return new Window().document as unknown as Document;
}

function makePin(id: string, overrides: Partial<Pin> = {}): Pin {
  return {
    id,
    schemaVersion: 1,
    status: "open",
    createdAt: "2026-08-04T00:00:00.000Z",
    text: `pin ${id}`,
    kind: "note",
    author: { userId: "u1" },
    ...overrides,
  };
}

const PR58 = { connector: "github", ref: "58", url: "https://github.com/x/y/pull/58" };

function spies(): DrawerHandlers & {
  onActivate: ReturnType<typeof mock>;
  onResolve: ReturnType<typeof mock>;
  onUnresolve: ReturnType<typeof mock>;
} {
  return { onActivate: mock(), onClose: mock(), onResolve: mock(), onUnresolve: mock() };
}

function open(pins: Pin[], extra: Partial<ToolbarState> = {}): ToolbarState {
  return { ...initialState(), pins, inboxOpen: true, ...extra };
}

function click(root: HTMLElement, selector: string): void {
  (root.querySelector(selector) as HTMLElement).click();
}

describe("drawer row actions", () => {
  test("an open row resolves; a resolved row unresolves; the body still activates", () => {
    const on = spies();
    const d = createDrawer(docIn(), on);
    const a = makePin("pin_aaaaaaaaaa");
    const b = makePin("pin_bbbbbbbbbb", {
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T01:00:00.000Z" },
    });
    d.update(open([a, b]));
    click(d.root, '[data-item="pin_aaaaaaaaaa"] [data-act="resolve"]');
    expect(on.onResolve).toHaveBeenCalledWith("pin_aaaaaaaaaa");
    click(d.root, '[data-item="pin_aaaaaaaaaa"] .tt');
    expect(on.onActivate).toHaveBeenCalledWith("pin_aaaaaaaaaa");
    click(d.root, '[data-tab="resolved"]');
    click(d.root, '[data-item="pin_bbbbbbbbbb"] [data-act="unresolve"]');
    expect(on.onUnresolve).toHaveBeenCalledWith("pin_bbbbbbbbbb");
  });

  test("a queued row has no resolve — the hub does not know it yet", () => {
    const d = createDrawer(docIn(), spies());
    const a = makePin("pin_aaaaaaaaaa");
    d.update(open([a], { queuedIds: new Set([a.id]) }));
    expect(d.root.querySelector('[data-act="resolve"]')).toBeNull();
    expect(d.root.textContent).toContain("QUEUED");
  });
});

describe("drawer link groups", () => {
  test("groupByLink keeps loose pins apart and groups by connector#ref in first-seen order", () => {
    const loose = makePin("pin_llllllllll");
    const p1 = makePin("pin_1111111111", { links: [PR58] });
    const p2 = makePin("pin_2222222222", { links: [{ connector: "github", ref: "60", url: "" }] });
    const p3 = makePin("pin_3333333333", { links: [PR58] });
    const g = groupByLink([p1, loose, p2, p3]);
    expect(g.loose).toEqual([loose]);
    expect([...g.groups.keys()]).toEqual(["github#58", "github#60"]);
    expect(g.groups.get("github#58")).toEqual([p1, p3]);
  });

  test("Resolve group needs a confirming click, then resolves every pin with the shipped note", () => {
    const on = spies();
    const d = createDrawer(docIn(), on);
    const p1 = makePin("pin_1111111111", { links: [PR58] });
    const p2 = makePin("pin_2222222222", { links: [PR58] });
    const loose = makePin("pin_llllllllll");
    d.update(open([p1, loose, p2]));
    const header = d.root.querySelector(".pb-group") as HTMLElement;
    expect(header.textContent).toContain("github");
    expect(header.textContent).toContain("#58");
    // Loose pins list first, the group after.
    const order = [...d.root.querySelectorAll("[data-item]")].map((n) =>
      n.getAttribute("data-item"),
    );
    expect(order).toEqual(["pin_llllllllll", "pin_1111111111", "pin_2222222222"]);
    click(d.root, "[data-group-resolve]");
    expect(on.onResolve).not.toHaveBeenCalled();
    expect((d.root.querySelector("[data-group-resolve]") as HTMLElement).textContent).toBe(
      "CONFIRM?",
    );
    click(d.root, "[data-group-resolve]");
    expect(on.onResolve.mock.calls).toEqual([
      ["pin_1111111111", "shipped in github#58"],
      ["pin_2222222222", "shipped in github#58"],
    ]);
    expect((d.root.querySelector("[data-group-resolve]") as HTMLElement).textContent).toBe(
      "RESOLVE 2",
    );
  });

  test("the RESOLVED tab is a flat list with no group headers", () => {
    const d = createDrawer(docIn(), spies());
    const p1 = makePin("pin_1111111111", {
      links: [PR58],
      status: "resolved",
      resolution: { by: "human", at: "2026-08-04T01:00:00.000Z" },
    });
    d.update(open([p1]));
    click(d.root, '[data-tab="resolved"]');
    expect(d.root.querySelector(".pb-group")).toBeNull();
    expect(d.root.querySelector('[data-act="unresolve"]')).not.toBeNull();
  });
});
