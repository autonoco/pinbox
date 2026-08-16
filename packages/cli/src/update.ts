// pinbox CLI — update check + passive apply (buttons-shaped).
// A TTY command (not `update`, not CI) may replace the compiled binary so the next
// run is current. The daemon still only records latest — its stdio is /dev/null.
import type { StatePaths } from "./paths.ts";
import { applyBinaryUpdate } from "./update-apply.ts";

export type UpdateChannel = "binary" | "npm";

const THROTTLE_MS = 6 * 3_600_000;
const TIMEOUT_MS = 3_000;
const RELEASES_URL = "https://github.com/autonoco/pinbox/releases";

type UpdateState = { latest: string; checkedAt: string; channel: UpdateChannel };

/** Check the channel we were installed from — compiled binaries update via GitHub Releases, everything else via npm. Same `/$bunfs/` probe as daemon.ts selfCommand. */
export function detectChannel(entry: string = Bun.main): UpdateChannel {
  return entry.startsWith("/$bunfs/") ? "binary" : "npm";
}

/**
 * Passive latest-version check. No-op when PINBOX_NO_UPDATE or CI is set, or when
 * update.json is fresher than 6h. Hard 3s cap; ANY failure is a silent no-op —
 * an update check must never take the daemon down or delay it.
 */
export async function scheduleUpdateCheck(
  paths: StatePaths,
  deps?: { fetchImpl?: typeof fetch; now?: () => number },
): Promise<void> {
  if (isSet("PINBOX_NO_UPDATE") || isSet("CI")) return;
  const now = deps?.now ?? Date.now;
  const file = updateFile(paths.stateDir);
  try {
    const previous = readState(file);
    if (previous !== null && now() - Date.parse(previous.checkedAt) <= THROTTLE_MS) return;
    const channel = detectChannel();
    // Race a plain timer as well as passing the signal: the cap must hold even for a
    // fetch implementation that ignores AbortSignal.
    const latest = await Promise.race([
      fetchLatestVersion(channel, deps?.fetchImpl ?? fetch),
      Bun.sleep(TIMEOUT_MS).then(() => null),
    ]);
    if (latest === null) return;
    const state: UpdateState = { latest, checkedAt: new Date(now()).toISOString(), channel };
    await Bun.write(file, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  } catch {
    // Silent by contract: offline, rate-limited, bad JSON — all mean "no hint today".
  }
}

/** One stderr line when a newer version is known; null when current, unknown, or unreadable. */
export function updateHint(stateDir: string, currentVersion: string): string | null {
  const state = readState(updateFile(stateDir));
  if (state === null) return null;
  try {
    if (Bun.semver.order(state.latest, currentVersion) !== 1) return null;
  } catch {
    return null;
  }
  return `pinbox ${state.latest} is available (installed ${currentVersion}) — see ${RELEASES_URL}`;
}

function updateFile(stateDir: string): string {
  return `${stateDir}/update.json`;
}

// Synchronous read without node:fs — same Bun.spawnSync + POSIX pattern as
// paths.ts's physicalPath (Bun APIs plus POSIX only, AGENTS.md conventions).
function readState(file: string): UpdateState | null {
  try {
    const result = Bun.spawnSync(["cat", file]);
    if (!result.success) return null;
    const raw: unknown = JSON.parse(result.stdout.toString());
    return isUpdateState(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isUpdateState(value: unknown): value is UpdateState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["latest"] === "string" &&
    typeof record["checkedAt"] === "string" &&
    (record["channel"] === "binary" || record["channel"] === "npm")
  );
}

export async function fetchLatestVersion(
  channel: UpdateChannel,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url =
    channel === "binary"
      ? "https://api.github.com/repos/autonoco/pinbox/releases/latest"
      : "https://registry.npmjs.org/-/package/@autono/pinbox/dist-tags";
  const res = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as Record<string, unknown>;
  const raw = channel === "binary" ? data["tag_name"] : data["latest"];
  if (typeof raw !== "string" || raw === "") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
}

function isSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== "";
}

/** TTY command: if a newer compiled binary exists, replace this one. Failures are silent. */
export async function maybePassiveUpdate(opts: {
  current: string;
  paths: StatePaths;
  argv: string[];
  tty: boolean;
  channel?: UpdateChannel;
  dest?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  apply?: typeof applyBinaryUpdate;
}): Promise<void> {
  if (isSet("PINBOX_NO_UPDATE") || isSet("CI") || !opts.tty) return;
  if (opts.argv.includes("update")) return;
  if ((opts.channel ?? detectChannel()) !== "binary") return;
  const now = opts.now ?? Date.now;
  const file = updateFile(opts.paths.stateDir);
  try {
    const previous = readState(file);
    if (previous !== null && now() - Date.parse(previous.checkedAt) <= THROTTLE_MS) return;
    const latest = await fetchLatestVersion("binary", opts.fetchImpl ?? fetch);
    if (latest === null) return;
    const state: UpdateState = {
      latest,
      checkedAt: new Date(now()).toISOString(),
      channel: "binary",
    };
    await Bun.write(file, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
    if (Bun.semver.order(latest, opts.current) !== 1) return;
    const apply = opts.apply ?? applyBinaryUpdate;
    await apply({
      current: opts.current,
      latest,
      dest: opts.dest ?? process.execPath,
      fetchImpl: opts.fetchImpl,
    });
  } catch {
    // Same contract as scheduleUpdateCheck: never fail the command the user typed.
  }
}
