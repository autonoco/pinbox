// pinbox CLI — Layer-2 headless handoff.
// Two rules here were learned the hard way and are non-negotiable:
//
//  1. **Kill the group, not the pid.** Agent CLIs spawn grandchildren; SIGTERM to the
//     direct pid orphans them. The child is spawned `detached` (its own process group)
//     and cancelled with `process.kill(-pid, …)`, SIGTERM then SIGKILL.
//  2. **Await the stream's close, never `exit`.** `exited` resolves before the pipes
//     drain — a probe lost 65,538 of 200,000 bytes that way. We await the readers.
//
// The brief travels as ONE argv element: it is data handed to the agent, never shell
// input, so it is never concatenated into a command string.
import type { AgentSpec } from "../agents.ts";
import { CliError } from "../errors.ts";

/** Long enough for a real integration (install + build + PR), short enough to not wedge. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Grace between SIGTERM and SIGKILL for the whole group. */
const KILL_GRACE_MS = 2_000;

export type SpawnResult = { exitCode: number; output: string };

/**
 * Run one agent's headless entry point with the brief as its single prompt argument.
 * Resolves with the agent's collected stdout (plus stderr when it failed) and its exit
 * code — a non-zero code is reported, not thrown; the caller decides what it means.
 * @throws CliError E_INTERNAL when the agent has no headless entry point.
 */
export async function spawnIntegrationAgent(
  spec: AgentSpec,
  brief: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<SpawnResult> {
  if (spec.headless === null) {
    throw new CliError(
      "E_INTERNAL",
      `${spec.id} has no headless entry point to hand the brief to`,
      "re-run with --dry-run and hand the brief to your agent manually",
    );
  }
  const proc = Bun.spawn(spec.headless(brief), {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true, // own process group — see rule 1
  });
  // `cancelEscalation` is armed only if the timeout actually fires; the `finally` below clears
  // both it and `timer`, so a child that exits on SIGTERM leaves no pending SIGKILL. Without
  // this the delayed kill lands on a pid group the OS may have already recycled.
  let cancelEscalation: (() => void) | undefined;
  const timer = setTimeout(() => {
    cancelEscalation = killGroup(proc);
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    // Rule 2: both readers settle only when the pipes close, after the last byte.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, output: exitCode === 0 ? stdout : stdout + stderr };
  } finally {
    clearTimeout(timer);
    cancelEscalation?.();
  }
}

/**
 * SIGTERM the whole group, then SIGKILL what survived the grace period.
 *
 * Returns a canceller the caller MUST invoke once the child has exited. An uncancelled
 * escalation fires at `-pid` after the process is gone, and pids are recycled — so it can
 * signal an unrelated process group. (Same defect class as `core/src/delivery/resume.ts`.)
 */
function killGroup(proc: Bun.Subprocess): () => void {
  if (!signalGroup(proc, "SIGTERM")) proc.kill("SIGTERM");
  const grace = setTimeout(() => {
    if (!signalGroup(proc, "SIGKILL")) proc.kill("SIGKILL");
  }, KILL_GRACE_MS);
  grace.unref();
  return () => {
    clearTimeout(grace);
  };
}

function signalGroup(proc: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(-proc.pid, signal);
    return true;
  } catch {
    // Group already gone, or the platform gave us no group — fall back to the pid.
    return false;
  }
}
