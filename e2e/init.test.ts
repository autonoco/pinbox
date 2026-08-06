// e2e — `pinbox init` and `pinbox link` over the COMPILED binary
// (packages/cli/dist/pinbox), in a mkdtemp git project with HOME/XDG_STATE_HOME
// redirected — the loop.test.ts harness.
// What only e2e can prove: that the shipped artifact is idempotent on a real
// filesystem, that it never spawns an agent when it says it will not (a booby-trap
// stub on PATH would leave a file behind), that the plugin it materializes is
// structurally loadable by Claude Code, and that `link` reaches E_CONNECTOR through
// the real daemon's serve wiring rather than an in-process stub.
import { afterAll, beforeAll, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const BINARY = `${repoRoot}packages/cli/dist/pinbox`;

// System tools only: git for `git init`, and NO `gh` (case d depends on its absence).
const RESTRICTED_PATH = "/usr/bin:/bin";

let tmp = "";
let binDir = "";
let boobyTrap = "";
let env: Record<string, string>;

/** Same shape as the schema fixtures (packages/core/src/schema.test.ts). */
const validInput = {
  text: "button is cut off",
  kind: "note",
  target: {
    url: "http://localhost:3000/",
    selector: "main > button.cta",
    tag: "button",
    rect: { x: 120, y: 480, width: 200, height: 48 },
    fixed: false,
  },
  env: {
    viewport: { w: 1440, h: 900, dpr: 2 },
    browser: "Chrome 130",
    os: "macOS",
    colorScheme: "light",
  },
  author: { userId: "bobak" },
};

beforeAll(async () => {
  tmp = (await Bun.$`mktemp -d`.text()).trim();
  binDir = `${tmp}/bin`;
  // The booby trap: a `claude` on PATH that records the fact it ran. Every assertion
  // below that says "spawns nothing" is only worth something because this exists.
  boobyTrap = `${tmp}/agent-ran`;
  await Bun.$`mkdir -p ${binDir} ${tmp}/home`.quiet();
  await Bun.write(`${binDir}/claude`, `#!/bin/sh\necho spawned > ${boobyTrap}\n`);
  await Bun.$`chmod 755 ${binDir}/claude`.quiet();
  env = {
    PATH: `${binDir}:${RESTRICTED_PATH}`,
    HOME: `${tmp}/home`,
    XDG_STATE_HOME: `${tmp}/state`,
    PINBOX_IDLE_MS: "60000",
  };
});

afterAll(async () => {
  await reapDaemons();
  if (tmp !== "") await Bun.$`rm -rf ${tmp}`.quiet();
});

test("compiled binary exists", async () => {
  expect(
    await Bun.file(BINARY).exists(),
    `missing ${BINARY} — run \`bun run build\` first (ci:validate builds before testing)`,
  ).toBe(true);
});

// (a)
test("init is idempotent: the second run changes nothing and still exits 0", async () => {
  const dir = await gitProject("idempotent");
  const first = await run(dir, ["init", "--agent", "none", "--yes"]);
  expect(first.code, first.stderr).toBe(0);
  const afterFirst = await Bun.file(`${dir}/.gitignore`).text();

  const second = await run(dir, ["init", "--agent", "none", "--yes"]);
  expect(second.code, second.stderr).toBe(0);
  expect(second.stdout).toContain("unchanged");
  expect(await Bun.file(`${dir}/.gitignore`).text()).toBe(afterFirst);
  expect(await dirExists(`${dir}/.pinbox`)).toBe(true);
}, 30_000);

// (b)
test("--dry-run emits the brief and writes nothing; an agent invocation spawns no agent", async () => {
  const dir = await gitProject("brief");
  const dry = await run(dir, ["init", "--dry-run"]);
  expect(dry.code, dry.stderr).toBe(0);
  expect(dry.stdout).toContain("pinbox/integration");
  expect(await dirExists(`${dir}/.claude`)).toBe(false);
  expect(await Bun.file(`${dir}/.gitignore`).exists()).toBe(false);
  expect(await Bun.file(boobyTrap).exists()).toBe(false);

  const agentRun = await run(dir, ["init", "--json", "--agent", "none"], { CLAUDECODE: "1" });
  expect(agentRun.code, agentRun.stderr).toBe(0);
  const envelope = JSON.parse(agentRun.stdout) as { ok: boolean; data: { brief?: string } };
  expect(envelope.ok).toBe(true);
  expect(envelope.data.brief).toContain("pinbox/integration");
  // An agent never spawns a second agent — the stub `claude` on PATH never ran.
  expect(await Bun.file(boobyTrap).exists()).toBe(false);
}, 30_000);

// (c)
test("the materialized Claude plugin is structurally loadable", async () => {
  const dir = await gitProject("plugin");
  await Bun.$`mkdir -p ${env["HOME"]}/.claude`.quiet();
  const init = await run(dir, ["init", "--agent", "claude", "--yes"]);
  expect(init.code, init.stderr).toBe(0);

  const root = `${dir}/.claude/skills/pinbox`;
  const manifest = (await Bun.file(`${root}/.claude-plugin/plugin.json`).json()) as {
    name: string;
  };
  expect(manifest.name).toBe("pinbox");

  const skill = await Bun.file(`${root}/skills/pinbox/SKILL.md`).text();
  expect(skill.length).toBeGreaterThan(0);
  expect(skill).toContain("pinbox");

  // hooks.json names the three §8 payload scripts through the dual-root idiom.
  const hooks = await Bun.file(`${root}/hooks/hooks.json`).text();
  for (const script of ["session-start.sh", "inject.sh", "stop.sh"]) {
    expect(hooks).toContain(script);
  }

  // The PATH channel only works if the shim is executable.
  const mode = (await Bun.file(`${root}/bin/pinbox`).stat()).mode & 0o777;
  expect(mode.toString(8)).toBe("755");
}, 30_000);

// (c) live gate — only where the real agent is installed.
test.skipIf(Bun.which("claude") === null)(
  "claude plugin validate accepts it",
  async () => {
    const dir = await gitProject("validate");
    const init = await run(dir, ["init", "--agent", "claude", "--yes"]);
    expect(init.code, init.stderr).toBe(0);
    const validate = Bun.spawnSync(
      ["claude", "plugin", "validate", `${dir}/.claude/skills/pinbox`],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(validate.exitCode, `${validate.stdout.toString()}${validate.stderr.toString()}`).toBe(0);
  },
  60_000,
);

// (d)
test("link: unknown pin is E_NOT_FOUND; an unusable gh makes a real pin E_CONNECTOR", async () => {
  const dir = await gitProject("link");
  // Do NOT assert gh is absent: GitHub's runners ship it at /usr/bin/gh, which is inside the
  // sanitized PATH. What this test actually pins is that an UNUSABLE gh — missing on a dev box,
  // present-but-unauthenticated on CI — surfaces as E_CONNECTOR rather than a crash or a hang.
  // (An authenticated gh would really link, so a CI job that logs gh in would need a stub.)

  const missing = await run(dir, ["link", "pin_0000000000", "--json"]);
  expect(missing.code).toBe(3);
  const notFound = JSON.parse(missing.stdout) as { ok: boolean; error: { code: string } };
  expect(notFound.ok).toBe(false);
  expect(notFound.error.code).toBe("E_NOT_FOUND");

  // A real pin, posted over raw HTTP the way the toolbar does, through the daemon the
  // command above just spawned — so the E_CONNECTOR below comes from serve's wiring.
  const state = await readHubState();
  if (state === null) throw new Error("hub.json not found under XDG_STATE_HOME");
  const created = await fetch(`http://127.0.0.1:${state.port}/pins`, {
    method: "POST",
    headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
    body: JSON.stringify(validInput),
  });
  expect(created.status).toBe(201);
  const { data } = (await created.json()) as { data: { id: string } };

  const linked = await run(dir, ["link", data.id, "--json"]);
  expect(linked.code).toBe(10);
  const envelope = JSON.parse(linked.stdout) as {
    ok: boolean;
    error: { code: string; hint?: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe("E_CONNECTOR");
  // Both unusable-gh states must name a next command; only the wording differs.
  expect(envelope.error.hint).toContain("gh auth login");
  expect(envelope.error.hint).toBeTypeOf("string");
}, 30_000);

// (e) the delivery check is the real register → pin → inject round trip, not a placeholder.
test("doctor reports the gh and delivery checks", async () => {
  const dir = await gitProject("doctor");
  const doctor = await run(dir, ["doctor", "--json"]);
  expect(doctor.code, doctor.stderr).toBe(0);
  const envelope = JSON.parse(doctor.stdout) as {
    data: { checks: { name: string; ok: boolean; detail: string }[] };
  };
  const byName = new Map(envelope.data.checks.map((check) => [check.name, check]));
  // The check itself must succeed; its detail reports whichever unusable state this machine is
  // in — "not found" on a dev box, "not authenticated" on a runner that ships gh. Asserting one
  // spelling made this pass locally and fail on CI.
  expect(byName.get("gh")?.ok).toBe(true);
  expect(byName.get("gh")?.detail).toMatch(/not found|not authenticated/);
  expect(byName.get("delivery")?.ok, byName.get("delivery")?.detail).toBe(true);
  expect(byName.get("delivery")?.detail).toContain("round trip ok");
}, 30_000);

// (f) The shipped artifact carries no loose files, so the post-commit payload has to be
// embedded — a source-tree run proves nothing about it. Without this test, commit-trailer
// resolution silently dies in every install while the unit tests (which inject assetsDir)
// stay green.
test("the compiled binary installs the post-commit hook from its embedded payload", async () => {
  const dir = await gitProject("git-hook");
  const first = await run(dir, ["init", "--agent", "none", "--yes", "--json"]);
  expect(first.code, first.stderr).toBe(0);
  const envelope = JSON.parse(first.stdout) as { ok: boolean; data: { gitHook: string } };
  expect(envelope.ok).toBe(true);
  expect(envelope.data.gitHook).toBe("installed");

  const hook = Bun.file(`${dir}/.git/hooks/post-commit`);
  expect(await hook.exists()).toBe(true);
  expect(((await hook.stat()).mode & 0o111) !== 0).toBe(true);
  // It is the trailer hook, not an empty file.
  expect(await hook.text()).toContain("session trailer");

  // Re-running never clobbers what is already there.
  const second = await run(dir, ["init", "--agent", "none", "--yes", "--json"]);
  expect(second.code, second.stderr).toBe(0);
  expect((JSON.parse(second.stdout) as { data: { gitHook: string } }).data.gitHook).toBe("kept");
}, 30_000);

/** A fresh git project under the shared temp root. */
async function gitProject(name: string): Promise<string> {
  const dir = `${tmp}/${name}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env });
  return dir;
}

/** Run the compiled binary in `cwd` with the restricted environment. */
async function run(
  cwd: string,
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BINARY, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function dirExists(path: string): Promise<boolean> {
  return (await Bun.$`test -d ${path}`.quiet().nothrow()).exitCode === 0;
}

/** Every daemon this file spawned (one per project dir) — reaped at the end. */
async function reapDaemons(): Promise<void> {
  const glob = new Bun.Glob("pinbox/*/hub.json");
  let matches: string[] = [];
  try {
    matches = [...glob.scanSync({ cwd: env["XDG_STATE_HOME"] as string, dot: true })];
  } catch {
    return;
  }
  for (const match of matches) {
    try {
      const state = (await Bun.file(`${env["XDG_STATE_HOME"]}/${match}`).json()) as { pid: number };
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone, or never written
    }
  }
}

/** The state file the daemon writes under XDG_STATE_HOME (project id is hashed — glob). */
async function readHubState(): Promise<{ pid: number; port: number; token: string } | null> {
  const glob = new Bun.Glob("pinbox/*/hub.json");
  let matches: string[];
  try {
    matches = [...glob.scanSync({ cwd: env["XDG_STATE_HOME"] as string, dot: true })];
  } catch {
    return null;
  }
  const first = matches[0];
  if (first === undefined) return null;
  try {
    return (await Bun.file(`${env["XDG_STATE_HOME"]}/${first}`).json()) as {
      pid: number;
      port: number;
      token: string;
    };
  } catch {
    return null;
  }
}
