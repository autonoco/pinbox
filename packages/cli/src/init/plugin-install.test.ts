// Plugin install routes: the Claude @skills-dir copy materializes the embedded assets
// byte-exact with modes (and is idempotent), and the shell route runs the registry's
// documented commands (dry-run renders without spawning).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { AGENTS, type AgentSpec } from "../agents.ts";
import { PLUGIN_FILES } from "./plugin-assets.ts";
import { installClaudeSkillsDir, installViaShell } from "./plugin-install.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-plugin-install-${crypto.randomUUID()}`;

beforeAll(async () => {
  await $`mkdir -p ${tmpRoot}`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("installClaudeSkillsDir", () => {
  test("materializes every PLUGIN_FILES entry byte-exact, bin/pinbox 0755", async () => {
    const target = `${tmpRoot}/proj`;
    const outcome = await installClaudeSkillsDir(target);
    expect(outcome).toMatchObject({ agent: "claude", method: "skills-dir", ok: true });
    expect(outcome.detail).toContain("installed");
    for (const file of PLUGIN_FILES) {
      const dest = Bun.file(`${target}/.claude/skills/pinbox/${file.path}`);
      expect(await dest.text()).toBe(file.contents);
    }
    const binStat = await Bun.file(`${target}/.claude/skills/pinbox/bin/pinbox`).stat();
    expect(binStat.mode & 0o777).toBe(0o755);
  });

  test("second run is unchanged", async () => {
    const target = `${tmpRoot}/proj`;
    const outcome = await installClaudeSkillsDir(target);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("unchanged");
  });
});

describe("installViaShell", () => {
  const codex = AGENTS.find((spec) => spec.id === "codex") as AgentSpec;

  test("dry-run renders the registry commands without spawning anything", async () => {
    const outcome = await installViaShell(codex, "autonoco/pinbox", { dryRun: true });
    expect(outcome).toMatchObject({ agent: "codex", method: "shell", ok: true });
    expect(outcome.detail).toContain("codex plugin marketplace add autonoco/pinbox");
    expect(outcome.detail).toContain("codex plugin add pinbox@pinbox");
  });

  test("a failing command reports ok: false with the command named", async () => {
    const failing: AgentSpec = {
      ...codex,
      install: { kind: "shell", command: () => [["false"]], restart: null },
    };
    const outcome = await installViaShell(failing, "autonoco/pinbox", { dryRun: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("false");
  });

  test("a passing command chain reports ok: true and the restart step", async () => {
    const passing: AgentSpec = {
      ...codex,
      install: { kind: "shell", command: () => [["true"]], restart: "codex restart" },
    };
    const outcome = await installViaShell(passing, "autonoco/pinbox", { dryRun: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("codex restart");
  });
});
