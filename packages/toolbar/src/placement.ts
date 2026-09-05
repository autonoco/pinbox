// @autono/pinbox-toolbar — placement controller
// Everything between "placing mode armed" and "a client-only draft exists":
// the hover reticle, the touch drag-aim grip, hit-testing, shift+click
// multi-target accumulation and the dashed marks that receipt it. Split out of
// element.ts (file-size rule) as one unit because these pieces share state —
// the hovered element, the pending extra targets, the per-frame viewport probe
// — and nothing else in the element reads any of it. Overlay coordinates are
// page-space (pageX/pageY); the reticle and aim layers are position: fixed.
import { type BrowserTarget, captureTarget } from "./capture.ts";
import type { Store } from "./state.ts";
import { hitTest, targetLabel } from "./targeting/dom.ts";
import { type Aim, createAim, needsDragAim, startPoint } from "./ui/aim.ts";
import { renderMultiMarks } from "./ui/multimarks.ts";
import { createReticle, type Reticle } from "./ui/reticle.ts";

export interface PlacementDeps {
  win: Window;
  /** The toolbar element — excluded from hit-testing so you cannot pin the bar. */
  host: Element;
  store: Store;
  /** Multi-target marks render into the pin layer, next to the markers. */
  pinsLayer: HTMLElement;
  /** Esc / cancel from the aim grip. */
  onCancel(): void;
}

export interface Placement {
  /** The hover outline; lives in the page-space overlay. */
  readonly outline: HTMLElement;
  /** The fixed crosshair; lives at the shadow root. */
  readonly crosshair: HTMLElement;
  /**
   * Install listeners and (re)mount the aim layer into `shadow`. The aim controller's timers and
   * window listeners die on disconnect, so it is rebuilt on every connect — a re-parented element
   * would otherwise come back with a grip that renders and does nothing.
   */
  connect(shadow: ShadowRoot): void;
  disconnect(): void;
  /** Per render: keep reticle, aim and multi-marks consistent with placing mode. */
  render(placing: boolean): void;
  /** A page click while placing. Shift accumulates, plain places; drag-aim hosts ignore taps. */
  handleClick(e: MouseEvent): void;
}

