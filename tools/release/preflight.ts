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
import { publishPlan } from "./publish.ts";

const REGISTRY = "https://registry.npmjs.org";

/** Does npm know this name at all? 404 means "never published", which OIDC cannot fix. */
async function exists(name: string): Promise<boolean> {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2F")}`, { method: "HEAD" });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`registry lookup for ${name} failed: ${response.status}`);
  return true;
}

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
      "\nrepo autonoco/pinbox, workflow release.yml). Every release after that is automatic.",
  );
  process.exit(1);
}

console.log(`\nall ${plan.length} packages exist; publishing as ${plan[0]?.version ?? "?"}`);
