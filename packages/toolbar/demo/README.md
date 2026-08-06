# toolbar/demo

Dev fixture page — runs the **real** `<pinbox-toolbar>` against the **real** local hub.
Nothing is stubbed: `serve.ts` starts `startHubServer` with realtime and a local attachment sink,
and the page loads the built `dist/index.js`. The design prototypes in `docs/design/toolbar/` are
the visual reference; the MERIDIAN markup here is lifted from `v2-command-bar.html` minus its
prototype toolbar.

```sh
cd packages/toolbar
bun run build          # the page loads dist/, not src/
bun run demo           # prints the page URL, the hub URL, and the db path
```

The demo also publishes the two discovery files `pinbox` looks for (`discovery.ts`), so the CLI
**adopts** this hub rather than spawning its own — every `pinbox …` below is run from
`packages/toolbar/demo`.

> **The hub.json `version` must be the CLI's own.** `ensureHub` adopts an existing hub only when
> that string equals `packages/cli/package.json`'s version and otherwise SIGTERMs it as a stale
> daemon — which would kill the demo (and the page's hub) on the first `pinbox` command, silently.
> `discovery.ts` therefore reads the CLI manifest at runtime instead of hardcoding anything, and
> `discovery.test.ts` asserts the two match. Do not replace it with a literal.

State lives in `demo/.pinbox/` (gitignored). Delete it for a clean run:
`rm -rf packages/toolbar/demo/.pinbox`.

## Manual checklist

Browser-only paths (canvas capture, `createImageBitmap`, real WebSocket reconnect timing) are not
covered by `bun test` — this list is how they get exercised. Run it before shipping toolbar changes.

- [ ] **Place / discard a draft.** Press the bar's place action (or `c`), sweep the page: the
      reticle outlines the *deepest* element under the cursor and labels it from `data-pb-el`
      (HEADLINE, METRICS ROW, PILLAR CARD…). `Esc` discards with nothing written — confirm
      `pinbox list --json` still returns the previous count.
- [ ] **Create a pin.** Place on HEADLINE, type, submit. A needle pin lands on the anchor, the
      chip animates in, and `pinbox show <id> --json` reports the same `target.selector` and rect.
- [ ] **Thread reply.** Open the card, reply. The message appends optimistically and the pin stays
      `open` — replying never resolves.
- [ ] **Resolve via CLI → badge flips live.** In a second terminal:
      `pinbox resolve <id> --json`. Without touching the browser, the pin's badge flips to RESOLVED
      and the verify prompt appears. This is the WS event path end to end.
- [ ] **Accept / reopen.** Accept → status stays `resolved`, verification recorded. Reopen on a
      second pin → status flips back to `open` with the resolution kept as history
      (`pinbox show <id> --json`).
- [ ] **Screenshot thumb.** Create a pin over PILLAR CARD with capture enabled: a thumbnail renders
      in the card, and the pin carries a **path** (`demo/.pinbox/media/…`), never bytes — check
      `pinbox show <id> --json` and confirm the file exists on disk.
- [ ] **Offline banner + reconcile.** Ctrl-C `serve.ts`. The bar shows offline within a few seconds
      and existing threads render read-only from the localStorage mirror. Create a pin while
      offline (it is flagged QUEUED), reload the page (mirror still renders), then restart
      `bun run demo`: the bar returns to live, the queued pin POSTs, and `pinbox list --json`
      contains it exactly once.
- [ ] **Catch-up replay.** While the browser tab is closed, `pinbox reply <id> "…"`. Reopen the
      page: the missed message arrives via the catch-up frame, not a full refetch (the cursor
      advanced — check the devtools WS frames).
