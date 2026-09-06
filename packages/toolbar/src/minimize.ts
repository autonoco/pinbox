// @autono/pinbox-toolbar — minimize-to-puck controller.
// Ports the validated prototype (docs/design/toolbar/v3-minimize.html, plan in
// v3-minimize.md): the bar collapses into a draggable 48px puck and back. The
// sequencing is the whole trick — swap first, move second. Each endpoint
// crossfades the real element with an identical-geometry morph surface while
// the spring HOLDS, then morphs; arrivals reverse it (real element fades in
// over the settled surface, the layer fades out beneath). An opaque surface
// exists at every instant, so nothing ever pops.
//
// The drag/tap rules (primary button only, 8px start, 12px tap ceiling, a hold
// abandoned when the owner changes mid-press) live in motion/drag.ts, shared
// with the command bar; the three prototype regressions they guard are still
// named test cases in minimize.test.ts.
//
// A tap toggles the fan menu (vertical quick-actions out of the puck); the
// bar comes back via the fan's EXPAND, the M key, or restore().
//
// Release hands the landing to the REAL puck, not the morph surface (dogfood:
// "after I drag it, it stops being draggable"). The surface is pointer-inert and
// the ghosted puck was untouchable for the ~550 ms the spring took to settle, so
// a grab during that window fell through to the page. Now the puck is visible
// and grabbable the instant you let go; the spring still carries it home, and a
// press mid-flight simply starts the next drag from wherever it is.
import { attachDrag, clampToViewport, type Point, readPoint } from "./motion/drag.ts";
import { FOLLOW_SPRING, MORPH_SPRING, mkSpring } from "./motion/spring.ts";
import type { StorageLike } from "./transport/mirror.ts";
import type { FanAction, MinimizeUi } from "./ui/puck.ts";

const PUCK = 48;
const MARGIN = 16;
/** Spring hold while the surface swap crossfades (ms). */
const HOLD_MINIMIZE = 90;
const HOLD_RESTORE = 70;
/** Arrival: real element fades in first, morph layer fades this much later. */
const SWAP_FADE = 100;
/** …and is display:none'd once its own fade has finished. */
const LAYER_HIDE = 140;
const BAR_RADIUS = 4;
/** The carrier icon rides the surface only while it is puck-like (< this width). */
const CARRIER_MAX_W = 260;
/** Fan close transition length before display:none. */
const FAN_HIDE = 300;

export type MinimizeMode = "bar" | "toPuck" | "puck" | "drag" | "settle" | "toBar";

export interface MinimizeHost {
  win: Window;
  /** The command bar root (ghosted while minimized). */
  bar: HTMLElement;
  ui: MinimizeUi;
  /** Dock persistence; null degrades to session-only. Writes never throw upward. */
  storage: StorageLike | null;
  /** Mirror-style namespace: `pinbox:<endpoint>`. */
  storagePrefix: string;
  /** prefers-reduced-motion: instant swaps, no morph layer. */
  reduced: boolean;
  /** Config-supplied start state, used when nothing is persisted. */
  initialMinimized: boolean;
  /** A toggle settled: update the store, dispatch events, hand off focus. */
  onSettled(minimized: boolean, keyboard: boolean): void;
  /** A fan item other than EXPAND was chosen — the element runs the action
   * (placing, inbox, theme) WITHOUT restoring: that is the point of the fan. */
  onFanAction(action: Exclude<FanAction, "expand">): void;
}

export interface MinimizeController {
  minimized(): boolean;
  mode(): MinimizeMode;
  minimize(keyboard?: boolean): void;
  restore(keyboard?: boolean): void;
  /** Close the fan menu if open; true when something closed (Esc chaining). */
  closeFan(): boolean;
  /** Apply persisted/config state on (re)connect, instantly — no morph. */
  applyInitial(): void;
  destroy(): void;
}

