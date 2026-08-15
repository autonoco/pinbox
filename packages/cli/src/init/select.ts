// pinbox CLI — init target selection and handoff agent pick.
// Flag / detection / mode gates stay here; human TTY confirm uses OpenTUI, with
// injectable confirm/prompt seams for tests and a stderr prompt fallback.
import { AGENTS, type AgentSpec, detectAgents } from "../agents.ts";
import { CliError } from "../errors.ts";
import { isJsonMode } from "../output.ts";
import type { InitContext, InitFlags } from "./context.ts";
import { invocationMode } from "./detect.ts";
import type { InstallOutcome } from "./plugin-install.ts";
import { askLine, askYesNo } from "./prompt.ts";
import { confirmInstallTargets, pickHandoffAgentTui } from "./tui/index.ts";

export type Target = InstallOutcome["agent"];

const LONG_TAIL: readonly ("cursor" | "copilot")[] = ["cursor", "copilot"];
const VALID_TARGETS: readonly string[] = [...AGENTS.map((spec) => spec.id), ...LONG_TAIL];

async function ask(ctx: InitContext, question: string): Promise<boolean> {
  return await (ctx.confirm ?? askYesNo)(question);
}

async function askFor(ctx: InitContext, question: string): Promise<string | null> {
  return await (ctx.prompt ?? askLine)(question);
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
export async function selectTargets(
  flags: InitFlags,
  ctx: InitContext,
): Promise<{ targets: Target[]; planOnly: boolean }> {
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
  // Human TTY: OpenTUI confirm when no test seam is injected; stderr fallback otherwise.
  if (ctx.confirm === undefined && ctx.isTTY === true) {
    try {
      const accepted = await confirmInstallTargets(targets);
      return { targets, planOnly: !accepted };
    } catch {
      // Fall through.
    }
  }
  const accepted = await ask(ctx, `install pinbox for: ${targets.join(", ")}?`);
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

/** Single candidate ⇒ one confirm; several ⇒ pick one. `--yes` takes the first. */
export async function pickHandoffAgent(
  candidates: AgentSpec[],
  flags: InitFlags,
  ctx: InitContext,
): Promise<AgentSpec | null> {
  const first = candidates[0] as AgentSpec;
  if (flags.yes === true) return first;
  // Injected seams win (tests); otherwise the OpenTUI picker owns the human path.
  if (ctx.confirm === undefined && ctx.prompt === undefined && ctx.isTTY === true) {
    try {
      return await pickHandoffAgentTui(candidates);
    } catch {
      // Fall through to the plain stderr prompts if the TUI cannot start.
    }
  }
  if (candidates.length === 1) {
    return (await ask(ctx, `have ${first.id} wire the toolbar and open a pinbox/integration PR?`))
      ? first
      : null;
  }
  const menu = candidates.map((spec, index) => `${index + 1}. ${spec.id}`).join("\n");
  const answer = Number(
    await askFor(ctx, `which agent should wire the toolbar and open a PR?\n${menu}\n(number)`),
  );
  return Number.isInteger(answer) && answer >= 1 && answer <= candidates.length
    ? (candidates[answer - 1] as AgentSpec)
    : null;
}

function surfaceExists(projectDir: string, target: "cursor" | "copilot"): boolean {
  const dir = target === "cursor" ? `${projectDir}/.cursor` : `${projectDir}/.github`;
  try {
    return Bun.spawnSync(["test", "-d", dir]).exitCode === 0;
  } catch {
    return false;
  }
}
