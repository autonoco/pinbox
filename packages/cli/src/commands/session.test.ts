// Hidden `pinbox session` verb — register/list + hook-mode inject/pending, against an
// IN-PROCESS hub (setConnectionForTests pattern from commands.test.ts). Hook-mode
// stdout is the AGENTS' contract ({"hookSpecificOutput":…}), never the --json envelope.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { startHubServer } from "@autono/pinbox-core/hub-server";
import type { Session } from "@autono/pinbox-core/sessions";
import { openStore, type PinStore } from "@autono/pinbox-core/store";
import { $ } from "bun";
import { HubClient } from "../client.ts";
import { setConnectionForTests } from "../daemon.ts";
import { buildProgram } from "../main.ts";
import { projectId, readHubState } from "../paths.ts";
import {
  renderSessions,
  runSessionInject,
  runSessionList,
  runSessionPending,
  runSessionRegister,
  runSessionTrailer,
} from "./session.ts";
import { fingerprintAgent, setHookStdinForTests } from "./session-hook.ts";
import { validInput } from "./transcript-fixtures.ts";

class ExitSignal extends Error {
  constructor(public exitCode: number | undefined) {
    super(`exit ${exitCode}`);
  }
}

type Spies = {
  out: ReturnType<typeof spyOn<Console, "log">>;
  err: ReturnType<typeof spyOn<Console, "error">>;
  exit: ReturnType<typeof spyOn<typeof process, "exit">>;
};

function installSpies(): Spies {
  return {
    out: spyOn(console, "log").mockImplementation(() => {}),
    err: spyOn(console, "error").mockImplementation(() => {}),
    exit: spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as typeof process.exit),
  };
}

function restoreSpies(spies: Spies): void {
  spies.out.mockRestore();
  spies.err.mockRestore();
  spies.exit.mockRestore();
  process.exitCode = 0;
}

let store: PinStore;
let server: Awaited<ReturnType<typeof startHubServer>>;
let hub: HubClient;
const savedClaudecode = process.env["CLAUDECODE"];

