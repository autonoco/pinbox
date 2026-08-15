# tools/

Release and CI scripts. House rule: **logic lives in TypeScript here; workflow YAML only wires credentials and calls these scripts.**

Present:

- `security/` — `scan-introduced-secrets.ts`, the gitleaks range scan behind the `gitleaks`
  required check on `main`. Dismissals live in `.gitleaksignore` as line-level fingerprints.

Planned:

- `release/` — auto-release bumps the next minor and tags; `bun build --compile` per target (cross-compiled via `--target=bun-{linux,darwin}-{x64,arm64}`). From that output it **generates** the npm platform packages `@autono/pinbox-<os>-<cpu>` (manifest with `os`/`cpu` + one binary) and the ~5 KB `@autono/pinbox` launcher whose `optionalDependencies` pin them at an exact version — this is the primary channel; the same binaries also go to a GitHub Release behind a `curl | sh` installer for machines with no JS runtime. Publish platforms first and the launcher last, or the first install after a release 404s. Then a per-package `bun publish` loop for the libraries (dependencies before dependents, exact pins; never raw `changeset publish` under Bun — it ships literal `workspace:*`/`catalog:` strings).
- `skillgen/` — renders `skills/pinbox/SKILL.md` + CLI reference docs from the command tree; invoked by the docs-sync workflow.
- `validate/` — anything `ci:validate` needs beyond topological `bun run --filter` fan-out (check, typecheck, `bun test`, knip).

Scripts here are run with `bun tools/<name>/...` and use `Bun.$` for shelling out; each subdirectory gets its own README when added. No loose single-file scripts at this level.
