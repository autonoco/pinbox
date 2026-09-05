# Toolbar v4: dogfood fixes

Eight reviewer reports plus one product ask (item 9) from the 2026-09 dogfood round, each traced to a cause in the shipped
code, with the fix, the files it touches, and how it is verified. Ordered by ship order, not by
report order: the first four are one-file fixes that unblock the reviewer today; the last four
are structural and land as separate PRs.

Reviewer build note: the reviewer's toolbar predates `58d98b3` (capture reuse) and `3ed9ef0`
(Unresolve). Two of the eight reports may already be fixed in `main` but not in her bundle.
Confirm the build she runs before starting items 4 and 2b. `apps/web/public/pinbox/toolbar.iife.js`
was last resynced 2026-08-17 and does contain `liveCapture`; a consumer on the npm package needs
a release cut.

---

## 1. Stuck THINKING pins

**Cause.** `ui/card.ts` `patchTyping` shows the THINKING row whenever the pin is open and the
last message is human (`deriveUiStatus` = `waiting`). There is no timeout, no agent-liveness
signal, and no error state. A pin nobody ever answers spins forever. Pin #10 spun for two weeks
because that is the design, not a bug in it.

**Fix.** Split "waiting" into three UI states driven by time and by hub session liveness:

| Condition | Chip / row |
|---|---|
| last human message < 90 s ago | `THINKING` (as today) |
| 90 s to 10 min, an agent session `active()` on the hub | `WAITING FOR AGENT` (static, no dots) |
| > 10 min, or no active agent session | `NO RESPONSE` row with two buttons: **Nudge** (re-posts the last human message as a new thread message so a watcher re-triggers) and **Resolve** |

- `state.ts`: `UiStatus` gains `"stale"`. `deriveUiStatus` takes a `now` argument (tests use
  `setSystemTime`) and returns `stale` when the last human message is older than
  `STALE_AFTER_MS`. Keep the function pure; the element passes `Date.now()`.
- `element.ts`: a 30 s interval re-renders while any open pin is `waiting`, so the state
  flips without a hub event. Clear it on disconnect.
- `transport.ts`: `GET /sessions` once on connect and on every reconnect; store the newest
  `Session` with `endedAt` unset as `state.agentSession: Session | null`. This is a read of an
  existing route (`routes-sessions.ts`), no hub change.
- `ui/card.ts`: `patchTyping` becomes `patchPending(threadEl, kind)` with kinds
  `thinking | waiting | stale | none`. New `staleHtml()` for the row.
- `ui/drawer.ts`: chip label reads the new status; `NO RESPONSE` in amber.

**Tests.** `state.test.ts` for the time thresholds; `card.test.ts` for the three rows; one
transport test that a `/sessions` response populates `agentSession`.

**Size.** ~120 lines across four files. `card.ts` is at 506 and gets the `staleHtml` /
`patchPending` pair moved into a new `ui/card-pending.ts` first (file-size rule).

---

## 2. Failed pins cannot be cleared

**Cause.** Resolve exists only on the open card (`ui/card.ts` `hdHtml`, gated by
`resolvable = status === "open" && !queued`). Reaching the card requires clicking the chip.
`ui/pins.ts` `anchorRect` draws no chip when the pin's URL is another view or its selector no
longer resolves. So a pin whose anchor is gone, which is exactly what a failed pin on a rebuilt
page looks like, is listed in the drawer with no action on it. The drawer (`ui/drawer.ts`) has
tabs and rows but zero per-row actions. Clicking a row activates the pin and positions the card
at the stale stored rect, often off-screen.

**Fix.**

