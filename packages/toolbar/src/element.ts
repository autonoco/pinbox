// @autono/pinbox-toolbar — web component root
// Shadow DOM isolation; --pb-* theme tokens with a neutral default; zero runtime
// deps. Ports the prototype's placement loop and keyboard map (docs/design/
// toolbar/v2-command-bar.html lines 521–545, 701–712): armed command bar →
// reticle over labeled outlines → click places a client-only draft. Transactional
// drafts: nothing reaches the hub until the first comment submits (Task 6/8);
// esc / click-away discards. Overlay coordinates are page-space (pageX/pageY),
// the pin layer sits at the document origin; the reticle is position: fixed.
import type { Attachment, PinInput } from "@autono/pinbox-core/schema";
import { captureTarget } from "./capture.ts";
import type { PinboxConfig } from "./index.ts";
import { pinsToMarkdown } from "./markdown.ts";
import { captureElement, uploadAttachment } from "./screenshot.ts";
import {
  appendThreadMessage,
  applyHubEvent,
  createStore,
  type Store,
  type ToolbarState,
  upsertPin,
} from "./state.ts";
import { hitTest, targetLabel } from "./targeting/dom.ts";
import { HubTransport } from "./transport.ts";
import { type Aim, createAim, needsDragAim, startPoint } from "./ui/aim.ts";
import { type Bar, createBar } from "./ui/bar.ts";
import { type CardActions, renderCard } from "./ui/card.ts";
import { createDrawer, type Drawer } from "./ui/drawer.ts";
import { renderPins } from "./ui/pins.ts";
import { createReticle, type Reticle } from "./ui/reticle.ts";
import { createShortcutsModal, type ShortcutsModal } from "./ui/shortcuts.ts";
import { PAGE_CSS, PAGE_PLACING_CLASS, TOOLBAR_CSS } from "./ui/styles.ts";

// SSR guard: framework wrappers import this module on the server, where
// HTMLElement does not exist. The class is only *used* in a browser.
const BaseElement = (globalThis.HTMLElement ?? (class {} as unknown)) as typeof HTMLElement;

/** Keystrokes are ignored while a text control has focus (prototype line 702–703). */
function isTextEntry(target: EventTarget | undefined): boolean {
  const el = target as HTMLElement | undefined;
  const tag = el?.tagName ?? "";
  return tag === "TEXTAREA" || tag === "INPUT" || el?.isContentEditable === true;
}

export class PinboxToolbarElement extends BaseElement {
  static readonly tagName = "pinbox-toolbar";

  readonly store: Store = createStore();
  /** Card → transport seam (wired by #startTransport once a config exists). */
  readonly actions: {
    send?: (pinId: string | "draft", text: string) => void;
    verify?: (pinId: string, outcome: "accepted" | "reopened") => void;
    resolve?: (pinId: string) => void;
  } = {};

  #config: PinboxConfig | null = null;
  #transport: HubTransport | null = null;
  #token = "";
  #built = false;
  #bar: Bar | null = null;
  #reticle: Reticle | null = null;
  #pinsLayer: HTMLElement | null = null;
  #drawer: Drawer | null = null;
  #aim: Aim | null = null;
  #modal: ShortcutsModal | null = null;
  #helpOpen = false;
  #pageStyle: HTMLStyleElement | null = null;
  #unsubscribe: (() => void) | null = null;
  #hover: Element | null = null;

