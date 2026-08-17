// @autono/pinbox-toolbar — minimize-to-puck controller.
// Ports the validated prototype (docs/design/toolbar/v3-minimize.html, plan in
// v3-minimize.md): the bar collapses into a draggable 48px puck and back. The
// sequencing is the whole trick — swap first, move second. Each endpoint
// crossfades the real element with an identical-geometry morph surface while
// the spring HOLDS, then morphs; arrivals reverse it (real element fades in
// over the settled surface, the layer fades out beneath). An opaque surface
// exists at every instant, so nothing ever pops.
//
// Three regressions this file must never reintroduce (each hit for real in
// the prototype, each a named test case in minimize.test.ts):
//   - a non-primary-button press must not start a drag (macOS right-click
//     never delivers pointerup — the pending drag wedged the UI)
//   - restore()/minimize() clear pending pointer state, and a drag may only
//     START from mode "puck" (a keyboard restore mid-hold otherwise let the
//     next pointermove hijack the morph)
//   - a release under TAP_MAX total travel is a tap and restores — trackpad
//     clicks wander several pixels, and treating them as drags read as the
//     puck "not responding"
import { FOLLOW_SPRING, MORPH_SPRING, mkSpring } from "./motion/spring.ts";
import type { StorageLike } from "./transport/mirror.ts";
import type { MinimizeUi } from "./ui/puck.ts";

const PUCK = 48;
const MARGIN = 16;
/** Movement that begins a drag… */
const DRAG_START = 8;
/** …but a release under this much TOTAL travel is still a tap. */
const TAP_MAX = 12;
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
}

export interface MinimizeController {
  minimized(): boolean;
  mode(): MinimizeMode;
  minimize(keyboard?: boolean): void;
  restore(keyboard?: boolean): void;
  /** Apply persisted/config state on (re)connect, instantly — no morph. */
  applyInitial(): void;
  destroy(): void;
}

interface PointerHold {
  px: number;
  py: number;
  ox: number;
  oy: number;
  lx: number;
  ly: number;
  moved: boolean;
}

export function createMinimize(host: MinimizeHost): MinimizeController {
  const { win, bar, ui } = host;
  const main = mkSpring({ x: 0, y: 0, w: 0, h: 0, r: 0 });
  let mode: MinimizeMode = "bar";
  let puckPos: { x: number; y: number } | null = null;
  let dock: { x: number; y: number } | null = loadDock();
  let pdown: PointerHold | null = null;
  let keyboardToggle = false;
  let raf = 0;
  let last = 0;
  let holdTimer = 0;
  let fadeTimer = 0;
  let hideTimer = 0;

  // ---- persistence (mirror convention: storage never throws upward) -------
  function loadDock(): { x: number; y: number } | null {
    try {
      const raw = host.storage?.getItem(`${host.storagePrefix}:dock`);
      if (raw == null) return null;
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
      if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
      return { x: parsed.x, y: parsed.y };
    } catch {
      return null;
    }
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
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  function clampPos(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: clamp(p.x, MARGIN, win.innerWidth - MARGIN - PUCK),
      y: clamp(p.y, MARGIN, win.innerHeight - MARGIN - PUCK),
    };
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
    pdown = null;
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
    pdown = null;
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

  // ---- drag ---------------------------------------------------------------
  function onPointerDown(e: PointerEvent): void {
    if (mode !== "puck" || e.button !== 0) return;
    try {
      ui.puck.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointer events have no capturable pointer
    }
    if (puckPos === null) return;
    pdown = {
      px: e.clientX,
      py: e.clientY,
      ox: puckPos.x,
      oy: puckPos.y,
      lx: e.clientX,
      ly: e.clientY,
      moved: false,
    };
  }

  function onPointerMove(e: PointerEvent): void {
    if (pdown === null) return;
    pdown.lx = e.clientX;
    pdown.ly = e.clientY;
    const dx = e.clientX - pdown.px;
    const dy = e.clientY - pdown.py;
    if (!pdown.moved) {
      if (mode !== "puck") {
        // A keyboard restore ran mid-hold — abandon the pending drag.
        pdown = null;
        return;
      }
      if (Math.hypot(dx, dy) < DRAG_START) return;
      pdown.moved = true;
      mode = "drag";
      if (!host.reduced) {
        ui.puck.classList.add("pb-ghost");
        main.snap({ x: pdown.ox, y: pdown.oy, w: PUCK, h: PUCK, r: PUCK / 2 });
        render();
        showMorph();
      }
    }
    const next = { x: pdown.ox + dx, y: pdown.oy + dy };
    if (host.reduced) {
      const p = clampPos(next);
      placePuck(p.x, p.y);
    } else {
      main.to({ ...next, w: PUCK, h: PUCK, r: PUCK / 2 }, FOLLOW_SPRING);
      ensureLoop();
    }
  }

  function onPointerUp(): void {
    if (pdown === null) return;
    const total = Math.hypot(pdown.lx - pdown.px, pdown.ly - pdown.py);
    const wasDrag = pdown.moved && total >= TAP_MAX;
    const origin = { x: pdown.ox, y: pdown.oy };
    const startedDrag = pdown.moved;
    pdown = null;
    if (!wasDrag) {
      // A tap (even a slightly sloppy one) restores. If a drag had visually
      // started, put the puck back first so restore launches from its spot.
      if (startedDrag && mode === "drag") {
        main.snap({ x: origin.x, y: origin.y, w: PUCK, h: PUCK, r: PUCK / 2 });
        placePuck(origin.x, origin.y);
        ui.puck.classList.remove("pb-ghost");
        hideMorph();
        mode = "puck";
      }
      restore(false);
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
    // Free placement: settle right where it was released, just inside the viewport.
    const p = clampPos({ x: main.tgt.x, y: main.tgt.y });
    main.to({ ...p, w: PUCK, h: PUCK, r: PUCK / 2 }, MORPH_SPRING);
    mode = "settle";
    ensureLoop();
  }

  /** Keyboard/AT activation is a synthesized click (detail 0) with no pointer events. */
  function onClick(e: MouseEvent): void {
    if (e.detail === 0) restore(true);
  }

  function onResize(): void {
    if (mode === "puck" && puckPos !== null) {
      const p = clampPos(puckPos);
      placePuck(p.x, p.y);
    }
    if (dock !== null) dock = clampPos(dock);
  }

  ui.puck.addEventListener("pointerdown", onPointerDown);
  ui.puck.addEventListener("pointermove", onPointerMove);
  ui.puck.addEventListener("pointerup", onPointerUp);
  ui.puck.addEventListener("pointercancel", onPointerUp);
  ui.puck.addEventListener("click", onClick);
  win.addEventListener("resize", onResize);

  return {
    minimized: () => mode !== "bar",
    mode: () => mode,
    minimize,
    restore,
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
      ui.puck.removeEventListener("pointerdown", onPointerDown);
      ui.puck.removeEventListener("pointermove", onPointerMove);
      ui.puck.removeEventListener("pointerup", onPointerUp);
      ui.puck.removeEventListener("pointercancel", onPointerUp);
      ui.puck.removeEventListener("click", onClick);
      win.removeEventListener("resize", onResize);
      if (raf !== 0) win.cancelAnimationFrame(raf);
      raf = 0;
      win.clearTimeout(holdTimer);
      win.clearTimeout(fadeTimer);
      win.clearTimeout(hideTimer);
    },
  };
}
