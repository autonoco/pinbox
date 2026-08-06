// pinbox CLI — the agent registry.
// One data table drives everything init and doctor know about coding agents:
// detection (PATH binary + config dir + env fingerprints), the headless entry
// point for Layer-2 spawns, and the per-agent install route (research §2D).

export type AgentId = "claude" | "codex" | "hermes" | "openclaw";

export type InstallRoute =
  // Claude Code: copy the embedded plugin into <target>/.claude/skills/pinbox/ —
  // loads as pinbox@skills-dir; no marketplace, no network (research §3).
  | { kind: "skills-dir" }
  // Shell-out route: each inner array is one argv; `restart` is the instruction
  // init prints after installing (null when the agent needs none).
  | { kind: "shell"; command: (repoSlug: string) => string[][]; restart: string | null };

export type AgentSpec = {
  id: AgentId;
  /** Binary probed with Bun.which. */
  bin: string;
  /** Home-relative config dir whose existence counts as "installed". */
  configDir: string;
  /**
   * Invocation fingerprints (env vars the agent sets in processes it runs).
   * CLAUDECODE is verified against the real agent; the rest are data-driven
   * here — this registry is their single source of truth.
   */
  envMarkers: string[];
  /** Headless one-shot argv, or null when the agent has no Layer-2 spawn. */
  headless: ((prompt: string) => string[]) | null;
  install: InstallRoute;
};

export const AGENTS: readonly AgentSpec[] = [
  {
    id: "claude",
    bin: "claude",
    configDir: "~/.claude",
    envMarkers: ["CLAUDECODE"],
    headless: (prompt) => ["claude", "-p", prompt],
    install: { kind: "skills-dir" },
  },
  {
    id: "codex",
    bin: "codex",
    configDir: "~/.codex",
    envMarkers: ["CODEX_SANDBOX"],
    headless: (prompt) => ["codex", "exec", prompt],
    install: {
      kind: "shell",
      command: (repoSlug) => [
        ["codex", "plugin", "marketplace", "add", repoSlug],
        ["codex", "plugin", "add", "pinbox@pinbox"],
      ],
      restart: null,
    },
  },
  {
    id: "hermes",
    bin: "hermes",
    configDir: "~/.hermes",
    envMarkers: ["HERMES_SESSION"],
    // Verified: -z/--oneshot, composes with --resume SESSION.
    headless: (prompt) => ["hermes", "-z", prompt],
    install: {
      kind: "shell",
      command: (repoSlug) => [
        ["hermes", "plugins", "install", `${repoSlug}/integrations/hermes`, "--enable"],
      ],
      restart: "hermes gateway restart",
    },
  },
  {
    id: "openclaw",
    bin: "openclaw",
    configDir: "~/.openclaw",
    envMarkers: ["OPENCLAW_SESSION_KEY"],
    headless: null, // no Layer-2 spawn — delivery is the gateway plugin or the next-heartbeat push
    install: {
      kind: "shell",
      command: (repoSlug) => [
        ["openclaw", "plugins", "install", "--marketplace", repoSlug, "pinbox-openclaw"],
      ],
      restart: "openclaw gateway restart",
    },
  },
];

export type DetectedAgent = {
  spec: AgentSpec;
  onPath: boolean;
  configDirExists: boolean;
  detected: boolean;
};

/**
 * Probe every registered agent: Bun.which over the (injectable) PATH plus a
 * config-dir stat under the (injectable) home. detected = onPath || configDirExists.
 * Never throws — an unreadable home or empty PATH just reports false.
 */
export function detectAgents(opts?: {
  env?: Record<string, string | undefined>;
  home?: string;
}): DetectedAgent[] {
  const env = opts?.env ?? process.env;
  const home = opts?.home ?? env["HOME"];
  const path = env["PATH"] ?? "";
  return AGENTS.map((spec) => {
    const onPath = path !== "" && Bun.which(spec.bin, { PATH: path }) !== null;
    const configDirExists =
      home !== undefined && home !== "" && dirExists(`${home}/${spec.configDir.slice(2)}`);
    return { spec, onPath, configDirExists, detected: onPath || configDirExists };
  });
}

// POSIX `test -d` via Bun.spawnSync — Bun APIs plus POSIX only (same precedent
// as paths.ts's `pwd -P`); Bun.file().exists() is false for directories.
function dirExists(dir: string): boolean {
  try {
    return Bun.spawnSync(["test", "-d", dir]).exitCode === 0;
  } catch {
    return false;
  }
}
