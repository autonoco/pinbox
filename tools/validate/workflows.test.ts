// tools/validate — the workflows are code, and the two things they can get wrong are invisible
// to a YAML syntax check:
//   1. naming an entry point that does not exist (docs-sync → skillgen), or
//      scoping drift detection to one of the six artifacts that generator writes, so the other
//      five drift silently;
//   2. releasing without binding the git tag to the version actually compiled and published,
//      which ships vX.Y.Z-named artifacts built from a tree that still says X.Y.Z-1.
// Both are one-line mistakes that only fail in production, so they are asserted here.
import { expect, test } from "bun:test";
import { SEMVER_SOURCE } from "../release/bump-version.ts";

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
type Job = { steps?: Step[]; needs?: string | string[]; if?: string; uses?: string };
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

test("auto-release and release.yml share one concurrency group", async () => {
  // Buttons: one lock so a hand-pushed tag cannot race a main-branch release.
  const group = async (file: string) => {
    const text = await Bun.file(`${root}.github/workflows/${file}`).text();
    return text.match(/^concurrency:\n {2}group: (\S+)/m)?.[1];
  };
  const auto = await group("auto-release.yml");
  const release = await group("release.yml");
  expect(auto).toBe("pinbox-release");
  expect(release).toBe(auto);
});

test("auto-release is one job that tags and publishes — it does not call release.yml", async () => {
  const auto = await workflow("auto-release.yml");
  expect(Object.keys(auto.jobs)).toEqual(["release"]);
  expect(auto.jobs["release"]?.uses).toBeUndefined();
  const script = runsOf(steps(auto, "release"));
  expect(script).toContain("git tag -a");
  expect(script).toContain("gh release create");
  expect(script).toContain("release:build");
  expect(script).toContain("release:publish");
  expect(script).toContain("release/preflight.ts");
  expect(script).not.toContain("gh pr create");
  expect(script).not.toContain("git commit");
});

test("release.yml is hand-pushed tags only and does not publish npm", async () => {
  const text = await Bun.file(`${root}.github/workflows/release.yml`).text();
  expect(text).toContain('tags: ["v*"]');
  expect(text).not.toContain("workflow_call");
  expect(text).not.toContain("workflow_dispatch");
  const release = await workflow("release.yml");
  expect(Object.keys(release.jobs)).toEqual(["release"]);
  const script = runsOf(steps(release, "release"));
  expect(script).toContain("gh release create");
  expect(script).toContain("release:build");
  expect(script).not.toContain("release:publish");
});

test("compile's all-platform install is not frozen — stamp already mutated manifests", async () => {
  const text = await Bun.file(`${root}tools/release/compile.ts`).text();
  const install = text.match(/bun install[^`\n]+--os \$\{all\}[^`\n]*/)?.[0];
  expect(install).toBeDefined();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal shell source
  expect(install).toContain("--cpu ${all}");
  expect(install).not.toContain("--frozen-lockfile");
});

test("auto-release stamps the tag in the workspace and does not commit it", async () => {
  const auto = await workflow("auto-release.yml");
  const script = runsOf(steps(auto, "release"));
  expect(script).toContain("bump-version.ts");
  expect(script).not.toContain("git commit");
  expect(script).not.toContain("git add");
  expect(script).not.toContain("gh pr create");
});

// A rerun after a failed release job checks out the same SHA the first attempt already tagged.
// Without this guard the version step computes the NEXT minor from that tag and mints a second
// version on the same commit — and npm publish is not reversible.
test("auto-release reruns reuse the tag already pointing at HEAD", async () => {
  const auto = await workflow("auto-release.yml");
  const version = steps(auto, "release").find((step) =>
    (step.run ?? "").includes("git tag --points-at HEAD"),
  );
  expect(version, "the version step must look for a tag already on HEAD").toBeDefined();
  const script = version?.run ?? "";

  // The guard decides before the next-minor calculation ever sees the first attempt's tag.
  expect(script.indexOf("--points-at HEAD")).toBeLessThan(script.indexOf("LATEST="));
  // Only a real release tag is reused — not any stray `v*` ref on the commit. The predicate is
  // the ONE canonical SemVer policy, byte-for-byte the SEMVER_SOURCE bump-version.ts enforces,
  // so no path can accept a tag the stamping tool would refuse (or vice versa).
  const guard = script.slice(0, script.indexOf("LATEST="));
  expect(guard).toContain(`SEMVER='${SEMVER_SOURCE}'`);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal shell source
  expect(guard).toContain('grep -E "^v${SEMVER}$"');
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

test("auto-release compiles and publishes the version the tag step decided, via env", async () => {
  const auto = await workflow("auto-release.yml");
  const list = steps(auto, "release");
  const build = list.find((step) => (step.run ?? "").includes("release:build"));
  const publish = list.find((step) => (step.run ?? "").includes("release:publish"));
  expect(build, "the job must run release:build").toBeDefined();
  expect(publish, "the job must run release:publish").toBeDefined();
  expect(build?.run).toMatch(/release:build\s+"?\$\{?VERSION/);
  expect(publish?.run).toMatch(/release:publish\s+"?\$\{?VERSION/);
  expect(build?.run).not.toContain("${{");
  expect(publish?.run).not.toContain("${{");
  expect(build?.env?.["VERSION"]).toContain("steps.version.outputs.version");
  expect(publish?.env?.["VERSION"]).toContain("steps.version.outputs.version");
});

test("auto-release checks the registry before it uploads anything", async () => {
  const names = steps(await workflow("auto-release.yml"), "release").map((step) => step.run ?? "");
  const preflight = names.findIndex((run) => run.includes("release/preflight.ts"));
  const publish = names.findIndex((run) => run.includes("release:publish"));
  expect(preflight, "the job must run the registry preflight").toBeGreaterThanOrEqual(0);
  expect(preflight).toBeLessThan(publish);
});

test("hand-pushed tag release binds compile to the tag via env", async () => {
  const release = await workflow("release.yml");
  const list = steps(release, "release");
  const stamp = list.find((step) => (step.run ?? "").includes("bump-version.ts"));
  const build = list.find((step) => (step.run ?? "").includes("release:build"));
  expect(stamp?.env?.["REF_NAME"]).toContain("github.ref_name");
  expect(stamp?.run).toContain(`SEMVER='${SEMVER_SOURCE}'`);
  expect(build?.env?.["VERSION"]).toContain("steps.version.outputs.version");
  expect(build?.run).not.toContain("${{");
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
