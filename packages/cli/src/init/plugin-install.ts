// pinbox CLI — per-agent plugin install routes (research §2D).
// Claude Code: materialize the embedded plugin assets into <target>/.claude/skills/pinbox/
// (@skills-dir — no marketplace, no network, uninstall = rm -rf; research §3's recommended
// route). Everyone else: Bun.spawn the registry's documented install commands.
import { $ } from "bun";
import type { AgentId, AgentSpec } from "../agents.ts";
import { PLUGIN_FILES } from "./plugin-assets.ts";

export type InstallOutcome = {
  agent: AgentId | "cursor" | "copilot";
  method: "skills-dir" | "shell" | "markers";
  ok: boolean;
  detail: string;
};

/**
 * Copy PLUGIN_FILES → `${targetRoot}/.claude/skills/pinbox/` with modes; loads as
 * pinbox@skills-dir next session. targetRoot = projectDir, or the os home with --global.
 * Byte-identical re-run reports "unchanged". Caveat (printed by init): project-scope
 * loads only from the LAUNCH directory's .claude/skills/.
 */
export async function installClaudeSkillsDir(targetRoot: string): Promise<InstallOutcome> {
  const root = `${targetRoot}/.claude/skills/pinbox`;
  let changed = false;
  try {
    for (const asset of PLUGIN_FILES) {
      const dest = `${root}/${asset.path}`;
      const existing = Bun.file(dest);
      if (!(await existing.exists()) || (await existing.text()) !== asset.contents) {
        await Bun.write(dest, asset.contents, { createPath: true });
        changed = true;
      }
      // Mode is enforced every run (bin/pinbox must stay 0755 for the PATH channel).
      await $`chmod ${asset.mode.toString(8)} ${dest}`.quiet();
    }
  } catch (cause) {
    return { agent: "claude", method: "skills-dir", ok: false, detail: message(cause) };
  }
  return {
    agent: "claude",
    method: "skills-dir",
    ok: true,
    detail: `${changed ? "installed" : "unchanged"} .claude/skills/pinbox (skills-dir)`,
  };
}

/**
 * Run the registry's documented install commands for one agent; stderr is captured
 * into `detail`, and the restart step (when the agent needs one) is always named.
 */
export async function installViaShell(
  spec: AgentSpec,
  repoSlug: string,
  opts: { dryRun: boolean },
): Promise<InstallOutcome> {
  if (spec.install.kind !== "shell") {
    return { agent: spec.id, method: "shell", ok: false, detail: `${spec.id} has no shell route` };
  }
  const commands = spec.install.command(repoSlug);
  const rendered = commands.map((argv) => argv.join(" ")).join(" && ");
  if (opts.dryRun) {
    return { agent: spec.id, method: "shell", ok: true, detail: `dry-run: \`${rendered}\`` };
  }
  for (const argv of commands) {
    try {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (exitCode !== 0) {
        const reason = stderr.trim() === "" ? `exited ${exitCode}` : stderr.trim();
        return {
          agent: spec.id,
          method: "shell",
          ok: false,
          detail: `\`${argv.join(" ")}\` failed: ${reason}`,
        };
      }
    } catch (cause) {
      return {
        agent: spec.id,
        method: "shell",
        ok: false,
        detail: `\`${argv.join(" ")}\` failed: ${message(cause)}`,
      };
    }
  }
  const restart = spec.install.restart === null ? "" : ` — restart: \`${spec.install.restart}\``;
  return {
    agent: spec.id,
    method: "shell",
    ok: true,
    detail: `installed via \`${rendered}\`${restart}`,
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
