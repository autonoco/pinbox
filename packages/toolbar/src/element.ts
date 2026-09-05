// @autono/pinbox-toolbar — web component root
// Shadow DOM isolation; --pb-* theme tokens with a neutral default; zero runtime
// deps. Ports the prototype's placement loop and keyboard map (docs/design/
// toolbar/v2-command-bar.html lines 521–545, 701–712): armed command bar →
// reticle over labeled outlines → click places a client-only draft. Transactional
// drafts: nothing reaches the hub until the first comment submits (Task 6/8);
// esc / click-away discards. Overlay coordinates are page-space (pageX/pageY),
// the pin layer sits at the document origin; the reticle is position: fixed.
import type { Attachment, PinInput } from "@autono/pinbox-core/schema";
import { type AnchorWatch, watchAnchors } from "./anchor-watch.ts";
import type { PinboxConfig } from "./index.ts";
import { shortcutFor } from "./keys.ts";
import { pinsToMarkdown, pinToMarkdown } from "./markdown.ts";
import { createMinimize, type MinimizeController } from "./minimize.ts";
import { createPlacement, type Placement } from "./placement.ts";
import { captureElement, releaseCapture, uploadAttachment } from "./screenshot.ts";
import {
  agentIsLive,
  appendThreadMessage,
  applyHubEvent,
  createStore,
  type Store,
  type ToolbarState,
  upsertPin,
} from "./state.ts";
import { HubTransport } from "./transport.ts";
import type { ActionId } from "./ui/actions.ts";
import { type Bar, createBar } from "./ui/bar.ts";
import { type CardActions, renderCard } from "./ui/card.ts";
import type { DraftKind } from "./ui/card-parts.ts";
import { createDrawer, type Drawer } from "./ui/drawer.ts";
import { anchorRect, renderPins } from "./ui/pins.ts";
import { createMinimizeUi, type MinimizeUi } from "./ui/puck.ts";
import { createShortcutsModal, type ShortcutsModal } from "./ui/shortcuts.ts";
import { PAGE_CSS, PAGE_PLACING_CLASS, TOOLBAR_CSS } from "./ui/styles.ts";

// SSR guard: framework wrappers import this module on the server, where
// HTMLElement does not exist. The class is only *used* in a browser.
const BaseElement = (globalThis.HTMLElement ?? (class {} as unknown)) as typeof HTMLElement;

export class PinboxToolbarElement extends BaseElement {
  static readonly tagName = "pinbox-toolbar";
  /** Watched so a config that arrives after insertion can still start the transport. */
  static readonly observedAttributes = ["hub", "token"];

  readonly store: Store = createStore();
  /** Card → transport seam (wired by #startTransport once a config exists). */
  readonly actions: {
    send?: (pinId: string | "draft", text: string, kind: DraftKind) => void;
    verify?: (pinId: string, outcome: "accepted" | "reopened") => void;
    resolve?: (pinId: string, note?: string) => void;
  } = {};

  #config: PinboxConfig | null = null;
  #transport: HubTransport | null = null;
  /**
   * Connected-lifetime counter, bumped on disconnect. #startTransport can park at
   * an await (getToken, or `await undefined` on the token-less path); a
   * continuation that crossed a disconnect must not install a transport into a
   * later lifetime, where it would shadow or duplicate that lifetime's own start.
   */
  #lifetime = 0;
  /** One deferred start per tick, however many attribute callbacks land in it. */
  #startQueued = false;
  #token = "";
  #built = false;
  #bar: Bar | null = null;
  #pinsLayer: HTMLElement | null = null;
  #drawer: Drawer | null = null;
  /** Reticle, drag-aim and multi-target capture — see placement.ts. */
  #placement: Placement | null = null;
  #modal: ShortcutsModal | null = null;
  #minUi: MinimizeUi | null = null;
  #min: MinimizeController | null = null;
  /** SPA view watcher: DOM/history changes re-run the anchor-gated render. */
  #anchors: AnchorWatch | null = null;
  #helpOpen = false;
  /** The 30 s wall-clock tick that ages pending pins into WAITING / NO RESPONSE. 0 when idle. */
  #clockTimer = 0;
  #pageStyle: HTMLStyleElement | null = null;
  #unsubscribe: (() => void) | null = null;

