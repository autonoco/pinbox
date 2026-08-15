// Command-level tests for Layer 2's *handoff* ending — the branch that prompts and spawns.
// It is reachable only in human mode (TTY stdin AND human stdout), so these tests force a
// TTY stdout and inject the confirm/prompt/spawn seams `InitContext` carries for exactly
// this purpose. A real `claude` stub sits on PATH as a booby trap: the injected spawner
// replaces it, so the trap file appearing means the real spawn ran.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { AGENTS, type AgentSpec } from "../agents.ts";
import type { spawnIntegrationAgent } from "../init/spawn.ts";
import {
  type InitContext,
  type InitData,
  type InitFlags,
  pickHandoffAgent,
  runInit,
} from "./init.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-handoff-${crypto.randomUUID()}`;
const fakeHome = `${tmpRoot}/home`;

class ExitSignal extends Error {
  constructor(public exitCode: number | undefined) {
    super(`exit ${exitCode}`);
  }
}

type SpawnCall = { agent: string; brief: string; cwd: string };

/** An injectable spawner that records its call and returns (or throws) a canned result. */
function fakeSpawn(
  calls: SpawnCall[],
  outcome: { exitCode: number; output: string } | Error,
  onCall?: () => void,
): typeof spawnIntegrationAgent {
  return async (spec, brief, opts) => {
    calls.push({ agent: spec.id, brief, cwd: opts.cwd });
    onCall?.();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
}

type Sink = { stdout: string[]; stderr: string[] };

/**
 * `isJsonMode` reads `process.stdout.isTTY`, and under `bun test` stdout is a pipe whose
 * `isTTY` is a read-only accessor — redefine it to model a terminal, restore on the way out.
 */
function setStdoutTTY(isTTY: boolean): () => void {
  const prior = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
  return () => {
    if (prior === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, "isTTY", prior);
  };
}

/**
 * Run with console/process/TTY spied. The sink arrays fill *live*, so an injected
 * spawner can read what the user has already seen at the moment it is called.
 */
async function capture(
  run: () => Promise<void>,
  opts: { stdoutTTY: boolean; sink?: Sink },
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  const { stdout, stderr } = opts.sink ?? { stdout: [], stderr: [] };
  const out = spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(args.map(String).join(" "));
  });
  const err = spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as typeof process.exit);
  const restoreTTY = setStdoutTTY(opts.stdoutTTY);
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
  return { stdout, stderr, exitCode };
}

/** A git project with an executable `claude` on its own PATH plus a booby-trap marker. */
async function handoffProject(
  name: string,
): Promise<{ dir: string; env: Record<string, string | undefined> }> {
  const dir = `${tmpRoot}/${name}`;
  await $`mkdir -p ${dir}/bin`.quiet();
  await $`git -C ${dir} init -q`.quiet();
  await Bun.write(`${dir}/bin/claude`, `#!/bin/sh\n: > ${dir}/spawned\n`);
  await $`chmod 0755 ${dir}/bin/claude`.quiet();
  return { dir, env: { HOME: fakeHome, PATH: `${dir}/bin` } };
}

function baseCtx(dir: string, env: Record<string, string | undefined>): InitContext {
  return { projectDir: dir, env, home: fakeHome, isTTY: true };
}

/** Accept every confirm, recording the questions asked. */
function acceptAll(asked: string[]): (question: string) => boolean {
  return (question) => {
    asked.push(question);
    return true;
  };
}

