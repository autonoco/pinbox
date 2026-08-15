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
  /** An action's inputs — `persist-credentials` among them. */
  with?: Record<string, unknown>;
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

test("auto-release tags the merge SHA and does not commit back to main", async () => {
  const auto = await workflow("auto-release.yml");
  const script = Object.values(auto.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n");
  expect(script).toContain("git tag -a");
  expect(script).not.toContain("gh pr create");
  expect(script).not.toContain("git commit");
  expect(script).not.toContain("bump-version.ts");
});

// A rerun after a failed release job checks out the same SHA the first attempt already tagged.
// Without this guard the version step computes the NEXT minor from that tag and mints a second
// version on the same commit — and npm publish is not reversible.
test("auto-release reruns reuse the tag already pointing at HEAD", async () => {
  const auto = await workflow("auto-release.yml");
  const version = steps(auto, "tag").find((step) =>
    (step.run ?? "").includes("git tag --points-at HEAD"),
  );
  expect(version, "the version step must look for a tag already on HEAD").toBeDefined();
  const script = version?.run ?? "";

  // The guard decides before the next-minor calculation ever sees the first attempt's tag.
  expect(script.indexOf("--points-at HEAD")).toBeLessThan(script.indexOf("LATEST="));
  // Only a real release tag is reused — not any stray `v*` ref on the commit.
  const guard = script.slice(0, script.indexOf("LATEST="));
  expect(guard).toContain("grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'");
  // Reuse means reuse: the found tag is emitted verbatim and tag creation is switched off.
  expect(guard).toContain("create_tag=false");
  expect(guard).toContain('tag=$EXISTING_TAG"');
  expect(guard).toMatch(/version=\$\{EXISTING_TAG#v\}"/);
});

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
  // The exact variable the script reads. Joining every env value would pass on an unrelated one.
  expect(build?.env?.["VERSION"]).toContain("needs.plan.outputs.version");
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
  expect(publish?.env?.["VERSION"]).toContain("needs.plan.outputs.version");
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
  // Bound to the step that evaluates it: `runsOf` flattens every script, so asserting against the
  // last step's env would pass even if some other step were the one branching on REF_TYPE.
  const decide = plan?.steps?.find((step) => (step.run ?? "").includes('"$REF_TYPE" = "tag"'));
  expect(decide?.env?.["REF_TYPE"]).toContain("github.ref_type");
  // A tag names its own version; auto-release passes one in via workflow_call. Anything else —
  // in particular a workflow_dispatch started from a branch — fails loudly instead of shipping.
  // The full anchored grep commands, not fragments: a dropped `$` anchor or a check moved out of
  // its branch must fail here.
  expect(script).toContain('"$REF_TYPE" = "tag"');
  expect(script).toContain("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'");
  // The workflow_call version is validated as semver too, and arrives through env bound to the
  // deciding step, so a malformed caller input cannot name the release. The branch keys off
  // `$CALL_VERSION`, not `$EVENT_NAME`: inside a reusable workflow, github.event_name names the
  // CALLER's event (push), never `workflow_call`.
  expect(script).toContain('-n "$CALL_VERSION"');
  expect(script).toContain("grep -Eq '^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'");
  expect(decide?.env?.["CALL_VERSION"]).toContain("inputs.version");
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

// Shape assertions prove the script contains the checks; running it proves they decide. Same env
// contract the workflow binds, so these are the real event shapes — including the branch-dispatch
// hole the test above describes.
test("plan's decide script, executed: tags and calls release, a branch dispatch cannot", async () => {
  const release = await workflow("release.yml");
  const decide = release.jobs["plan"]?.steps?.find((step) =>
    (step.run ?? "").includes('"$REF_TYPE" = "tag"'),
  );
  const script = decide?.run;
  if (script === undefined) throw new Error("release.yml plan has no decide step");

  const { $ } = await import("bun");
  const none = { CALL_VERSION: "", CALL_REF: "", REF_TYPE: "", REF_NAME: "" };
  const decideWith = async (env: Record<string, string>) => {
    const out = `${import.meta.dir}/zz-decide-probe.out`;
    await Bun.write(out, "");
    try {
      const result = await $`bash -c ${script}`
        .env({ ...process.env, ...none, ...env, GITHUB_OUTPUT: out })
        .nothrow()
        .quiet();
      const outputs = await Bun.file(out).text();
      return { exitCode: result.exitCode, released: outputs.includes("release=true"), outputs };
    } finally {
      await Bun.file(out).delete();
    }
  };

  const tag = await decideWith({ REF_TYPE: "tag", REF_NAME: "v1.2.3" });
  expect(tag.exitCode).toBe(0);
  expect(tag.released).toBe(true);
  expect(tag.outputs).toContain("version=1.2.3");
  expect(tag.outputs).toContain("tag=v1.2.3");

  const call = await decideWith({
    CALL_VERSION: "1.2.3",
    CALL_REF: "v1.2.3",
    REF_TYPE: "branch",
    REF_NAME: "main",
  });
  expect(call.exitCode).toBe(0);
  expect(call.released).toBe(true);
  expect(call.outputs).toContain("checkout_ref=v1.2.3");

  // One click of "Run workflow" on main — the irreversible-publish hole. Must refuse.
  const dispatch = await decideWith({ REF_TYPE: "branch", REF_NAME: "main" });
  expect(dispatch.exitCode).not.toBe(0);
  expect(dispatch.released).toBe(false);

  // A `v*` tag that is not a release version must refuse too, not ship a Release named vnext.
  const badTag = await decideWith({ REF_TYPE: "tag", REF_NAME: "vnext" });
  expect(badTag.exitCode).not.toBe(0);
  expect(badTag.released).toBe(false);
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

test("the workflow validator opens .yaml files too", async () => {
  // GitHub honours both extensions. A workflow the validator never opens is one it never checks,
  // and the failure is silent — the rules simply do not apply to that file.
  const source = await Bun.file(`${import.meta.dir}/workflows.ts`).text();
  expect(source).toContain('Bun.Glob("*.{yml,yaml}")');
});

test("every checkout in the tree states what it does with the token", async () => {
  // The validator enforces this; this proves the tree currently satisfies it, so a regression
  // shows up as a failing test rather than only as a failing CI script.
  for (const file of new Bun.Glob("*.{yml,yaml}").scanSync({
    cwd: `${import.meta.dir}/../../.github/workflows`,
  })) {
    const parsed = await workflow(file);
    for (const [name, job] of Object.entries(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (!String(step.uses ?? "").startsWith("actions/checkout")) continue;
        expect(
          step.with?.["persist-credentials"],
          `${file} job ${name} must not persist the checkout token`,
        ).toBe(false);
      }
    }
  }
});

/** Every `on:` spelling GitHub accepts, run through the real validator. */
async function validatorAccepts(name: string, yaml: string): Promise<{ ok: boolean; out: string }> {
  const { $ } = await import("bun");
  const dir = `${import.meta.dir}/../../.github/workflows`;
  const probe = `${dir}/zz-${name}-probe.yml`;
  await Bun.write(probe, yaml);
  try {
    const result = await $`bun ${import.meta.dir}/workflows.ts`.nothrow().quiet();
    return { ok: result.exitCode === 0, out: result.stderr.toString() + result.stdout.toString() };
  } finally {
    await Bun.file(probe).delete();
  }
}

const JOB =
  'jobs:\n  x:\n    timeout-minutes: 5\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n';

test("`on: push` — a single event, named with no config", async () => {
  // Iterating a string walks its characters, so this reported "0" as a bad trigger key and failed
  // a workflow that is entirely correct: the validator becoming the bug it exists to catch.
  const { ok, out } = await validatorAccepts("scalar", `name: probe\non: push\n${JOB}`);
  expect(ok, out).toBe(true);
});

test("`on: [push, pull_request]` — a list of events", async () => {
  const yaml = `name: probe\non: [push, pull_request]\n${JOB}`;
  const { ok, out } = await validatorAccepts("list", yaml);
  expect(ok, out).toBe(true);
});

test("a scheduled workflow is not rejected for its cron list", async () => {
  // `on.schedule` is a LIST of `{ cron }`, so its keys are "0", "1", … — checking those against
  // trigger-key names would reject every scheduled workflow the moment one is added.
  const { $ } = await import("bun");
  const dir = `${import.meta.dir}/../../.github/workflows`;
  const probe = `${dir}/zz-schedule-probe.yml`;
  await Bun.write(
    probe,
    [
      "name: probe",
      "on:",
      "  schedule:",
      '    - cron: "0 0 * * *"',
      "jobs:",
      "  x:",
      "    timeout-minutes: 5",
      "    runs-on: ubuntu-latest",
      "    steps:",
      '      - run: "true"',
      "",
    ].join("\n"),
  );
  try {
    const result = await $`bun ${import.meta.dir}/workflows.ts`.nothrow().quiet();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    await Bun.file(probe).delete();
  }
});