export function createPlacement(deps: PlacementDeps): Placement {
  const { win, host, store, pinsLayer } = deps;
  const doc = host.ownerDocument;
  const reticle: Reticle = createReticle(doc);
  let aim: Aim | null = null;
  let hover: Element | null = null;
  /** Shift+click accumulation while placing — extra loci for ONE pending pin. */
  let extraTargets: BrowserTarget[] = [];
  /** Pending viewport-refresh frame, 0 when none is queued. */
  let viewportFrame = 0;

  const placing = (): boolean => store.get().mode === "placing";

  /**
   * Work out what sits under a viewport point and highlight it. Shared by both ways of aiming —
   * following a mouse, and dragging the reticle — so the two can never disagree.
   */
  function probe(clientX: number, clientY: number): void {
    const el = hitTest(doc, clientX, clientY, (hit) => hit === host);
    hover = el;
    if (el) {
      reticle.snap(el.getBoundingClientRect(), targetLabel(el), { x: win.scrollX, y: win.scrollY });
    } else {
      reticle.release();
    }
    aim?.setLabel(el ? targetLabel(el) : "NOTHING UNDER THE PIN");
  }

  /**
   * Bring the drag-aim reticle up with placing mode, seeded mid-screen and already showing what
   * it is over — the first thing you see is a live target, not an empty crosshair.
   */
  function syncAim(on: boolean): void {
    if (!aim) return;
    if (!on || !needsDragAim(win)) {
      aim.hide();
      return;
    }
    if (aim.root.classList.contains("on")) {
      // Already up: only re-seat it if the viewport shrank out from under it (a rotation).
      if (aim.point.x <= win.innerWidth && aim.point.y <= win.innerHeight) return;
      aim.show(Math.min(aim.point.x, win.innerWidth), Math.min(aim.point.y, win.innerHeight));
      return;
    }
    const { x, y } = startPoint(win);
    aim.show(x, y);
    probe(x, y);
  }

  /** Commit the pin the drag-aim reticle is sitting on. */
  function confirmAim(): void {
    if (!aim) return;
    // Re-probe first: the reticle is fixed to the viewport, so anything that moved the page under
    // it since the last drag leaves the target stale.
    probe(aim.point.x, aim.point.y);
    const el = hover ?? doc.body;
    const at = { x: aim.point.x + win.scrollX, y: aim.point.y + win.scrollY };
    store.place({ target: captureTarget(el, { at }), placedAt: at });
    reticle.release();
  }

  function clearExtraTargets(): void {
    if (extraTargets.length === 0) return;
    extraTargets = [];
    renderMultiMarks(pinsLayer, []);
  }

  /** Placement click: capture the hovered target (or body) into a client-only draft. */
  function placeDraft(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const el = hover ?? doc.body;
    const capture = captureTarget(el, { at: { x: e.pageX, y: e.pageY } });
    // The committing click is the anchor; shift+clicked extras ride along as target.targets
    // (dogfood #29 — one pin about several elements).
    if (extraTargets.length > 0) capture.target.targets = extraTargets;
    clearExtraTargets();
    store.place({ target: capture, placedAt: { x: e.pageX, y: e.pageY } });
    reticle.release();
  }

  /** Shift+click while placing: capture WITHOUT committing; a numbered dashed outline is the receipt. */
  function accumulateTarget(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    extraTargets = [...extraTargets, captureTarget(hover ?? doc.body).target];
    renderMultiMarks(pinsLayer, extraTargets);
  }

  /**
   * Keep the drag-aim reticle honest while the viewport moves under it — one probe per frame,
   * not per event: momentum scrolling on a phone dispatches faster than frames.
   */
  const onViewportChange = (): void => {
    if (!placing() || viewportFrame !== 0) return;
    viewportFrame = win.requestAnimationFrame(() => {
      viewportFrame = 0;
      if (!placing()) return;
      syncAim(true);
      if (aim?.root.classList.contains("on") === true) probe(aim.point.x, aim.point.y);
    });
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!placing()) return;
    reticle.move(e);
    probe(e.clientX, e.clientY);
  };

  function mountAim(shadow: ShadowRoot): void {
    shadow.querySelector(".pb-aim")?.remove();
    aim = createAim(doc, {
      onAim: probe,
      onConfirm: confirmAim,
      onCancel: deps.onCancel,
    });
    shadow.appendChild(aim.root);
  }

  return {
    outline: reticle.outline,
    crosshair: reticle.crosshair,
    connect(shadow) {
      if (aim === null) mountAim(shadow);
      doc.addEventListener("mousemove", onMouseMove);
      // The reticle is viewport-fixed; the page is not. Both of these change what sits under it.
      win.addEventListener("scroll", onViewportChange, { passive: true });
      win.addEventListener("resize", onViewportChange);
    },
    disconnect() {
      doc.removeEventListener("mousemove", onMouseMove);
      win.removeEventListener("scroll", onViewportChange);
      win.removeEventListener("resize", onViewportChange);
      if (viewportFrame !== 0) win.cancelAnimationFrame(viewportFrame);
      viewportFrame = 0;
      aim?.destroy();
      aim = null;
    },
    render(on) {
      // However placing ended — Esc, P, a commit, a card opening — the pending multi-target set
      // dies with it; orphaned dashed outlines are lies.
      if (!on) clearExtraTargets();
      if (!on) reticle.release();
      syncAim(on);
    },
    handleClick(e) {
      // While drag-aiming, a tap is how you scroll and how you follow links — placement there is
      // the explicit confirm instead. (Shift is a keyboard key, so multi-capture is pointer-only.)
      if (needsDragAim(win)) return;
      if (e.shiftKey) accumulateTarget(e);
      else placeDraft(e);
    },
  };
}
