// tools/validate — the workflows are code, and the two things they can get wrong are invisible
// to a YAML syntax check:
//   1. naming an entry point that does not exist (docs-sync → skillgen), or
//      scoping drift detection to one of the six artifacts that generator writes, so the other
//      five drift silently;
//   2. releasing without binding the git tag to the version actually compiled and published,
//      which ships vX.Y.Z-named artifacts built from a tree that still says X.Y.Z-1.
// Both are one-line mistakes that only fail in production, so they are asserted here.
import { expect, test } from "bun:test";

const root = new URL("../..", import.meta.url).pathname;

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  if?: string;
};
type Job = { steps?: Step[]; needs?: string | string[]; if?: string };
type Workflow = { jobs: Record<string, Job> };

async function workflow(file: string): Promise<Workflow> {
  const text = await Bun.file(`${root}.github/workflows/${file}`).text();
  return Bun.YAML.parse(text) as Workflow;
}

function steps(wf: Workflow, job: string): Step[] {
  const found = wf.jobs[job];
  if (found === undefined) throw new Error(`no job ${job} in ${Object.keys(wf.jobs).join(", ")}`);
  return found.steps ?? [];
}

function runsOf(list: Step[]): string {
  return list.map((step) => step.run ?? "").join("\n");
}

/** Every job `job` waits on, transitively — what "nothing runs before the guard" is asserted with. */
function needsClosure(jobs: Record<string, Job>, job: string): string[] {
  const seen = new Set<string>();
  const queue = [job];
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    const needs = jobs[current]?.needs ?? [];
    for (const dep of typeof needs === "string" ? [needs] : needs) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen];
}

test("docs-sync invokes skillgen's real entry point, and only paths that exist", async () => {
  const script = runsOf(steps(await workflow("docs-sync.yml"), "docs-sync"));
  expect(script).toContain("tools/skillgen/generate.ts");
  // skillgen ships `generate.ts`, guarded by `if (import.meta.main)`, not an `index.ts`.
  expect(script).not.toContain("tools/skillgen/index.ts");

  // This is a live existence check on every path the workflow names.
  const referenced = new Set(script.match(/tools\/skillgen\/[\w./-]+/g) ?? []);
  expect(referenced.size).toBeGreaterThan(0);
  if (await Bun.file(`${root}tools/skillgen/generate.ts`).exists()) {
    for (const path of referenced) {
      expect(await Bun.file(`${root}${path}`).exists(), `${path} is referenced but missing`).toBe(
        true,
      );
    }
  }
});

test("docs-sync gates on skillgen's whole generated set, not skills/pinbox alone", async () => {
  const list = steps(await workflow("docs-sync.yml"), "docs-sync");
  const script = runsOf(list);

  // `--check` byte-diffs every artifact the generator owns — three SKILL.md copies, both
  // plugin manifests, and the embedded plugin-assets module — and exits 1 on any drift.
  expect(script).toContain("tools/skillgen/generate.ts --check");
  // A hand-rolled diff scoped to one output reports the other five as clean.
  expect(script).not.toMatch(/git\s+(diff|add|status)[^\n]*skills\/pinbox/);

  const pr = list.find((step) => (step.run ?? "").includes("gh pr create"));
  expect(pr, "docs-sync must open a PR rather than push to main").toBeDefined();
  const prScript = pr?.run ?? "";
  // The PR has to carry the regeneration itself, and all of it: a partial commit leaves the
  // repo drifted after the merge that was supposed to fix it.
  expect(prScript).toMatch(/bun tools\/skillgen\/generate\.ts(?! --check)/);
  expect(prScript).toContain("git add -A");
});

