// pinbox CLI — init command, both layers.
// Layer 1 (deterministic): .pinbox/ dir → gitignore → agent selection (flags ∩ detection)
// → plugin install per agent → marker blocks for the non-plugin long tail → git hook.
// Idempotent: every writer reports "unchanged" on re-run, exit 0 both times. --dry-run
// runs the same sequence with zero writes: each writer reports its predicted outcome,
// agent installs report "would install".
// Layer 2 (handoff): the integration brief, then one of two endings — the brief itself,
// for --dry-run, agent invocations (an agent never spawns a second agent) and machine
// output (nothing may prompt in front of an envelope); or, for a human at a terminal, the
// headless handoff that ends in a pinbox/integration PR. Only the human ending prompts or
// spawns, which is why it alone prints Layer 1 up front — the spawn can block for minutes.
// UX: facts stdout, messaging stderr, `--json` envelope
// (docs/design/cli/v1-transcripts.md style).
import type { Command } from "commander";
import { AGENTS, type AgentId, type AgentSpec, detectAgents } from "../agents.ts";
import { CliError } from "../errors.ts";
import { integrationBrief } from "../init/brief.ts";
import { detectRepo, invocationMode } from "../init/detect.ts";
import { ensureGitignore, installGitHook } from "../init/hooks-install.ts";
import {
  agentCheatsheet,
  MARKER_TARGETS,
  type MarkerResult,
  upsertMarkerBlock,
} from "../init/markers.ts";
import {
  type InstallOutcome,
  installClaudeSkillsDir,
  installViaShell,
} from "../init/plugin-install.ts";
import { askLine, askYesNo } from "../init/prompt.ts";
import { installClaudeSettings, type SettingsOutcome } from "../init/settings-install.ts";
import { spawnIntegrationAgent } from "../init/spawn.ts";
import { ensurePinboxDir } from "../init/state-dir.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";

/** Marketplace source for the shell install routes (research §2D). */
const REPO_SLUG = "autonoco/pinbox";

export type InitFlags = OutputFlags & {
  agent?: string;
  global?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** commander's --no-input: present ⇒ false. */
  input?: boolean;
  agentMode?: boolean;
};

/** Everything ambient, injected — command-level tests run in mkdtemp projects. */
export type InitContext = {
  projectDir: string;
  env: Record<string, string | undefined>;
  home: string | undefined;
  isTTY?: boolean;
  /**
   * The three ambient effects Layer 2's handoff ending needs. Default to the terminal
   * globals and the real spawner; tests inject them to reach the branch that prompts.
   */
  confirm?: (question: string) => boolean;
  prompt?: (question: string) => string | null;
  spawn?: typeof spawnIntegrationAgent;
};

/** Both seams ask on stderr (init/prompt.ts) and run only in human mode (see initLayer2). */
function ask(ctx: InitContext, question: string): boolean {
  return (ctx.confirm ?? askYesNo)(question);
}

function askFor(ctx: InitContext, question: string): string | null {
  return (ctx.prompt ?? askLine)(question);
}

/** Layer 2's spawn ending: what the handed-off agent did with the brief. */
export type Handoff = {
  agent: AgentId;
  exitCode: number;
  /** The PR the agent opened, when its output named one; null ⇒ the local-branch fallback. */
  prUrl: string | null;
  detail: string;
};

export type InitData = {
  pinboxDir: "created" | "unchanged";
  gitignore: Awaited<ReturnType<typeof ensureGitignore>>;
  agents: InstallOutcome[];
  markers: MarkerResult[];
  gitHook: Awaited<ReturnType<typeof installGitHook>>;
  /** Hook registration + the `pinbox` allow rule in .claude/settings.json. */
  claudeSettings: SettingsOutcome;
  /** Present when the caller continues the integration: --dry-run, or an agent invocation. */
  brief?: string;
  /** Present only when a headless agent was handed the brief. */
  handoff?: Handoff;
};

type Target = InstallOutcome["agent"];