  /** Card → element: send/verify/resolve forward to the transport seam; close dismisses. */
  readonly #cardActions: CardActions = {
    send: (pinId, text, kind) => this.actions.send?.(pinId, text, kind),
    verify: (pinId, outcome) => this.actions.verify?.(pinId, outcome),
    resolve: (pinId) => this.actions.resolve?.(pinId),
    nudge: (pinId) => this.#nudge(pinId),
    copy: (pinId) => this.#copyPin(pinId),
    close: () => this.#dismiss(),
  };

  /** Programmatic path (Pinbox.init). The snippet path reads hub/token attributes. */
  configure(config: PinboxConfig): void {
    this.#config = config;
    // Same late-config rescue as the attribute path: configuring an element that
    // already connected configless must still start it.
    if (this.isConnected) this.#queueStart();
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
    // `#build` runs once; the placement and minimize controllers' listeners and timers do not
    // survive a disconnect, so both are (re)connected here rather than there.
    if (this.shadowRoot) this.#placement?.connect(this.shadowRoot);
    if (this.#min === null) this.#mountMinimize();
    this.#anchors = watchAnchors(window, () => this.#render(this.store.get()));
    document.addEventListener("click", this.#onClickCapture, true);
    // Capture phase on window: we see the key before the host's own hotkey handlers can swallow
    // it, and stop it only when an action actually ran (keys.ts has the rules).
    window.addEventListener("keydown", this.#onKeyDown, true);
    this.#unsubscribe = this.store.subscribe((s) => this.#render(s));
    this.#render(this.store.get());
    this.#startClock();
    this.#queueStart();
  }

  /** Age is state (state.ts `clock`), so a tick is a render and stale pins flip without a hub event. */
  #startClock(): void {
    const tick = (): void => this.store.update({ clock: Date.now() });
    tick();
    this.#clockTimer = window.setInterval(tick, 30_000);
  }

  /**
   * Late-config rescue: an element inserted BEFORE its hub/token attributes were
   * set connected configless and #startTransport bailed. Starting here the moment
   * a config first exists keeps such an element from staying silently dead.
   * Config is still read once — a running transport is never reconfigured.
   */
  attributeChangedCallback(): void {
    if (this.isConnected && this.config !== null) this.#queueStart();
  }

  /**
   * Start at the END of the current tick, not synchronously: a config assembled
   * attribute-by-attribute on a connected element (append → set hub → set token)
   * must be read whole. A synchronous start at the first fragment would connect
   * token-less and, per the read-once rule, drop the token forever.
   */
  #queueStart(): void {
    if (this.#startQueued) return;
    this.#startQueued = true;
    queueMicrotask(() => {
      this.#startQueued = false;
      void this.#startTransport();
    });
  }

  disconnectedCallback(): void {
    this.#lifetime += 1;
    this.#transport?.close();
    this.#transport = null;
    document.removeEventListener("click", this.#onClickCapture, true);
    window.removeEventListener("keydown", this.#onKeyDown, true);
    this.#placement?.disconnect();
    this.#min?.destroy();
    this.#min = null;
    releaseCapture(); // drop the shared tab-capture stream (and its indicator)
    this.#anchors?.destroy();
    this.#anchors = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    window.clearInterval(this.#clockTimer);
    this.#clockTimer = 0;
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
    this.#placement = createPlacement({
      win: window,
      host: this,
      store: this.store,
      pinsLayer: this.#pinsLayer,
      onCancel: () => this.#dismiss(),
    });
    overlay.appendChild(this.#placement.outline);
    // Card slot — renderCard (ui/card.ts) populates and positions it.
    const card = document.createElement("div");
    card.className = "pb-card";
    card.hidden = true;
    overlay.appendChild(card);
    shadow.appendChild(overlay);
    shadow.appendChild(this.#placement.crosshair);
    this.#bar = createBar(document, {
      onAction: (id, keyboard) => this.#runAction(id, keyboard),
    });
    shadow.appendChild(this.#bar.root);
    this.#minUi = createMinimizeUi(document);
    shadow.appendChild(this.#minUi.morphWrap);
    shadow.appendChild(this.#minUi.puck);
    shadow.appendChild(this.#minUi.fan);
    this.#drawer = createDrawer(document, {
      onActivate: (pinId) => this.#activateFromInbox(pinId),
      onClose: () => this.store.update({ inboxOpen: false }),
      onResolve: (pinId, note) => this.actions.resolve?.(pinId, note),
      onUnresolve: (pinId) => this.actions.verify?.(pinId, "reopened"),
    });
    shadow.appendChild(this.#drawer.root);
    this.#modal = createShortcutsModal(document, () => this.#setHelp(false));
    shadow.appendChild(this.#modal.root);
    this.#pinsLayer.addEventListener("click", (e) => this.#onChipClick(e));
  }

  /** Same lifetime split as #mountAim: the controller's window listeners and timers die on
   * disconnect, so it is (re)built on connect and re-applies the persisted resting state. */
  #mountMinimize(): void {
    const ui = this.#minUi;
    const bar = this.#bar;
    if (ui === null || bar === null) return;
    this.#min = createMinimize({
      win: window,
      bar: bar.root,
      ui,
      storage: globalThis.localStorage ?? null,
      storagePrefix: `pinbox:${this.config?.endpoint ?? ""}`,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      initialMinimized: this.config?.minimized === true,
      onSettled: (minimized, keyboard) => this.#onMinimizeSettled(minimized, keyboard),
      // Fan actions run WITHOUT restoring — placing, the drawer, and the theme
      // all work independently of the bar; that is the point of the fan.
      onFanAction: (action) => this.#runAction(action, false),
    });
    this.#min.applyInitial();
  }

  #onMinimizeSettled(minimized: boolean, keyboard: boolean): void {
    if (this.store.get().minimized !== minimized) this.store.update({ minimized });
    this.dispatchEvent(
      new CustomEvent(minimized ? "pinbox:minimize" : "pinbox:restore", {
        bubbles: true,
        composed: true,
      }),
    );
    // Keyboard-initiated toggles hand focus to the surface that remains.
    if (!keyboard) return;
    if (minimized) this.#minUi?.puck.focus();
    else this.#bar?.root.querySelector<HTMLElement>('[data-ref="min"]')?.focus();
  }

  /** Public: collapse the bar to the floating puck. Bar surfaces close first —
   * the morph must never sweep over an open card, drawer, or armed reticle. */
  minimize(keyboard = false): void {
    const state = this.store.get();
    if (state.mode === "placing" || state.activePinId !== null || state.draft !== null) {
      this.#dismiss();
    }
    if (state.inboxOpen) this.store.update({ inboxOpen: false });
    this.#setHelp(false);
    this.#min?.minimize(keyboard);
  }

  /** Public: bring the bar back from the puck. */
  restore(keyboard = false): void {
    this.#min?.restore(keyboard);
  }

  /**
   * Task 8 wiring: WS events mutate the store, connection state renders in the
   * bar, card actions hit the hub. The mirror seeds pins so an offline reload
   * still renders read-only threads and queued drafts.
   */
  async #startTransport(): Promise<void> {
    if (this.#transport !== null || !this.isConnected) return;
    const cfg = this.config;
    if (cfg === null) return;
    const lifetime = this.#lifetime;
    const token = cfg.token ?? (await cfg.getToken?.().catch(() => undefined)) ?? "";
    // The await above can span a disconnect (or disconnect + reconnect). A stale
    // continuation must not install a transport: it would connect on a detached
    // element, or shadow the reconnect's own start and leak a live socket.
    if (this.#lifetime !== lifetime || this.#transport !== null || !this.isConnected) return;
    this.#token = token;
    const transport = new HubTransport({
      endpoint: cfg.endpoint,
      token: this.#token,
      onEvent: (e) => applyHubEvent(this.store, e),
      onConnection: (connection) => this.store.update({ connection }),
      onPins: (pins) => this.store.update({ pins }),
      onSessions: (sessions) => this.store.update({ agentLive: agentIsLive(sessions, Date.now()) }),
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
    this.actions.send = (pinId, text, kind) => void this.#send(transport, pinId, text, kind);
    this.actions.resolve = (pinId, note) =>
      void transport
        .resolve(pinId, note)
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
  async #send(
    transport: HubTransport,
    pinId: string | "draft",
    text: string,
    kind: DraftKind,
  ): Promise<void> {
    try {
      if (pinId === "draft") {
        const draft = this.store.get().draft;
        if (draft === null) return;
        const input: PinInput = {
          text,
          kind,
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
    // Scroll to where the anchor is NOW. A terminal `pinbox pin` has no rect, and a pin whose
    // element is not on this view has no honest place either — activating still opens the card
    // (docked mid-viewport, card.ts); scrolling to a stale y would be worse.
    const rect = pin === undefined ? null : anchorRect(document, pin);
    if (rect) {
      const y = rect.y + rect.height / 2;
      window.scrollTo({ top: Math.max(0, y - window.innerHeight / 2), behavior: "smooth" });
    }
  }

  /**
   * Nudge a stale pin: re-post the last human message as a new thread message. A watcher that
   * missed the original (crashed, restarted, registered late) gets a fresh event to wake on.
   */
  #nudge(pinId: string): void {
    const state = this.store.get();
    const pin = state.pins.find((p) => p.id === pinId);
    if (pin === undefined) return;
    const thread = state.threads.get(pinId) ?? [];
    const last = [...thread].reverse().find((m) => m.role === "human");
    this.actions.send?.(pinId, last?.text ?? pin.text, "note");
  }

  /** The markdown offline fallback: copy every open pin's block to the clipboard. */
  #copyOpenPins(): true {
    const state = this.store.get();
    try {
      void navigator.clipboard.writeText(pinsToMarkdown(state.pins, state.threads));
    } catch {
      // clipboard unavailable (insecure context) — the affordance degrades silently
    }
    return true;
  }

  /** The card's copy: exactly the pin you are looking at, thread included. */
  #copyPin(pinId: string): void {
    const state = this.store.get();
    const pin = state.pins.find((p) => p.id === pinId);
    if (pin === undefined) return;
    try {
      void navigator.clipboard.writeText(pinToMarkdown(pin, state.threads.get(pinId) ?? []));
    } catch {
      // same degradation as #copyOpenPins
    }
  }

  #togglePinsHidden(): true {
    this.store.update({ pinsHidden: !this.store.get().pinsHidden });
    return true;
  }

  #setHelp(open: boolean): void {
    this.#helpOpen = open;
    this.#modal?.set(open);
  }

  #toggleHelp(): true {
    this.#setHelp(!this.#helpOpen);
    return true;
  }

  /** Chip click toggles the pin active (prototype data-open delegation, line 675). */
  #onChipClick(e: MouseEvent): void {
    const id = (e.target as Element).closest?.("[data-open]")?.getAttribute("data-open");
    if (!id || id === "draft") return;
    const active = this.store.get().activePinId;
    if (active !== id) this.#ensureThread(id);
    this.store.update({ activePinId: active === id ? null : id });
  }

  #togglePlacing(): true {
    const placing = this.store.get().mode === "placing";
    // Arming unhides: accumulation marks and the fresh marker both render into
    // the pin layer, and an invisible receipt reads as a dead click.
    this.store.update(
      placing
        ? { mode: "idle", activePinId: null }
        : { mode: "placing", activePinId: null, pinsHidden: false },
    );
    return true;
  }

  #toggleInbox(): true {
    this.store.update({ inboxOpen: !this.store.get().inboxOpen });
    return true;
  }

  #toggleTheme(): true {
    const next = this.getAttribute("data-pb") === "dark" ? "light" : "dark";
    this.setAttribute("data-pb", next);
    return true;
  }

  /** esc / click-away: leave placing, discard the draft (client-only), deactivate. */
  #dismiss(): void {
    this.#setHelp(false);
    this.store.update({ mode: "idle", activePinId: null });
    if (this.store.get().draft) this.store.discardDraft();
  }

  // Capture-phase so placement wins over the page's own click handlers; events
  // originating inside the shadow root are ignored (bar/chips handle their own).
  #onClickCapture = (e: MouseEvent): void => {
    if (e.composedPath().includes(this)) return;
    const state = this.store.get();
    if (state.mode === "placing") {
      this.#placement?.handleClick(e);
      return;
    }
    // Anything open closes when you click away from it — the card, and the inbox with it. An inbox
    // that only closed from its own X meant clicking the page did nothing and it just sat there.
    if (state.inboxOpen) this.store.update({ inboxOpen: false });
    if (state.activePinId || state.draft) this.#dismiss();
  };

  /**
   * One handler per action, for every surface: bar buttons, fan items and keys all name an
   * action from the table (ui/actions.ts). A handler returns false when nothing was there to act
   * on, so the key path can let the host have the keystroke (an Esc with nothing open is the
   * page's Esc; R with no active pin is the page's R).
   */
  readonly #handlers: Record<ActionId, (keyboard: boolean) => boolean> = {
    escape: () => {
      // The fan closes first; every other surface works minimized or not.
      if (this.#min?.closeFan() === true) return true;
      const s = this.store.get();
      const open =
        s.mode === "placing" || s.activePinId !== null || s.draft !== null || this.#helpOpen;
      this.#dismiss();
      return open;
    },
    pin: () => this.#togglePlacing(),
    inbox: () => this.#toggleInbox(),
    theme: () => this.#toggleTheme(),
    copy: () => this.#copyOpenPins(),
    hide: () => this.#togglePinsHidden(),
    help: () => this.#toggleHelp(),
    resolve: () => {
      const active = this.store.get().activePinId;
      if (active === null) return false;
      this.actions.resolve?.(active);
      return true;
    },
    minimize: (keyboard) => {
      if (this.#min?.minimized() === true) this.restore(keyboard);
      else this.minimize(keyboard);
      return true;
    },
  };

  #runAction(id: ActionId, keyboard: boolean): boolean {
    return this.#handlers[id](keyboard);
  }

  #onKeyDown = (e: KeyboardEvent): void => {
    const id = shortcutFor(e, this.config?.shortcuts ?? "all");
    if (id === null) return;
    if (!this.#runAction(id, true)) return;
    // Handled: the host never sees it. Unhandled keys fall through untouched above.
    e.preventDefault();
    e.stopPropagation();
  };

  #render(state: ToolbarState): void {
    const placing = state.mode === "placing";
    this.toggleAttribute("data-placing", placing);
    document.body.classList.toggle(PAGE_PLACING_CLASS, placing);
    this.#placement?.render(placing);
    if (this.#pinsLayer) renderPins(this.#pinsLayer, state);
    if (this.shadowRoot) renderCard(this.shadowRoot, state, this.#cardActions);
    this.#drawer?.update(state);
    this.#bar?.update(state);
    this.#minUi?.update(state);
  }
}
