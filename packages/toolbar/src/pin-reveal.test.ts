import { expect, spyOn, test } from "bun:test";
import type { Pin } from "@autono/pinbox-core/schema";
import { Window as HappyWindow } from "happy-dom";
import { pendingPinReveal, revealPin, samePinView, scrollToPin } from "./pin-reveal.ts";
import { anchorRect } from "./ui/pins.ts";

function fixture(url = "https://app.test/inbox?a=1&b=2") {
  const win = new HappyWindow({ url });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div style="overflow:auto"><div id="message">Target</div></div>';
  const element = doc.querySelector("#message") as HTMLElement;
  Object.defineProperty(element, "getClientRects", {
    value: () => [{ x: 0, y: 900, width: 100, height: 20 }],
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({
      x: 0,
      y: 900,
      left: 0,
      top: 900,
      right: 100,
      bottom: 920,
      width: 100,
      height: 20,
    }),
  });
  const scroll = spyOn(element, "scrollIntoView").mockImplementation(() => {});
  const pin: Pin = {
    id: "pin_test",
    text: "Target",
    kind: "comment",
    status: "open",
    schemaVersion: 1,
    createdAt: "2026-09-14T00:00:00Z",
    author: { userId: "test" },
    target: { url, selector: "#message" },
  };
  return { win, doc, element, scroll, pin };
}

test("scrolls the actual target through ancestor containers, including pins without stored rects", () => {
  const f = fixture();
  expect(scrollToPin(f.doc, f.pin)).toBe(true);
  expect(f.scroll).toHaveBeenCalledWith({ behavior: "instant", block: "center", inline: "center" });
  expect(anchorRect(f.doc, f.pin)?.y).toBe(900);
  f.win.close();
});

test("query ordering does not hide the same view", () => {
  const f = fixture();
  f.pin.target = { ...f.pin.target, url: "https://app.test/inbox?b=2&a=1" };
  expect(samePinView(f.win as unknown as Window, f.pin.target.url)).toBe(true);
  expect(scrollToPin(f.doc, f.pin)).toBe(true);
  expect(anchorRect(f.doc, f.pin)).not.toBeNull();
  f.win.close();
});

test("page-wide and missing targets do not scroll to invented coordinates", () => {
  const f = fixture();
  f.pin.target = { selector: "html" };
  expect(scrollToPin(f.doc, f.pin)).toBe(false);
  f.pin.target = { selector: "#missing" };
  expect(scrollToPin(f.doc, f.pin)).toBe(false);
  expect(f.scroll).not.toHaveBeenCalled();
  f.win.close();
});

test("same-origin navigation resumes only after the target arrives and consumes its intent once", () => {
  const f = fixture();
  f.pin.target = { url: "https://app.test/other", selector: "#message" };
  const nav = spyOn(f.win.location, "assign").mockImplementation((url) =>
    f.win.happyDOM.setURL(String(url)),
  );
  expect(revealPin(f.doc, f.pin, "hub")).toBe(true);
  expect(nav).toHaveBeenCalledWith("https://app.test/other");
  f.element.remove();
  expect(pendingPinReveal(f.doc, [f.pin], "hub")).toBeNull();
  f.doc.body.append(f.element);
  expect(pendingPinReveal(f.doc, [f.pin], "other-hub")).toBeNull();
  expect(pendingPinReveal(f.doc, [f.pin], "hub")).toBe(f.pin.id);
  expect(pendingPinReveal(f.doc, [f.pin], "hub")).toBeNull();
  f.win.close();
});

test("external URLs never navigate and expired intents never reopen a pin", () => {
  const f = fixture();
  const nav = spyOn(f.win.location, "assign").mockImplementation(() => {});
  f.pin.target = { url: "https://other.test/elsewhere", selector: "#message" };
  expect(revealPin(f.doc, f.pin, "hub")).toBe(false);
  expect(nav).not.toHaveBeenCalled();
  f.win.sessionStorage.setItem("pinbox:hub:reveal", JSON.stringify({ id: f.pin.id, expires: 1 }));
  expect(pendingPinReveal(f.doc, [f.pin], "hub")).toBeNull();
  expect(f.win.sessionStorage.getItem("pinbox:hub:reveal")).toBeNull();
  f.win.close();
});
