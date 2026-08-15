#!/usr/bin/env bun
// tools/release — the publish step. ORDER IS THE CONTRACT:
//   libs first, dependencies before dependents (core → toolbar → mcp), then the four
//   platform packages, then the launcher DEAD LAST. The launcher is the only package whose
//   install can fail on something that is not on the registry yet: its optionalDependencies
//   are exact pins, so publishing it before its platform packages guarantees a broken-install
//   window for every user who installs during it.
//
// Mechanism per package: `bun pm pack` → `npm publish <tgz> --provenance --access public`.
// `bun pm pack` is what rewrites `workspace:*` and `catalog:` into real ranges; NEVER run
// `changeset publish` under Bun, which ships those protocol strings literally. The npm CLI
// appears exactly here, in CI, for the one flag bun publish lacks (--provenance, which binds
// the artifact to this repo + workflow via OIDC).
import { $ } from "bun";
import { stageLauncher, stagePlatform } from "./manifests.ts";
import { TARGETS } from "./targets.ts";

const repoRoot = new URL("../..", import.meta.url).pathname;
const BIN_DIR = `${repoRoot}dist/release/bin`;
const STAGE_DIR = `${repoRoot}dist/release/stage`;
const TGZ_DIR = `${repoRoot}dist/release/tarballs`;

/** Workspace libraries, dependencies before dependents. `packages/cli` is private: it ships as the compiled binary, not as source. */
const LIBS = ["core", "toolbar", "mcp"] as const;

export type PublishStep = {
  readonly name: string;
  readonly version: string;
  /** Where the tarball comes from — a workspace dir, or a generated package. */
  readonly source: string;
};

/** The ordered plan, derived from the manifests on disk. Reads only; safe to print. */
export async function publishPlan(): Promise<PublishStep[]> {
  const steps: PublishStep[] = [];
  for (const lib of LIBS) {
    const manifest = await readManifest(`${repoRoot}packages/${lib}/package.json`);
    steps.push({ name: manifest.name, version: manifest.version, source: `packages/${lib}` });
  }
  const version = await binaryVersion();
  for (const target of TARGETS) {
    steps.push({
      name: target.pkgName,
      version,
      source: `generated ← dist/release/bin/${target.assetName}`,
    });
  }
  steps.push({ name: "@autono/pinbox", version, source: "generated launcher (published LAST)" });
  return steps;
}

/**
 * `expectVersion` is the git tag, minus its `v`. Every artifact here takes its version from
 * `packages/cli/package.json`, so without the tag to compare against, a release tagged v1.2.3 on
 * a tree whose manifests still read 1.2.2 (bump skipped) publishes 1.2.2
 * under that tag's name, silently. Compared before anything is staged or uploaded.
 */
type PublishOptions = {
  dryRun: boolean;
  expectVersion?: string | undefined;
  /**
   * Publish without `--provenance`. Provenance is minted from a CI OIDC token, so it cannot be
   * produced from a laptop — and npm will not let you configure Trusted Publishing for a package
   * that does not exist yet. That is a genuine chicken-and-egg for a first release: this flag is
   * the one-time escape hatch that creates the packages so TP can then be configured on them.
   * CI must never pass it; the release workflow does not.
   */
  noProvenance: boolean;
};

export async function publishAll(opts: PublishOptions): Promise<void> {
  if (opts.expectVersion !== undefined) {
    const actual = await binaryVersion();
    if (actual !== opts.expectVersion) {
      throw new Error(
        `version mismatch: packages/cli/package.json is ${actual}, releasing ` +
          `${opts.expectVersion} (release stamps the tag onto manifests in CI; run bun tools/release/bump-version.ts <ver> first)`,
      );
    }
  }
  const plan = await publishPlan();
  console.log(opts.dryRun ? "publish plan (dry run — no network):" : "publishing:");
  plan.forEach((step, index) => {
    console.log(`  ${index + 1}. ${step.name}@${step.version}  [${step.source}]`);
  });
  if (opts.dryRun) return;

  await $`mkdir -p ${TGZ_DIR}`.quiet();
  for (const lib of LIBS) {
    const manifest = await readManifest(`${repoRoot}packages/${lib}/package.json`);
    await publishDir(`${repoRoot}packages/${lib}`, `${TGZ_DIR}/${lib}.tgz`, opts.noProvenance, {
      name: manifest.name,
      version: manifest.version,
    });
  }
  await publishBinaryChannel(await binaryVersion(), opts.noProvenance);
}

