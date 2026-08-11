// pinbox CLI — register the agent hooks in `.claude/settings.json`.
//
// The skill install writes `hooks/{session-start,inject,stop}.sh` under
// `.claude/skills/pinbox/`, but Claude Code reads hook registrations from `.claude/settings.json`
// and nowhere else. Without this step the scripts sit on disk and never run: no pin is ever
// pushed into a turn, so the agent only sees one if the user thinks to ask. Measured on a real
// repo — `pinbox init`, drop a pin, start the agent, and nothing reaches it.
//
// The permission entry is the other half. The skill tells the agent to run `pinbox reply` and
// `pinbox resolve`; without an allow rule it does the work, then hits a wall and cannot close the
// pin. Also measured: the agent edited the file and reported that it could not resolve.
//
// Merge, never clobber. This file belongs to the user; pinbox adds what is missing and leaves
// every other key — and any hook they wrote themselves — untouched.
/** Where the skill install writes its hook scripts, relative to the project root. */
const HOOKS_DIR = ".claude/skills/pinbox/hooks";

/** The command an allow-rule must cover for the agent to reply and resolve. */
const PINBOX_PERMISSION = "Bash(pinbox:*)";

type HookCommand = { type: "command"; command: string };
type HookMatcher = { hooks: HookCommand[] };
type Settings = {
  hooks?: Record<string, HookMatcher[]>;
  permissions?: { allow?: string[] };
  [key: string]: unknown;
};

/** Event → script, in the order the delivery model needs them. */
const HOOK_SCRIPTS: ReadonlyArray<readonly [event: string, script: string]> = [
  ["SessionStart", "session-start.sh"], // registers the session, so pins have somewhere to route
  ["UserPromptSubmit", "inject.sh"], // pulls pending pins into the turn — the delivery itself
  ["Stop", "stop.sh"], // holds the turn while pins are still pending
];

export type SettingsOutcome = "installed" | "updated" | "unchanged" | "failed";

function commandFor(script: string): string {
  return `"$CLAUDE_PROJECT_DIR/${HOOKS_DIR}/${script}"`;
}

/** True when some matcher already runs this exact script — the user may have wired it by hand. */
function alreadyRegistered(matchers: HookMatcher[] | undefined, script: string): boolean {
  return (matchers ?? []).some((matcher) =>
    (matcher.hooks ?? []).some((hook) => hook.command?.includes(script)),
  );
}

function addHooks(settings: Settings): boolean {
  let changed = false;
  const hooks = settings.hooks ?? {};
  for (const [event, script] of HOOK_SCRIPTS) {
    if (alreadyRegistered(hooks[event], script)) continue;
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [{ type: "command", command: commandFor(script) }] },
    ];
    changed = true;
  }
  if (changed) settings.hooks = hooks;
  return changed;
}

function addPermission(settings: Settings): boolean {
  const permissions = settings.permissions ?? {};
  const allow = permissions.allow ?? [];
  if (allow.includes(PINBOX_PERMISSION)) return false;
  permissions.allow = [...allow, PINBOX_PERMISSION];
  settings.permissions = permissions;
  return true;
}

/**
 * Register the hooks and allow `pinbox` in `${projectDir}/.claude/settings.json`.
 *
 * Idempotent: a second run reports `unchanged`. A settings file that exists but does not parse is
 * left strictly alone and reported as `failed` — overwriting a user's broken JSON would lose work
 * they can still recover by fixing a typo.
 */
export async function installClaudeSettings(
  projectDir: string,
  opts?: { dryRun?: boolean },
): Promise<SettingsOutcome> {
  const path = `${projectDir}/.claude/settings.json`;
  const file = Bun.file(path);
  const existed = await file.exists();

  let settings: Settings = {};
  if (existed) {
    try {
      const parsed: unknown = await file.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "failed";
      settings = parsed as Settings;
    } catch {
      return "failed";
    }
  }

  const hooksChanged = addHooks(settings);
  const permissionChanged = addPermission(settings);
  if (!hooksChanged && !permissionChanged) return "unchanged";
  if (opts?.dryRun === true) return existed ? "updated" : "installed";

  await Bun.write(path, `${JSON.stringify(settings, null, 2)}\n`, { createPath: true });
  return existed ? "updated" : "installed";
}
