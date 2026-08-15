# tools/release

Distribution is the **esbuild platform-package pattern**: the compiled binary *is* the
product, and everything else here is packaging glue generated at release time.

| file | what it owns |
| --- | --- |
| `targets.ts` | the four shipped platforms — the single source of truth for the compile matrix, the generated manifests, and `install.sh`'s `uname` mapping |
| `compile.ts` | `bun build --compile` for all four targets from one machine (`bun run release:build` → `dist/release/bin/`) |
| `bump-version.ts` | set every shipped package's version before an auto-release tags (CLI + core + toolbar + mcp) |
| `manifests.ts` | the **generated** npm packages: the `@autono/pinbox` launcher (manifest + node shim) and the four `@autono/pinbox-<os>-<cpu>` packages. Never checked in |
| `publish.ts` | the ordered publish: `bun pm pack` → `npm publish --provenance` (`bun run release:publish`; `--dry-run` prints the plan) |
| `install.sh` | the secondary channel: `curl … \| sh`, checksum-verified, for machines with no JS runtime |
| `release.test.ts` | the pack-and-install e2e that gates every publish |

## The release flow

1. **Merge to main** — `.github/workflows/auto-release.yml` bumps the next minor (`v0.N.0` → `v0.N+1.0`), commits the manifest bump with `[skip release]`, tags it, runs gitleaks on the introduced commits, then `workflow_call`s `release.yml`.
2. **Skip** — put `[skip release]` in the merge commit message, or let a `github-actions[bot]` commit (docs-sync, the bump itself) land without releasing.
3. **Recovery** — `workflow_dispatch` on auto-release with an existing `v*` tag, or dispatch `release.yml` from that tag ref.
4. **Hand-cut tag** — bump the four package manifests to match, `git tag vX.Y.Z && git push origin vX.Y.Z`. `release.yml` on `v*` still works. Tagging ahead of the manifests fails compile: `pinbox --version` reads `packages/cli/package.json`.

`release.yml` does the rest: `ci:validate` → compile all four → smoke on Ubuntu **and** macOS (`release.test.ts` against the artifacts this run compiled, bun off `PATH`) → GitHub Release with binaries + `.sha256` + `install.sh` → npm publish with OIDC provenance.

Bump + tag + publish stay in one path: a tag pushed with `GITHUB_TOKEN` does not trigger sibling workflows.

## Two rules that look like details and are not

**Publish order is the contract.** Libraries dependencies-first (`core → toolbar → mcp`),
then the four platform packages, then the launcher **dead last**. The launcher's
`optionalDependencies` are **exact pins**, never ranges — publishing it before its platform
packages exist on the registry opens a window in which every fresh install is broken. The
exact pin is also what keeps that window from ever reopening (research ADOPT-9): with a range,
npm can resolve a platform package the launcher was never published against.

**Never run `changeset publish` under Bun.** Changesets does not understand Bun's
`workspace:*` and `catalog:` protocols and ships them literally, producing packages nobody can
install. `bun pm pack` is what rewrites them — and the rewrite is asymmetric on purpose:

- `catalog:` → the **declared range** from the root catalog (`zod: catalog:` → `zod: ^4.0.0`),
  because a catalog entry is shared *policy*, and consumers should get the same latitude.
- `workspace:*` → an **exact pin** of the sibling's version, because the packages in this repo
  are released together and only that exact pair was ever tested as a unit.

So the pipeline is `bun pm pack` (correct manifest rewriting) → `npm publish <tgz>` — the npm
CLI appearing for the one flag `bun publish` lacks: `--provenance`, which binds the tarball to
this repo, workflow, and commit via the job's OIDC token. npm appears in exactly that one
step; everything else is Bun.

## Two deliberate inversions of AGENTS.md

Both live in the generated manifests, and both are required by the format:

1. **The launcher shim is plain CommonJS with `#!/usr/bin/env node`.** npm's bin machinery
   assumes node, so this file runs under Node on nearly every machine — Bun-first ones
   included. It is packaging glue, not pinbox, and uses the Node/Bun shared subset only.
2. **Neither generated manifest declares `engines`.** The binary embeds Bun; an `engines.bun`
   field would block exactly the machines the binary exists to serve.

## Local checks

```sh
bun test tools/release                    # the pack-and-install e2e (compiles if dist is stale)
bun tools/release/publish.ts --dry-run    # the exact ordered plan, no network
bun run lint:pkg                          # publint + attw on every publishable package
```
