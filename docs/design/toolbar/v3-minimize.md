# v3 — minimize to a floating puck

**Status: planned.** Validated as a standalone prototype (2026-08-16) before touching this
repo; `v3-minimize.html` in this directory is the runnable reference, the same way
`v2-command-bar.html` was the reference for the shipped toolbar. Every number in the
behavior contract below was tuned there, and each regression listed was hit for real
during prototyping — the port must not reintroduce them.

## What it is

A new square button at the command bar's far right collapses the bar into a 48px
floating circle ("puck") — pinbox ident icon plus the open-pin count badge. The morph is
a spring-animated surface styled *identically* to the bar (same translucent fill,
backdrop blur, border, shadow), so both endpoint handoffs are pixel-invisible. The puck
drags anywhere (free placement, clamped 16px inside the viewport), remembers its spot,
and a tap — or `M` — restores the bar to its fixed bottom-center home.

Deliberately **not** in scope, tried and cut in the prototype:

- **No gooey/metaball filter.** A full-viewport SVG filter dropped frames badly (210ms
  stalls measured); even region-clipped it added machinery for a look that read worse
  than the plain morph. The bar-styled surface is the design.
- **No snap-to-edge.** Snap plus a tight click threshold made sloppy trackpad clicks
  fling the puck to the screen edge — users read it as "stopped responding."

## Behavior contract (validated in the prototype)

