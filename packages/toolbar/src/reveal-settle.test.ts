import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { settlePinReveal } from "./reveal-settle.ts";

function clock() {
  const win = new Window();
  const timers = new Map<number, () => void>();
  let id = 0;
  spyOn(win, "setTimeout").mockImplementation((fn) => {
    timers.set(++id, fn as () => void);
    return id as unknown as ReturnType<typeof win.setTimeout>;
  });
  spyOn(win, "clearTimeout").mockImplementation((key) => {
    timers.delete(Number(key));
  });
  return {
    win,
    doc: win.document as unknown as Document,
    tick() {
      const entry = timers.entries().next().value;
      if (entry) {
        timers.delete(entry[0]);
        entry[1]();
      }
    },
    timers,
  };
}

test("navigation reveal has a bounded settling period", () => {
  const f = clock();
  let calls = 0;
  settlePinReveal(f.doc, () => calls++);
  for (let i = 0; i < 20; i++) f.tick();
  expect(calls).toBe(10);
  expect(f.timers.size).toBe(0);
  f.win.close();
});

test("human scrolling cancels pending automatic reveals immediately", () => {
  const f = clock();
  let calls = 0;
  settlePinReveal(f.doc, () => calls++);
  f.tick();
  f.win.document.dispatchEvent(new f.win.Event("wheel"));
  f.tick();
  expect(calls).toBe(1);
  expect(f.timers.size).toBe(0);
  f.win.close();
});
