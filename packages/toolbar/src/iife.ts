// @autono/pinbox-toolbar — entry for the SCRIPT-TAG bundle only (`dist/toolbar.iife.js`).
//
// An iife bundle assigns the entry module's NAMESPACE to `globalName`. Pointing it at
// `src/index.ts` — which exports a `Pinbox` object — therefore produced `Pinbox.Pinbox.init(…)`
// on the host page. This module exists solely to make that namespace the intended surface, so a
// script-tag consumer writes `Pinbox.init({ endpoint })` like every other install path.
//
// Deliberately NOT reachable from `src/index.ts` and NOT in package.json `exports`: the ESM
// entries' shape is a separate published contract and must not change. Keep this surface the
// values a no-build embed can actually use — the type-only exports of `src/index.ts` (config,
// state, transport interfaces) mean nothing to a script tag and are omitted on purpose.
//
// `src/build.test.ts` evaluates the built bundle and asserts this shape.
import { Pinbox } from "./index.ts";

/** Mount the toolbar: `Pinbox.init({ endpoint, getToken, targeting, anchorAttribute })`. */
export const init = Pinbox.init;

export type { PinboxConfig } from "./index.ts";
export { defineToolbarElement, PinboxToolbarElement } from "./index.ts";