export function createMinimize(host: MinimizeHost): MinimizeController {
  const { win, bar, ui } = host;
  const main = mkSpring({ x: 0, y: 0, w: 0, h: 0, r: 0 });
  let mode: MinimizeMode = "bar";
  let puckPos: { x: number; y: number } | null = null;
  let dock: { x: number; y: number } | null = loadDock();
  let keyboardToggle = false;
  let raf = 0;
  let last = 0;
  let holdTimer = 0;
  let fadeTimer = 0;
  let hideTimer = 0;
  let fanOpen = false;
  let fanTimer = 0;

  // ---- persistence (mirror convention: storage never throws upward) -------
  function loadDock(): Point | null {
    return readPoint(host.storage, `${host.storagePrefix}:dock`);
  }
  function persist(): void {
    try {
      if (dock) host.storage?.setItem(`${host.storagePrefix}:dock`, JSON.stringify(dock));
      host.storage?.setItem(`${host.storagePrefix}:minimized`, mode === "bar" ? "0" : "1");
    } catch {
      // private mode / quota — the choice just does not survive a reload
    }
  }
  function loadMinimized(): boolean {
    try {
      const raw = host.storage?.getItem(`${host.storagePrefix}:minimized`);
      return raw == null ? host.initialMinimized : raw === "1";
    } catch {
      return host.initialMinimized;
    }
  }

  // ---- geometry -----------------------------------------------------------
  function clampPos(p: Point): Point {
    return clampToViewport(p, win, { w: PUCK, h: PUCK }, MARGIN);
  }
  function defaultDock(): { x: number; y: number } {
    const r = bar.getBoundingClientRect();
    return { x: r.left + r.width / 2 - PUCK / 2, y: r.top + (r.height - PUCK) / 2 };
  }
  function placePuck(x: number, y: number): void {
    puckPos = { x, y };
    ui.puck.style.transform = `translate(${x}px, ${y}px)`;
  }

  // ---- morph layer --------------------------------------------------------
  function render(): void {
    const m = main.cur;
    ui.surface.style.width = `${m.w}px`;
    ui.surface.style.height = `${m.h}px`;
    ui.surface.style.borderRadius = `${m.r}px`;
    ui.surface.style.transform = `translate(${m.x}px, ${m.y}px)`;
    ui.carrier.style.transform = `translate(${m.x + m.w / 2 - PUCK / 2}px, ${m.y + m.h / 2 - PUCK / 2}px)`;
    // Settling: the real puck rides the spring (the morph layer is already hidden).
    if (mode === "settle") placePuck(m.x, m.y);
    const iconOn =
      mode === "drag" ||
      mode === "settle" ||
      ((mode === "toPuck" || mode === "toBar") && m.w < CARRIER_MAX_W);
    ui.carrier.classList.toggle("show", iconOn);
  }
  function showMorph(): void {
    win.clearTimeout(hideTimer);
    win.clearTimeout(fadeTimer);
    ui.morphWrap.hidden = false;
    void ui.morphWrap.offsetWidth;
    ui.morphWrap.classList.add("on");
  }
  function hideMorph(): void {
    ui.morphWrap.classList.remove("on");
    ui.carrier.classList.remove("show");
    win.clearTimeout(hideTimer);
    hideTimer = win.setTimeout(() => {
      ui.morphWrap.hidden = true;
    }, LAYER_HIDE);
  }

  // ---- animation loop -----------------------------------------------------
  function tick(now: number): void {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const done = main.step(dt);
    render();
    if (done && mode !== "drag") {
      raf = 0;
      if (mode === "toPuck" || mode === "settle") finishPuck();
      else if (mode === "toBar") finishBar();
    } else {
      raf = win.requestAnimationFrame(tick);
    }
  }
  function ensureLoop(): void {
    if (raf === 0) {
      last = win.performance.now();
      raf = win.requestAnimationFrame(tick);
    }
  }

  function finishPuck(): void {
    placePuck(main.cur.x, main.cur.y);
    ui.puck.classList.remove("pb-ghost");
    win.clearTimeout(fadeTimer);
    fadeTimer = win.setTimeout(hideMorph, SWAP_FADE);
    mode = "puck";
    persist();
    host.onSettled(true, keyboardToggle);
  }
  function finishBar(): void {
    bar.classList.remove("pb-ghost");
    win.clearTimeout(fadeTimer);
    fadeTimer = win.setTimeout(hideMorph, SWAP_FADE);
    mode = "bar";
    persist();
    host.onSettled(false, keyboardToggle);
  }

  // ---- transitions --------------------------------------------------------
  function minimize(keyboard = false): void {
    if (mode !== "bar") return;
    drag.cancel();
    keyboardToggle = keyboard;
    const r = bar.getBoundingClientRect();
    const d = clampPos(dock ?? defaultDock());
    bar.classList.add("pb-ghost");
    if (host.reduced) {
      placePuck(d.x, d.y);
      ui.puck.classList.remove("pb-ghost");
      mode = "puck";
      persist();
      host.onSettled(true, keyboard);
      return;
    }
    main.snap({ x: r.left, y: r.top, w: r.width, h: r.height, r: BAR_RADIUS });
    mode = "toPuck";
    render();
    showMorph();
    // Hold while the bar crossfades into the identical-geometry surface —
    // morphing during the swap reads as a glitchy double exposure.
    win.clearTimeout(holdTimer);
    holdTimer = win.setTimeout(() => {
      main.to({ x: d.x, y: d.y, w: PUCK, h: PUCK, r: PUCK / 2 }, MORPH_SPRING);
      ensureLoop();
    }, HOLD_MINIMIZE);
  }

  function restore(keyboard = false): void {
    if (mode !== "puck" || puckPos === null) return;
    closeFan();
    drag.cancel();
    keyboardToggle = keyboard;
    dock = { ...puckPos };
    ui.puck.classList.add("pb-ghost");
    if (host.reduced) {
      bar.classList.remove("pb-ghost");
      mode = "bar";
      persist();
      host.onSettled(false, keyboard);
      return;
    }
    const r = bar.getBoundingClientRect();
    main.snap({ x: puckPos.x, y: puckPos.y, w: PUCK, h: PUCK, r: PUCK / 2 });
    mode = "toBar";
    render();
    showMorph();
    win.clearTimeout(holdTimer);
    holdTimer = win.setTimeout(() => {
      main.to({ x: r.left, y: r.top, w: r.width, h: r.height, r: BAR_RADIUS }, MORPH_SPRING);
      ensureLoop();
    }, HOLD_RESTORE);
  }

  // ---- fan menu -----------------------------------------------------------
  /** Fan out of the puck: direction away from the nearer vertical edge,
   * labels sliding toward screen center. */
  function openFan(): void {
    if (mode !== "puck" || puckPos === null) return;
    win.clearTimeout(fanTimer);
    ui.fan.hidden = false;
    const upward = puckPos.y + PUCK / 2 > win.innerHeight / 2;
    ui.fan.classList.toggle("up", upward);
    ui.fan.classList.toggle("down", !upward);
    ui.fan.classList.toggle("labels-right", puckPos.x + PUCK / 2 < win.innerWidth / 2);
    ui.fan.classList.toggle("labels-left", puckPos.x + PUCK / 2 >= win.innerWidth / 2);
    ui.fan.style.left = `${puckPos.x + PUCK / 2 - 20}px`;
    void ui.fan.offsetHeight;
    const h = ui.fan.offsetHeight;
    ui.fan.style.top = upward ? `${puckPos.y - h - 10}px` : `${puckPos.y + PUCK + 10}px`;
    ui.fan.classList.add("on");
    ui.puck.setAttribute("aria-expanded", "true");
    fanOpen = true;
  }

  function closeFan(): boolean {
    if (!fanOpen) return false;
    ui.fan.classList.remove("on");
    ui.puck.setAttribute("aria-expanded", "false");
    fanOpen = false;
    win.clearTimeout(fanTimer);
    fanTimer = win.setTimeout(() => {
      ui.fan.hidden = true;
    }, FAN_HIDE);
    return true;
  }

  function onFanClick(e: MouseEvent): void {
    const item = (e.target as Element).closest?.("[data-act]");
    const act = item?.getAttribute("data-act") as FanAction | null | undefined;
    if (act == null) return;
    if (act === "expand") {
      closeFan();
      restore(e.detail === 0);
      return;
    }
    host.onFanAction(act);
  }

  /** Click-away, at the document level: shadow events retarget, so membership
   * is checked via composedPath, not target. */
  function onDocPointerDown(e: Event): void {
    if (!fanOpen) return;
    const path = e.composedPath();
    if (path.includes(ui.fan) || path.includes(ui.puck)) return;
    closeFan();
  }

  // ---- drag (rules in motion/drag.ts) --------------------------------------
  /** Grabbable at rest and while settling — mid-flight, the spring's current spot is the origin. */
  const grabbable = (): boolean => mode === "puck" || mode === "settle";
  const drag = attachDrag(ui.puck, {
    origin: () => {
      if (mode === "settle") return { x: main.cur.x, y: main.cur.y };
      return mode === "puck" ? puckPos : null;
    },
    // A keyboard restore mid-hold flips the mode; the held pointer must not drag the ghost.
    canStart: grabbable,
    onStart(origin) {
      closeFan();
      mode = "drag";
      if (!host.reduced) {
        ui.puck.classList.add("pb-ghost");
        main.snap({ x: origin.x, y: origin.y, w: PUCK, h: PUCK, r: PUCK / 2 });
        render();
        showMorph();
      }
    },
    onMove(next) {
      if (host.reduced) {
        const p = clampPos(next);
        placePuck(p.x, p.y);
      } else {
        main.to({ ...next, w: PUCK, h: PUCK, r: PUCK / 2 }, FOLLOW_SPRING);
        ensureLoop();
      }
    },
    onEnd({ dragged, started, origin }) {
      if (!dragged) {
        // A tap (even a slightly sloppy one) toggles the fan — the bar comes
        // back via the fan's EXPAND. If a drag had visually started, put the
        // puck back first.
        if (started && mode === "drag") {
          main.snap({ x: origin.x, y: origin.y, w: PUCK, h: PUCK, r: PUCK / 2 });
          placePuck(origin.x, origin.y);
          ui.puck.classList.remove("pb-ghost");
          hideMorph();
          mode = "puck";
        }
        if (!closeFan()) openFan();
        return;
      }
      if (host.reduced) {
        if (puckPos) {
          const p = clampPos(puckPos);
          placePuck(p.x, p.y);
          dock = { ...p };
        }
        mode = "puck";
        persist();
        return;
      }
      // Free placement: settle right where it was released, just inside the viewport. The REAL
      // puck takes over from the surface here, so it is grabbable at once (see header).
      const p = clampPos({ x: main.tgt.x, y: main.tgt.y });
      placePuck(main.cur.x, main.cur.y);
      ui.puck.classList.remove("pb-ghost");
      hideMorph();
      main.to({ ...p, w: PUCK, h: PUCK, r: PUCK / 2 }, MORPH_SPRING);
      mode = "settle";
      ensureLoop();
    },
  });

  /** Keyboard/AT activation is a synthesized click (detail 0) with no pointer events. */
  function onClick(e: MouseEvent): void {
    if (e.detail !== 0) return;
    if (!closeFan()) openFan();
  }

  function onResize(): void {
    closeFan();
    if (mode === "puck" && puckPos !== null) {
      const p = clampPos(puckPos);
      placePuck(p.x, p.y);
    }
    if (dock !== null) dock = clampPos(dock);
  }

  ui.puck.addEventListener("click", onClick);
  ui.fan.addEventListener("click", onFanClick);
  win.document.addEventListener("pointerdown", onDocPointerDown);
  win.addEventListener("resize", onResize);

  return {
    minimized: () => mode !== "bar",
    mode: () => mode,
    minimize,
    restore,
    closeFan,
    applyInitial() {
      if (!loadMinimized()) return;
      const apply = (): void => {
        if (mode !== "bar") return;
        const d = clampPos(dock ?? defaultDock());
        bar.classList.add("pb-ghost");
        placePuck(d.x, d.y);
        ui.puck.classList.remove("pb-ghost");
        mode = "puck";
        host.onSettled(true, false);
      };
      // Defer a frame when animating normally: at connect time the bar may not
      // have laid out yet, and defaultDock would measure a zero rect.
      if (host.reduced) apply();
      else win.requestAnimationFrame(apply);
    },
    destroy() {
      drag.destroy();
      ui.puck.removeEventListener("click", onClick);
      ui.fan.removeEventListener("click", onFanClick);
      win.document.removeEventListener("pointerdown", onDocPointerDown);
      win.removeEventListener("resize", onResize);
      if (raf !== 0) win.cancelAnimationFrame(raf);
      raf = 0;
      win.clearTimeout(holdTimer);
      win.clearTimeout(fadeTimer);
      win.clearTimeout(hideTimer);
      win.clearTimeout(fanTimer);
      ui.fan.hidden = true;
      ui.fan.classList.remove("on");
      fanOpen = false;
    },
  };
}
