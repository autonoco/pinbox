// The interactive Layer-1 path, which every other init test deliberately avoids: a human at
// a terminal (TTY stdin AND TTY stdout, no --json, no --agent, no --yes) is *asked* before
// anything is installed, and declining must leave the disk exactly as it was.
// Also covers `--global` with no HOME, which used to downgrade to project scope in silence.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { type InitContext, type InitFlags, runInit } from "./init.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-init-tty-${crypto.randomUUID()}`;
const fakeHome = `${tmpRoot}/home`;
// PATH empty ⇒ no agent is spawnable, so Layer 2 never reaches the handoff prompt and these
// tests observe Layer 1's picker alone.
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

function dirExists(path: string): boolean {
  return Bun.spawnSync(["test", "-d", path]).exitCode === 0;
}

/** Model a terminal on stdout: `isJsonMode` reads it, and human mode is the branch under test. */
function setStdoutTTY(isTTY: boolean): () => void {
  const prior = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  return () => {
    if (prior === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", prior);
  };
}

async function capture(
  run: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(args.map(String).join(" "));
  });
  const err = spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as typeof process.exit);
  const restoreTTY = setStdoutTTY(true);
  let exitCode: number | undefined;
  try {
    await run();
  } catch (thrown) {
    if (!(thrown instanceof ExitSignal)) throw thrown;
    exitCode = thrown.exitCode;
  } finally {
    restoreTTY();
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
    process.exitCode = 0;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

/** A human context: both ends of the terminal, with the confirm seam recorded. */
function humanCtx(dir: string, asked: string[], answer: boolean): InitContext {
  return {
    projectDir: dir,
    env,
    home: fakeHome,
    isTTY: true,
    confirm: (question) => {
      asked.push(question);
      return answer;
    },
  };
}

beforeAll(async () => {
  await $`mkdir -p ${fakeHome}/.claude`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("pinbox init — the human TTY picker", () => {
  test("a human is asked before anything is installed, and the detected set is named", async () => {
    const dir = await gitProject("picker-asked");
    const asked: string[] = [];
    const captured = await capture(() => runInit({} as InitFlags, humanCtx(dir, asked, true)));
    expect(captured.exitCode).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("install pinbox for:");
    expect(asked[0]).toContain("claude");
  });

  test("accepting installs for real", async () => {
    const dir = await gitProject("picker-accept");
    const captured = await capture(() => runInit({} as InitFlags, humanCtx(dir, [], true)));
    expect(dirExists(`${dir}/.claude/skills/pinbox`)).toBe(true);
    expect(captured.stdout).toContain("installed .claude/skills/pinbox");
    expect(captured.stdout).not.toContain("would install");
  });

  test("declining is plan-only: the agent is reported as 'would install' and NOTHING is written", async () => {
    const dir = await gitProject("picker-decline");
    const captured = await capture(() => runInit({} as InitFlags, humanCtx(dir, [], false)));
    expect(captured.exitCode).toBeUndefined();
    // The install did not happen — no skills dir, no marker files.
    expect(dirExists(`${dir}/.claude/skills/pinbox`)).toBe(false);
    expect(await Bun.file(`${dir}/.cursor/rules/pinbox.mdc`).exists()).toBe(false);
    expect(await Bun.file(`${dir}/.github/copilot-instructions.md`).exists()).toBe(false);
    // …and it said so, twice: the plan line and the note telling the user how to proceed.
    expect(captured.stdout).toContain("would install");
    expect(captured.stdout).toContain("pass --agent claude or --yes");
    expect(captured.stderr).toContain("nothing installed");
  });

  test("declining still writes the project state — .pinbox/ and the gitignore entry are not agent installs", async () => {
    const dir = await gitProject("picker-decline-state");
    await capture(() => runInit({} as InitFlags, humanCtx(dir, [], false)));
    expect(dirExists(`${dir}/.pinbox`)).toBe(true);
    expect(await Bun.file(`${dir}/.gitignore`).text()).toContain(".pinbox/");
  });

  test("the question is never printed to stdout — facts stdout, messaging stderr", async () => {
    const dir = await gitProject("picker-stream");
    const captured = await capture(() => runInit({} as InitFlags, humanCtx(dir, [], false)));
    expect(captured.stdout).not.toContain("install pinbox for:");
  });
});

describe("pinbox init over a hand-damaged marker file", () => {
  test("one unparseable file is a reported failure, not an aborted init", async () => {
    const dir = await gitProject("bad-markers");
    // The END line deleted by hand — upsertMarkerBlock refuses to guess where the block ends.
    const damaged = "# Cursor rules\n\n<!-- PINBOX:START -->\nstale\n\nmy own notes\n";
    await Bun.write(`${dir}/.cursor/rules/pinbox.mdc`, damaged);
    const captured = await capture(() =>
      runInit({ agent: "cursor", yes: true } as InitFlags, {
        projectDir: dir,
        env,
        home: fakeHome,
        isTTY: false,
      }),
    );
    // Not a crash: exit 0, and the rest of Layer 1 still ran.
    expect(captured.exitCode).toBeUndefined();
    expect(captured.stdout).toContain("no  cursor");
    expect(captured.stdout).toContain("refusing to guess");
    expect(captured.stdout).toContain("ok  git-hook");
    // And the user's prose is still there.
    expect(await Bun.file(`${dir}/.cursor/rules/pinbox.mdc`).text()).toBe(damaged);
  });
});

describe("pinbox init --global with no HOME", () => {
  test("says so instead of silently installing project-scoped", async () => {
    const dir = await gitProject("global-no-home");
    const captured = await capture(() =>
      runInit({ global: true, yes: true, agent: "claude" } as InitFlags, {
        projectDir: dir,
        env: { PATH: "" },
        home: undefined,
        isTTY: false,
      }),
    );
    expect(captured.exitCode).toBeUndefined();
    const said = `${captured.stdout}\n${captured.stderr}`;
    expect(said).toContain("--global");
    expect(said.toLowerCase()).toContain("home");
    // The downgrade itself is still fine — it just may not be silent.
    expect(said).toContain("project scope");
  });

  test("--global with a HOME installs there and says nothing about a downgrade", async () => {
    const dir = await gitProject("global-with-home");
    const captured = await capture(() =>
      runInit({ global: true, yes: true, agent: "claude" } as InitFlags, {
        projectDir: dir,
        env,
        home: fakeHome,
        isTTY: false,
      }),
    );
    expect(dirExists(`${fakeHome}/.claude/skills/pinbox`)).toBe(true);
    expect(dirExists(`${dir}/.claude/skills/pinbox`)).toBe(false);
    expect(`${captured.stdout}\n${captured.stderr}`).not.toContain("--global");
  });
});
