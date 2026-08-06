// @autono/pinbox-toolbar/svelte — Svelte entry (subpath ./svelte)
// Custom elements are svelte-NATIVE: importing this module registers
// <pinbox-toolbar>, so a Svelte template can use the tag directly with hub/token
// attributes. The `pinbox` action below is for the programmatic path (getToken,
// targeting) that attributes cannot express. svelte is an OPTIONAL peer used for
// types only — nothing from the svelte runtime is imported at value level.
import type { Action } from "svelte/action";
import { defineToolbarElement, type PinboxConfig, PinboxToolbarElement } from "./index.ts";

// Re-export the whole vanilla surface so `@autono/pinbox-toolbar/svelte` is a
// self-sufficient import (element registration side effect included).
export * from "./index.ts";

/**
 * `<div use:pinbox={{ endpoint }} />` — creates + configures the element BEFORE insertion
 * (its transport starts in connectedCallback) and removes it when the node is destroyed.
 * Config forwards once; re-create the node to change endpoints.
 */
export const pinbox: Action<HTMLElement, PinboxConfig> = (node, config) => {
  defineToolbarElement();
  const el = document.createElement(PinboxToolbarElement.tagName) as PinboxToolbarElement;
  el.configure(config);
  node.appendChild(el);
  return {
    destroy: () => {
      el.remove();
    },
  };
};
