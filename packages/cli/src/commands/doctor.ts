// pinbox CLI — doctor command.
// A capability probe, not a version table: each check DOES the thing the CLI needs and
// reports what happened. `agents` is informational; any other check failing exits 1.
// The JSON envelope stays ok:true when doctor ran — findings live in data, the exit
// code carries the verdict. UX spec: docs/design/cli/v1-transcripts.md §doctor.
import { Database } from "bun:sqlite";
import type { PinInput } from "@autono/pinbox-core/schema";
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { ensureHub, selfCommand } from "../daemon.ts";
import { emit, isJsonMode, type OutputFlags } from "../output.ts";
import { statePaths, withSecretUmask } from "../paths.ts";

/**
 * `name` is machine output, so it is a versioned contract: `sqlite`, `fts5`, `state-dir`,
 * `db-writable`, `hub`, `agents`, `gh`, `delivery`. `e2e/init.test.ts` looks checks up by
 * these strings; the plan pins the check *set*, not the names, so they are pinned here.
 * Rename one only as a deliberate machine-output change.
 */
export type DoctorCheck = { name: string; ok: boolean; detail: string };

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .summary("probe this machine's capabilities")
    .description(
      "Probe this machine's capabilities: storage, state dir, hub spawn, agents on PATH.",
    )
    .option("--json", "machine output")
    .action(async (_opts: { json?: boolean }, cmd: Command) => {
      await runDoctor(cmd.optsWithGlobals() as OutputFlags);
    });
}

async function runDoctor(flags: OutputFlags): Promise<void> {
  const projectDir = process.cwd();
  const checks: DoctorCheck[] = [
    checkSqlite(),
    checkFts5(),
    await checkStateDir(projectDir),
    await checkDbWritable(projectDir),
    await checkHub(projectDir),
    checkAgents(),
    checkGh(),
    await checkPluginDelivery(projectDir),
  ];
  emit({ checks }, flags, renderChecks);
  const failing = checks.filter((check) => !check.ok).length;
  if (!isJsonMode(flags)) {
    // Check lines are stdout (they are the data); the count line is stderr.
    console.error(
      failing === 0
        ? `${checks.length} checks, all ok`
        : `${checks.length} checks, ${failing} failing`,
    );
  }
  if (failing > 0) process.exitCode = 1;
}

export function checkSqlite(): DoctorCheck {
  try {
    const db = new Database(":memory:");
    db.transaction(() => {
      db.exec("CREATE TABLE probe (x TEXT)");
      db.query("INSERT INTO probe (x) VALUES (?1)").run("ok");
    })();
    const row = db.query("SELECT x FROM probe").get() as { x: string } | null;
    db.close();
    return result("sqlite", row?.x === "ok", "created and read a table in :memory:");
  } catch (cause) {
    return { name: "sqlite", ok: false, detail: message(cause) };
  }
}

/** FTS5 gates `pinbox list --search`; bun:sqlite ships it compiled in — prove it. */
export function checkFts5(): DoctorCheck {
  try {
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)");
    db.query("INSERT INTO probe (x) VALUES ('hello world')").run();
    const row = db.query("SELECT x FROM probe WHERE probe MATCH 'hello'").get();
    db.close();
    return result("fts5", row !== null, "MATCH query answered on a virtual table");
  } catch (cause) {
    return { name: "fts5", ok: false, detail: message(cause) };
  }
}

export async function checkStateDir(projectDir: string): Promise<DoctorCheck> {
  const { stateDir } = statePaths(projectDir);
  try {
    const probe = `${stateDir}/.doctor-probe`;
    // Creates the dir 0700 (umask, at create time) when missing — the same way serve does.
    await withSecretUmask(() => Bun.write(probe, "ok", { createPath: true }));
    await Bun.file(probe).unlink();
    const mode = (await Bun.file(stateDir).stat()).mode & 0o777;
    const modeStr = `0${mode.toString(8)}`;
    if ((mode & 0o077) !== 0) {
      return {
        name: "state-dir",
        ok: false,
        detail: `${display(stateDir)} mode ${modeStr}, expected 0700`,
      };
    }
    return {
      name: "state-dir",
      ok: true,
      detail: `${display(stateDir)} writable, mode ${modeStr}`,
    };
  } catch (cause) {
    return { name: "state-dir", ok: false, detail: `${display(stateDir)}: ${message(cause)}` };
  }
}

