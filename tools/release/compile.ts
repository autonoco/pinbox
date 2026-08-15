#!/usr/bin/env bun
// tools/release — the compile matrix. `bun build --compile` cross-compiles, so ONE CI job
// emits all four binaries; the compiled binary IS the product (it embeds the Bun runtime),
// and everything else in this directory is packaging glue around it.
import { $ } from "bun";
import { TARGETS, type Target, targetFor } from "./targets.ts";

const repoRoot = new URL("../..", import.meta.url).pathname;
const ENTRY = `${repoRoot}packages/cli/src/main.ts`;
/** What `packages/cli` itself compiles to — reused when it is newer than the sources. */
const DEV_BINARY = `${repoRoot}packages/cli/dist/pinbox`;

/** The target for this machine. Throws on a platform we do not ship — there is no fallback. */
export function currentTarget(): Target {
  const found = targetFor(process.platform, process.arch);
  if (found === null) {
    throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  }
  return found;
}

/**
 * `packages/cli/dist/pinbox` when it is newer than every source file that feeds it, else null.
 * Compiling takes seconds; `bun run build` already ran in ci:validate, so the common case is free.
 */
export async function freshBinary(): Promise<string | null> {
  const binary = Bun.file(DEV_BINARY);
  if (!(await binary.exists())) return null;
  const built = binary.lastModified;
  for (const pkg of ["cli", "core"]) {
    const glob = new Bun.Glob("**/*.ts");
    for (const rel of glob.scanSync({ cwd: `${repoRoot}packages/${pkg}/src` })) {
      if (Bun.file(`${repoRoot}packages/${pkg}/src/${rel}`).lastModified > built) return null;
    }
  }
  return DEV_BINARY;
}

/**
 * Build the workspace libraries before compiling.
 *
 * The CLI imports `@autono/pinbox-core/*` subpaths, which resolve to that package's `dist/` —
 * so on a clean checkout `bun build --compile` fails to resolve every one of them. Doing it here
 * rather than as a workflow step means any caller is correct: the release job, a local dry run,
 * or whatever runs this next. `bun run --filter` walks the dependency graph in order.
 */
async function buildLibraries(): Promise<void> {
  await $`bun run --filter '*' build`.cwd(repoRoot).quiet();
}

/**
 * Install `@opentui/core`'s native packages for EVERY platform, not just this machine's.
 *
 * A plain `bun install` skips optionalDependencies whose os/cpu don't match the host, but the
 * compile matrix cross-compiles all four targets from one Linux runner: bundling for a foreign
 * target hits `import("@opentui/core-<os>-<arch>")` and fails to resolve unless that package is
 * on disk. `--target` dead-code-eliminates the other platforms' branches, so each binary still
 * embeds only its own native library (verified by identical binary size either way). The
 * lockfile already pins these packages; this changes node_modules only.
 */
async function installAllPlatformNatives(): Promise<void> {
  const all = "*";
  await $`bun install --frozen-lockfile --os ${all} --cpu ${all}`.cwd(repoRoot).quiet();
}

/** Compile one target into `<outDir>/<assetName>`; returns the binary path. */
export async function compileTarget(target: Target, outDir: string): Promise<string> {
  const outfile = `${outDir}/${target.assetName}`;
  await $`mkdir -p ${outDir}`.quiet();
  await $`bun build ${ENTRY} --compile --target=${target.bunTarget} --outfile ${outfile}`.cwd(
    repoRoot,
  );
  return outfile;
}

/**
 * Compile all four. `version` is asserted against the CLI manifest rather than injected:
 * `pinbox --version` reads that manifest, so a mismatch would ship a binary that lies.
 * The release workflow stamps the git tag onto that manifest in the CI workspace first.
 */
export async function compileAll(
  version: string,
  outDir: string,
): Promise<{ target: string; binary: string }[]> {
  await assertVersion(version);
  await installAllPlatformNatives();
  await buildLibraries();
  const built: { target: string; binary: string }[] = [];
  for (const target of TARGETS) {
    built.push({ target: target.bunTarget, binary: await compileTarget(target, outDir) });
  }
  return built;
}

async function assertVersion(version: string): Promise<void> {
  const manifest = (await Bun.file(`${repoRoot}packages/cli/package.json`).json()) as {
    version: string;
  };
  if (manifest.version !== version) {
    throw new Error(
      `version mismatch: packages/cli/package.json is ${manifest.version}, releasing ${version} ` +
        "(release stamps the tag onto manifests in CI; run bun tools/release/bump-version.ts <ver> first)",
    );
  }
}

if (import.meta.main) {
  // `bun run release:build` — defaults are the release layout publish.ts reads back.
  const args = process.argv.slice(2);
  const manifest = (await Bun.file(`${repoRoot}packages/cli/package.json`).json()) as {
    version: string;
  };
  const version = args[0] ?? manifest.version;
  const outDir = args[1] ?? `${repoRoot}dist/release/bin`;
  for (const { target, binary } of await compileAll(version, outDir)) {
    console.log(`${target}\t${binary}`);
  }
}