/** The generated half: four platform packages, then the launcher. Staged from `release:build`'s output. */
async function publishBinaryChannel(version: string, noProvenance: boolean): Promise<void> {
  for (const target of TARGETS) {
    const binary = `${BIN_DIR}/${target.assetName}`;
    if (!(await Bun.file(binary).exists())) {
      throw new Error(`missing ${binary} — run \`bun run release:build\` first`);
    }
    const dir = await stagePlatform(target, version, binary, STAGE_DIR);
    await publishDir(dir, `${TGZ_DIR}/${target.assetName}.tgz`, noProvenance, {
      name: target.pkgName,
      version,
    });
  }
  // Last, and only now that every pin it declares resolves on the registry.
  await publishDir(
    await stageLauncher(version, STAGE_DIR),
    `${TGZ_DIR}/launcher.tgz`,
    noProvenance,
    {
      name: "@autono/pinbox",
      version,
    },
  );
}

/**
 * Is this exact name@version already on the registry?
 *
 * Publishing is eight sequential steps and npm refuses to overwrite a version, so ANY failure
 * partway leaves a half-published release that can never be re-run — the retry dies on the first
 * package with EPUBLISHCONFLICT instead of finishing the remaining seven. Checking first makes
 * the whole run resumable, which matters most for the launcher: it is published last precisely
 * so it is never live before the binaries it points at, and that ordering is worthless if a
 * retry cannot get past step one.
 */
async function alreadyPublished(name: string, version: string): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`, {
    headers: { accept: "application/json" },
  }).catch(() => null);
  return res !== null && res.status === 200;
}

async function publishDir(
  dir: string,
  tarball: string,
  noProvenance = false,
  identity?: { name: string; version: string },
): Promise<void> {
  if (identity !== undefined && (await alreadyPublished(identity.name, identity.version))) {
    console.log(`  skip ${identity.name}@${identity.version} — already on the registry`);
    return;
  }
  await $`bun pm pack --filename ${tarball} --quiet`.cwd(dir);
  const argv = noProvenance
    ? ["npm", "publish", tarball, "--access", "public"]
    : ["npm", "publish", tarball, "--provenance", "--access", "public"];
  // stdio is INHERITED, not captured. With 2FA enabled npm prints a browser URL and blocks on
  // the approval; through a captured pipe it has no terminal, so that flow cannot complete and
  // the publish dies on EOTP. Inheriting also means npm's progress reaches CI logs live.
  const proc = Bun.spawn(argv, { cwd: repoRoot, stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`npm publish failed (exit ${code}) for ${tarball}`);
}

/** The binary's version is the CLI manifest's — `pinbox --version` reads exactly that file. */
async function binaryVersion(): Promise<string> {
  return (await readManifest(`${repoRoot}packages/cli/package.json`)).version;
}

async function readManifest(path: string): Promise<{ name: string; version: string }> {
  return (await Bun.file(path).json()) as { name: string; version: string };
}

if (import.meta.main) {
  // `bun run release:publish [version]` — the optional positional is the tag being released.
  const args = process.argv.slice(2);
  await publishAll({
    dryRun: args.includes("--dry-run"),
    noProvenance: args.includes("--no-provenance"),
    expectVersion: args.find((arg) => !arg.startsWith("--")),
  });
}
