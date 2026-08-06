// pinbox CLI — hidden serve command.
// Runs the hub in the foreground; users never type it — the daemon lifecycle
// (daemon.ts) spawns it detached. Token generation, store open, state files (0600),
// idle exit, and cleanup all live here.
import { drainConnectorPolls, POLL_OPEN_MS } from "@autono/pinbox-core/connectors";
import {
  createHooksAdapter,
  type DeliveryAdapter,
  DeliveryRouter,
} from "@autono/pinbox-core/delivery";
// Bun-only adapters (Bun.spawn / Bun.which): the CLI serve path is their ONLY importer
// router.ts never statically imports them, keeping ./delivery Workers-safe.
import { createOpenclawAdapter } from "@autono/pinbox-core/delivery/openclaw";
import { createResumeAdapter } from "@autono/pinbox-core/delivery/resume";
import { createWebhookAdapter, type WebhookConfig } from "@autono/pinbox-core/delivery/webhook";
import {
  gitEnv,
  localDirSink,
  registerAttachmentSink,
  startHubServer,
} from "@autono/pinbox-core/hub-server";
import { openStore } from "@autono/pinbox-core/store";
import { $ } from "bun";
import type { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { localConnectors } from "../gh-transport.ts";
import {
  type HubState,
  projectId,
  readHubState,
  type StatePaths,
  statePaths,
  withSecretUmask,
} from "../paths.ts";
import { scheduleUpdateCheck } from "../update.ts";

const DEFAULT_IDLE_MS = 1_800_000;
const DRAIN_INTERVAL_MS = 15_000;

export function registerServe(program: Command): void {
  program
    .command("serve", { hidden: true })
    .description(
      "Run the hub in the foreground. You normally never run this: every pinbox command " +
        "starts the hub on demand and it exits when idle. Useful for debugging the daemon.",
    )
    .option("--project <dir>", "project directory to serve (default: cwd)")
    .addHelpText(
      "after",
      "\nEnvironment:\n" +
        "  PINBOX_IDLE_MS   idle shutdown in milliseconds (default: 1800000)\n\n" +
        "The hub binds 127.0.0.1 on an ephemeral port. The port is written to\n" +
        ".pinbox/server.json; the pid and bearer token live in the XDG state dir (0600).\n" +
        "Secrets never sit in the repo.",
    )
    .action(async (opts: { project?: string }) => {
      await runServe(opts);
    });
}

/** Start the hub, publish its state files, and stay in the foreground until idle exit. */
async function runServe(opts: { project?: string }): Promise<void> {
  const projectDir = absolutize(opts.project ?? process.cwd());
  const paths = statePaths(projectDir);
  const token = newToken();

  await $`mkdir -p ${`${projectDir}/.pinbox`}`.quiet();
  const store = openStore(paths.dbFile);

  // Delivery boot — the ONE dispatch call site. The WS host swap comes after this.
  // getPin: thread.message events carry only pinId — without the lookup, reply
  // deliveries fail retryable instead of shipping (delivery/payload.ts).
  const getPin = (id: string) => store.getPin(id);
  const adapters: DeliveryAdapter[] = [
    createHooksAdapter(),
    createOpenclawAdapter({ getPin }),
    createResumeAdapter({ getPin }),
  ];
  const webhook = webhookConfigFromEnv(); // PINBOX_WEBHOOK_URL + PINBOX_WEBHOOK_SECRET, both or neither
  if (webhook) adapters.push(createWebhookAdapter(webhook));
  const router = new DeliveryRouter({ store, adapters });
  const unsubscribe = store.subscribe((e) => void router.dispatch(e));
  await router.drainDue(); // boot reconciliation: replay events missed while no daemon ran
  const drainTimer = setInterval(() => void router.drainDue(), DRAIN_INTERVAL_MS);
  drainTimer.unref(); // the drain loop must never keep an idle daemon alive
  // Idle-exit can strand a pending retry: that is fine — the next CLI call respawns the
  // daemon and boot drainDue() picks it up. The queue, not the process, is durable.

  // Boot order: realtime WS host + the local attachment sink.
  registerAttachmentSink(store, localDirSink(`${projectDir}/.pinbox/media`));

  // Connectors — host-injected transport (gh CLI); inbound+outbound mirroring reconciles
  // on pins.due_at. Poll cadence is coarse; drainConnectorPolls also runs once at boot.
  const connectors = localConnectors(projectDir);
  void drainConnectorPolls(store, connectors);
  const connectorTimer = setInterval(
    () => void drainConnectorPolls(store, connectors),
    POLL_OPEN_MS,
  );
  connectorTimer.unref();

  const server = await startHubServer({
    store,
    token,
    connectors,
    enrichEnv: () => gitEnv(projectDir),
    idleMs: idleMsFromEnv(),
    realtime: { projectId: projectId(projectDir) },
  });

  await writeStateFiles(paths, server.port, token);
  void scheduleUpdateCheck(paths); // passive, fire-and-forget, throttled
  installShutdownHooks(paths, async () => {
    clearInterval(drainTimer);
    clearInterval(connectorTimer);
    unsubscribe();
    await server.close();
    store.close();
  });
  // Nothing else to do: the Bun.serve handle keeps the process alive until the idle
  // timer stops it (then beforeExit cleans up and the loop drains to exit 0) or a
  // signal lands.
}

/** 24 random bytes, base64url — the bearer token every route except /health requires. */
function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

async function writeStateFiles(paths: StatePaths, port: number, token: string): Promise<void> {
  const state: HubState = { pid: process.pid, port, token, version: packageJson.version };
  const tmp = `${paths.stateFile}.tmp-${process.pid}`;
  // 0600 file / 0700 dirs at create time via umask — never chmod-after; the tmp+rename
  // pair keeps ensureHub's poll from ever reading a half-written hub.json.
  await withSecretUmask(async () => {
    await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
  });
  await $`mv ${tmp} ${paths.stateFile}`.quiet();
  // Port ONLY — the project-side discovery file carries no secret.
  await Bun.write(paths.serverJson, `${JSON.stringify({ port }, null, 2)}\n`);
}

function installShutdownHooks(paths: StatePaths, stop: () => Promise<void>): void {
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // Delete only our own files: a replacement daemon may have overwritten them already.
    const state = await readHubState(paths.stateFile);
    if (state?.pid === process.pid) {
      await Bun.file(paths.stateFile)
        .unlink()
        .catch(() => {});
      await Bun.file(paths.serverJson)
        .unlink()
        .catch(() => {});
    }
  };
  const onSignal = async (): Promise<void> => {
    await stop();
    await cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", () => void onSignal());
  process.on("SIGINT", () => void onSignal());
  // Idle exit path: hub-server stops itself, the loop drains, and this runs before the
  // process exits 0 on its own. The async work re-arms the loop; the flag ends it.
  process.on("beforeExit", () => void cleanup());
}

/**
 * Optional webhook adapter config: PINBOX_WEBHOOK_URL + PINBOX_WEBHOOK_SECRET, both or
 * neither — a lone half is treated as unset (never sign with an empty secret, never
 * POST to an empty URL).
 */
function webhookConfigFromEnv(): WebhookConfig | null {
  const url = process.env["PINBOX_WEBHOOK_URL"];
  const secret = process.env["PINBOX_WEBHOOK_SECRET"];
  if (url === undefined || url === "" || secret === undefined || secret === "") return null;
  return { url, secret };
}

function idleMsFromEnv(): number {
  const raw = process.env["PINBOX_IDLE_MS"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MS;
}

function absolutize(path: string): string {
  return path.startsWith("/") ? path : `${process.cwd()}/${path}`;
}
