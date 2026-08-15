#!/usr/bin/env bun
// tools/release — set every shipped package's version to the release being cut.
//
// Auto-release bumps before it tags: `pinbox --version` and release:build/publish read
// packages/cli/package.json, so a tag alone would ship a binary that lies. Keep the set here,
// not in the workflow YAML (tools/README.md house rule).
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

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
