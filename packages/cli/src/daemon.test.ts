import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { ensureHub, selfCommand } from "./daemon.ts";
import { CliError } from "./errors.ts";
import { type HubState, statePaths } from "./paths.ts";

// Under `bun test`, Bun.main is the TEST FILE — letting selfCommand() default would
// spawn this file as the hub and recurse. Every spawn below passes the entry explicitly.
const cliEntry = new URL("./main.ts", import.meta.url).pathname;
const command = [process.execPath, cliEntry];

describe("selfCommand", () => {
  test("compiled binary re-invokes itself with no script argument", () => {
    expect(selfCommand("/$bunfs/root/pinbox")).toEqual([process.execPath]);
  });

  test("source or npm shape re-invokes bun with the entry script", () => {
    expect(selfCommand("/abs/path/main.ts")).toEqual([process.execPath, "/abs/path/main.ts"]);
  });
});

describe("ensureHub (integration, real spawn)", () => {
  const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-daemon-${crypto.randomUUID()}`;
  const projectDir = `${tmpRoot}/proj`;
  const savedEnv: Record<string, string | undefined> = {};

  const readState = async (): Promise<HubState> =>
    (await Bun.file(statePaths(projectDir).stateFile).json()) as HubState;

  const hubGone = async (port: number): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(250) });
      } catch {
        return;
      }
      await Bun.sleep(100);
    }
    throw new Error(`hub on port ${port} still answering after SIGTERM`);
  };

  beforeAll(async () => {
    savedEnv["XDG_STATE_HOME"] = process.env["XDG_STATE_HOME"];
    savedEnv["PINBOX_IDLE_MS"] = process.env["PINBOX_IDLE_MS"];
    process.env["XDG_STATE_HOME"] = `${tmpRoot}/state`;
    process.env["PINBOX_IDLE_MS"] = "60000";
    await $`mkdir -p ${projectDir}`.quiet();
  });

  afterAll(async () => {
    try {
      const state = await readState();
      process.kill(state.pid, "SIGTERM");
    } catch {
      // no daemon left behind — nothing to stop
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await $`rm -rf ${tmpRoot}`.quiet();
  });

  test("spawns a detached hub and returns a healthy, authorized connection", async () => {
    const conn = await ensureHub(projectDir, { command });
    expect(conn.baseUrl).toStartWith("http://127.0.0.1:");
    expect(conn.token.length).toBeGreaterThan(0);

    const health = await fetch(`${conn.baseUrl}/health`);
    expect(health.status).toBe(200);

    const summary = await fetch(`${conn.baseUrl}/summary`, {
      headers: { authorization: `Bearer ${conn.token}` },
    });
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as { ok: boolean; data: { open: number } };
    expect(body.ok).toBe(true);
    expect(body.data.open).toBe(0);
  }, 20_000);

  test("daemon runs in its own process group (detached from the CLI's)", async () => {
    const state = await readState();
    // A group leader's pgid is its own pid. If the daemon inherited the spawner's
    // group, a Ctrl+C group SIGINT aimed at the CLI would kill it too.
    const pgid = await $`ps -o pgid= -p ${state.pid}`.text();
    expect(pgid.trim()).toBe(String(state.pid));
  });

  test("state file is 0600 with pid/port/token/version; server.json is port-only", async () => {
    const paths = statePaths(projectDir);
    const stat = await Bun.file(paths.stateFile).stat();
    expect(stat.mode & 0o777).toBe(0o600);

    const state = await readState();
    expect(typeof state.pid).toBe("number");
    expect(typeof state.port).toBe("number");
    expect(state.token.length).toBeGreaterThan(0);
    expect(typeof state.version).toBe("string");

    const serverJson = (await Bun.file(paths.serverJson).json()) as Record<string, unknown>;
    expect(serverJson).toEqual({ port: state.port });
    expect("token" in serverJson).toBe(false);
  });

  test("second ensureHub reuses the running daemon (same pid, same token)", async () => {
    const before = await readState();
    const conn = await ensureHub(projectDir, { command });
    const after = await readState();
    expect(after.pid).toBe(before.pid);
    expect(conn.token).toBe(before.token);
  }, 20_000);

  test("respawns with a new pid after the daemon is SIGTERMed", async () => {
    const before = await readState();
    process.kill(before.pid, "SIGTERM");
    await hubGone(before.port);

    const conn = await ensureHub(projectDir, { command });
    const after = await readState();
    expect(after.pid).not.toBe(before.pid);
    const health = await fetch(`${conn.baseUrl}/health`);
    expect(health.status).toBe(200);
  }, 20_000);

  test("throws E_HUB_UNREACHABLE with a doctor hint when the spawn cannot come up", async () => {
    const deadDir = `${tmpRoot}/dead-proj`;
    await $`mkdir -p ${deadDir}`.quiet();
    const exitImmediately = [process.execPath, "-e", "process.exit(1)"];
    try {
      await ensureHub(deadDir, { command: exitImmediately });
      expect.unreachable("ensureHub should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe("E_HUB_UNREACHABLE");
      expect(cliErr.message).toBe("cannot reach the hub and could not start one");
      expect(cliErr.hint).toBe("run `pinbox doctor` to find out why");
    }
  }, 20_000);
});
