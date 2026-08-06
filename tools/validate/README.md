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