test("release compiles the version `plan` decided on, passed through env", async () => {
  const release = await workflow("release.yml");
  const list = steps(release, "compile");
  const build = list.find((step) => (step.run ?? "").includes("release:build"));
  expect(build, "the compile job must run release:build").toBeDefined();
  const script = build?.run ?? "";

  // Without an argument `compileAll`'s assertVersion compares the CLI manifest to itself and
  // can never fail — the guard is inert and the release binds to nothing.
  expect(script).toMatch(/release:build\s+"?\$\{?VERSION/);
  // Refs and versions are attacker-shaped input; they arrive through env, never `${{ }}` inline.
  expect(script).not.toContain("${{");
  // One place decides what is being released, and everything downstream reads that decision —
  // rather than each job re-deriving a version from whatever ref it happens to see.
  expect(Object.values(build?.env ?? {}).join(" ")).toContain("needs.plan.outputs.version");
  expect(needsClosure(release.jobs, "compile")).toContain("plan");
});

test("release publishes the version `plan` decided on too", async () => {
  const release = await workflow("release.yml");
  const list = steps(release, "publish");
  const publish = list.find((step) => (step.run ?? "").includes("release:publish"));
  expect(publish, "the publish job must run release:publish").toBeDefined();
  const script = publish?.run ?? "";
  expect(script).toMatch(/release:publish\s+"?\$\{?VERSION/);
  expect(script).not.toContain("${{");
  expect(Object.values(publish?.env ?? {}).join(" ")).toContain("needs.plan.outputs.version");
  expect(needsClosure(release.jobs, "publish")).toContain("plan");
});

// npm unpublish is heavily restricted, so a bogus publish is not recoverable. `workflow_dispatch`
// is the hole: its `github.ref_name` is whatever ref the run was started from, and one click of
// "Run workflow" on `main` would otherwise cut a Release named `main` and fan it out to npm.
test("release only ships what `plan` said to ship", async () => {
  const release = await workflow("release.yml");
  const plan = release.jobs["plan"];
  expect(plan, "release.yml needs a `plan` job that decides what is released").toBeDefined();

  const script = runsOf(plan?.steps ?? []);
  expect(script).not.toContain("${{");
  expect(Object.values(plan?.steps?.at(-1)?.env ?? {}).join(" ")).toContain("github.ref_type");
  // A tag names its own version; a branch does not, so the manifest is read instead — and only
  // ships when that version has never been tagged, so an ordinary merge releases nothing.
  expect(script).toContain('"$REF_TYPE" = "tag"');
  expect(script).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+");
  expect(script).toContain("refs/tags/v$version");
  expect(script).toMatch(/exit 1/);

  // Nothing runs ahead of the plan, so no job can act on a version nobody decided.
  for (const name of Object.keys(release.jobs)) {
    if (name === "plan") continue;
    expect(needsClosure(release.jobs, name), `job ${name} must transitively need plan`).toContain(
      "plan",
    );
  }

  // Belt and braces: the two irreversible jobs re-check for themselves, so neither a single-job
  // re-run nor a future edit to `needs` can ship something nobody decided to ship.
  for (const name of ["github-release", "publish"]) {
    expect(release.jobs[name]?.if, `${name} must carry its own release guard`).toContain(
      "needs.plan.outputs.release",
    );
  }
});

// Trusted Publishing cannot create a package that does not exist; npm answers a bare 404 on the
// PUT, which is how the v0.1.0 release failed after signing provenance for every tarball.
test("release checks the registry before it uploads anything", async () => {
  const release = await workflow("release.yml");
  const list = steps(release, "publish");
  const names = list.map((step) => step.run ?? "");
  const preflight = names.findIndex((run) => run.includes("release/preflight.ts"));
  const publish = names.findIndex((run) => run.includes("release:publish"));
  expect(preflight, "the publish job must run the registry preflight").toBeGreaterThanOrEqual(0);
  expect(preflight).toBeLessThan(publish);
});

test("both workflows keep their release-shape guarantees", async () => {
  const release = await workflow("release.yml");
  // Ordering is the gate: nothing publishes until the compiled artifacts survived smoke.
  const jobs = release.jobs as Record<string, { needs?: string | string[] }>;
  expect([jobs["compile"]?.needs ?? []].flat()).toContain("validate");
  expect([jobs["publish"]?.needs ?? []].flat()).toContain("github-release");
});
