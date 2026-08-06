import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { AGENTS, detectAgents } from "./agents.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-agents-${crypto.randomUUID()}`;
const homeWithClaude = `${tmpRoot}/home-claude`;
const emptyHome = `${tmpRoot}/home-empty`;
const binDir = `${tmpRoot}/bin`;

beforeAll(async () => {
  await $`mkdir -p ${homeWithClaude}/.claude ${emptyHome} ${binDir}`.quiet();
  await Bun.write(`${binDir}/codex`, "#!/bin/sh\nexit 0\n");
  await $`chmod 755 ${binDir}/codex`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("AGENTS registry", () => {
  test("lists claude, codex, hermes, openclaw — in that order", () => {
    expect(AGENTS.map((spec) => spec.id)).toEqual(["claude", "codex", "hermes", "openclaw"]);
  });

  test("claude installs via the skills-dir copy — no marketplace, no network", () => {
    const claude = AGENTS.find((spec) => spec.id === "claude");
    expect(claude?.install).toEqual({ kind: "skills-dir" });
  });

  test("codex install route runs marketplace add then plugin add, no restart", () => {
    const codex = AGENTS.find((spec) => spec.id === "codex");
    if (codex?.install.kind !== "shell") throw new Error("codex install must be shell");
    expect(codex.install.command("autonoco/pinbox")).toEqual([
      ["codex", "plugin", "marketplace", "add", "autonoco/pinbox"],
      ["codex", "plugin", "add", "pinbox@pinbox"],
    ]);
    expect(codex.install.restart).toBeNull();
  });

  test("hermes install route targets the monorepo subdir and asks for a gateway restart", () => {
    const hermes = AGENTS.find((spec) => spec.id === "hermes");
    if (hermes?.install.kind !== "shell") throw new Error("hermes install must be shell");
    expect(hermes.install.command("autonoco/pinbox")).toEqual([
      ["hermes", "plugins", "install", "autonoco/pinbox/integrations/hermes", "--enable"],
    ]);
    expect(hermes.install.restart).toBe("hermes gateway restart");
  });

  test("openclaw install route uses the marketplace source and asks for a gateway restart", () => {
    const openclaw = AGENTS.find((spec) => spec.id === "openclaw");
    if (openclaw?.install.kind !== "shell") throw new Error("openclaw install must be shell");
    expect(openclaw.install.command("autonoco/pinbox")).toEqual([
      ["openclaw", "plugins", "install", "--marketplace", "autonoco/pinbox", "pinbox-openclaw"],
    ]);
    expect(openclaw.install.restart).toBe("openclaw gateway restart");
  });

  test("headless entry points: claude -p, codex exec, hermes -z; openclaw has none", () => {
    const byId = new Map(AGENTS.map((spec) => [spec.id, spec]));
    expect(byId.get("claude")?.headless?.("fix it")).toEqual(["claude", "-p", "fix it"]);
    expect(byId.get("codex")?.headless?.("fix it")).toEqual(["codex", "exec", "fix it"]);
    expect(byId.get("hermes")?.headless?.("fix it")).toEqual(["hermes", "-z", "fix it"]);
    expect(byId.get("openclaw")?.headless).toBeNull();
  });

  test("claude's env fingerprint is CLAUDECODE (spec table)", () => {
    const claude = AGENTS.find((spec) => spec.id === "claude");
    expect(claude?.envMarkers).toContain("CLAUDECODE");
  });
});

describe("detectAgents", () => {
  test("a ~/.claude dir detects claude without any PATH binary", () => {
    const detected = detectAgents({ env: { PATH: "" }, home: homeWithClaude });
    const claude = detected.find((entry) => entry.spec.id === "claude");
    expect(claude).toEqual({
      spec: AGENTS[0] as (typeof AGENTS)[number],
      onPath: false,
      configDirExists: true,
      detected: true,
    });
  });

  test("a codex binary on an injected PATH detects codex without a config dir", () => {
    const detected = detectAgents({ env: { PATH: binDir }, home: emptyHome });
    const codex = detected.find((entry) => entry.spec.id === "codex");
    expect(codex?.onPath).toBe(true);
    expect(codex?.configDirExists).toBe(false);
    expect(codex?.detected).toBe(true);
  });

  test("nothing on PATH, empty home: every agent is detected: false — and it never throws", () => {
    const detected = detectAgents({ env: { PATH: "" }, home: emptyHome });
    expect(detected).toHaveLength(AGENTS.length);
    for (const entry of detected) {
      expect(entry.detected).toBe(false);
      expect(entry.onPath).toBe(false);
      expect(entry.configDirExists).toBe(false);
    }
  });

  test("a nonexistent home dir never throws", () => {
    const detected = detectAgents({ env: { PATH: "" }, home: `${tmpRoot}/does-not-exist` });
    for (const entry of detected) expect(entry.configDirExists).toBe(false);
  });
});
