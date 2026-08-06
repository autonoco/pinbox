// Command-level init tests (Layer 1): mkdtemp project + git init, injected env/home.
// Idempotency (second run all-unchanged, exit 0), --agent validation (unknown targets
// error loudly), --agent none writes project state only, and non-interactive runs
// without --agent/--yes never install silently.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { type InitData, runInit } from "./init.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-init-${crypto.randomUUID()}`;
const fakeHome = `${tmpRoot}/home`;
// PATH is empty so detection comes only from the fake home's config dirs.
const env = { HOME: fakeHome, PATH: "" };

class ExitSignal extends Error {
  constructor(public exitCode: number | undefined) {
    super(`exit ${exitCode}`);
  }
}

async function gitProject(name: string): Promise<string> {
  const dir = `${tmpRoot}/${name}`;
  await $`mkdir -p ${dir}`.quiet();
  await $`git -C ${dir} init -q`.quiet();
  return dir;
}

/** Run and return {envelope, exitCode} with console/process spied. */
async function capture(run: () => Promise<void>): Promise<{
  envelope: { ok: boolean; data?: InitData; error?: { code: string; hint?: string } };
  exitCode: number | undefined;
}> {
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as typeof process.exit);
  let exitCode: number | undefined;
  try {
    try {
      await run();
    } catch (thrown) {
      if (!(thrown instanceof ExitSignal)) throw thrown;
      exitCode = thrown.exitCode;
    }
    // Read before the finally: mockRestore clears the recorded calls.
    return { envelope: JSON.parse(String(out.mock.calls.at(-1)?.[0])), exitCode };
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
    process.exitCode = 0;
  }
}

beforeAll(async () => {
  await $`mkdir -p ${fakeHome}/.claude`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("pinbox init (Layer 1)", () => {
  test("default --yes run: .pinbox/, gitignore, claude via skills-dir from the fake home", async () => {
    const dir = await gitProject("default");
    const { envelope, exitCode } = await capture(() =>
      runInit({ json: true, yes: true }, { projectDir: dir, env, home: fakeHome, isTTY: false }),
    );
    expect(exitCode).toBeUndefined();
    expect(envelope.ok).toBe(true);
    const data = envelope.data as InitData;
    expect(data.pinboxDir).toBe("created");
    expect(data.gitignore).toBe("created");
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]).toMatchObject({ agent: "claude", method: "skills-dir", ok: true });
    // packages/cli/hooks/post-commit ships, so the install no longer degrades.
    expect(data.gitHook).toBe("installed");
    expect(await Bun.file(`${dir}/.git/hooks/post-commit`).exists()).toBe(true);
    expect(await Bun.file(`${dir}/.claude/skills/pinbox/.claude-plugin/plugin.json`).exists()).toBe(
      true,
    );
  });

  test("second run is all-unchanged, exit 0, no duplicate gitignore line", async () => {
    const dir = await gitProject("twice");
    await capture(() =>
      runInit({ json: true, yes: true }, { projectDir: dir, env, home: fakeHome, isTTY: false }),
    );
    const { envelope, exitCode } = await capture(() =>
      runInit({ json: true, yes: true }, { projectDir: dir, env, home: fakeHome, isTTY: false }),
    );
    expect(exitCode).toBeUndefined();
    const data = envelope.data as InitData;
    expect(data.pinboxDir).toBe("unchanged");
    expect(data.gitignore).toBe("unchanged");
    expect(data.agents[0]?.detail).toContain("unchanged");
    const lines = (await Bun.file(`${dir}/.gitignore`).text())
      .split("\n")
      .filter((line) => line === ".pinbox/");
    expect(lines).toHaveLength(1);
  });

  test("--agent nope errors loudly: E_INVALID_INPUT envelope, exit 2", async () => {
    const dir = await gitProject("unknown-agent");
    const { envelope, exitCode } = await capture(() =>
      runInit(
        { json: true, agent: "nope" },
        { projectDir: dir, env, home: fakeHome, isTTY: false },
      ),
    );
    expect(exitCode).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("E_INVALID_INPUT");
    expect(envelope.error?.hint).toContain("claude");
  });

  test("--agent none installs nothing but still writes project state", async () => {
    const dir = await gitProject("none");
    const { envelope } = await capture(() =>
      runInit(
        { json: true, agent: "none" },
        { projectDir: dir, env, home: fakeHome, isTTY: false },
      ),
    );
    const data = envelope.data as InitData;
    expect(data.agents).toHaveLength(0);
    expect(data.pinboxDir).toBe("created");
    expect(await Bun.file(`${dir}/.claude/skills/pinbox/skills/pinbox/SKILL.md`).exists()).toBe(
      false,
    );
  });

  test("non-interactive without --agent/--yes never installs silently: would-do listing only", async () => {
    const dir = await gitProject("plan-only");
    const { envelope, exitCode } = await capture(() =>
      runInit(
        { json: true },
        { projectDir: dir, env: { ...env, CLAUDECODE: "1" }, home: fakeHome, isTTY: false },
      ),
    );
    expect(exitCode).toBeUndefined();
    const data = envelope.data as InitData;
    expect(data.agents.length).toBeGreaterThan(0);
    for (const outcome of data.agents) expect(outcome.detail).toContain("would install");
    expect(await Bun.file(`${dir}/.claude/skills/pinbox/bin/pinbox`).exists()).toBe(false);
    // Project state still lands — it is deterministic and local.
    expect(data.pinboxDir).toBe("created");
  });

  test("--dry-run writes nothing: no .pinbox/, no .gitignore, no skills dir, no markers", async () => {
    const dir = await gitProject("dry-run");
    const { envelope, exitCode } = await capture(() =>
      runInit(
        { json: true, agent: "claude,cursor", dryRun: true },
        { projectDir: dir, env, home: fakeHome, isTTY: false },
      ),
    );
    expect(exitCode).toBeUndefined();
    expect(envelope.ok).toBe(true);
    const data = envelope.data as InitData;
    // Predicted outcomes, same envelope shape as a real run.
    expect(data.pinboxDir).toBe("created");
    expect(data.gitignore).toBe("created");
    expect(data.agents).toHaveLength(2);
    for (const outcome of data.agents) expect(outcome.detail).toContain("would install");
    expect(data.markers).toEqual([]);
    // Zero writes on disk.
    expect(await Bun.file(`${dir}/.gitignore`).exists()).toBe(false);
    expect(Bun.spawnSync(["test", "-d", `${dir}/.pinbox`]).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["test", "-d", `${dir}/.claude`]).exitCode).not.toBe(0);
    expect(await Bun.file(`${dir}/.cursor/rules/pinbox.mdc`).exists()).toBe(false);
    expect(await Bun.file(`${dir}/.git/hooks/post-commit`).exists()).toBe(false);
  });

  test("--dry-run on an initialized project predicts unchanged", async () => {
    const dir = await gitProject("dry-run-after");
    await capture(() =>
      runInit({ json: true, yes: true }, { projectDir: dir, env, home: fakeHome, isTTY: false }),
    );
    const { envelope } = await capture(() =>
      runInit(
        { json: true, yes: true, dryRun: true },
        { projectDir: dir, env, home: fakeHome, isTTY: false },
      ),
    );
    const data = envelope.data as InitData;
    expect(data.pinboxDir).toBe("unchanged");
    expect(data.gitignore).toBe("unchanged");
  });

  test("--agent cursor writes the marker block even without a .cursor dir", async () => {
    const dir = await gitProject("cursor");
    const { envelope } = await capture(() =>
      runInit(
        { json: true, agent: "cursor" },
        { projectDir: dir, env, home: fakeHome, isTTY: false },
      ),
    );
    const data = envelope.data as InitData;
    expect(data.agents[0]).toMatchObject({ agent: "cursor", method: "markers", ok: true });
    expect(data.markers).toEqual(["created"]);
    const text = await Bun.file(`${dir}/.cursor/rules/pinbox.mdc`).text();
    expect(text).toContain("<!-- PINBOX:START -->");
    expect(text).toContain("pinbox list");
  });

  test("a .github surface auto-selects the copilot marker on a --yes run", async () => {
    const dir = await gitProject("copilot-surface");
    await $`mkdir -p ${dir}/.github`.quiet();
    const { envelope } = await capture(() =>
      runInit({ json: true, yes: true }, { projectDir: dir, env, home: fakeHome, isTTY: false }),
    );
    const data = envelope.data as InitData;
    expect(data.agents.map((a) => a.agent)).toContain("copilot");
    expect(await Bun.file(`${dir}/.github/copilot-instructions.md`).exists()).toBe(true);
  });
});

