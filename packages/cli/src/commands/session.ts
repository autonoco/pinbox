// pinbox CLI — hidden `session` verb: the plumbing agent hooks call.
// register/list/inject/pending. `--hook` reads the agent's hook payload from stdin
// and speaks the hookSpecificOutput contract; stdin parse, fingerprinting, and hook
// stdout shapes live in session-hook.ts so this file stays a thin commander surface.
// Without --hook: the normal output contract (--json envelope / human facts).
// UX spec: docs/design/cli/v2-session-transcripts.md.
import type { SessionRef } from "@autono/pinbox-core/schema";
import { parseTrailers, type Session } from "@autono/pinbox-core/sessions";
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { CliError } from "../errors.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import {
  buildPendingContext,
  fingerprintAgent,
  hookOutput,
  readHookPayload,
} from "./session-hook.ts";

export type SessionRefOptions = OutputFlags & { agent?: string; key?: string; hook?: boolean };
export type SessionRegisterOptions = SessionRefOptions & { cwd?: string };
export type SessionInjectOptions = SessionRefOptions & { raw?: boolean };
export type SessionTrailerOptions = OutputFlags & { commit?: string };

export function registerSession(program: Command): void {
  const session = program
    .command("session", { hidden: true })
    .summary("agent-session plumbing, invoked by agent hooks")
    .description(
      "Hidden plumbing invoked by agent hooks: register agent sessions with the hub and " +
        "pull pending pin context. Not part of the human surface — the pinbox skill and " +
        "the hook scripts in packages/cli/hooks/ are the callers.",
    );

  session
    .command("register")
    .summary("register (upsert) an agent session")
    .description("Register (upsert) an agent session with the hub. Fired by SessionStart hooks.")
    .option("--agent <name>", "agent name (claude, codex, hermes, openclaw)")
    .option("--key <key>", "agent session key")
    .option("--cwd <dir>", "session working directory")
    .option("--hook", "read the agent hook payload JSON from stdin; side-effect only")
    .option("--json", "machine output")
    .action(async (_opts: SessionRegisterOptions, cmd: Command) => {
      await runSessionRegister(cmd.optsWithGlobals() as SessionRegisterOptions);
    });

  session
    .command("list")
    .summary("list registered agent sessions")
    .description("List registered agent sessions, most recently seen first.")
    .option("--json", "machine output")
    .action(async (_opts: OutputFlags, cmd: Command) => {
      await runSessionList(cmd.optsWithGlobals() as OutputFlags);
    });

  session
    .command("inject")
    .summary("pull open-pin context into the agent's next turn")
    .description(
      "Pull pending deliveries and every open pin as injection context. Fired by " +
        "UserPromptSubmit hooks; re-injection every turn is the delivery model.",
    )
    .option("--agent <name>", "agent name (claude, codex, hermes, openclaw)")
    .option("--key <key>", "agent session key")
    .option("--hook", "stdin payload in, hookSpecificOutput JSON out")
    .option("--raw", "print the bare context text (for wrappers that add their own envelope)")
    .option("--json", "machine output")
    .action(async (_opts: SessionInjectOptions, cmd: Command) => {
      await runSessionInject(cmd.optsWithGlobals() as SessionInjectOptions);
    });

  session
    .command("pending")
    .summary("report pins awaiting delivery to this session")
    .description(
      "Report open pins awaiting delivery to this session — the read-only Stop-hook " +
        "gate. Emits nothing when there is nothing pending.",
    )
    .option("--agent <name>", "agent name (claude, codex, hermes, openclaw)")
    .option("--key <key>", "agent session key")
    .option("--hook", "stdin payload in, hookSpecificOutput JSON out (silent when zero)")
    .option("--json", "machine output")
    .action(async (_opts: SessionRefOptions, cmd: Command) => {
      await runSessionPending(cmd.optsWithGlobals() as SessionRefOptions);
    });

  session
    .command("trailer")
    .summary("resolve pins named by commit-message trailers")
    .description(
      "Parse Fixes/Resolves/Closes pin trailers from a commit message and resolve those " +
        "pins with the SHA attached. Fired by the post-commit hook; idempotent — " +
        "already-resolved and unknown ids skip silently, so amend/rebase re-fires are safe.",
    )
    .option("--commit <sha>", "commit to read (default HEAD)")
    .option("--json", "machine output")
    .action(async (_opts: SessionTrailerOptions, cmd: Command) => {
      await runSessionTrailer(cmd.optsWithGlobals() as SessionTrailerOptions);
    });
}