| Concern | Decision |
|---|---|
| Springs | morph: stiffness 300 / damping 30 (skiper64's values); pointer-follow: 600 / 38. Semi-implicit Euler, substepped at 1/240s so throttled-tab frame gaps can never destabilize it |
| Morph sequencing | swap first, move second: the bar crossfades (90ms) into an identical-geometry surface, the spring **holds** during the swap (90ms minimize / 70ms restore), then morphs. Endpoints reverse it: real element fades in over the settled surface, morph layer fades out 100ms later. An opaque surface exists at every instant |
| Carrier icon | ident icon + badge ride the morph surface only while it is puck-like (width < 260px) — never double-exposed over bar content |
| Tap vs drag | drag starts at ≥8px; release under 12px total travel is a tap and **restores** (trackpad clicks travel several px; this was the "stops responding" bug) |
| Drag | pointer capture, primary button only (`e.button !== 0` guard — right-click on macOS never delivers pointerup and wedged the prototype), free placement, clamped 16px margins |
| Keyboard | `M` toggles minimize/restore. `Escape` keeps its existing dismiss semantics and does **not** restore. Keyboard-initiated toggles hand focus to the puck / minimize button; pointer-initiated toggles blur (no stray focus ring) |
| Pending-drag hygiene | `restore()`/`minimize()` clear any pending pointer state; a restore that runs mid-hold (keyboard) makes the next pointermove abandon the stale drag instead of hijacking the morph |
| Ghosting | hidden elements get opacity 0 + `visibility: hidden` (delayed 90ms) + `pointer-events: none` — out of the tab order, but `getBoundingClientRect()` still measures for morph targets |
| Reduced motion | `prefers-reduced-motion`: no morph layer, instant swap. Note `styles.ts` already clamps every shadow-root transition to 1ms under reduced motion — don't promise CSS fades here; the swap is simply instant |
| Persistence | the transport's `StorageLike` seam (`transport/mirror.ts` — injectable, memory fallback), with the mirror's key convention: `pinbox:<endpoint>:dock` (viewport coords, re-clamped on load/resize) and `pinbox:<endpoint>:minimized`, so a reload keeps the choice |
| While minimized | pins and chips stay live — only the bar's surfaces go. Minimizing dismisses an open card/drawer first (the same `#dismiss` Escape uses), so the morph never sweeps over them. Puck shows the open-pin count badge; a small amber dot marks degraded connection (`offline` / `incompatible`), replacing the bar's `· OFFLINE` text |
| Mode interplay | minimize while placing exits placing first (armed state needs the bar). `p`/`i`/`c` pressed while minimized restore the bar, then run — the bar is those features' surface |
| z-order (shadow ladder) | morph layer 89 (below bar 90), puck 95 — both clear the card (80) and drawer (85), stay under aim (100) and the shortcuts modal (120) |

## Port architecture

`element.ts` is at 520 lines — past the 500 soft threshold — so nothing lands there
beyond wiring. New logic goes in new modules, matching the existing `ui/*` shape
(hand-rolled DOM strings, one stylesheet, no framework):

| File | Contents | ~Lines |
|---|---|---|
| `src/motion/spring.ts` (new) | `mkSpring` — multi-property substepped spring; no DOM | 60 |
| `src/ui/puck.ts` (new) | puck button DOM (ident icon, badge, connection dot), morph surface + carrier DOM, `update(state)` like `bar.ts` | 110 |
| `src/minimize.ts` (new) | the controller: modes (`bar/toPuck/puck/drag/settle/toBar`), hold + fade sequencing timers, drag/tap handling, dock persistence, focus handoff, reduced-motion branch. Decompose deliberately — fallow flags functions over 60 lines (`maxUnitSize`), and a monolithic controller function will trip it | 220 |
| `src/ui/styles.ts` | `.pb-puck`, `.pb-morph`, `.pb-ghost`, carrier + badge rules | +80 |
| `src/ui/bar.ts` | minimize button (`.pb-tb.sq`, **14×14** stroke-1.4 shrink icon like every other bar glyph, `title="Minimize (M)"`) | +6 |
| `src/ui/shortcuts.ts` | `M — minimize` row in the help modal | +1 |
| `src/state.ts` | `minimized: boolean` on `ToolbarState` + a store method in the `place`/`commitDraft` style | +8 |
| `src/element.ts` | wiring only: instantiate the controller in `connectedCallback` and **destroy it (listeners + pending timers) in `disconnectedCallback`, exactly like `#mountAim`/`#aim.destroy()`** — reparenting is the documented trap; `m` in `#shortcuts`; placing/minimize interplay guards; `minimize()`/`restore()` methods + `pinbox:minimize`/`pinbox:restore` composed events; `#render` toggles bar/puck through the controller | +30 |

`element.ts` is already past the 500-line soft threshold (520), so the guard hook will
warn on these edits. The +30 of wiring is accepted deliberately — everything with logic
in it lives in the new modules. If review finds it creeping further, extract the
`#shortcuts` keymap into its own module first rather than arguing with the hook.

Public API stays additive: element methods `minimize()` / `restore()`, an optional
`minimized` boolean on `PinboxConfig` (that's what keeps the React/Vue/Svelte wrappers
change-free — they forward the config wholesale), and `pinbox:minimize` /
`pinbox:restore` composed events so hosts can react.

## Tests (`bun test`, happy-dom per-test instances — the `aim.test.ts` pattern)

- `spring.test.ts` — converges to target, settles below thresholds, stays stable across
  a simulated 1s frame gap (substepping), `snap` zeroes velocity.
- `minimize.test.ts` — state transitions for the full cycle, plus the three prototype
  regressions as named cases: non-primary-button pointerdown is ignored; restore during
  a held-but-unmoved pointer clears the pending drag; an 11px sloppy release restores
  while a 13px one settles in place. Dock persistence round-trip with the injected
  storage seam.
- `puck.test.ts` — badge count and connection dot track state updates.

## Landing sequence

1. Branch `toolbar-minimize`; new modules + wiring as above.
2. `bun test`, Biome, `bun run agent:review:changed` (fallow) — element.ts stays
   wiring-only (see budget note above); boundaries stay toolbar-local (no runtime
   `core` imports).
3. `bun tools/validate/site-toolbar.ts --write` — re-sync the vendored
   `apps/web/public/pinbox/toolbar.iife.js`; `ci:validate` byte-compares it and fails
   on drift.
4. Changeset: `@autono/pinbox-toolbar` **minor** — additive API (changesets computes
   the number).
5. Dogfood: lark-admin dev via the Vite plugin, then larkhelps.dev staging through the
   cloud hub. The puck must not collide with the touch aim bar (z 100) on narrow
   viewports.
6. Docs: the shortcut table in `docs/integrations/toolbar.mdx` gains the `M` row and a
   minimize section. (`SKILL.md` is generated from the CLI tree — a toolbar change
   cannot touch it.)

Estimate: about a day including tests and review.
