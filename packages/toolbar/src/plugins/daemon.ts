// @autono/pinbox-toolbar — hub discovery + daemon adoption for the dev plugins
// Exports HubStatus, readServerPort(), readHubToken(), probeHub(), ensureHub().
//
// PORTABILITY — `node:` imports are CORRECT HERE. Do not "fix" them to Bun APIs.
//
// This is not a Node concession, and it is not about how many people have Bun installed.
// Vite's bin carries `#!/usr/bin/env node`, and Bun honors shebangs — so Bun hands Vite to
// Node on the two invocations people actually type. Measured on a Bun-first machine
// (bun 1.3.14), a plugin's `configResolved` hook reported:
//
//   bunx vite build                        -> NODE 24.18.0
//   bun run dev        (script: "vite")    -> NODE 24.18.0
//   bun --bun run dev                      -> BUN 1.3.14
//   bun run dev + bunfig [run] bun = true  -> BUN 1.3.14
//
// So even with Bun everywhere, this module runs under Node unless each consumer opts in
// per-project. `Bun.file`/`Bun.spawn` here would throw "Bun is not defined" on rows 1 and 2.
// `node:fs`/`node:path`/`node:child_process` are implemented fully by Bun, so they work in
// all four. Everything else uses web-standard globals (`fetch`, `AbortSignal.timeout`).
//
// The repo rule this follows: Bun APIs in processes WE launch (cli, core, daemon, hub, tests,
// builds); the Node/Bun shared subset only where we are a guest in someone else's runtime.
// That is exactly two places repo-wide — here, and the generated npm launcher shim.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedPinboxOptions } from "./options";

/** Result of ensuring a hub is reachable. `adopted` is true when it was ALREADY running. */
export interface HubStatus {
  url: string;
  adopted: boolean;
}

const DEFAULT_PROBE_TIMEOUT_MS = 750;
const SPAWN_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

function warn(message: string): void {
  console.warn(`[pinbox] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hubUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Read the port the hub daemon advertises in `<projectRoot>/.pinbox/server.json`.
 *
 * That file holds the PORT ONLY — `{ "port": number }`. The auth token and pid live in the XDG
 * state dir at 0600 and are deliberately never written into the repo, so there is nothing secret
 * to read here. Returns undefined when the file is missing, unreadable, or malformed.
 */
export function readServerPort(projectRoot: string): number | undefined {
  try {
    const raw = readFileSync(join(projectRoot, ".pinbox", "server.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const port = (parsed as Record<string, unknown>)["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return undefined;
    }
    return port;
  } catch {
    return undefined;
  }
}

/**
 * Read the hub bearer token from the XDG state dir — the secret half `readServerPort` skips.
 *
 * XDG PARITY with packages/cli/src/paths.ts, which computes the state dir as
 * `${XDG_STATE_HOME ?? ~/.local/state}/pinbox/<sha256(physical project path).slice(0, 12)>`.
 * The CLI hashes with Bun.CryptoHasher over `pwd -P`; this guest-rule file must reach the same
 * 12-hex id via the node: shared subset — `node:crypto` createHash over `realpathSync`.
 * daemon.test.ts asserts the parity by building its fixture the CLI way.
 *
 * Returns undefined on ANY failure (no env, no file, garbled JSON, non-string token) — a missing
 * token degrades the toolbar, it must never break the consumer's dev server.
 */
export function readHubToken(projectRoot: string): string | undefined {
  try {
    let physical: string;
    try {
      physical = realpathSync(projectRoot);
    } catch {
      physical = projectRoot; // paths.ts uses the path as-is when it cannot be resolved
    }
    const id = createHash("sha256").update(physical).digest("hex").slice(0, 12);
    const xdg = process.env["XDG_STATE_HOME"];
    const home = process.env["HOME"];
    const stateHome =
      xdg !== undefined && xdg !== ""
        ? xdg
        : home !== undefined && home !== ""
          ? join(home, ".local", "state")
          : undefined;
    if (stateHome === undefined) return undefined;
    const raw = readFileSync(join(stateHome, "pinbox", id, "hub.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const token = (parsed as Record<string, unknown>)["token"];
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** `GET <url>/health`. Resolves false on any error, non-2xx, or timeout. Never throws. */
export async function probeHub(
  url: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Explicit hub wins; otherwise re-read the port file (the daemon may have just written it). */
function currentHubUrl(options: ResolvedPinboxOptions): string | undefined {
  if (options.hub !== undefined) return options.hub;
  const port = readServerPort(options.projectRoot);
  return port === undefined ? undefined : hubUrlForPort(port);
}

/**
 * Spawn `pinbox serve` DETACHED, unref'd, with stdio ignored, so it outlives this dev server.
 *
 * The daemon is ADOPTED, never OWNED: no teardown is registered anywhere in this module. Editing
 * `vite.config.ts` restarts the dev server in-process, and the OLD server's close handlers fire
 * AFTER the new `configureServer` — any teardown we registered would kill the hub we just
 * started. Deduping is done purely by the out-of-process health probe; the daemon owns its own
 * idle-exit lifecycle.
 */
function spawnDaemon(projectRoot: string): boolean {
  try {
    const child = spawn("pinbox", ["serve"], {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
    });
    // Without a listener an async spawn failure (e.g. `pinbox` not on PATH) is an unhandled
    // 'error' event, which would crash the consumer's dev server. Swallow it; the poll below
    // reports the failure through the normal return path.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a hub URL, adopting a running daemon when possible and spawning one otherwise.
 *
 * Never throws and never registers teardown: a dead hub degrades the toolbar, it must never break
 * the consumer's dev server. On failure it logs one concise warning and returns undefined.
 */
export async function ensureHub(options: ResolvedPinboxOptions): Promise<HubStatus | undefined> {
  if (options.disabled) return undefined;

  try {
    const existing = currentHubUrl(options);
    if (existing !== undefined && (await probeHub(existing))) {
      return { url: existing, adopted: true };
    }

    if (!options.spawnDaemon) {
      warn("no running hub found and spawnDaemon is disabled — toolbar not injected.");
      return undefined;
    }

    if (!spawnDaemon(options.projectRoot)) {
      warn("could not start `pinbox serve` — toolbar not injected.");
      return undefined;
    }

    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const url = currentHubUrl(options);
      if (url !== undefined && (await probeHub(url))) {
        return { url, adopted: false };
      }
    }

    warn(`hub did not become healthy within ${SPAWN_WAIT_MS / 1000}s — toolbar not injected.`);
    return undefined;
  } catch {
    warn("hub discovery failed — toolbar not injected.");
    return undefined;
  }
}