  /** Card → element: send/verify/resolve forward to the transport seam; close dismisses. */
  readonly #cardActions: CardActions = {
    send: (pinId, text) => this.actions.send?.(pinId, text),
    verify: (pinId, outcome) => this.actions.verify?.(pinId, outcome),
    resolve: (pinId) => this.actions.resolve?.(pinId),
    close: () => this.#dismiss(),
  };

  /** Programmatic path (Pinbox.init). The snippet path reads hub/token attributes. */
  configure(config: PinboxConfig): void {
    this.#config = config;
  }

  get config(): PinboxConfig | null {
    if (this.#config) return this.#config;
    const hub = this.getAttribute("hub");
    if (!hub) return null;
    const token = this.getAttribute("token");
    return token === null ? { endpoint: hub } : { endpoint: hub, token };
  }

  connectedCallback(): void {
    if (!this.#built) {
      this.#built = true;
      this.#build();
    }
    if (!this.hasAttribute("data-pb")) {
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      this.setAttribute("data-pb", dark ? "dark" : "light");
    }
    const style = document.createElement("style");
    style.textContent = PAGE_CSS;
    document.head.appendChild(style);
    this.#pageStyle = style;
    document.addEventListener("mousemove", this.#onMouseMove);
    // The reticle is viewport-fixed; the page is not. Both of these change what sits under it.
    window.addEventListener("scroll", this.#onViewportChange, { passive: true });
    window.addEventListener("resize", this.#onViewportChange);
    document.addEventListener("click", this.#onClickCapture, true);
    document.addEventListener("keydown", this.#onKeyDown);
    this.#unsubscribe = this.store.subscribe((s) => this.#render(s));
    this.#render(this.store.get());
    void this.#startTransport();
  }

  disconnectedCallback(): void {
    this.#transport?.close();
    this.#transport = null;
    document.removeEventListener("mousemove", this.#onMouseMove);
    window.removeEventListener("scroll", this.#onViewportChange);
    window.removeEventListener("resize", this.#onViewportChange);
    document.removeEventListener("click", this.#onClickCapture, true);
    document.removeEventListener("keydown", this.#onKeyDown);
    this.#aim?.destroy();
    this.#aim = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#pageStyle?.remove();
    this.#pageStyle = null;
    document.body.classList.remove(PAGE_PLACING_CLASS);
  }

  #build(): void {
    const shadow = this.attachShadow({ mode: "open" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(TOOLBAR_CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = TOOLBAR_CSS;
      shadow.appendChild(style);
    }
    const overlay = document.createElement("div");
    overlay.className = "pb-overlay";
    this.#pinsLayer = document.createElement("div");
    overlay.appendChild(this.#pinsLayer);
    this.#reticle = createReticle(document);
    overlay.appendChild(this.#reticle.outline);
    // Card slot — renderCard (ui/card.ts) populates and positions it.
    const card = document.createElement("div");
    card.className = "pb-card";
    card.hidden = true;
    overlay.appendChild(card);
    shadow.appendChild(overlay);
    shadow.appendChild(this.#reticle.crosshair);
    this.#bar = createBar(document, {
      onPin: () => this.#togglePlacing(),
      onInbox: () => this.store.update({ inboxOpen: !this.store.get().inboxOpen }),
      onTheme: () => this.#toggleTheme(),
      onHelp: () => this.#toggleHelp(),
      onCopy: () => this.#copyOpenPins(),
    });
    shadow.appendChild(this.#bar.root);
    this.#drawer = createDrawer(document, {
      onActivate: (pinId) => this.#activateFromInbox(pinId),
      onClose: () => this.store.update({ inboxOpen: false }),
    });
    shadow.appendChild(this.#drawer.root);
    this.#aim = createAim(document, {
      onAim: (x, y) => this.#probe(x, y),
      onConfirm: () => this.#confirmAim(),
      onCancel: () => this.#dismiss(),
    });
    shadow.appendChild(this.#aim.root);
    this.#modal = createShortcutsModal(document, () => this.#setHelp(false));
    shadow.appendChild(this.#modal.root);
    this.#pinsLayer.addEventListener("click", (e) => this.#onChipClick(e));
  }

  /**
   * Task 8 wiring: WS events mutate the store, connection state renders in the
   * bar, card actions hit the hub. The mirror seeds pins so an offline reload
   * still renders read-only threads and queued drafts.
   */
  async #startTransport(): Promise<void> {
    if (this.#transport !== null) return;
    const cfg = this.config;
    if (cfg === null) return;
    this.#token = cfg.token ?? (await cfg.getToken?.().catch(() => undefined)) ?? "";
    const transport = new HubTransport({
      endpoint: cfg.endpoint,
      token: this.#token,
      onEvent: (e) => applyHubEvent(this.store, e),
      onConnection: (connection) => this.store.update({ connection }),
      onPins: (pins) => this.store.update({ pins }),
      onOutbox: (ids) => this.store.update({ queuedIds: new Set(ids) }),
    });
    this.#transport = transport;
    // Seed: last-known mirror + queued outbox drafts, the latter flagged "queued".
    const queued = transport.outboxPins();
    const seed = [...transport.mirrorPins(), ...queued];
    if (seed.length > 0 && this.store.get().pins.length === 0) {
      this.store.update({ pins: seed });
    }
    if (queued.length > 0) {
      this.store.update({ queuedIds: new Set(queued.map((p) => p.id)) });
    }
    this.actions.send = (pinId, text) => void this.#send(transport, pinId, text);
    this.actions.resolve = (pinId) =>
      void transport
        .resolve(pinId)
        .then((pin) => upsertPin(this.store, pin))
        .catch(() => {});
    this.actions.verify = (pinId, outcome) =>
      void transport
        .verify(pinId, outcome)
        .then((pin) => {
          upsertPin(this.store, pin);
          // Accepting is the end of the pin: it closes the card and takes the marker off the page
          // with it. Leaving the thread sitting open on a pin you just signed off reads as though
          // the click did not land. Reopening is the opposite — the card stays, composer focused.
          if (outcome === "accepted") this.#dismiss();
        })
        .catch(() => {});
    transport.connect();
  }

  /** draft ⇒ compose PinInput (+ best-effort screenshot) and createPin; else thread reply. */
  async #send(transport: HubTransport, pinId: string | "draft", text: string): Promise<void> {
    try {
      if (pinId === "draft") {
        const draft = this.store.get().draft;
        if (draft === null) return;
        const input: PinInput = {
          text,
          kind: "note",
          target: draft.target.target,
          env: draft.target.env,
          author: { userId: transport.consumerId },
        };
        const shot = await this.#screenshot(draft.target.target.selector);
        if (shot !== null) input.attachments = [shot];
        this.store.commitDraft(await transport.createPin(input));
      } else {
        appendThreadMessage(this.store, await transport.reply(pinId, text));
      }
    } catch {
      // hub rejection/network drop: the connection state in the bar is the surface;
      // offline drafts are already queued by the transport's outbox
    }
  }

  /** Best-effort element screenshot: draft submit → captureElement → uploadAttachment. */
  async #screenshot(selector: string): Promise<Attachment | null> {
    const cfg = this.config;
    if (cfg === null) return null;
    // Opted out: never call getDisplayMedia, so the tab-share prompt never appears.
    if (cfg.screenshots === false) return null;
    try {
      const el = document.querySelector(selector);
      if (el === null) return null;
      const img = await captureElement(el);
      if (img === null) return null;
      return await uploadAttachment(cfg.endpoint, this.#token, img);
    } catch {
      return null; // the pin ships without pixels; structured capture still carries it
    }
  }

  /** Threads build from WS events; after a reload the cursor skips old ones — fetch lazily. */
  #ensureThread(pinId: string): void {
    const transport = this.#transport;
    if (transport === null || this.store.get().threads.has(pinId)) return;
    void transport
      .getThread(pinId)
      .then((messages) => {
        const threads = new Map(this.store.get().threads);
        threads.set(pinId, messages);
        this.store.update({ threads });
      })
      .catch(() => {});
  }

  /** Inbox item click: activate the pin and scroll it into view (prototype line 700). */
  #activateFromInbox(pinId: string): void {
    const pin = this.store.get().pins.find((p) => p.id === pinId);
    this.#ensureThread(pinId);
    this.store.update({ activePinId: pinId });
    // A terminal `pinbox pin` has no captured rect, so there is nowhere to scroll —
    // activating it still opens its card. Scrolling to a made-up y would be worse.
    const rect = pin?.target?.rect;
    if (rect) {
      const y = rect.y + rect.height / 2;
      window.scrollTo({ top: Math.max(0, y - window.innerHeight / 2), behavior: "smooth" });
    }
  }

  /** The markdown offline fallback: copy every open pin's block to the clipboard. */
  #copyOpenPins(): void {
    const state = this.store.get();
    try {
      void navigator.clipboard.writeText(pinsToMarkdown(state.pins, state.threads));
    } catch {
      // clipboard unavailable (insecure context) — the affordance degrades silently
    }
  }

  #setHelp(open: boolean): void {
    this.#helpOpen = open;
    this.#modal?.set(open);
  }

  #toggleHelp(): void {
    this.#setHelp(!this.#helpOpen);
  }

  /** Chip click toggles the pin active (prototype data-open delegation, line 675). */
  #onChipClick(e: MouseEvent): void {
    const id = (e.target as Element).closest?.("[data-open]")?.getAttribute("data-open");
    if (!id || id === "draft") return;
    const active = this.store.get().activePinId;
    if (active !== id) this.#ensureThread(id);
    this.store.update({ activePinId: active === id ? null : id });
  }

  #togglePlacing(): void {
    const placing = this.store.get().mode === "placing";
    this.store.update({ mode: placing ? "idle" : "placing", activePinId: null });
  }

  #toggleInbox(): void {
    this.store.update({ inboxOpen: !this.store.get().inboxOpen });
  }

  #resolveActive(): void {
    const active = this.store.get().activePinId;
    if (active) this.actions.resolve?.(active);
  }

  #toggleTheme(): void {
    const next = this.getAttribute("data-pb") === "dark" ? "light" : "dark";
    this.setAttribute("data-pb", next);
  }

  /** esc / click-away: leave placing, discard the draft (client-only), deactivate. */
  #dismiss(): void {
    this.#setHelp(false);
    this.store.update({ mode: "idle", activePinId: null });
    if (this.store.get().draft) this.store.discardDraft();
  }

  /**
   * Work out what sits under a viewport point and highlight it.
   *
   * Shared by both ways of aiming — following a mouse, and dragging the reticle — so the two can
   * never disagree about what is under the crosshair.
   */
  #probe(clientX: number, clientY: number): void {
    const el = hitTest(document, clientX, clientY, (hit) => hit === this);
    this.#hover = el;
    if (el) {
      this.#reticle?.snap(el.getBoundingClientRect(), targetLabel(el), {
        x: window.scrollX,
        y: window.scrollY,
      });
    } else {
      this.#reticle?.release();
    }
    this.#aim?.setLabel(el ? targetLabel(el) : "NOTHING UNDER THE PIN");
  }

  /**
   * Keep the drag-aim reticle honest while the viewport moves under it.
   *
   * Scrolling changes what is beneath a fixed reticle, and resizing (a phone rotating, a window
   * dragged narrow) can both strand it off-screen and flip which way of aiming applies.
   */
  #onViewportChange = (): void => {
    if (this.store.get().mode !== "placing") return;
    this.#syncAim(true);
    const aim = this.#aim;
    if (aim?.root.classList.contains("on") === true) this.#probe(aim.point.x, aim.point.y);
  };

  #onMouseMove = (e: MouseEvent): void => {
    if (this.store.get().mode !== "placing" || !this.#reticle) return;
    this.#reticle.move(e);
    this.#probe(e.clientX, e.clientY);
  };

  /** Commit the pin the drag-aim reticle is sitting on. */
  #confirmAim(): void {
    const aim = this.#aim;
    if (!aim) return;
    // Re-probe first. The reticle is fixed to the viewport, so anything that moves the page under
    // it — a scroll, a late image, a reflow — leaves the last drag's target stale, and confirming
    // would pin an element that is no longer there.
    this.#probe(aim.point.x, aim.point.y);
    const el = this.#hover ?? document.body;
    this.store.place({
      target: captureTarget(el, {
        at: { x: aim.point.x + window.scrollX, y: aim.point.y + window.scrollY },
      }),
      placedAt: { x: aim.point.x + window.scrollX, y: aim.point.y + window.scrollY },
    });
    this.#reticle?.release();
  }

  /** Placement click: capture the hovered target (or body) into a client-only draft. */
  #placeDraft(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const el = this.#hover ?? document.body;
    this.store.place({
      target: captureTarget(el, { at: { x: e.pageX, y: e.pageY } }),
      placedAt: { x: e.pageX, y: e.pageY },
    });
    this.#reticle?.release();
  }

  // Capture-phase so placement wins over the page's own click handlers; events
  // originating inside the shadow root are ignored (bar/chips handle their own).
  #onClickCapture = (e: MouseEvent): void => {
    if (e.composedPath().includes(this)) return;
    const state = this.store.get();
    if (state.mode === "placing") {
      // While drag-aiming, a tap is how you scroll and how you follow links — placing on it would
      // pin something every time you touched the page, and always before you could see what.
      // Placement there is the explicit confirm instead.
      if (!needsDragAim(window)) this.#placeDraft(e);
      return;
    }
    // Anything open closes when you click away from it — the card, and the inbox with it. An inbox
    // that only closed from its own X meant clicking the page did nothing and it just sat there.
    if (state.inboxOpen) this.store.update({ inboxOpen: false });
    if (state.activePinId || state.draft) this.#dismiss();
  };

  /** Prototype keyboard map (v2-command-bar.html lines 701–712). */
  #shortcuts: Record<string, () => void> = {
    escape: () => this.#dismiss(),
    p: () => this.#togglePlacing(),
    i: () => this.#toggleInbox(),
    d: () => this.#toggleTheme(),
    r: () => this.#resolveActive(),
    c: () => this.#copyOpenPins(),
    "?": () => this.#toggleHelp(),
  };

  #onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(e.composedPath()[0])) return;
    this.#shortcuts[e.key === "?" ? "?" : e.key.toLowerCase()]?.();
  };

  /**
   * Bring the drag-aim reticle up with placing mode, seeded mid-screen and already showing what it
   * is over — so the first thing you see is a live target, not an empty crosshair waiting for a
   * mouse that is never coming.
   */
  #syncAim(placing: boolean): void {
    const aim = this.#aim;
    if (!aim) return;
    if (!placing || !needsDragAim(window)) {
      aim.hide();
      return;
    }
    if (aim.root.classList.contains("on")) {
      // Already up: only re-seat it if the viewport shrank out from under it, which a rotation
      // does. Otherwise leave it exactly where it was put.
      if (aim.point.x <= window.innerWidth && aim.point.y <= window.innerHeight) return;
      aim.show(Math.min(aim.point.x, window.innerWidth), Math.min(aim.point.y, window.innerHeight));
      return;
    }
    const { x, y } = startPoint(window);
    aim.show(x, y);
    this.#probe(x, y);
  }

  #render(state: ToolbarState): void {
    const placing = state.mode === "placing";
    this.toggleAttribute("data-placing", placing);
    document.body.classList.toggle(PAGE_PLACING_CLASS, placing);
    if (!placing) this.#reticle?.release();
    this.#syncAim(placing);
    if (this.#pinsLayer) renderPins(this.#pinsLayer, state);
    if (this.shadowRoot) renderCard(this.shadowRoot, state, this.#cardActions);
    this.#drawer?.update(state);
    this.#bar?.update(state);
  }
}
