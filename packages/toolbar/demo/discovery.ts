// pinbox toolbar demo — the discovery files `pinbox` probes for.
//
// Split out of serve.ts so the adopt contract is testable without starting two servers.
// This is OUR process, so it is Bun-native throughout; the `node:` guest rule stops at
// src/plugins/ and nothing here ships to npm.
//
// The path/hash/permission rules below are packages/cli/src/paths.ts's — MIRRORED rather than
// imported, because the toolbar package does not depend on the CLI (and must not: see the
// boundary rules in CLAUDE.md). Mirroring is the cost of that, so the mirror is asserted in
// discovery.test.ts instead of trusted.

/** The CLI's package.json — the source of truth for the version ensureHub compares against. */
const CLI_PACKAGE_JSON = `${import.meta.dir}/../../cli/package.json`;

/**
 * The version string the demo must publish.
 *
 * ensureHub() adopts an existing hub ONLY when `hub.json`'s version equals the CLI's own
 * package version; anything else is treated as a stale daemon and SIGTERMed. The demo's
 * shutdown handler then exits, so a mismatched string means the first `pinbox …` command kills
 * the hub the browser page is attached to. Read from the CLI's manifest so the two cannot drift.
 */
async function cliVersion(): Promise<string> {
  const pkg = (await Bun.file(CLI_PACKAGE_JSON).json()) as { version?: unknown };
  if (typeof pkg.version !== "string") {
    throw new Error(`demo: no version in ${CLI_PACKAGE_JSON}`);
  }
  return pkg.version;
}

/** 12-hex sha256 of a directory's physical path — the CLI's projectId(), same inputs. */
export function projectId(dir: string): string {
  const probe = Bun.spawnSync(["pwd", "-P"], { cwd: dir });
  const physical = probe.success ? probe.stdout.toString().trim() || dir : dir;
  return new Bun.CryptoHasher("sha256").update(physical).digest("hex").slice(0, 12);
}

export interface DiscoveryFiles {
  /** The directory the CLI will be run from — hashes to the project id. */
  demoDir: string;
  port: number;
  token: string;
  /** The hub process's pid; ensureHub liveness-checks it before signalling. */
  pid: number;
}

/**
 * Write `.pinbox/server.json` (port only, lives in the repo) and the XDG `hub.json` (pid, port,
 * bearer token, version — 0600 via umask at create time, never chmod-after), exactly as
 * `pinbox serve` does, so the CLI's adopt-never-own probe finds this hub.
 */
export async function publishDiscoveryFiles(files: DiscoveryFiles): Promise<void> {
  const { demoDir, port, token, pid } = files;
  await Bun.write(`${demoDir}/.pinbox/server.json`, `${JSON.stringify({ port }, null, 2)}\n`, {
    createPath: true,
  });

  const stateHome = process.env["XDG_STATE_HOME"] || `${process.env["HOME"]}/.local/state`;
  const stateFile = `${stateHome}/pinbox/${projectId(demoDir)}/hub.json`;
  const state = { pid, port, token, version: await cliVersion() };
  const previousUmask = process.umask(0o077);
  try {
    await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  } finally {
    process.umask(previousUmask);
  }
}