const LONG_TAIL: readonly ("cursor" | "copilot")[] = ["cursor", "copilot"];
const VALID_TARGETS: readonly string[] = [...AGENTS.map((spec) => spec.id), ...LONG_TAIL];

export function registerInit(program: Command): void {
  program
    .command("init")
    .summary("set up pinbox in this project")
    .description(
      "Set up pinbox in this project: .pinbox/ state, gitignore entry, " +
        "plugin install per detected agent, git hook.",
    )
    .option("--agent <list>", "agents to install for (comma-separated), or none")
    .option("--global", "install agent plugins user-wide instead of into this project")
    .option("--dry-run", "print what would happen without installing")
    .option("--yes", "accept the detected defaults without prompting")
    .option("--no-input", "never prompt")
    .option("--agent-mode", "force agent invocation mode")
    .option("--json", "machine output")
    .action(async (_opts: InitFlags, cmd: Command) => {
      await runInit(cmd.optsWithGlobals() as InitFlags, {
        projectDir: process.cwd(),
        env: process.env,
        home: process.env["HOME"],
        isTTY: process.stdin.isTTY === true,
      });
    });
}

export async function runInit(flags: InitFlags, ctx: InitContext): Promise<void> {
  try {
    const human = !isJsonMode(flags);
    const { data, notes } = await initLayer1(flags, ctx);
    // Human runs print Layer 1 the moment it is done: Layer 2's handoff blocks for as long
    // as the agent runs (15 minutes at the ceiling), and a failed spawn must not swallow
    // the record of what init already wrote. JSON mode stays one envelope, emitted below.
    if (human) {
      emit(data, flags, renderLayer1);
      flushNotes(notes);
    }
    Object.assign(data, await initLayer2(flags, ctx, notes));
    if (human) {
      emit(data, flags, renderLayer2);
      flushNotes(notes);
    } else {
      emit(data, flags, renderInit);
    }
  } catch (err) {
    fail(err, flags);
  }
}

/** Print and drain: notes already shown must never be repeated by a later flush. */
function flushNotes(notes: string[]): void {
  for (const note of notes) console.error(note);
  notes.length = 0;
}

/**
 * Layer 2 — the integration brief and its ending, mode-gated:
 *   --dry-run          ⇒ emit the brief, change nothing;
 *   agent invocation   ⇒ emit the brief for the calling agent to continue. An agent
 *                        never spawns a second agent;
 *   JSON mode          ⇒ emit the brief: a prompt would land on stdout in front of the
 *                        envelope and stderr must stay empty (output.ts contract);
 *   human TTY          ⇒ offer the headless handoff (`--yes` accepts) and report the PR.
 * `--yes` means "do not prompt", not "I am an agent", so it is deliberately withheld
 * from this mode probe — the handoff turns on the TTY and the agent fingerprints alone.
 */
async function initLayer2(
  flags: InitFlags,
  ctx: InitContext,
  notes: string[],
): Promise<{ brief?: string; handoff?: Handoff }> {
  const brief = integrationBrief(detectRepo(ctx.projectDir));
  if (flags.dryRun === true) {
    notes.push("dry run — the brief above is exactly what an agent would receive");
    return { brief };
  }
  const mode = invocationMode({
    flags: { agentMode: flags.agentMode === true, noInput: flags.input === false },
    env: ctx.env,
    isTTY: ctx.isTTY === true,
  });
  if (mode === "agent") {
    notes.push("agent invocation — no second agent spawned; continue with the brief above");
    return { brief };
  }
  // `--json`, or any non-TTY stdout: machine output owns stdout, so nothing may prompt.
  if (isJsonMode(flags)) return { brief };
  // Only `onPath` agents can be handed the brief: spec.headless() spawns the bare bin
  // name, so a config dir left behind by an uninstalled agent is a guaranteed ENOENT.
  const candidates = detectAgents({
    env: ctx.env,
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
  })
    .filter((agent) => agent.onPath && agent.spec.headless !== null)
    .map((agent) => agent.spec);
  const chosen = candidates.length === 0 ? null : pickHandoffAgent(candidates, flags, ctx);
  if (chosen === null) {
    notes.push(
      candidates.length === 0
        ? "no headless-capable agent on PATH — hand the brief above to your agent"
        : "handoff declined — hand the brief above to your agent when you are ready",
    );
    return { brief };
  }
  return { handoff: await handOff(chosen, brief, ctx) };
}

