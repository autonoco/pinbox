// tools/release — the check that runs before anything reaches npm.
//
// Trusted Publishing mints npm credentials from a CI OIDC token, and it can only publish a
// package that ALREADY EXISTS with a trusted publisher configured on it. Publishing a brand-new
// scoped name over OIDC gets a bare `404 Not Found - PUT` — which reads like the registry is
// broken, or like the package was deleted, rather than like a setting has never been filled in.
//
// That is not hypothetical. It is exactly how the v0.1.0 release failed: every tarball built,
// provenance was signed and logged, and then the PUT 404'd on @autono/pinbox-core. The packages
// were published by hand afterwards, so the pipeline has still never completed a release.
//
// This turns that into a sentence you can act on, before any tarball is uploaded — so a release
// cannot get half way through the ORDERED publish sequence and strand the launcher pointing at
// platform packages that are not there.
import { $ } from "bun";
import { publishPlan } from "./publish.ts";

const REGISTRY = "https://registry.npmjs.org";

/**
 * `npm publish --provenance` over OIDC needs Trusted Publishing support, which landed in
 * npm 11.5.1. `setup-node` pins Node, not npm, and a cached Node 24.x can carry an older
 * bundled npm — so the floor is enforced here, before anything is signed or uploaded.
 */
const MIN_NPM = [11, 5, 1] as const;

async function assertNpmVersion(): Promise<void> {
  const raw = (await $`npm --version`.text()).trim();
  const parts = raw.split(".").map((piece) => Number.parseInt(piece, 10));
  // First non-zero difference across major.minor.patch decides; ties mean "at the floor".
  const delta = MIN_NPM.map((floor, i) => (parts[i] ?? 0) - floor).find((d) => d !== 0) ?? 0;
  if (delta < 0) {
    console.error(
      `npm ${raw} is too old for Trusted Publishing: --provenance over OIDC needs ` +
        `npm >= ${MIN_NPM.join(".")}. Update Node (npm ships with it) or npm itself.`,
    );
    process.exit(1);
  }
  console.log(`✓ npm ${raw} (>= ${MIN_NPM.join(".")})`);
}

/** Long enough for a slow registry, short enough that a hung one is not mistaken for a slow one. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** Does npm know this name at all? 404 means "never published", which OIDC cannot fix. */
async function exists(name: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${REGISTRY}/${name.replace("/", "%2F")}`, {
      method: "HEAD",
      // Without a deadline a stalled connection hangs the publish job until the workflow's own
      // timeout kills it — twenty minutes later, with no clue which package it was waiting on.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`registry lookup for ${name} did not answer within 10s: ${reason}`);
  }
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`registry lookup for ${name} failed: ${response.status}`);
  return true;
}

await assertNpmVersion();

const plan = await publishPlan();
const missing: string[] = [];

for (const step of plan) {
  const known = await exists(step.name);
  console.log(`${known ? "✓" : "✗"} ${step.name}`);
  if (!known) missing.push(step.name);
}

if (missing.length > 0) {
  console.error("\nThese packages have never been published, so CI cannot publish them:\n");
  for (const name of missing) console.error(`  ${name}`);
  console.error(
    "\nTrusted Publishing can only publish a package that already exists. Create each one" +
      "\nfrom a laptop ONCE with `bun run release:publish <version> --no-provenance`, then add a" +
      "\ntrusted publisher for it on npmjs.com (Settings → Trusted Publisher → GitHub Actions," +
      "\nrepo autonoco/pinbox, workflow auto-release.yml). Every release after that is automatic.",
  );
  process.exit(1);
}

console.log(`\nall ${plan.length} packages exist; publishing as ${plan[0]?.version ?? "?"}`);