export async function runSessionRegister(opts: SessionRegisterOptions): Promise<void> {
  try {
    const { ref } = await resolveRef(opts, opts.cwd);
    const client = await connectClient();
    const session = await client.registerSession(ref);
    if (opts.hook) return; // SessionStart is side-effect only — no hook stdout
    emit(session, opts, (s) => s.id);
    if (!isJsonMode(opts)) console.error(`registered ${session.agent} session ${session.key}`);
  } catch (err) {
    fail(err, opts);
  }
}

export async function runSessionList(opts: OutputFlags): Promise<void> {
  try {
    const client = await connectClient();
    const sessions = await client.listSessions();
    emit(sessions, opts, renderSessions);
    if (!isJsonMode(opts)) console.error(`${sessions.length} session(s)`);
  } catch (err) {
    fail(err, opts);
  }
}

export async function runSessionInject(opts: SessionInjectOptions): Promise<void> {
  try {
    const { ref, hookEventName } = await resolveRef(opts);
    const client = await connectClient();
    // Upsert (not lookup): an agent whose hook is pulling is definitionally alive, so
    // registering revives an ended session and yields the id the pull routes need.
    const session = await client.registerSession(ref);
    const result = await client.sessionInject(session.id);
    if (opts.hook) {
      // Zero open pins injects nothing — empty context must not spend agent tokens.
      if (result.pins.length > 0) {
        console.log(hookOutput(hookEventName ?? "UserPromptSubmit", result.context));
      }
      return;
    }
    if (opts.raw) {
      if (result.pins.length > 0) console.log(result.context);
      return;
    }
    emit(result, opts, (r) => (r.pins.length === 0 ? "" : r.context));
    if (!isJsonMode(opts)) {
      console.error(`${result.pins.length} open pin(s), ${result.delivered} delivered`);
    }
  } catch (err) {
    fail(err, opts);
  }
}

export async function runSessionPending(opts: SessionRefOptions): Promise<void> {
  try {
    const { ref, hookEventName } = await resolveRef(opts);
    const client = await connectClient();
    // Lookup, never register: pending is the read-only gate — an unknown session
    // simply has nothing pending.
    const sessions = await client.listSessions();
    const session = sessions.find((s) => s.agent === ref.agent && s.key === ref.key);
    const result =
      session === undefined ? { count: 0, pins: [] } : await client.sessionPending(session.id);
    if (opts.hook) {
      // count 0 emits NOTHING — empty stdout must not hold the agent.
      if (result.count > 0) {
        console.log(hookOutput(hookEventName ?? "Stop", buildPendingContext(result.pins)));
      }
      return;
    }
    emit(result, opts, (r) => r.pins.map((pin) => pin.id).join("\n"));
    if (!isJsonMode(opts)) console.error(`${result.count} pending`);
  } catch (err) {
    fail(err, opts);
  }
}

/**
 * `pinbox session trailer [--commit <sha>]` — commit-trailer resolution (A2 write path).
 * Open pin ⇒ resolve with the full SHA attached; already-resolved or unknown ⇒ skip
 * SILENTLY (post-commit hooks re-fire on amend/rebase; idempotent, never fails the
 * commit). Attribution: by "agent" when the env fingerprints one, else "human".
 */
export async function runSessionTrailer(opts: SessionTrailerOptions): Promise<void> {
  try {
    const { message, sha } = readCommit(opts.commit);
    const by = fingerprintAgent() === null ? "human" : "agent";
    const outcome = await resolveTrailerIds(parseTrailers(message), by, sha);
    emit(outcome, opts, () => "");
    if (!isJsonMode(opts)) {
      for (const id of outcome.resolved) console.error(`resolved ${id} (${sha.slice(0, 7)})`);
    }
  } catch (err) {
    fail(err, opts);
  }
}

type TrailerOutcome = { resolved: string[]; skipped: string[] };

