// @autono/pinbox-toolbar/vue — thin Vue wrapper (subpath ./vue)
// vue is an OPTIONAL peer, evaluated only when this subpath is imported.
// defineComponent-free on purpose: a plain options object is a valid Vue component and
// keeps the wrapper free of Vue's type machinery; `this` is typed structurally instead.
import { h, type VNode } from "vue";
import { defineToolbarElement, type PinboxConfig, PinboxToolbarElement } from "./index.ts";

/** The slice of the Vue component instance this wrapper touches. */
interface WrapperInstance {
  $el: Element;
  config: PinboxConfig;
  _pbEl?: PinboxToolbarElement;
}

/**
 * `<PinboxToolbar :config="{ endpoint }" />` — forwards the config ONCE on mount (the
 * element does not support live reconfiguration; re-key to change endpoints), removes the
 * element on unmount. Created + configured BEFORE insertion because the element starts
 * its transport in connectedCallback.
 */
export const PinboxToolbar = {
  name: "PinboxToolbar",
  props: { config: { type: Object, required: true } },
  mounted(this: WrapperInstance): void {
    defineToolbarElement();
    const el = document.createElement(PinboxToolbarElement.tagName) as PinboxToolbarElement;
    el.configure(this.config);
    this._pbEl = el;
    this.$el.appendChild(el);
  },
  unmounted(this: WrapperInstance): void {
    this._pbEl?.remove();
    delete this._pbEl;
  },
  render(): VNode {
    return h("div", { style: { display: "contents" } });
  },
};

/** The slice of a Vue `App` the install helper touches. */
interface AppLike {
  unmount: () => void;
}

/**
 * Plain functional install helper: `installPinbox(app, { endpoint })` mounts one toolbar
 * for the whole app (appended to document.body, outside Vue's tree) and tears it down
 * when the app unmounts. For per-view control use the `PinboxToolbar` component instead.
 */
export function installPinbox(app: AppLike, config: PinboxConfig): void {
  defineToolbarElement();
  const el = document.createElement(PinboxToolbarElement.tagName) as PinboxToolbarElement;
  el.configure(config);
  document.body.appendChild(el);
  const unmount = app.unmount;
  app.unmount = () => {
    el.remove();
    unmount.call(app);
  };
}
