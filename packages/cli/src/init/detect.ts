// pinbox CLI — environment detection for init.
// Two questions, both pure probes: who is running init (human vs agent — the
// spec's most-explicit-wins matrix), and what does the project look like
// (git / package manager / framework — feeds the Layer-2 integration brief).

import { AGENTS } from "../agents.ts";

export type InvocationMode = "human" | "agent";

/**
 * Spec §Human vs agent invocation, most-explicit wins:
 * explicit flags > env fingerprints (CLAUDECODE etc., CI) > TTY.
 * Non-TTY is never "human" — prompting into a pipe hangs the caller.
 */
export function invocationMode(opts: {
  flags: { agentMode?: boolean; noInput?: boolean; yes?: boolean };
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}): InvocationMode {
  const { flags } = opts;
  if (flags.agentMode === true || flags.noInput === true || flags.yes === true) return "agent";
  const env = opts.env ?? process.env;
  const markers = [...AGENTS.flatMap((spec) => spec.envMarkers), "CI"];
  if (markers.some((name) => isSet(env[name]))) return "agent";
  const isTTY = opts.isTTY ?? process.stdin.isTTY === true;
  return isTTY ? "human" : "agent";
}

const LOCKFILES: readonly [string, "bun" | "pnpm" | "yarn" | "npm"][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const FRAMEWORK_CONFIGS: readonly [string, "vite" | "next"][] = [
  ["vite.config.ts", "vite"],
  ["vite.config.js", "vite"],
  ["vite.config.mts", "vite"],
  ["vite.config.mjs", "vite"],
  ["next.config.js", "next"],
  ["next.config.ts", "next"],
  ["next.config.mjs", "next"],
  ["next.config.mts", "next"],
];

/** One top-level directory listing answers every probe; never throws. */
export function detectRepo(projectDir: string): {
  git: boolean;
  packageManager: "bun" | "pnpm" | "yarn" | "npm" | null;
  framework: "vite" | "next" | null;
} {
  const entries = topLevelEntries(projectDir);
  return {
    // `.git` may be a dir (normal checkout) or a file (worktree) — both count.
    git: entries.has(".git"),
    packageManager: LOCKFILES.find(([file]) => entries.has(file))?.[1] ?? null,
    framework: FRAMEWORK_CONFIGS.find(([file]) => entries.has(file))?.[1] ?? null,
  };
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function topLevelEntries(dir: string): Set<string> {
  try {
    return new Set(new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false, dot: true }));
  } catch {
    return new Set(); // dir missing or unreadable — every probe answers "no"
  }
}
