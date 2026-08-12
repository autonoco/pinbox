// tools/validate — the CI hardening rules, enforced instead of remembered.
//
// Every rule here is one that was already broken in this repo, and every one of them fails
// quietly: an unpinned action changes under you, an unpinned Bun breaks a build nobody touched, a
// job with no timeout burns a runner for six hours, and a checkout token left in .git/config is
// one `run:` step away from anything the build happens to execute.
//
// Modelled on autonoco/buttons-platform, which pins tool versions, bounds every job, and refuses
// to run a deploy whose credentials are missing rather than failing later with a confusing error.
const root = Bun.fileURLToPath(new URL("../..", import.meta.url));
const dir = `${root}.github/workflows`;

/** Action majors, matched to buttons-platform so both repos move together. */
const PINNED_ACTIONS: Record<string, string> = {
  "actions/checkout": "v7",
  "actions/setup-node": "v6",
  "oven-sh/setup-bun": "v2",
};

/** The Bun CI runs. Not "latest": a Bun release must never break a tree nobody changed. */
const BUN_VERSION = "1.3.14";

type Step = { uses?: string; with?: Record<string, unknown>; run?: string; name?: string };
type Job = { "timeout-minutes"?: number; steps?: Step[]; uses?: string };
type Triggers = Record<string, Record<string, unknown> | Record<string, unknown>[] | null>;

const problems: string[] = [];

function check(file: string, ok: boolean, message: string): void {
  if (!ok) problems.push(`${file}: ${message}`);
}

// Both extensions: GitHub honours .yaml, and a workflow this never opened is one it never checked.
const files = [...new Bun.Glob("*.{yml,yaml}").scanSync({ cwd: dir })].sort();

for (const file of files) {
  const parsed = Bun.YAML.parse(await Bun.file(`${dir}/${file}`).text()) as {
    on?: Triggers;
    /** YAML 1.1 reads a bare `on:` key as the boolean true; both spellings reach us. */
    true?: Triggers;
    jobs?: Record<string, Job>;
  };

  // A job key indented one level too far lands inside the trigger block, where GitHub silently
  // ignores it — the workflow still runs, just not when or how you meant. Caught here because a
  // bulk edit put `timeout-minutes` under `push:` in all five files at once and every one of them
  // still parsed as valid YAML.
  const triggers = (parsed.on ?? parsed.true ?? {}) as Record<string, unknown>;
  const TRIGGER_KEYS = new Set([
    "branches",
    "branches-ignore",
    "tags",
    "tags-ignore",
    "paths",
    "paths-ignore",
    "types",
    "inputs",
    "cron",
    "schedule",
    "workflows",
    "secrets",
    "outputs",
  ]);
  for (const [event, config] of Object.entries(triggers)) {
    // `schedule` is a LIST of `{ cron }`, not a keyed config: its indexes are "0", "1", … and
    // checking them against key names would reject every scheduled workflow ever added.
    const entries = Array.isArray(config) ? (config as Record<string, unknown>[]) : [config ?? {}];
    for (const entry of entries) {
      for (const key of Object.keys(entry)) {
        check(
          file,
          TRIGGER_KEYS.has(key),
          `"${key}" under trigger "${event}" is not a trigger key`,
        );
      }
    }
  }
  const jobs = Object.entries(parsed.jobs ?? {});
  check(file, jobs.length > 0, "no jobs — did the YAML parse?");

  for (const [name, job] of jobs) {
    // A reusable-workflow call has no steps of its own and inherits the callee's bounds.
    if (job.uses !== undefined) continue;

    check(file, typeof job["timeout-minutes"] === "number", `job "${name}" has no timeout-minutes`);

    for (const step of job.steps ?? []) {
      const uses = step.uses;
      if (uses === undefined) continue;
      const [action, ref] = uses.split("@");
      const want = action === undefined ? undefined : PINNED_ACTIONS[action];
      if (want !== undefined) {
        check(file, ref === want, `job "${name}" uses ${uses}, expected ${action}@${want}`);
      }
      if (action === "actions/checkout") {
        // Never left to the default. A checkout token stays in .git/config for the whole job, one
        // `run:` step away from anything the build happens to execute; the job that genuinely
        // pushes authenticates that one command instead.
        const persist = (step.with as { "persist-credentials"?: unknown } | undefined)?.[
          "persist-credentials"
        ];
        check(
          file,
          persist === false,
          `job "${name}" checks out without persist-credentials: false`,
        );
      }
      if (action === "oven-sh/setup-bun") {
        const pinned = (step.with as { "bun-version"?: unknown } | undefined)?.["bun-version"];
        check(
          file,
          pinned === BUN_VERSION,
          `job "${name}" does not pin bun-version to ${BUN_VERSION} (got ${String(pinned)})`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error("CI workflows break the hardening rules:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nSee the header of ${"tools/validate/workflows.ts"} for why each rule exists.`);
  process.exit(1);
}

console.log(`.github/workflows: ${files.length} workflows, every job pinned and bounded.`);
