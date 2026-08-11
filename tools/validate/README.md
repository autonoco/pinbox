# tools/validate

Repo-wide invariants `ci:validate` checks that no per-package script can see. Each file is a
standalone Bun script that exits non-zero with the fix in the message.

- `template-drift.ts` — `examples/worker` must stay a byte-identical materialization of
  `packages/cli/templates/worker` (one sanctioned difference: the example README's provenance
  header).
- `hub-version.ts` — `HUB_VERSION` in `packages/core/src/hub.ts` must equal the core package
  version. `/health` reports it and the CLI respawns a stale daemon on mismatch, so drift here
  silently disables that respawn.
- `workflows.test.ts` — the two CI contracts a YAML syntax check cannot see, both of which only
  fail in production: `docs-sync.yml` must invoke `tools/skillgen/generate.ts --check` (the whole
  six-artifact generated set, not `skills/pinbox` alone, and not an entry filename that does not
  exist), and `release.yml` must pass the git tag to `release:build` / `release:publish` so the
  manifest-vs-tag assertion is a real gate rather than a comparison of the manifest to itself.
- `site-assets.ts` — every local `href`/`src`/`url()` in `apps/web/public` must resolve to a real
  file. The site ships with no build step, so nothing else resolves those paths: a renamed font or
  a moved stylesheet fails silently, the browser substitutes a system face, and the page still
  loads looking almost right.
- `site-toolbar.ts` — the toolbar bundle `apps/web` serves must be the one this repo builds. It is
  a *copy* (the site has no build step), and a copy drifts: pinbox.sh would keep demonstrating an
  old build while the repo moved on, so the one page whose job is to be the product shows
  something that is not. `--write` refreshes it; `predeploy` runs that.
