# docs/design

Design and UX exploration — this is the gate before implementation. Nothing in `packages/` gets built until the relevant design here is approved.

- `toolbar/` — **self-contained HTML mockups** (the house pattern from the studio workspace: one file per design, openable directly in a browser, no build step, no external resources). The toolbar is DOM UI, so HTML prototypes are the real medium — interaction states (pin placement, composer, status badges, accept/reopen, move mode) should be clickable with faked data.
- `cli/` — the CLI is the primary surface, so its UX gets designed too: human-mode output specs as literal terminal transcripts (what `pinbox summary`, `list`, `resolve`, errors, and `--help` actually print), before any command is implemented.
- `principles.md` — the interaction language both surfaces share (tone, color/status vocabulary, information density, what never prompts).

Convention: one design iteration = one file (`toolbar/v1-composer.html`, `cli/v1-transcripts.md`). Superseded files stay for history — these are historical artifacts, not documentation. For the system as shipped, read `docs/`.

Iterations so far:

- `toolbar/v1-pin-loop.html` — self-contained first pass (FAB dock, FLIP outline, spring system). Open directly in a browser.
- `toolbar/v2-command-bar.html` — **current direction**. Open directly in a browser. Conversational threads, direct change mode (`?mode=propose` for the gated variant), channel mirroring, inbox. Typography is a system-font stand-in: the branded display face is licensed and stays out of this repo. Branding is a *theme*; the toolbar ships neutral `--pb-*` tokens.