beforeAll(async () => {
  store = openStore(":memory:");
  server = await startHubServer({ store, token: "t-test", idleMs: 60_000 });
  setConnectionForTests({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t-test" });
  hub = new HubClient(`http://127.0.0.1:${server.port}`, "t-test");
  // The fingerprint tests must not depend on the environment this suite runs under.
  process.env["CLAUDECODE"] = "1";
});

afterAll(async () => {
  if (savedClaudecode === undefined) {
    Reflect.deleteProperty(process.env, "CLAUDECODE");
  } else {
    process.env["CLAUDECODE"] = savedClaudecode;
  }
  setHookStdinForTests(null);
  setConnectionForTests(null);
  await server.close();
  store.close();
});

describe("agent fingerprinting", () => {
  test("CLAUDECODE=1 fingerprints claude; empty env fingerprints nothing", () => {
    expect(fingerprintAgent({ CLAUDECODE: "1" })).toBe("claude");
    expect(fingerprintAgent({})).toBeNull();
    expect(fingerprintAgent({ CLAUDECODE: "" })).toBeNull();
  });
});

describe("session register / list", () => {
  test("register --agent/--key --json emits the Session envelope", async () => {
    const spies = installSpies();
    try {
      await runSessionRegister({ agent: "claude", key: "s-flag-1", cwd: "/tmp/proj", json: true });
      const body = JSON.parse(String(spies.out.mock.calls.at(-1)?.[0])) as {
        ok: boolean;
        data: Session;
      };
      expect(body.ok).toBe(true);
      expect(body.data.id).toMatch(/^ses_[a-z0-9]{10}$/);
      expect(body.data.agent).toBe("claude");
      expect(body.data.key).toBe("s-flag-1");
      expect(body.data.cwd).toBe("/tmp/proj");
    } finally {
      restoreSpies(spies);
    }
  });

  test("register without --agent/--key (non-hook) is E_INVALID_INPUT, exit 2", async () => {
    const spies = installSpies();
    try {
      await expect(runSessionRegister({ json: true })).rejects.toThrow(ExitSignal);
      const body = JSON.parse(String(spies.out.mock.calls[0]?.[0]));
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("E_INVALID_INPUT");
      expect(typeof body.error.hint).toBe("string");
      expect(spies.exit).toHaveBeenCalledWith(2);
    } finally {
      restoreSpies(spies);
    }
  });

  test("register --hook parses the stdin payload, fingerprints claude, emits nothing", async () => {
    setHookStdinForTests(
      JSON.stringify({
        session_id: "s-hook-1",
        cwd: "/tmp/hookproj",
        hook_event_name: "SessionStart",
      }),
    );
    const spies = installSpies();
    try {
      await runSessionRegister({ hook: true });
      // SessionStart is side-effect only: no stdout at all.
      expect(spies.out).not.toHaveBeenCalled();
    } finally {
      restoreSpies(spies);
      setHookStdinForTests(null);
    }
    const sessions = await hub.listSessions();
    const registered = sessions.find((s) => s.key === "s-hook-1");
    expect(registered?.agent).toBe("claude");
    expect(registered?.cwd).toBe("/tmp/hookproj");
  });

  test("session list --json lists registered sessions", async () => {
    const spies = installSpies();
    try {
      await runSessionList({ json: true });
      const body = JSON.parse(String(spies.out.mock.calls.at(-1)?.[0])) as {
        ok: boolean;
        data: Session[];
      };
      expect(body.ok).toBe(true);
      expect(body.data.map((s) => s.key)).toContain("s-hook-1");
      expect(body.data.map((s) => s.key)).toContain("s-flag-1");
    } finally {
      restoreSpies(spies);
    }
  });
});

describe("hook-mode inject / pending", () => {
  const hookStdin = JSON.stringify({
    session_id: "s-hook-1",
    cwd: "/tmp/hookproj",
    hook_event_name: "UserPromptSubmit",
  });

  test("inject --hook prints the hookSpecificOutput shape with the pin text inside", async () => {
    const pin = await hub.createPin(validInput);
    setHookStdinForTests(hookStdin);
    const spies = installSpies();
    try {
      await runSessionInject({ hook: true });
      expect(spies.out).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(spies.out.mock.calls[0]?.[0]));
      expect(body).toEqual({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: expect.stringContaining(pin.text),
        },
      });
      expect(body.hookSpecificOutput.additionalContext).toContain(pin.id);
    } finally {
      restoreSpies(spies);
      setHookStdinForTests(null);
    }
  });

  test("pending --hook with zero pending prints nothing and exits 0", async () => {
    setHookStdinForTests(JSON.stringify({ session_id: "s-hook-1", hook_event_name: "Stop" }));
    const spies = installSpies();
    try {
      await runSessionPending({ hook: true });
      expect(spies.out).not.toHaveBeenCalled();
      expect(spies.exit).not.toHaveBeenCalled();
    } finally {
      restoreSpies(spies);
      setHookStdinForTests(null);
    }
  });

  test("pending --hook with a pending row emits the Stop hold with the pin text", async () => {
    const pin = await hub.createPin(validInput);
    const session = (await hub.listSessions()).find((s) => s.key === "s-hook-1");
    if (!session) throw new Error("session s-hook-1 not registered");
    const seq = (await hub.summary()).lastEventSeq;
    store.deliveries.enqueue({
      eventSeq: seq,
      sessionId: session.id,
      adapter: "hooks",
      dueAt: null,
    });

    setHookStdinForTests(JSON.stringify({ session_id: "s-hook-1", hook_event_name: "Stop" }));
    const spies = installSpies();
    try {
      await runSessionPending({ hook: true });
      expect(spies.out).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(spies.out.mock.calls[0]?.[0]));
      expect(body.hookSpecificOutput.hookEventName).toBe("Stop");
      expect(body.hookSpecificOutput.additionalContext).toContain(pin.id);
      expect(body.hookSpecificOutput.additionalContext).toContain(pin.text);
    } finally {
      restoreSpies(spies);
      setHookStdinForTests(null);
    }
  });
});

