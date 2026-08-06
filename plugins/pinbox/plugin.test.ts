// Structural gate for the Claude Code + Codex plugin artifact. Every shape asserted
// below was read off the installed CLIs, not inferred — do not "simplify" an
// assertion without re-verifying against a real install.
//
// The facts this suite pins:
// - Both agents read ONE marketplace file. `.claude-plugin/marketplace.json` is the
//   canonical path; `.agents/plugins/marketplace.json` is Codex's current standard
//   path. They must stay byte-identical, so a single edit cannot desync them.
// - Codex hard-errors at install when a plugin manifest's `name` differs from the
//   marketplace entry's `name`. Both manifests and both marketplace files therefore
//   assert the same literal "pinbox".
// - Codex resolves every component path relative to the plugin root, so each must be
//   `./`-prefixed and must not escape via `..`.
//
// Runs under root `bun test`. Live `claude plugin validate` gate is skipped when the
// CLI is absent (no --strict: foreign keys warn by design).
import { describe, expect, test } from "bun:test";
import { $ } from "bun";

const pluginDir = import.meta.dir;
const repoRoot = new URL("../..", `file://${pluginDir}/`).pathname.replace(/\/$/, "");

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  (await Bun.file(path).json()) as Record<string, unknown>;

// The three hook payload basenames both manifests reference. Renaming one here
// without renaming the file breaks installs silently.
const PINNED_HOOK_SCRIPTS = ["session-start.sh", "inject.sh", "stop.sh"];
// The literal shell idiom the generated hooks.json must contain. `${…}` is inert in a plain
// string, which is the point — the rule guards against an accidental template, not this.
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal shell source
const DUAL_ROOT = "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}";

describe("plugin manifests", () => {
  test("claude manifest parses and name is the public contract", async () => {
    const manifest = await readJson(`${pluginDir}/.claude-plugin/plugin.json`);
    expect(manifest["name"]).toBe("pinbox");
    expect(typeof manifest["version"]).toBe("string");
    expect(typeof manifest["description"]).toBe("string");
  });

  test("codex manifest paths are ./-confined and every referenced path exists", async () => {
    const manifest = await readJson(`${pluginDir}/.codex-plugin/plugin.json`);
    expect(manifest["name"]).toBe("pinbox");
    const iface = manifest["interface"] as Record<string, unknown>;
    expect(iface["displayName"]).toBe("Pinbox");
    const componentPaths = [
      manifest["skills"],
      manifest["hooks"],
      manifest["mcpServers"],
      iface["logo"],
    ] as string[];
    for (const p of componentPaths) {
      expect(typeof p).toBe("string");
      expect(p.startsWith("./")).toBe(true);
      expect(p.includes("..")).toBe(false);
      const target = `${pluginDir}/${p.slice(2)}`;
      const exists = (await $`test -e ${target}`.nothrow().quiet()).exitCode === 0;
      expect(exists).toBe(true);
    }
  });
});

describe("marketplace files", () => {
  const claudePath = `${repoRoot}/.claude-plugin/marketplace.json`;
  const agentsPath = `${repoRoot}/.agents/plugins/marketplace.json`;

  test("both files are byte-identical (Codex current standard + legacy/Claude path)", async () => {
    const a = await Bun.file(claudePath).text();
    const b = await Bun.file(agentsPath).text();
    expect(a).toBe(b);
  });

  test("required keys present and manifest name equals the marketplace entry name", async () => {
    const manifest = await readJson(`${pluginDir}/.claude-plugin/plugin.json`);
    const codexManifest = await readJson(`${pluginDir}/.codex-plugin/plugin.json`);
    for (const path of [claudePath, agentsPath]) {
      const market = await readJson(path);
      expect(typeof market["name"]).toBe("string");
      expect(typeof (market["owner"] as Record<string, unknown>)["name"]).toBe("string");
      const plugins = market["plugins"] as Record<string, unknown>[];
      expect(plugins.length).toBeGreaterThan(0);
      for (const entry of plugins) {
        expect(typeof entry["name"]).toBe("string");
        expect(entry["source"]).toBeDefined();
      }
      // Codex hard-errors at install when plugin.json name ≠ marketplace entry name.
      const entry = plugins.find((p) => p["name"] === "pinbox");
      expect(entry).toBeDefined();
      expect(manifest["name"]).toBe(entry?.["name"] as string);
      expect(codexManifest["name"]).toBe(entry?.["name"] as string);
    }
  });
});

describe("hooks.json", () => {
  test("every command uses the dual-root idiom and a §8 pinned script basename", async () => {
    const doc = await readJson(`${pluginDir}/hooks/hooks.json`);
    const events = doc["hooks"] as Record<string, { hooks: { type: string; command: string }[] }[]>;
    const eventNames = Object.keys(events);
    expect(eventNames.sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    const commands = Object.values(events).flatMap((matchers) =>
      matchers.flatMap((matcher) => matcher.hooks.map((h) => h.command)),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(DUAL_ROOT);
      const basename = command.split("/hooks/")[1]?.replace(/"$/, "");
      expect(PINNED_HOOK_SCRIPTS).toContain(basename ?? "");
    }
  });
});

describe("bin shim and mcp manifest", () => {
  test("bin/pinbox is executable in git and starts #!/bin/sh", async () => {
    const staged = (await $`git ls-files -s plugins/pinbox/bin/pinbox`.cwd(repoRoot).text()).trim();
    expect(staged.startsWith("100755 ")).toBe(true);
    const text = await Bun.file(`${pluginDir}/bin/pinbox`).text();
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test(".mcp.json parses and names the pinbox server", async () => {
    const doc = await readJson(`${pluginDir}/.mcp.json`);
    const servers = doc["mcpServers"] as Record<string, unknown>;
    expect(servers["pinbox"]).toBeDefined();
  });
});

describe("live CLI gate", () => {
  test.skipIf(!Bun.which("claude"))("claude plugin validate exits 0", async () => {
    const result = await $`claude plugin validate ./plugins/pinbox`.cwd(repoRoot).nothrow().quiet();
    expect(result.exitCode).toBe(0);
  });
});