async function resolveTrailerIds(
  ids: string[],
  by: "human" | "agent",
  sha: string,
): Promise<TrailerOutcome> {
  const outcome: TrailerOutcome = { resolved: [], skipped: [] };
  if (ids.length === 0) return outcome; // no trailers ⇒ never touch (or spawn) the hub
  const client = await connectClient();
  for (const id of ids) {
    try {
      await client.resolve(id, by, undefined, sha);
      outcome.resolved.push(id);
    } catch (err) {
      if (!isSkippableResolveError(err)) throw err;
      outcome.skipped.push(id);
    }
  }
  return outcome;
}

/** Already-resolved and unknown ids skip silently: amend/rebase re-fires are safe. */
function isSkippableResolveError(err: unknown): boolean {
  return err instanceof CliError && (err.code === "E_NOT_FOUND" || err.code === "E_CONFLICT");
}

/** Commit message + full SHA via `git log -1` in the current directory. */
function readCommit(sha?: string): { message: string; sha: string } {
  const result = Bun.spawnSync(["git", "log", "-1", "--format=%B%n%H", sha ?? "HEAD"]);
  if (!result.success) {
    throw new CliError(
      "E_INVALID_INPUT",
      `git log failed: ${result.stderr.toString().trim() || "not a git repository?"}`,
      "run from inside a git repository, or pass --commit <sha> that exists",
    );
  }
  const lines = result.stdout.toString().trimEnd().split("\n");
  const fullSha = lines.at(-1) ?? "";
  return { message: lines.slice(0, -1).join("\n"), sha: fullSha };
}

/** One line per session: id, agent, key, state. Empty list renders nothing. */
export function renderSessions(sessions: Session[]): string {
  if (sessions.length === 0) return "";
  const agentWidth = Math.max(...sessions.map((s) => s.agent.length));
  const keyWidth = Math.max(...sessions.map((s) => s.key.length));
  return sessions
    .map(
      (s) =>
        `${s.id}  ${s.agent.padEnd(agentWidth)}  ${s.key.padEnd(keyWidth)}  ` +
        `${s.endedAt === undefined ? "active" : "ended"}`,
    )
    .join("\n");
}

type ResolvedRef = { ref: SessionRef; hookEventName: string | undefined };

/**
 * Resolve the session ref: `--hook` reads the payload from stdin and fingerprints the
 * agent from env (`--agent` overrides; unknown + no flag is E_INVALID_INPUT); without
 * it, both --agent and --key are required.
 */
async function resolveRef(opts: SessionRefOptions, cwdFlag?: string): Promise<ResolvedRef> {
  return opts.hook ? resolveHookRef(opts, cwdFlag) : resolveFlagRef(opts, cwdFlag);
}

async function resolveHookRef(opts: SessionRefOptions, cwdFlag?: string): Promise<ResolvedRef> {
  const payload = await readHookPayload();
  const agent = opts.agent ?? fingerprintAgent();
  if (agent === null || agent === undefined) {
    throw new CliError(
      "E_INVALID_INPUT",
      "cannot fingerprint the agent from the environment",
      "pass --agent <claude|codex|hermes|openclaw>",
    );
  }
  const key = opts.key ?? payload.sessionId;
  if (key === undefined) {
    throw new CliError(
      "E_INVALID_INPUT",
      "hook payload carries no session_id",
      "pass --key <key>, or pipe the agent's hook payload JSON on stdin",
    );
  }
  const cwd = cwdFlag ?? payload.cwd;
  return {
    ref: { agent, key, ...(cwd !== undefined ? { cwd } : {}) },
    hookEventName: payload.hookEventName,
  };
}

function resolveFlagRef(opts: SessionRefOptions, cwdFlag?: string): ResolvedRef {
  if (opts.agent === undefined || opts.key === undefined) {
    throw new CliError(
      "E_INVALID_INPUT",
      "missing --agent and --key",
      "pass --agent <name> --key <key>, or --hook with the agent's hook payload on stdin",
    );
  }
  return {
    ref: { agent: opts.agent, key: opts.key, ...(cwdFlag !== undefined ? { cwd: cwdFlag } : {}) },
    hookEventName: undefined,
  };
}
