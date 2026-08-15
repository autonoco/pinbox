#!/usr/bin/env bun
// tools/release — stamp the git-tag version onto manifests in the CI workspace.
//
// Buttons tags the merge SHA and injects the version at build time (ldflags). Pinbox's
// compile/publish read package.json, so the release job stamps that tag here and never
// commits it back to main. Keep the set here, not in the workflow YAML.

// One canonical SemVer policy for every release path. Both workflows embed this exact source
// as their `SEMVER` shell variable (tools/validate/workflows.test.ts asserts it verbatim), so
// a tag the workflows accept is a version this tool accepts, and vice versa. The official
// semver.org grammar: no leading-zero numeric components, no leading-zero numeric prerelease
// identifiers, no empty identifiers, build metadata allowed. Written to be valid in POSIX ERE
// (grep -E) and JS alike: no \d, no non-capturing groups.
export const SEMVER_SOURCE =
  "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)" +
  "(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?" +
  "(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?";
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);

/** Workspace packages that share a release version (libraries + the CLI source of truth). */
export const VERSIONED_PACKAGES = [
  "packages/cli",
  "packages/core",
  "packages/toolbar",
  "packages/mcp",
] as const;

const repoRoot = new URL("../..", import.meta.url).pathname;

export function assertReleaseVersion(version: string): void {
  if (!SEMVER.test(version)) {
    throw new Error(`not a release version: ${JSON.stringify(version)}`);
  }
}

/** Write `version` into each VERSIONED_PACKAGES manifest. Returns the paths touched. */
export async function bumpVersion(version: string, root = repoRoot): Promise<string[]> {
  assertReleaseVersion(version);
  const touched: string[] = [];
  for (const dir of VERSIONED_PACKAGES) {
    const path = `${root}${dir}/package.json`;
    const manifest = (await Bun.file(path).json()) as Record<string, unknown>;
    if (typeof manifest["version"] !== "string") {
      throw new Error(`${dir}/package.json has no string version`);
    }
    manifest["version"] = version;
    await Bun.write(path, `${JSON.stringify(manifest, null, 2)}\n`);
    touched.push(path);
  }
  const mcpMain = `${root}packages/mcp/src/main.ts`;
  if (await Bun.file(mcpMain).exists()) {
    const src = await Bun.file(mcpMain).text();
    const next = src.replace(
      /export const SERVER_VERSION = "[^"]+";/,
      `export const SERVER_VERSION = "${version}";`,
    );
    if (next !== src) {
      await Bun.write(mcpMain, next);
      touched.push(mcpMain);
    }
  }
  return touched;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (version === undefined) {
    console.error("usage: bun tools/release/bump-version.ts <semver>");
    process.exit(1);
  }
  const paths = await bumpVersion(version);
  for (const path of paths) console.log(path);
}
