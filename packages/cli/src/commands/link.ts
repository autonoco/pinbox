// pinbox CLI — link command.
// pinbox link <id> [connector] — create the remote tracker item through the hub's
// host-injected connector and store the persistent two-way link; the due_at poll
// reconciler mirrors the thread both ways from then on. JSON `data` is the updated
// full Pin (the 201 body). client.ts's shape is pinned, so the
// POST rides getConnection() + a local envelope unwrap; folding link() into HubClient
// is a post-merge cleanup, noted, not done.
import type { Pin } from "@autono/pinbox-core/schema";
import type { Command } from "commander";
import { getConnection } from "../daemon.ts";
import { CliError, type ErrorCode, EXIT_CODES } from "../errors.ts";
import { ghUnusableReason } from "../gh-transport.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { remapNotFound } from "./flags.ts";

export type LinkOptions = OutputFlags;

export function registerLink(program: Command): void {
  program
    .command("link")
    .summary("link a pin to an external tracker")
    .description(
      "Link a pin to an external tracker: creates the remote item and mirrors the thread " +
        "both ways from then on.",
    )
    .argument("<id>", "pin id (pin_xxxxxxxxxx)")
    .argument("[connector]", "tracker connector", "github")
    .option("--json", "machine output")
    .action(async (id: string, connector: string, _opts: LinkOptions, cmd: Command) => {
      await runLink(id, connector, cmd.optsWithGlobals() as LinkOptions);
    });
}

export async function runLink(id: string, connector: string, opts: LinkOptions): Promise<void> {
  try {
    const pin = await postLink(id, connector);
    const link = (pin.links ?? []).filter((l) => l.connector === connector).at(-1);
    const label = link === undefined ? connector : `${link.connector}#${link.ref}`;
    emit(pin, opts, () => (link === undefined ? "" : `${label}  ${link.url}`));
    if (!isJsonMode(opts)) console.error(`linked ${pin.id} to ${label}`);
  } catch (err) {
    fail(remapMissingGh(remapLinkConflict(remapNotFound(err, id), id), connector), opts);
  }
}

/** POST /pins/:id/links with the ~20-line envelope unwrap (HubClient's shape is pinned). */
async function postLink(id: string, connector: string): Promise<Pin> {
  const { baseUrl, token } = await getConnection(process.cwd());
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/pins/${id}/links`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ connector }),
    });
  } catch {
    throw new CliError(
      "E_HUB_UNREACHABLE",
      "cannot reach the hub and could not start one",
      "run `pinbox doctor` to find out why",
    );
  }
  type Envelope =
    | { ok: true; data: Pin }
    | { ok: false; error: { code?: string; message?: string; hint?: string } };
  const envelope = (await res.json().catch(() => null)) as Envelope | null;
  if (envelope?.ok === true) return envelope.data;
  if (envelope?.ok === false) {
    const { code, message, hint } = envelope.error;
    const known = code !== undefined && code in EXIT_CODES;
    throw new CliError(known ? (code as ErrorCode) : "E_INTERNAL", message ?? "hub error", hint);
  }
  throw new CliError("E_INTERNAL", `unexpected hub response (${res.status})`);
}

/** Duplicate (connector, ref): keep the hub's message, add the next command to run. */
function remapLinkConflict(err: unknown, id: string): unknown {
  return err instanceof CliError && err.code === "E_CONFLICT"
    ? new CliError("E_CONFLICT", err.message, `run \`pinbox show ${id}\` to see its links`)
    : err;
}

/**
 * The hub only knows no "github" connector was injected (serve's localConnectors found
 * no gh); the CLI shares the machine, so it can see why and name the actual fix.
 */
function remapMissingGh(err: unknown, connector: string): unknown {
  if (!(err instanceof CliError) || err.code !== "E_CONNECTOR" || connector !== "github") {
    return err;
  }
  // Deliberately NOT keyed on the hub's message. An unusable gh fails two different ways: absent,
  // so serve injects no connector and the hub says "no connector available"; or installed but
  // logged out, so the connector IS injected and the failure is gh's own stderr instead. Matching
  // the first message left the second — which is what any fresh machine and every CI runner looks
  // like — with no hint at all, breaking the rule that every error names a next command.
  // The CLI shares the machine with gh, so it can just ask — and its answer REPLACES the hub's
  // generic "run `pinbox doctor`" hint, which is true but makes the user take an extra step to
  // learn what this process already knows.
  const reason = ghUnusableReason();
  if (reason === null) return err;
  const hint =
    reason === "missing"
      ? "install GitHub CLI (gh) and run `gh auth login`"
      : "run `gh auth login`, then retry — `pinbox doctor` shows the gh status";
  return new CliError("E_CONNECTOR", err.message, hint);
}