async function checkDbWritable(projectDir: string): Promise<DoctorCheck> {
  const { dbFile } = statePaths(projectDir);
  const dbDir = dbFile.slice(0, dbFile.lastIndexOf("/"));
  try {
    if (await Bun.file(dbFile).exists()) {
      const db = new Database(dbFile);
      db.query("PRAGMA journal_mode").get();
      db.close();
    } else {
      const probe = `${dbDir}/.doctor-probe`;
      await Bun.write(probe, "ok", { createPath: true });
      await Bun.file(probe).unlink();
    }
    return { name: "db-writable", ok: true, detail: ".pinbox/pinbox.db opens for writing" };
  } catch (cause) {
    return { name: "db-writable", ok: false, detail: `${dbFile}: ${message(cause)}` };
  }
}

async function checkHub(projectDir: string): Promise<DoctorCheck> {
  try {
    const { baseUrl } = await ensureHub(projectDir);
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { data?: { schemaVersion?: number } };
    const schemaVersion = body.data?.schemaVersion;
    if (!res.ok || schemaVersion === undefined) {
      return { name: "hub", ok: false, detail: `unhealthy response from ${baseUrl}/health` };
    }
    return {
      name: "hub",
      ok: true,
      detail: `spawned, healthy at ${baseUrl} (schemaVersion ${schemaVersion})`,
    };
  } catch (cause) {
    return { name: "hub", ok: false, detail: `spawn failed: ${message(cause)}` };
  }
}

/** Informational — always ok; the detail says which agent CLIs are on PATH. */
export function checkAgents(): DoctorCheck {
  const found = ["claude", "codex", "hermes"].filter((name) => Bun.which(name) !== null);
  return {
    name: "agents",
    ok: true,
    detail: found.length > 0 ? `found: ${found.join(", ")}` : "none found",
  };
}

/** How long a `gh` sub-probe may take before the whole doctor run is the thing at risk. */
const GH_PROBE_MS = 5_000;

/**
 * `gh` gates `pinbox link` and nothing else, so every outcome here is informational —
 * it states what this machine can do, it never fails the run. ok:false means the probe
 * itself broke mid-flight, not that gh is missing.
 */
export function checkGh(): DoctorCheck {
  try {
    // Against the CURRENT PATH: Bun.which's default snapshots the startup environment.
    const bin = Bun.which("gh", { PATH: process.env["PATH"] ?? "" });
    if (bin === null) {
      return {
        name: "gh",
        ok: true,
        detail: "not found — `pinbox link` unavailable until gh is installed and authed",
      };
    }
    // `gh auth status` is the only honest auth probe: a stored token can be dead.
    const authed = spawnQuiet([bin, "auth", "status"]) === 0;
    const version = ghVersion(bin);
    return {
      name: "gh",
      ok: true,
      detail: authed
        ? `${version}, authenticated`
        : `${version}, not authenticated — run \`gh auth login\` before \`pinbox link\``,
    };
  } catch (cause) {
    return { name: "gh", ok: false, detail: message(cause) };
  }
}

function spawnQuiet(argv: string[]): number | null {
  return Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore", timeout: GH_PROBE_MS }).exitCode;
}

/** "gh version 2.62.0 (2026-01-01)" → "gh 2.62.0"; anything unparseable → "gh". */
function ghVersion(bin: string): string {
  const out = Bun.spawnSync([bin, "--version"], { timeout: GH_PROBE_MS }).stdout.toString();
  const version = /gh version (\S+)/.exec(out)?.[1];
  return version === undefined ? "gh" : `gh ${version}`;
}

const DELIVERY = "delivery";
/** The probe registers under its own agent name so it never collides with a real session. */
const PROBE_AGENT = "doctor";

/**
 * The plugin check verifies DELIVERY, never file existence: every plugin
 * failure mode — wrong dir, unparsed manifest, hook registered but never fired — looks
 * exactly like a successful install on disk. So the probe walks the real path a pin
 * takes: register a session → post a probe pin bound to it → prove `pinbox session
 * inject` hands that pin back as additionalContext → resolve the probe pin.
 *
 * A `session` hop that exits non-zero or a silent inject is
 * ok:false naming the hop that dropped the pin.
 *
 * No teardown hop: the plan's prose ends "…resolve the probe pin, end the session", but
 * The verb surface is `register|inject|pending` with no `end`, so the probe resolves its
 * pin and leaves the session to expire. Revisit if a teardown verb ever ships.
 */
