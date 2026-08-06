# examples/

Copy-paste-trivial example apps. Workspace members, each run in CI as an install-and-build smoke — they catch packaging/exports regressions that publint can't.

Planned set (keep it to 2-3):

- `vite-react/` — toolbar via the Vite dev plugin + React wrapper.
- `script-tag/` — plain static HTML using the IIFE bundle; proves the no-framework path.
- `worker/` — a materialized copy of `packages/cli/templates/worker`, deploy-checked in CI.

Rules: examples must stay trivially copy-pasteable — no coupling to the docs site, no shared helper packages, minimal dependencies. If an example needs explanation beyond its own README, it's too complex.
