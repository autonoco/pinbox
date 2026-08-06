// pinbox CLI — hub daemon lifecycle.
// ensureHub(): read state → probe health → reuse, or SIGTERM a version-mismatched hub
// (guarded by a liveness check so a recycled pid is never signalled blind), or
// detached-self-spawn `serve` and poll until the NEW pid's state file answers /health.
import packageJson from "../package.json" with { type: "json" };
import { CliError } from "./errors.ts";
import { readHubState, statePaths } from "./paths.ts";

const HEALTH_TIMEOUT_MS = 500;
const SPAWN_POLL_MS = 100;
const SPAWN_DEADLINE_MS = 3_000;
const TERM_DEADLINE_MS = 2_000;

export type HubConnection = { baseUrl: string; token: string };

// Test seam: command tests inject an in-process hub here instead of
// letting every verb spawn a real detached daemon.
let connectionForTests: HubConnection | null = null;

export function setConnectionForTests(connection: HubConnection | null): void {
  connectionForTests = connection;
}

/** The connection every verb uses: the test-injected hub, or the real daemon. */
export function getConnection(projectDir: string): Promise<HubConnection> {
  return connectionForTests ? Promise.resolve(connectionForTests) : ensureHub(projectDir);
}

/**
 * Argv prefix that re-invokes this CLI — the two shapes it ships in, and nothing else.
 * The entry is a parameter, not an inferred global: under `bun test`, Bun.main is the
 * TEST FILE, and defaulting there would spawn the test as the hub and recurse.
 */
export function selfCommand(entry: string = Bun.main): string[] {
  // Compiled standalone binary: process.execPath IS pinbox and the entry is the
  // embedded "/$bunfs/..." path — re-invoke the binary with no script argument.
  // Otherwise (source or npm install): process.execPath is bun, entry is the script.
  return entry.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, entry];
}

/**
 * Return a healthy hub for the project, spawning one as a detached daemon if needed.
 * @throws CliError E_HUB_UNREACHABLE when no hub answers within the spawn deadline.
 */
export async function ensureHub(
  projectDir: string,
  opts?: { command?: string[] },
): Promise<HubConnection> {
  const paths = statePaths(projectDir);

  const existing = await readHubState(paths.stateFile);
  if (existing && isAlive(existing.pid) && (await isHealthy(existing.port))) {
    if (existing.version === packageJson.version) {
      return { baseUrl: baseUrl(existing.port), token: existing.token };
    }
    await terminate(existing.pid); // stale version — replace the daemon
  }

  const command = opts?.command ?? selfCommand();
  const proc = Bun.spawn([...command, "serve", "--project", projectDir], {
    stdio: ["ignore", "ignore", "ignore"],
    // Spread, don't rely on the default: Bun.spawn's default env is the process's
    // STARTUP environ — runtime process.env mutations (XDG_STATE_HOME in tests,
    // PINBOX_IDLE_MS) only reach the daemon through an explicit env object.
    env: { ...process.env },
    // detached: the daemon must lead its OWN process group — an undetached child
    // inherits the CLI's group, so a Ctrl+C (group SIGINT) aimed at the CLI would
    // kill the daemon with it. Surviving parent exit alone is not enough.
    detached: true,
  });
  // unref: the CLI must exit without waiting on the daemon.
  proc.unref();

  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const state = await readHubState(paths.stateFile);
    // pid guard: only OUR spawn's state file counts — a stale file from a dead daemon
    // (or a concurrent racer's) can never satisfy the poll with someone else's token.
    if (state && state.pid === proc.pid && (await isHealthy(state.port))) {
      return { baseUrl: baseUrl(state.port), token: state.token };
    }
    await Bun.sleep(SPAWN_POLL_MS);
  }
  throw new CliError(
    "E_HUB_UNREACHABLE",
    "cannot reach the hub and could not start one",
    "run `pinbox doctor` to find out why",
  );
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True only for a pinbox hub: /health must answer the machine-output envelope. */
async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return false;
    const record = body as Record<string, unknown>;
    return record["ok"] === true;
  } catch {
    return false;
  }
}

/** SIGTERM a pid we just proved alive, then wait for it to exit. */
async function terminate(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // exited between the liveness check and the signal
  }
  const deadline = Date.now() + TERM_DEADLINE_MS;
  while (Date.now() < deadline && isAlive(pid)) {
    await Bun.sleep(50);
  }
}