export async function checkPluginDelivery(
  projectDir: string,
  opts?: { command?: string[] },
): Promise<DoctorCheck> {
  const key = `doctor-probe-${crypto.randomUUID()}`;
  // Under `bun test` Bun.main is the TEST FILE, so the command is a parameter and never
  // an inferred global — the same rule selfCommand() itself documents.
  const command = opts?.command ?? selfCommand();
  try {
    const register = await runSelf(command, ["session", "register"], { projectDir, key });
    if (register.exitCode !== 0) {
      return { name: DELIVERY, ok: false, detail: hopFailed("session register", register) };
    }
    return await deliveryRoundTrip(projectDir, command, key);
  } catch (cause) {
    return { name: DELIVERY, ok: false, detail: message(cause) };
  }
}

async function deliveryRoundTrip(
  projectDir: string,
  command: string[],
  key: string,
): Promise<DoctorCheck> {
  const hub = await connectClient(projectDir);
  const text = probeText(key);
  const pin = await hub.createPin(probeInput(text, key));
  try {
    const inject = await runSelf(command, ["session", "inject", "--json"], { projectDir, key });
    if (inject.exitCode !== 0) {
      return { name: DELIVERY, ok: false, detail: hopFailed("session inject", inject) };
    }
    if (!injectedContext(inject.stdout).includes(text)) {
      return {
        name: DELIVERY,
        ok: false,
        detail: "`pinbox session inject` returned no context carrying the probe pin",
      };
    }
    return {
      name: DELIVERY,
      ok: true,
      detail: `round trip ok — ${pin.id} reached the session through \`session inject\``,
    };
  } finally {
    // A probe pin must never survive its probe, whatever the verdict was.
    await hub.resolve(pin.id, "agent", "doctor delivery probe").catch(() => {});
  }
}

type SelfRun = { exitCode: number; stdout: string; stderr: string };

/**
 * Re-invoke this CLI with the probe session on argv.
 *
 * The probe passes the session key by flag, not by env var. Env vars looked like the
 * safer choice at first — flags were avoided because a
 * commander program with no such options answers `error: unknown option '--key'` and
 * misspelled flag exits 1. But the shipped shape is `--agent <name> --key <key>`: declared options
 * on register/inject/pending, and env is read only to *fingerprint the agent*, never for
 * the key. So the flags are the published channel and the env guess never bound —
 * passing it was the failure this probe reported.
 */
async function runSelf(
  command: string[],
  args: string[],
  ctx: { projectDir: string; key: string },
): Promise<SelfRun> {
  const proc = Bun.spawn([...command, ...args, "--agent", PROBE_AGENT, "--key", ctx.key], {
    // The project decides which hub the verb talks to — the probe pin is posted to that
    // same one, so a probe run from elsewhere would test two unrelated queues.
    cwd: ctx.projectDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function probeText(key: string): string {
  return `pinbox doctor delivery probe ${key}`;
}

/** The smallest pin the schema accepts, tagged to the probe session. */
function probeInput(text: string, key: string): PinInput {
  return {
    text,
    kind: "note",
    target: {
      url: "pinbox://doctor",
      selector: "html",
      tag: "html",
      rect: { x: 0, y: 0, width: 0, height: 0 },
      fixed: false,
    },
    env: {
      viewport: { w: 0, h: 0, dpr: 1 },
      browser: "pinbox doctor",
      os: process.platform,
      colorScheme: "light",
    },
    author: { userId: "pinbox-doctor" },
    agentSession: { agent: PROBE_AGENT, key },
  };
}

/**
 * The two shapes: the `--json` envelope (`data.context`) and, under `--hook`, the agent
 * contract `hookSpecificOutput.additionalContext`. Anything else is the raw text printed.
 */
function injectedContext(stdout: string): string {
  try {
    const body = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: string };
      data?: { additionalContext?: string; context?: string };
    };
    return (
      body.hookSpecificOutput?.additionalContext ??
      body.data?.context ??
      body.data?.additionalContext ??
      stdout
    );
  } catch {
    return stdout;
  }
}

function hopFailed(hop: string, run: SelfRun): string {
  const said = `${run.stderr}${run.stdout}`.trim().split("\n")[0] ?? "";
  return `\`pinbox ${hop}\` exited ${run.exitCode}${said === "" ? "" : `: ${said}`}`;
}

function renderChecks(data: { checks: DoctorCheck[] }): string {
  return data.checks
    .map((check) => `${check.ok ? "ok" : "no"}  ${check.name.padEnd(11)}  ${check.detail}`)
    .join("\n");
}

function result(name: string, ok: boolean, okDetail: string): DoctorCheck {
  return { name, ok, detail: ok ? okDetail : `${name} probe produced the wrong answer` };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function display(path: string): string {
  const home = process.env["HOME"];
  return home !== undefined && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