- **2a. Drawer row actions.** Each open row gets a hover/focus action cluster: **Resolve** and
  **Open** (activates + scrolls into view; when `anchorRect` is null, opens the card pinned to
  the drawer edge instead of the stale rect). Resolved rows get **Unresolve** (same wire call as
  today's Reopen). `drawer.ts` grows a `DrawerActions` interface mirroring `CardActions`.
- **2b. Card fallback position.** `card.ts` `anchorOf` uses the stored rect blindly. Route it
  through the same `anchorRect` helper as pins (export it from `ui/pins.ts`); when null, dock
  the card at the drawer edge or viewport centre.
- **2c. Bulk clear.** Drawer footer: **Resolve all stale** (every pin in the `stale` state from
  item 1). One confirm bar, sequential `POST /pins/:id/resolve` with `by: "human"`, note
  `"no agent response"`.

**Tests.** `drawer.test.ts` (new) for the row actions and bulk path; `card.test.ts` for the
null-anchor fallback.

**Size.** ~150 lines. `drawer.ts` (158) stays under 500.

---

## 3. Reviewer resolves pins shipped or blocked on a PR

**Cause.** Not a permission problem. The hub has no roles (`hub.ts`: one bearer token, any
caller may `POST /pins/:id/resolve`). It is the same reachability problem as item 2: linked
pins (`pin.links[0]`, connector `github`) sit on views that no longer match, so the chip never
renders and the drawer has no action. The `#58` pins can be resolved by anyone who can reach a
Resolve button.

**Fix.** Item 2a covers the per-pin case. Add the PR-shaped case on top:

- **Drawer group by link.** When any open pin has a `links[0]`, the OPEN tab shows a collapsible
  group header per `connector:ref` (e.g. `github · #58`) with a **Resolve group** action. Same
  bulk path as 2c with note `"shipped in <ref>"`.
- **Resolve note surfaced.** The card's RESOLVED state shows `resolution.note` and
  `resolution.commit` when present (schema already carries them; card ignores them).
- **CLI parity, agent side.** `pinbox resolve --link github:#58` resolves every pin carrying that
  link so the agent can clear a merged PR's pins without the reviewer. `cli/src/commands/resolve.ts`
  gains the flag; SKILL.md regenerates.

**Out of scope.** Roles or a "reviewer" identity. If we want "only the reviewer verifies",
that is the existing `verify` step (`accepted | reopened`), already hers.

**Size.** ~100 lines toolbar, ~40 CLI.

---

## 4. Chrome tab-capture prompt on every pin

**Cause, present tense.** Fixed in `58d98b3` (2026-08-17): `screenshot.ts` keeps one
`getDisplayMedia` stream in `liveCapture` and reuses it until the track ends. The prompt is
once per page load. Two gaps remain:

1. **A page load is not a session.** SPA navigation is fine; a full reload, a new tab, or a
   dev-server HMR reload of the toolbar re-prompts. The browser will not let us persist a
   capture grant across loads, so "persist per session" is not achievable with tab capture.
2. **The prompt is on the critical path of committing a pin.** Denying it or waiting on it
   delays the commit.

**Fix.** Capture differently, with tab capture as the opt-in upgrade:

- **Default: no-permission DOM snapshot.** Rasterise the target element (not the page) via
  SVG `foreignObject` of the element's outerHTML with inlined computed styles, drawn to a
  canvas. No prompt. Cross-origin images taint and are skipped (drawn as their box colour).
  New `screenshot-dom.ts`, ~150 lines. Good enough for "which button" context; the agent
  already has selector + rect + text.
- **Opt-in: tab capture for the session.** The bar gets a camera toggle (and `S` shortcut).
  On: the existing `liveCapture` path, prompted once. Off (default): DOM snapshot. The choice
  persists in the same `StorageLike` store minimize uses, so a reload re-prompts only if she
  left it on. Surface "capture is on, Chrome will ask once" in the toggle's tooltip.
- **Commit never waits on capture.** `element.ts` commit path: POST the pin immediately, then
  attach the screenshot as a thread attachment when it resolves (`POST /attachments` +
  `thread.message` with `attachments`). The pin exists the moment she hits Comment.

**Verify first.** Confirm which build the reviewer runs. If it predates 2026-08-17 the report is
already fixed and only the default-mode change above is new work.

**Tests.** `screenshot-dom.test.ts` under happy-dom for the serialiser; existing
`screenshot.test.ts` covers reuse. Element test: commit resolves before capture does.

---

## 5. Two toolbars with different actions

**Cause.** Two hand-written action lists that drifted.

| Surface | Actions |
|---|---|
| Bar (`ui/bar.ts`) | PIN, INBOX, COPY, THEME, ?, MIN |
| Fan (`ui/puck.ts`) | PIN, INBOX, THEME, HIDE, EXPAND |

Bar lacks HIDE (H). Fan lacks COPY (C) and ? . Both surfaces are the same toolbar in two
densities, so they should render from one source.

**Fix.**

- New `ui/actions.ts`: a single ordered `ACTIONS` table `{ id, label, key, icon, surfaces:
  ("bar" | "fan")[], stateful?: (state) => {label, icon} }`. `expand` and `minimize` are the
  same action with a per-surface label.
- `bar.ts` and `puck.ts` render from the table; `element.ts` `#shortcuts` is generated from it
  too, so the shortcut modal (`ui/shortcuts.ts`) can never list a key the surfaces do not have.
- Bar gets HIDE. Fan gets COPY. `?` stays bar-only by table flag (it is discoverability for the
  bar; the fan shows key chips inline). Every other action is on both.
- Fan item count goes 5 to 6; check the vertical fan still fits the 16 px clamp at 375 px
  height in `minimize.ts` `positionFan`.

**Tests.** `actions.test.ts`: every action with a `key` appears in the shortcut map; every
`surfaces` entry renders a button with that `data-act`. Replaces hand-listed assertions in
`bar` and `puck` tests.

**Size.** ~80 new lines, ~40 removed.

---

## 6. Pins drift on scroll

**Cause.** `ui/pins.ts` `anchorRect` stores document coordinates (`rect + scrollX/Y`) and the
layer is `position: absolute` at the host's origin (`:host` and `.pb-overlay` in `styles.ts`).
That is correct only when all three hold: the host sits at the document origin, the page
scrolls on `window`, and the anchor moves with the document. Each fails in a real app:

1. **Host not at the origin.** `react.ts` appends the element inside the consumer's tree
   (`display: contents` wrapper). Any positioned, transformed, or `overflow` ancestor becomes
   the containing block and the whole layer is offset by that ancestor and scrolls with it.
2. **Inner scroll containers.** Next/Tailwind layouts often scroll a `main` with
   `overflow: auto` while `window.scrollY` stays 0. Pins are then computed at their initial
   position and never move, while the content does. Nothing re-renders on scroll:
   `watchAnchors` fires on mutation and popstate only, and `#onViewportChange` only touches
   the reticle.
3. **Sticky and fixed anchors.** A pin on a sticky header has a document rect that changes
   with every scroll, but no render runs, so the pin slides off it.

**Fix.** Viewport-space layer, re-laid out every frame the viewport moves.

- `styles.ts`: `.pb-overlay` becomes `position: fixed; inset: 0; height: auto;
  pointer-events: none` with children re-enabling pointer events. `:host` stays where it is
  but no longer matters for geometry.
- `ui/pins.ts` `anchorRect` returns `getBoundingClientRect()` directly (viewport space). The
  stored rect (`pin.target.rect`, document space) is the fallback only when the selector does
  not resolve, converted with the current `scrollX/Y`. `card.ts` `position` uses the same
  space.
- `element.ts`: `scroll` listener moves to `{ capture: true, passive: true }` on `document` so
  inner scroll containers fire it. On scroll or resize, schedule one `renderPins` +
  `renderCard` per frame. Add a `ResizeObserver` on `document.body` for layout shifts that
  are neither scroll nor mutation.
- **Mount to body.** `react.ts`, `vue.ts`, `svelte.ts`, and `iife.ts` append the element to
  `document.body` instead of the wrapper, so the fixed layer never inherits a transformed
  containing block. The wrapper stays for lifecycle only.

**Tests.** `pins.test.ts`: a pin inside a scrolled inner container stays on its element after
the container scrolls; a pin on a `position: sticky` element stays put after window scroll.
happy-dom lacks layout, so these stub `getBoundingClientRect`. Add one Playwright case in
`e2e/` against `examples/` with a real inner-scroll layout; this is the class of bug unit
tests cannot see.

**Size.** ~120 lines changed. Highest risk item; ship alone.

---

## 7. Keyboard shortcuts unreliable

**Cause.** `element.ts` `#onKeyDown` is a bubble-phase listener on `document` that dispatches
on `e.key.toLowerCase()` with no modifier check. Concretely:

- The host app's own keydown handlers (hotkey libraries, editors, `stopPropagation` in a modal)
  run first and swallow the event. Shortcuts then work on some pages and not others.
- `Cmd+P`, `Ctrl+I`, `Cmd+D`, `Cmd+C` all trigger our `p`, `i`, `d`, `c`. Print dialog opens
  and placing mode arms at the same time, which reads as "flaky".
- `isTextEntry` checks `composedPath()[0]` for `INPUT`, `TEXTAREA`, `contentEditable` only.
  `<select>`, custom editors with `role="textbox"`, and IME composition (`e.isComposing`)
  leak through.
- `e.repeat` is not filtered: holding `H` toggles hide on every repeat.
- Focus inside an `<iframe>` never delivers key events to the parent document at all.

**Fix.**

- Listen on `window` in the **capture** phase so we see the event before the host app. Only
  `preventDefault` + `stopPropagation` when we actually handled a key, so unhandled keys
  reach the page untouched.
- Ignore when `metaKey || ctrlKey || altKey`, `e.repeat`, or `e.isComposing`.
- `isTextEntry` also returns true for `SELECT`, `role="textbox"`, `role="combobox"`, and any
  element whose closest ancestor has `data-pinbox-ignore-keys`.
- Shortcuts table comes from `ui/actions.ts` (item 5).
- `shortcuts` config option: `"all" | "escape-only" | "off"` for hosts whose own hotkeys
  collide. Default `all`.
- Document the iframe limitation in the shortcuts modal footer ("focus the page first").

**Tests.** `element.test.ts`: dispatch on a child that calls `stopPropagation` and confirm the
shortcut still fires; `Cmd+P` does not arm placing; a repeat event toggles hide once.

**Size.** ~60 lines.

---

## 8. Open toolbar should be movable

**Cause.** `styles.ts` `.pb-bar` is `position: fixed; left: 50%; bottom: 26px` with no drag
path. Only the puck drags (`minimize.ts`, dock persisted through `StorageLike`).

**Fix.** Reuse the puck's drag controller, not a second one.

- Extract the pointer-drag logic from `minimize.ts` (primary-button guard, 8 px start
  threshold, 12 px tap tolerance, document-level move/end listeners, 16 px viewport clamp) into
  `motion/drag.ts` as `attachDrag(el, handle, opts)`. Minimize consumes it; this alone gets
  `minimize.ts` (487 lines) back under the 500 soft cap before new code lands.
- Bar gets a 12 px grip on its left edge (the only non-button area; dragging from buttons would
  race with clicks). `attachDrag(bar, grip)` with a `barPos` persisted alongside `dock` in the
  same storage record: `{ dock, barPos, minimized }`.
- Default position stays bottom-centre when `barPos` is null. Once dragged, `.pb-bar` switches
  from `left: 50%; transform` to explicit `left/top` so the morph geometry in `minimize.ts`
  (which reads `bar.getBoundingClientRect()`) needs no change.
- Clamp on `resize` so a saved position from a wide window is not off-screen on a narrow one
  (same rule the puck already applies).
- `R` for "reset position" is taken (resolve). Reset lives in the shortcuts modal as a link.

**Tests.** `minimize.test.ts` unchanged after the extraction (the refactor is behaviour-
preserving); `drag.test.ts` for the shared controller; `bar.test.ts` for persistence and the
resize clamp.

**Size.** ~40 lines moved, ~90 new.

---

## 9. Comment pins: notes the agent does not act on

**Ask.** Leave a remark on the page (for a teammate, for later, for the record) without an
agent picking it up as work.

**What exists.** `PinSchema.kind` is already `"note" | "move"`, and the toolbar hard-codes
`kind: "note"` at [element.ts:385](../../../packages/toolbar/src/element.ts). "note" is therefore
the actionable default and cannot be repurposed. The delivery router already has a `skip`
routing target that writes a `skipped` delivery row (keeps the replay cursor complete), so
"do not deliver this to any agent" is a one-branch change, not a new subsystem.

**Design.** A second pin kind, `comment`, chosen at draft time. Not a global toggle: a toggle
makes the next pin silently the wrong kind, and the reviewer's pins already suffer from state
she cannot see. The choice lives on the draft card where the text is typed, and the chip shows
it after commit.

- **Schema.** `kind: z.enum(["note", "move", "comment"])`. Additive on the wire; readers that
  switch on `kind` fall through to the note path. `--json` consumers see a new enum value,
  documented as a v1 additive change.
- **Router.** `delivery/router.ts` `route()`: `pin.created` with `kind === "comment"` returns
  `{ kind: "skip" }`. `thread.message` on a comment pin is also skipped, so a human replying to
  a human note does not wake an agent either. Both need the pin row, which `route` already
  loads for the pin id.
- **Sessions.** `routes-sessions.ts` `pending` and `inject` read from deliveries, so comment
  pins never reach the Stop or UserPromptSubmit hooks. No change there.
- **Toolbar draft card.** The composer row gets a two-state segmented control left of the
  button: **Ask agent** (default) and **Note**. The send button reads `Comment` or `Leave note`.
  Key: `N` toggles it while the draft is open (`ui/actions.ts` table, item 5). Persisted for
  the session only, and reset to Ask agent on every new draft, so it never becomes an invisible
  mode.
- **Toolbar after commit.** `deriveUiStatus`: a comment pin is never `waiting`, `replied`, or
  `stale` (item 1); it is `note` until resolved. No THINKING row, no NO RESPONSE row. Chip
  carries a small `N` glyph and a muted (non-amber) border so the two kinds read apart on the
  page. Drawer gets a NOTES filter chip on the OPEN tab.
- **Converting.** A note that turns out to be work: card action **Send to agent**, which
  `POST /pins/:id/kind` with `note` and logs a `pin.retargeted` event that the router treats
  like `pin.created`. This is the only new hub route and the only new event type; if we want
  to defer it, ship without conversion and the reviewer re-pins.
- **CLI.** `pinbox pin --comment` creates one from a terminal. `pinbox list` shows `note` in
  the status column for open comment pins; `--kind note|comment` filter. SKILL.md regenerates.
- **Skill text.** One line in the generated skill: comment pins are context, not tasks; read
  them, do not resolve them unprompted.

**Tests.** `schema.test.ts` accepts the new value and defaults old payloads to `note`.
`router.test.ts`: a comment pin and a reply on it both write `skipped` rows and never appear in
`/sessions/:id/pending`. `card.test.ts`: the control resets per draft; the THINKING row never
renders for a comment pin. `state.test.ts` for `deriveUiStatus`.

**Size.** ~40 core, ~120 toolbar, ~30 CLI. Ships after item 5 (actions table) and before item 1,
so the stale state is written once with both kinds in mind.

---

## Ship order

| PR | Items | Why first |
|---|---|---|
| 1 | 7 (shortcuts) | smallest, unblocks every "press R to resolve" path below |
| 2 | 5 (actions table) | 7 and 8 both want the single source of truth |
| 3 | 2 + 3 (drawer actions, bulk, link groups) | clears her backlog today |
| 4 | 9 (comment pins) | schema + router first so 1 is written for both kinds |
| 5 | 1 (stale state + nudge) | depends on the drawer states from 3 and the kinds from 9 |
| 6 | 8 (movable bar) | extraction refactor first, then the feature |
| 7 | 6 (viewport-space pins) | highest risk, alone, with the e2e case |
| 8 | 4 (DOM snapshot default) | after confirming her build; lowest urgency if 58d98b3 is in it |

Every PR ends with `bun run agent:review:changed` and a bundle resync to `apps/web/public/pinbox`.