/** Single candidate ⇒ one confirm; several ⇒ pick one. `--yes` takes the first. */
export function pickHandoffAgent(
  candidates: AgentSpec[],
  flags: InitFlags,
  ctx: InitContext,
): AgentSpec | null {
  const first = candidates[0] as AgentSpec;
  if (flags.yes === true) return first;
  if (candidates.length === 1) {
    return ask(ctx, `hand the integration brief to ${first.id}?`) ? first : null;
  }
  const menu = candidates.map((spec, index) => `${index + 1}. ${spec.id}`).join("\n");
  const answer = Number(
    askFor(ctx, `hand the integration brief to which agent?\n${menu}\n(number)`),
  );
  return Number.isInteger(answer) && answer >= 1 && answer <= candidates.length
    ? (candidates[answer - 1] as AgentSpec)
    : null;
}

const PR_URL = /https:\/\/\S+\/pull\/\d+/;

async function handOff(spec: AgentSpec, brief: string, ctx: InitContext): Promise<Handoff> {
  // Straight to stderr, not onto the deferred notes: the spawn below owns the terminal for
  // as long as the agent runs, and silence there reads as a hang. Human mode only.
  console.error(
    `handing the integration brief to ${spec.id} — it will open a pinbox/integration PR`,
  );
  let result: Awaited<ReturnType<typeof spawnIntegrationAgent>>;
  try {
    result = await (ctx.spawn ?? spawnIntegrationAgent)(spec, brief, { cwd: ctx.projectDir });
  } catch (cause) {
    throw new CliError(
      "E_INTERNAL",
      `handoff to ${spec.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      "re-run with --dry-run and hand the brief to your agent manually",
    );
  }
  const prUrl = PR_URL.exec(result.output)?.[0] ?? null;
  const detail =
    prUrl !== null
      ? prUrl
      : result.exitCode === 0
        ? "no PR url in the agent output — check for a local pinbox/integration branch"
        : `agent exited ${result.exitCode} — check for a local pinbox/integration branch`;
  return { agent: spec.id, exitCode: result.exitCode, prUrl, detail };
}

async function initLayer1(
  flags: InitFlags,
  ctx: InitContext,
): Promise<{ data: InitData; notes: string[] }> {
  const notes: string[] = [];
  const dryRun = flags.dryRun === true;
  const pinboxDir = ensurePinboxDir(ctx.projectDir, dryRun);
  const gitignore = await ensureGitignore(ctx.projectDir, { dryRun });
  const { targets, planOnly } = selectTargets(flags, ctx);
  const agents: InstallOutcome[] = [];
  const markers: MarkerResult[] = [];
  for (const target of targets) {
    if (target === "cursor" || target === "copilot") {
      agents.push(await installMarkers(target, ctx.projectDir, planOnly, dryRun, markers));
      continue;
    }
    const spec = AGENTS.find((candidate) => candidate.id === target) as AgentSpec;
    agents.push(await installAgent(spec, flags, ctx, planOnly, notes));
  }
  if (dryRun) {
    notes.push("dry run — nothing written; re-run without --dry-run to apply");
  } else if (planOnly && targets.length > 0) {
    notes.push("nothing installed — re-run with --agent <list> or --yes to install");
  }
  const gitHook = await installGitHook(ctx.projectDir, { dryRun });
  // Only meaningful once the skill's hook scripts exist on disk, so this runs after the agents.
  const claudeSettings = agents.some((a) => a.agent === "claude" && a.ok)
    ? await installClaudeSettings(ctx.projectDir, { dryRun })
    : "unchanged";
  return { data: { pinboxDir, gitignore, agents, markers, gitHook, claudeSettings }, notes };
}

/**
 * Flag parity with the picker: --agent wins (unknown targets error loudly, `none` is
 * empty); otherwise detection picks. Non-interactive runs never install silently —
 * without --agent/--yes they only list what they *would* do (planOnly) — JSON mode counts
 * as non-interactive whatever stdin is: a machine run has nobody to answer, so a question
 * there is a hang, not a prompt. A human TTY run confirms the detected set before installing.
 * --dry-run forces planOnly for the whole run (no prompt, no writes anywhere — Layer 1
 * becomes pure prediction).
 */
function selectTargets(
  flags: InitFlags,
  ctx: InitContext,
): { targets: Target[]; planOnly: boolean } {
  const dryRun = flags.dryRun === true;
  if (flags.agent !== undefined) return { targets: parseAgentFlag(flags.agent), planOnly: dryRun };
  const detected = detectAgents({
    env: ctx.env,
    ...(ctx.home === undefined ? {} : { home: ctx.home }),
  })
    .filter((agent) => agent.detected)
    .map((agent) => agent.spec.id);
  const surfaces = LONG_TAIL.filter((target) => surfaceExists(ctx.projectDir, target));
  const targets: Target[] = [...detected, ...surfaces];
  const mode = invocationMode({
    flags: {
      agentMode: flags.agentMode === true,
      noInput: flags.input === false,
      yes: flags.yes === true,
    },
    env: ctx.env,
    isTTY: ctx.isTTY === true,
  });
  if (dryRun) return { targets, planOnly: true };
  if (flags.yes === true || targets.length === 0) return { targets, planOnly: false };
  if (mode === "agent" || isJsonMode(flags)) return { targets, planOnly: true };
  // Human TTY: the picker, minimal form — detected set preselected, one confirm.
  const accepted = ask(ctx, `install pinbox for: ${targets.join(", ")}?`);
  return { targets, planOnly: !accepted };
}

/** Explicit `--agent` list: `none` ⇒ empty; unknown targets error loudly (E_INVALID_INPUT). */
function parseAgentFlag(list: string): Target[] {
  const names = list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 1 && names[0] === "none") return [];
  const unknown = names.filter((name) => !VALID_TARGETS.includes(name));
  if (unknown.length > 0) {
    throw new CliError(
      "E_INVALID_INPUT",
      `unknown agent target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      `valid targets: ${VALID_TARGETS.join(", ")}, none`,
    );
  }
  return [...new Set(names)] as Target[];
}

