// @autono/pinbox-toolbar — public entry
// Pinbox.init({ endpoint, getToken, targeting, anchorAttribute }) — the host
// page's only API; never renders a login (spec Toolbar/Config: sparse on
// purpose). Importing this module also registers <pinbox-toolbar> (the snippet
// path: attributes hub, token) — hence sideEffects: ["./dist/index.js"].
import { PinboxToolbarElement } from "./element.ts";

export interface PinboxConfig {
  /** Hub base URL. */
  endpoint: string;
  /** Local dev: injected by the dev plugin. */
  token?: string;
  /** Cloud: the host app supplies (spec: auth passthrough). */
  getToken?: () => Promise<string>;
  /** Default "dom"; "anchor" for sandboxed cross-origin iframe hosts (Task 7). */
  targeting?: "dom" | "anchor";
  /** Anchor mode attribute, default "data-pb-anchor". */
  anchorAttribute?: string;
  /** Reserved; the realtime topic is fixed server-side. */
  project?: string;
  /**
   * Attach a screenshot to new pins. Default true.
   *
   * Capturing one means asking the browser to share the tab, and that permission prompt is the
   * first thing a visitor sees — fine in a project you already trust, hostile on a public page.
   * Set false and pins ship with their structured capture (selector, markup, viewport) and no
   * pixels.
   */
  screenshots?: boolean;
  /**
   * Start with the bar collapsed to the floating puck. Default false. A
   * visitor's own choice, persisted per endpoint, wins over this on reload.
   */
  minimized?: boolean;
}

/** Register <pinbox-toolbar>; no-op outside a browser or when already defined. */
export function defineToolbarElement(): void {
  if (typeof customElements === "undefined") return;
  if (!customElements.get(PinboxToolbarElement.tagName)) {
    customElements.define(PinboxToolbarElement.tagName, PinboxToolbarElement);
  }
}

export const Pinbox = {
  init(config: PinboxConfig): PinboxToolbarElement {
    defineToolbarElement();
    const el = document.createElement(PinboxToolbarElement.tagName) as PinboxToolbarElement;
    el.configure(config);
    document.body.appendChild(el);
    return el;
  },
};

defineToolbarElement();

export type { CaptureResult } from "./capture.ts";
export { PinboxToolbarElement } from "./element.ts";
export type { Draft, Store, ToolbarState, UiStatus } from "./state.ts";
export {
  appendThreadMessage,
  applyHubEvent,
  createStore,
  deriveUiStatus,
  upsertPin,
} from "./state.ts";
export type {
  ConnectionState,
  HubEvent,
  StorageLike,
  TransportOptions,
  WebSocketLike,
} from "./transport.ts";
export { HubError, HubTransport } from "./transport.ts";
