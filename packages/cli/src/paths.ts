// pinbox CLI — state paths.
// The split of trust (Task 7): secrets (bearer token, pid) live in the XDG state dir,
// created 0700 with a 0600 hub.json; the repo's .pinbox/ holds only the db and a
// port-only server.json. Secrets never sit in the repo.

import { CliError } from "./errors.ts";

/** Shape of `${stateDir}/hub.json`, written 0600 by `pinbox serve`. */
export type HubState = { pid: number; port: number; token: string; version: string };

export type StatePaths = {
  stateDir: string;
  stateFile: string;
  dbFile: string;
  serverJson: string;
};

/** 12-hex sha256 of the project dir's physical path — one state dir per real project. */
export function projectId(projectDir: string): string {
  return new Bun.CryptoHasher("sha256").update(physicalPath(projectDir)).digest("hex").slice(0, 12);
}

/**
 * User-global state dir for the running installation, keyed by the binary's path:
 * one per install, shared across projects. Passive-update throttle and lock live here,
 * because the update target is `process.execPath`, which is not per-project.
 */
export function installStateDir(execPath: string = process.execPath): string {
  const id = new Bun.CryptoHasher("sha256").update(execPath).digest("hex").slice(0, 12);
  return `${stateHome()}/pinbox/install-${id}`;
}

export function statePaths(projectDir: string): StatePaths {
  const stateDir = `${stateHome()}/pinbox/${projectId(projectDir)}`;
  return {
    stateDir,
    stateFile: `${stateDir}/hub.json`,
    dbFile: `${projectDir}/.pinbox/pinbox.db`,
    serverJson: `${projectDir}/.pinbox/server.json`,
  };
}

/** Parse a hub.json; null on absence, unreadable JSON, or a shape that is not HubState. */
export async function readHubState(stateFile: string): Promise<HubState | null> {
  try {
    const raw: unknown = await Bun.file(stateFile).json();
    return isHubState(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Run `fn` with umask 0o077 so files land 0600 and directories 0700 — mode set at
 * create time, never chmod-after. Bun is single-threaded: no concurrent create can
 * slip inside the window.
 */
export async function withSecretUmask<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}

function isHubState(value: unknown): value is HubState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    typeof record["port"] === "number" &&
    typeof record["token"] === "string" &&
    typeof record["version"] === "string"
  );
}

function stateHome(): string {
  const xdg = process.env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") return xdg;
  const home = process.env["HOME"];
  if (home !== undefined && home !== "") return `${home}/.local/state`;
  throw new CliError(
    "E_INTERNAL",
    "cannot locate the state dir: neither XDG_STATE_HOME nor HOME is set",
  );
}

// Physical (symlink-free) path, so /tmp and /private/tmp map to one project id.
// `pwd -P` via Bun.spawnSync instead of node:fs realpath — Bun APIs plus POSIX only
// (AGENTS.md conventions). On any failure (dir missing, no pwd) the path is used as-is.
function physicalPath(dir: string): string {
  try {
    const result = Bun.spawnSync(["pwd", "-P"], { cwd: dir });
    if (!result.success) return dir;
    const out = result.stdout.toString().trim();
    return out === "" ? dir : out;
  } catch {
    return dir;
  }
}