async function installAgent(
  spec: AgentSpec,
  flags: InitFlags,
  ctx: InitContext,
  planOnly: boolean,
  notes: string[],
): Promise<InstallOutcome> {
  const method = spec.install.kind === "skills-dir" ? "skills-dir" : "shell";
  if (planOnly) {
    return {
      agent: spec.id,
      method,
      ok: true,
      detail: wouldInstall(spec.id, method, flags.dryRun === true),
    };
  }
  return method === "skills-dir"
    ? installSkillsDirRoute(flags, ctx, notes)
    : installShellRoute(spec, flags, notes);
}

async function installSkillsDirRoute(
  flags: InitFlags,
  ctx: InitContext,
  notes: string[],
): Promise<InstallOutcome> {
  // `--global` needs a home to install into. With none (HOME unset, or a stripped env) the
  // install falls back to project scope — which is a different thing from what was asked for,
  // so it is said out loud rather than quietly substituted.
  const downgraded = flags.global === true && ctx.home === undefined;
  if (downgraded) {
    notes.push(
      "--global ignored: no HOME in the environment — installing at project scope instead",
    );
  }
  const global = flags.global === true && ctx.home !== undefined;
  const outcome = await installClaudeSkillsDir(global ? (ctx.home as string) : ctx.projectDir);
  if (outcome.ok && !global) {
    notes.push("note: project-scope skills load only when the agent launches from this directory");
  }
  return outcome;
}

async function installShellRoute(
  spec: AgentSpec,
  flags: InitFlags,
  notes: string[],
): Promise<InstallOutcome> {
  const outcome = await installViaShell(spec, REPO_SLUG, { dryRun: flags.dryRun === true });
  if (outcome.ok && spec.install.kind === "shell" && spec.install.restart !== null) {
    notes.push(`restart required: \`${spec.install.restart}\``);
  }
  return outcome;
}