describe("human rendering", () => {
  test("renderSessions: aligned columns with state; empty list renders nothing", () => {
    const base = {
      registeredAt: "2026-08-04T10:00:00.000Z",
      lastSeenAt: "2026-08-04T10:00:00.000Z",
    };
    expect(
      renderSessions([
        { id: "ses_fylw8li611", agent: "claude", key: "e2e-s1", ...base },
        {
          id: "ses_2b9x0cmq4r",
          agent: "codex",
          key: "s2",
          ...base,
          endedAt: "2026-08-04T11:00:00.000Z",
        },
      ]),
    ).toBe(
      ["ses_fylw8li611  claude  e2e-s1  active", "ses_2b9x0cmq4r  codex   s2      ended"].join(
        "\n",
      ),
    );
    expect(renderSessions([])).toBe("");
  });
});

describe("session trailer", () => {
  const trailerRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-trailer-${crypto.randomUUID()}`;
  const repo = `${trailerRoot}/repo`;
  const savedCwd = process.cwd();

  async function commit(message: string): Promise<string> {
    await $`git -C ${repo} -c user.email=t@test.dev -c user.name=t -c commit.gpgsign=false commit --allow-empty -q -m ${message}`.quiet();
    return (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  }

  type TrailerData = { resolved: string[]; skipped: string[] };

  async function runTrailer(spies: Spies, commitSha?: string): Promise<TrailerData> {
    await runSessionTrailer({
      json: true,
      ...(commitSha !== undefined ? { commit: commitSha } : {}),
    });
    const body = JSON.parse(String(spies.out.mock.calls.at(-1)?.[0])) as {
      ok: boolean;
      data: TrailerData;
    };
    expect(body.ok).toBe(true);
    return body.data;
  }

  beforeAll(async () => {
    await $`mkdir -p ${repo}`.quiet();
    await $`git -C ${repo} init -q`.quiet();
    // The trailer verb reads the commit at process.cwd() — run the suite from the repo.
    process.chdir(repo);
  });

  afterAll(async () => {
    process.chdir(savedCwd);
    await $`rm -rf ${trailerRoot}`.quiet();
  });

  test("resolves a trailer-named open pin with the full SHA, by:agent under CLAUDECODE", async () => {
    const pin = await hub.createPin(validInput);
    const sha = await commit(`fix: cta padding\n\nResolves: ${pin.id}`);
    const spies = installSpies();
    try {
      const data = await runTrailer(spies);
      expect(data).toEqual({ resolved: [pin.id], skipped: [] });
      expect(spies.exit).not.toHaveBeenCalled();
    } finally {
      restoreSpies(spies);
    }
    const resolved = await hub.get(pin.id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.commit).toBe(sha);
    expect(resolved.resolution?.by).toBe("agent");

    // Re-run (post-commit hooks re-fire on amend/rebase): skips silently, exit 0.
    const again = installSpies();
    try {
      expect(await runTrailer(again)).toEqual({ resolved: [], skipped: [pin.id] });
      expect(again.exit).not.toHaveBeenCalled();
    } finally {
      restoreSpies(again);
    }
  });

  test("unknown pin id skips silently, exit 0", async () => {
    await commit("fix: dead pin\n\nFixes pin_zzzzzzzzzz");
    const spies = installSpies();
    try {
      expect(await runTrailer(spies)).toEqual({ resolved: [], skipped: ["pin_zzzzzzzzzz"] });
      expect(spies.exit).not.toHaveBeenCalled();
    } finally {
      restoreSpies(spies);
    }
  });

  test("attributes by:human when the environment fingerprints no agent", async () => {
    Reflect.deleteProperty(process.env, "CLAUDECODE");
    try {
      const pin = await hub.createPin(validInput);
      await commit(`fix: hover\n\ncloses ${pin.id}`);
      const spies = installSpies();
      try {
        expect(await runTrailer(spies)).toEqual({ resolved: [pin.id], skipped: [] });
      } finally {
        restoreSpies(spies);
      }
      expect((await hub.get(pin.id)).resolution?.by).toBe("human");
    } finally {
      process.env["CLAUDECODE"] = "1";
    }
  });

  test("--commit <sha> reads that commit, not HEAD", async () => {
    const pin = await hub.createPin(validInput);
    const trailerSha = await commit(`fix: focus ring\n\nResolves: ${pin.id}`);
    await commit("chore: unrelated");
    const spies = installSpies();
    try {
      expect(await runTrailer(spies, trailerSha)).toEqual({ resolved: [pin.id], skipped: [] });
    } finally {
      restoreSpies(spies);
    }
    const resolved = await hub.get(pin.id);
    expect(resolved.resolution?.commit).toBe(trailerSha);
  });
});

describe("post-commit hook script (real spawn through a PATH shim)", () => {
  const scriptRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-hook-${crypto.randomUUID()}`;
  const repo = `${scriptRoot}/repo`;
  const binDir = `${scriptRoot}/bin`;
  const cliEntry = new URL("../main.ts", import.meta.url).pathname;
  const hookScript = new URL("../../hooks/post-commit", import.meta.url).pathname;
  let env: Record<string, string>;
  let daemonPid: number | null = null;

  beforeAll(async () => {
    await $`mkdir -p ${repo} ${binDir}`.quiet();
    await $`git -C ${repo} init -q`.quiet();
    // The canonical scripts resolve `pinbox` from PATH — the shim IS that resolution,
    // exec-ing the source CLI under the test's own bun.
    await Bun.write(
      `${binDir}/pinbox`,
      `#!/bin/sh\nexec "${process.execPath}" "${cliEntry}" "$@"\n`,
    );
    await $`chmod 755 ${binDir}/pinbox`.quiet();
    env = {
      ...(process.env as Record<string, string>),
      PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      XDG_STATE_HOME: `${scriptRoot}/state`,
      PINBOX_IDLE_MS: "60000",
      CLAUDECODE: "1",
    };
  });

  afterAll(async () => {
    if (daemonPid !== null) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await $`rm -rf ${scriptRoot}`.quiet();
  });

  test("sh hooks/post-commit resolves the trailer-named pin via the daemon", async () => {
    // Warm the daemon through the shim (the same path the hook script takes). The
    // spawn deadline is 3s; a cold bun boot can miss it, so retry — the daemon keeps
    // booting in the background and a later probe finds it.
    let warmed = false;
    for (let attempt = 0; attempt < 3 && !warmed; attempt++) {
      warmed =
        Bun.spawnSync(["sh", "-c", "pinbox summary --json"], { cwd: repo, env }).exitCode === 0;
    }
    expect(warmed).toBe(true);
    const stateFile = `${scriptRoot}/state/pinbox/${projectId(repo)}/hub.json`;
    const state = await readHubState(stateFile);
    if (state === null) throw new Error("daemon state file missing after warm-up");
    daemonPid = state.pid;
    const authed = { authorization: `Bearer ${state.token}`, "content-type": "application/json" };

    const created = await fetch(`http://127.0.0.1:${state.port}/pins`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify(validInput),
    });
    expect(created.status).toBe(201);
    const pin = ((await created.json()) as { data: { id: string } }).data;

    await $`git -C ${repo} -c user.email=t@test.dev -c user.name=t -c commit.gpgsign=false commit --allow-empty -q -m ${`fix: cta\n\nResolves: ${pin.id}`}`.quiet();
    const sha = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();

    const hook = Bun.spawnSync(["sh", hookScript], { cwd: repo, env });
    expect(hook.exitCode).toBe(0);

    const shown = await fetch(`http://127.0.0.1:${state.port}/pins/${pin.id}`, { headers: authed });
    const body = (
      (await shown.json()) as {
        data: { status: string; resolution?: { commit?: string } };
      }
    ).data;
    expect(body.status).toBe("resolved");
    expect(body.resolution?.commit).toBe(sha);
  }, 30_000);
});

describe("surface", () => {
  test("`pinbox --help` does not list session (hidden plumbing)", () => {
    const help = buildProgram().helpInformation();
    expect(help).not.toContain("session");
  });
});
