// @autono/pinbox-core/delivery/resume — resume-spawn delivery adapter (dispatch rule 2:
// a gone session is resumed under the SAME session key from the recorded cwd; resume
// refused/impossible ⇒ E_SESSION_GONE).
//
// BUN-ONLY (Bun.spawn, Bun.which) — imported by the CLI serve path ONLY, never by
// router.ts: a static import there lands in the DO bundle, where subprocess spawning
// does not exist (it ships on the "./delivery/resume" subpath instead).
//
// Spawn rules (deep-dive §1.8, binding — both defects measured, both silent):
// (a) Orphan leak: detached: true so the agent leads its own process group; timeout
//     cancel is process.kill(-proc.pid, "SIGTERM") then SIGKILL after 2s — killing the
//     direct pid orphans the grandchildren (language servers, MCP servers).
// (b) Truncation: await close, never exit — drain both pipes to EOF, THEN await
//     proc.exited (a probe lost 65,538 of 200,000 bytes awaiting exit).
import type { Session } from "../sessions.ts";
import type { StoredEvent } from "../store.ts";
import { type GetPin, payloadForEvent } from "./payload.ts";
import { drainToExit, resolveBinary } from "./proc.ts";
import type { DeliveryAdapter } from "./router.ts";

export type ResumeCommand = (key: string, prompt: string) => string[];

export const RESUME_COMMANDS: Record<string, ResumeCommand> = {
  claude: (key, prompt) => ["claude", "--resume", key, "-p", prompt],
  codex: (key, prompt) => ["codex", "exec", "resume", key, prompt],
  // Hermes' resume flags are assumed to mirror Claude Code's and are not verified against
  // a released hermes CLI. If a resume never lands, check this line first.
  hermes: (key, prompt) => ["hermes", "--resume", key, "-p", prompt],
};

const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_ESCALATE_MS = 2_000;

export function createResumeAdapter(opts?: {
  commands?: Record<string, ResumeCommand>; // test seam
  timeoutMs?: number; // default 120_000
  /** Pin lookup for reply prompts — see payloadForEvent; serve passes store.getPin. */
  getPin?: GetPin;
}): DeliveryAdapter {
  const commands = opts?.commands ?? RESUME_COMMANDS;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const getPin = opts?.getPin;
  return {
    name: "resume",
    matches(session: Session): boolean {
      // Liveness ordering is the router's job (hooks precedes resume in the serve
      // array): resume sees ended sessions and escalations, so endedAt is deliberately
      // not checked. Reachable = cwd recorded + agent in the map + binary on PATH.
      if (session.cwd === undefined) return false;
      const command = commands[session.agent];
      if (command === undefined) return false;
      const binary = command("probe", "probe").at(0);
      return binary !== undefined && resolveBinary(binary) !== null;
    },
    async deliver(event: StoredEvent, session: Session): Promise<void> {
      const command = commands[session.agent];
      if (command === undefined || session.cwd === undefined) {
        // matches() gates this in the router path; direct callers get rule 2's terminal.
        throw new Error(
          `E_SESSION_GONE: cannot resume agent "${session.agent}" (no resume command or recorded cwd)`,
        );
      }
      const prompt = payloadForEvent(event, "resume", getPin);
      await run(command(session.key, prompt), session.key, session.cwd, timeoutMs);
    },
  };
}

async function run(cmd: string[], key: string, cwd: string, timeoutMs: number): Promise<void> {
  const binary = cmd.at(0);
  if (binary === undefined) throw new Error("resume command resolved to an empty argv");
  const resolved = resolveBinary(binary);
  if (resolved === null) {
    // Rule 2's "resume impossible": the agent binary left the PATH since matches().
    throw new Error(`E_SESSION_GONE: ${binary} not found on PATH to resume key ${key}`);
  }
  const proc = Bun.spawn([resolved, ...cmd.slice(1)], {
    cwd,
    env: { ...process.env }, // runtime env mutations do not reach children otherwise
    detached: true, // the agent leads its own process group — kill(-pid) reaps the tree
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timedOut = false;
  let cancelEscalation: (() => void) | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    cancelEscalation = killGroup(proc.pid);
  }, timeoutMs);
  try {
    const { code, stderr } = await drainToExit(proc);
    if (timedOut) {
      // Deliberately NOT E_SESSION_GONE: a hung resume proves nothing about the
      // session — the queue retries with backoff (terminal E_DELIVERY after 5).
      throw new Error(`resume ${binary} for session key ${key} timed out after ${timeoutMs}ms`);
    }
    if (code !== 0) {
      // Rule 2's "resume refused/impossible" — the router fails this terminally.
      throw new Error(
        `E_SESSION_GONE: ${binary} exited ${code} resuming session key ${key}` +
          (stderr === "" ? "" : ` — ${stderr}`),
      );
    }
  } finally {
    clearTimeout(timer);
    // drainToExit resolved ⇒ the child is gone (it drains the pipes to EOF and awaits
    // proc.exited), so the escalation has nothing left to kill — and must not fire.
    cancelEscalation?.();
  }
}

/**
 * SIGTERM the whole group, SIGKILL `escalateMs` later; returns a cancel for that
 * escalation. POSIX only — Windows has no process groups (§1.8).
 *
 * Cancelling is not an optimization. Once the child has exited, its pid is free for OS
 * reuse, and a pending kill(-pid, "SIGKILL") would then signal a process group that
 * belongs to something else entirely. `.unref()` keeps the timer from holding the loop
 * open but does NOT stop it firing, so the exit path has to clear it.
 */
export function killGroup(pid: number, escalateMs: number = SIGKILL_ESCALATE_MS): () => void {
  signalGroup(pid, "SIGTERM");
  const escalation = setTimeout(() => signalGroup(pid, "SIGKILL"), escalateMs);
  escalation.unref();
  return () => {
    clearTimeout(escalation);
  };
}

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH — the group already exited
  }
}