describe("pinbox init (Layer 2)", () => {
  /** A `claude` on PATH that records having run — proof no second agent was spawned. */
  async function boobyTrapBin(dir: string): Promise<{ binDir: string; trap: string }> {
    const binDir = `${dir}/bin`;
    const trap = `${dir}/spawned`;
    await Bun.write(`${binDir}/claude`, `#!/bin/sh\n: > ${trap}\n`);
    await $`chmod 0755 ${binDir}/claude`.quiet();
    return { binDir, trap };
  }

  test("--dry-run emits the brief and still writes nothing", async () => {
    const dir = await gitProject("layer2-dry-run");
    const { envelope, exitCode } = await capture(() =>
      runInit(
        { json: true, dryRun: true, agent: "none" },
        { projectDir: dir, env, home: fakeHome, isTTY: false },
      ),
    );
    expect(exitCode).toBeUndefined();
    const data = envelope.data as InitData;
    expect(data.brief).toContain("pinbox/integration");
    expect(data.brief).toContain("@autono/pinbox-toolbar");
    expect(data.handoff).toBeUndefined();
    expect(Bun.spawnSync(["test", "-d", `${dir}/.pinbox`]).exitCode).not.toBe(0);
    expect(await Bun.file(`${dir}/.gitignore`).exists()).toBe(false);
  });

  test("agent invocation emits data.brief and never spawns a second agent", async () => {
    const dir = await gitProject("layer2-agent-mode");
    const { binDir, trap } = await boobyTrapBin(dir);
    const { envelope, exitCode } = await capture(() =>
      runInit(
        { json: true },
        {
          projectDir: dir,
          env: { HOME: fakeHome, PATH: binDir, CLAUDECODE: "1" },
          home: fakeHome,
          isTTY: false,
        },
      ),
    );
    expect(exitCode).toBeUndefined();
    const data = envelope.data as InitData;
    expect(data.brief).toContain("pinbox/integration");
    expect(data.handoff).toBeUndefined();
    expect(await Bun.file(trap).exists()).toBe(false);
  });

  test("non-TTY without agent fingerprints still emits the brief instead of spawning", async () => {
    const dir = await gitProject("layer2-pipe");
    const { binDir, trap } = await boobyTrapBin(dir);
    // The brief is parameterized by detection: a bun lockfile picks the bun install line.
    await Bun.write(`${dir}/bun.lock`, "");
    const { envelope } = await capture(() =>
      runInit(
        { json: true, agent: "none", yes: true },
        { projectDir: dir, env: { HOME: fakeHome, PATH: binDir }, home: fakeHome, isTTY: false },
      ),
    );
    const data = envelope.data as InitData;
    expect(data.brief).toContain("bun add -d @autono/pinbox-toolbar");
    expect(await Bun.file(trap).exists()).toBe(false);
  });
});