beforeAll(async () => {
  await $`mkdir -p ${fakeHome}/.claude`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("pinbox init Layer 2 — the handoff ending", () => {
  test("human TTY: confirm accepted, brief spawned, PR url reported as a fact", async () => {
    const { dir, env } = await handoffProject("accepted");
    const calls: SpawnCall[] = [];
    const asked: string[] = [];
    const spawn = fakeSpawn(calls, {
      exitCode: 0,
      output: "opened https://github.com/acme/app/pull/12 for review\n",
    });
    const captured = await capture(
      async () => {
        await runInit({ yes: true } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: acceptAll(asked),
          spawn,
        });
      },
      { stdoutTTY: true },
    );
    expect(captured.exitCode).toBeUndefined();
    // The brief reached the agent as one argument, in the project dir.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.agent).toBe("claude");
    expect(calls[0]?.cwd).toBe(dir);
    expect(calls[0]?.brief).toContain("pinbox/integration");
    // The PR url becomes the handoff fact line, after the Layer-1 facts.
    const facts = captured.stdout.join("\n");
    expect(facts).toContain("ok  .pinbox");
    expect(facts).toContain("https://github.com/acme/app/pull/12");
    // No brief dump on the spawn path — the agent has it.
    expect(facts).not.toContain("# Pinbox toolbar integration");
    expect(await Bun.file(`${dir}/spawned`).exists()).toBe(false);
  });

  test("the handoff is not silent: facts and the handoff note land before the spawn is awaited", async () => {
    const { dir, env } = await handoffProject("not-silent");
    const calls: SpawnCall[] = [];
    const sink: Sink = { stdout: [], stderr: [] };
    const during: Sink = { stdout: [], stderr: [] };
    const spawn = fakeSpawn(calls, { exitCode: 0, output: "done" }, () => {
      during.stdout = [...sink.stdout];
      during.stderr = [...sink.stderr];
    });
    await capture(
      async () => {
        await runInit({ yes: true } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: () => true,
          spawn,
        });
      },
      { stdoutTTY: true, sink },
    );
    // Snapshotted *while the spawn was in flight*: the user already knows what init wrote
    // and that a handoff is running — a 15-minute agent run must not look like a hang.
    expect(during.stderr.join("\n")).toContain("handing the integration brief to claude");
    expect(during.stdout.join("\n")).toContain("ok  .pinbox");
  });

  test("declined confirm: the brief is printed, nothing is spawned", async () => {
    const { dir, env } = await handoffProject("declined");
    const calls: SpawnCall[] = [];
    const captured = await capture(
      async () => {
        await runInit({ agent: "none" } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: (question) => !question.includes("wire the toolbar"),
          spawn: fakeSpawn(calls, { exitCode: 0, output: "" }),
        });
      },
      { stdoutTTY: true },
    );
    expect(calls).toHaveLength(0);
    expect(captured.stdout.join("\n")).toContain("pinbox/integration");
    expect(captured.stderr.join("\n")).toContain("handoff declined");
  });

  test("a config dir without the binary on PATH is never offered — the argv could not resolve", async () => {
    const { dir } = await handoffProject("not-on-path");
    const asked: string[] = [];
    const calls: SpawnCall[] = [];
    const captured = await capture(
      async () => {
        // ~/.claude exists (detected) but PATH is empty, so `claude` cannot be spawned.
        await runInit({ agent: "none" } as InitFlags, {
          ...baseCtx(dir, { HOME: fakeHome, PATH: "" }),
          confirm: acceptAll(asked),
          spawn: fakeSpawn(calls, { exitCode: 0, output: "" }),
        });
      },
      { stdoutTTY: true },
    );
    expect(calls).toHaveLength(0);
    expect(asked.join("\n")).not.toContain("wire the toolbar");
    expect(captured.stderr.join("\n")).toContain("no headless-capable agent");
    expect(captured.stdout.join("\n")).toContain("pinbox/integration");
  });

  test("spawn failure: E_INTERNAL with the dry-run hint, Layer-1 facts already printed", async () => {
    const { dir, env } = await handoffProject("spawn-fails");
    const calls: SpawnCall[] = [];
    const captured = await capture(
      async () => {
        await runInit({ yes: true } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: () => true,
          spawn: fakeSpawn(calls, new Error("spawn claude ENOENT")),
        });
      },
      { stdoutTTY: true },
    );
    expect(captured.exitCode).toBe(1);
    // The record of what Layer 1 wrote survives the failure.
    expect(captured.stdout.join("\n")).toContain("ok  .pinbox");
    const stderr = captured.stderr.join("\n");
    expect(stderr).toContain("handoff to claude failed");
    expect(stderr).toContain("re-run with --dry-run and hand the brief to your agent manually");
  });

  test("a non-zero agent exit reports the local-branch fallback, not a PR", async () => {
    const { dir, env } = await handoffProject("agent-failed");
    const calls: SpawnCall[] = [];
    const captured = await capture(
      async () => {
        await runInit({ yes: true } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: () => true,
          spawn: fakeSpawn(calls, { exitCode: 2, output: "gh: not authenticated" }),
        });
      },
      { stdoutTTY: true },
    );
    expect(captured.exitCode).toBeUndefined();
    const facts = captured.stdout.join("\n");
    expect(facts).toContain("agent exited 2");
    expect(facts).toContain("pinbox/integration branch");
  });

  test("exit 0 with no PR url in the output falls back to the local branch line", async () => {
    const { dir, env } = await handoffProject("no-url");
    const calls: SpawnCall[] = [];
    const captured = await capture(
      async () => {
        await runInit({ yes: true } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: () => true,
          spawn: fakeSpawn(calls, { exitCode: 0, output: "committed everything, no remote" }),
        });
      },
      { stdoutTTY: true },
    );
    expect(captured.stdout.join("\n")).toContain("no PR url in the agent output");
  });

  test("--json on a TTY never prompts and never spawns: the envelope stays parseable", async () => {
    const { dir, env } = await handoffProject("json-tty");
    const calls: SpawnCall[] = [];
    const asked: string[] = [];
    const captured = await capture(
      async () => {
        await runInit({ json: true } as InitFlags, {
          ...baseCtx(dir, env),
          confirm: acceptAll(asked),
          prompt: (question) => {
            asked.push(question);
            return "1";
          },
          spawn: fakeSpawn(calls, { exitCode: 0, output: "https://x/pull/1" }),
        });
      },
      // stdout is a TTY *and* stdin is a TTY: the only shape where the old gate prompted.
      { stdoutTTY: true },
    );
    expect(asked).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(captured.stderr).toEqual([]);
    expect(captured.stdout).toHaveLength(1);
    const envelope = JSON.parse(String(captured.stdout[0])) as { ok: boolean; data: InitData };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.brief).toContain("pinbox/integration");
    expect(envelope.data.handoff).toBeUndefined();
  });
});

