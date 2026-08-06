#!/usr/bin/env bun
// tools/release — the four shipped platforms, in one place.
// Distribution is the esbuild platform-package pattern: one npm package per os/cpu holding
// exactly one compiled binary, gated by npm's own `os`/`cpu` fields, wired to a tiny launcher
// through exact-pinned optionalDependencies. This table is the single source of truth for the
// compile matrix, the generated manifests, and install.sh's uname mapping.

export type Target = {
  /** `bun build --compile --target=` value; one machine cross-compiles all four. */
  readonly bunTarget: "bun-darwin-arm64" | "bun-darwin-x64" | "bun-linux-arm64" | "bun-linux-x64";
  readonly npmOs: "darwin" | "linux";
  readonly npmCpu: "arm64" | "x64";
  /** `@autono/pinbox-<os>-<cpu>` */
  readonly pkgName: string;
  /** GitHub Release asset name (install.sh downloads this). */
  readonly assetName: string;
};

export const TARGETS: ReadonlyArray<Target> = [
  target("darwin", "arm64"),
  target("darwin", "x64"),
  target("linux", "arm64"),
  target("linux", "x64"),
];

function target(npmOs: Target["npmOs"], npmCpu: Target["npmCpu"]): Target {
  return {
    bunTarget: `bun-${npmOs}-${npmCpu}`,
    npmOs,
    npmCpu,
    pkgName: `@autono/pinbox-${npmOs}-${npmCpu}`,
    assetName: `pinbox-${npmOs}-${npmCpu}`,
  };
}

/** The target for the machine we are running on, or null when it is not one we ship. */
export function targetFor(platform: string, arch: string): Target | null {
  return TARGETS.find((t) => t.npmOs === platform && t.npmCpu === arch) ?? null;
}