async function installMarkers(
  target: "cursor" | "copilot",
  projectDir: string,
  planOnly: boolean,
  dryRun: boolean,
  markers: MarkerResult[],
): Promise<InstallOutcome> {
  const path = MARKER_TARGETS.find((candidate) => candidate.agent === target)?.path as string;
  if (planOnly) {
    return {
      agent: target,
      method: "markers",
      ok: true,
      detail: wouldInstall(target, "markers", dryRun),
    };
  }
  // A hand-damaged marker file (the writer refuses to guess where the block ends) is this
  // ONE target's failure, not the run's: aborting here would skip the git hook and leave the
  // project half-initialised over a file the user can fix in ten seconds.
  try {
    const result = await upsertMarkerBlock(`${projectDir}/${path}`, "PINBOX", agentCheatsheet());
    markers.push(result);
    return { agent: target, method: "markers", ok: true, detail: `${result} ${path} (markers)` };
  } catch (cause) {
    const detail = cause instanceof CliError ? `${cause.message} — ${cause.hint}` : String(cause);
    return { agent: target, method: "markers", ok: false, detail };
  }
}

function wouldInstall(target: Target, method: InstallOutcome["method"], dryRun: boolean): string {
  if (dryRun) return `would install (${method}) — dry run`;
  return `would install (${method}) — pass --agent ${target} or --yes`;
}

function surfaceExists(projectDir: string, target: "cursor" | "copilot"): boolean {
  const dir = target === "cursor" ? `${projectDir}/.cursor` : `${projectDir}/.github`;
  try {
    return Bun.spawnSync(["test", "-d", dir]).exitCode === 0;
  } catch {
    return false;
  }
}

const SETTINGS_DETAIL: Record<SettingsOutcome, string> = {
  installed: "registered pin delivery in .claude/settings.json",
  updated: "registered pin delivery in .claude/settings.json",
  unchanged: ".claude/settings.json already wired",
  failed: ".claude/settings.json is unreadable — hooks NOT registered, fix the JSON and re-run",
};

const GIT_HOOK_DETAIL: Record<InitData["gitHook"], string> = {
  installed: "installed .git/hooks/post-commit",
  kept: "kept existing .git/hooks/post-commit",
  "skipped-no-git": "no git repo — skipped",
};

/** Layer 1's facts — printed on their own, before Layer 2 can block. */
function renderLayer1(data: InitData): string {
  return [
    `ok  ${".pinbox".padEnd(8)}  ${data.pinboxDir}`,
    `ok  ${".gitignore".padEnd(8)}  ${data.gitignore} (.pinbox/ entry)`,
    ...data.agents.map(
      (outcome) => `${outcome.ok ? "ok" : "no"}  ${outcome.agent.padEnd(8)}  ${outcome.detail}`,
    ),
    `ok  ${"git-hook".padEnd(8)}  ${GIT_HOOK_DETAIL[data.gitHook]}`,
    `ok  ${"hooks".padEnd(8)}  ${SETTINGS_DETAIL[data.claudeSettings]}`,
  ].join("\n");
}

/**
 * Layer 2's ending, and only that: the handoff fact line, or the brief (they are mutually
 * exclusive). Empty when neither happened — emit() then prints nothing at all.
 */
function renderLayer2(data: InitData): string {
  if (data.handoff !== undefined) {
    const { handoff } = data;
    return `${handoff.prUrl !== null ? "ok" : "no"}  ${handoff.agent.padEnd(8)}  ${handoff.detail}`;
  }
  // The brief is a fact too: --dry-run and agent invocations hand it to their caller.
  return data.brief === undefined ? "" : `\n${data.brief}`;
}

/** The whole run in one rendering — the human form of the JSON envelope. */
function renderInit(data: InitData): string {
  const tail = renderLayer2(data);
  return tail === "" ? renderLayer1(data) : `${renderLayer1(data)}\n${tail}`;
}