describe("pickHandoffAgent", () => {
  const headless = AGENTS.filter((spec) => spec.headless !== null) as AgentSpec[];
  const ctx = (extra: Partial<InitContext>): InitContext => ({
    projectDir: "/nowhere",
    env: {},
    home: undefined,
    isTTY: true,
    ...extra,
  });

  test("--yes takes the first candidate without asking", async () => {
    const asked: string[] = [];
    const chosen = await pickHandoffAgent(headless, { yes: true }, ctx({ confirm: acceptAll(asked) }));
    expect(chosen?.id).toBe(headless[0]?.id);
    expect(asked).toEqual([]);
  });

  test("a single candidate is one confirm; declining picks nobody", async () => {
    const single = [headless[0] as AgentSpec];
    expect((await pickHandoffAgent(single, {}, ctx({ confirm: () => true })))?.id).toBe(single[0]?.id);
    expect(await pickHandoffAgent(single, {}, ctx({ confirm: () => false }))).toBeNull();
  });

  test("several candidates: a numbered menu, answered by index", async () => {
    const questions: string[] = [];
    const chosen = await pickHandoffAgent(
      headless,
      {},
      ctx({
        prompt: (question) => {
          questions.push(question);
          return "2";
        },
      }),
    );
    expect(chosen?.id).toBe(headless[1]?.id);
    expect(questions[0]).toContain(`2. ${headless[1]?.id}`);
  });

  test("an out-of-range or unparsable answer declines instead of guessing", async () => {
    expect(await pickHandoffAgent(headless, {}, ctx({ prompt: () => "9" }))).toBeNull();
    expect(await pickHandoffAgent(headless, {}, ctx({ prompt: () => "later" }))).toBeNull();
    expect(await pickHandoffAgent(headless, {}, ctx({ prompt: () => null }))).toBeNull();
  });
});
