// pinbox CLI — resolve command.
// The explicit path (commit trailers are the primary path). Resolve is
// once-only: a second attempt is E_CONFLICT, not a no-op — an agent must notice it
// raced another resolver. JSON `data` is the full updated Pin. UX spec: §resolve.
// `--link github#58` is the PR-shaped path: every open pin carrying that link
// resolves in one call, so a merged PR's pins clear without the reviewer
// hunting each one down (dogfood). JSON `data` is then a Pin[].
import type { Pin } from "@autono/pinbox-core/schema";
import type { Command } from "commander";
import { connectClient, type HubClient } from "../client.ts";
import { CliError } from "../errors.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { parseRole, remapConflict, remapNotFound, usageHint } from "./flags.ts";

export type ResolveOptions = OutputFlags & { as: string; note?: string; link?: string };

export function registerResolve(program: Command): void {
  program
    .command("resolve")
    .summary("mark a pin resolved")
    .description("Mark a pin resolved — one by id, or every open pin linked to a tracker item.")
    .argument("[id]", "pin id (pin_xxxxxxxxxx); omit with --link")
    .option("--link <connector#ref>", "resolve every open pin linked to this item, e.g. github#58")
    .option("--note <text>", "resolution note (e.g. what changed, or why it won't)")
    .option("--as <role>", "resolver: human or agent", "human")
    .option("--json", "machine output")
    .action(async (id: string | undefined, _opts: ResolveOptions, cmd: Command) => {
      await runResolve(id, cmd.optsWithGlobals() as ResolveOptions);
    });
}

export async function runResolve(id: string | undefined, opts: ResolveOptions): Promise<void> {
  if (opts.link !== undefined) {
    if (id !== undefined) {
      fail(
        new CliError(
          "E_INVALID_INPUT",
          "resolve accepts a pin id or --link, not both",
          usageHint("resolve"),
        ),
        opts,
      );
    }
    return runResolveLinked(opts.link, opts);
  }
  if (id === undefined) {
    fail(
      new CliError("E_INVALID_INPUT", "resolve needs a pin id or --link", usageHint("resolve")),
      opts,
    );
  }
  try {
    const by = parseRole(opts.as, "resolve");
    const client = await connectClient();
    const pin = await client.resolve(id, by, opts.note);
    emit(pin, opts, (p) => `${p.id} resolved`);
    if (!isJsonMode(opts) && pin.resolution) {
      const note = pin.resolution.note === undefined ? "" : ` — ${pin.resolution.note}`;
      console.error(`by ${pin.resolution.by}${note}`);
    }
  } catch (err) {
    fail(remapConflict(remapNotFound(err, id), id), opts);
  }
}

/** "github#58" → { connector, ref }; the label `pinbox link` prints, read back. */
function parseLink(raw: string): { connector: string; ref: string } {
  const at = raw.indexOf("#");
  if (at <= 0 || at === raw.length - 1) {
    throw new CliError(
      "E_INVALID_INPUT",
      `invalid --link: "${raw}" (expected connector#ref, e.g. github#58)`,
      usageHint("resolve"),
    );
  }
  return { connector: raw.slice(0, at), ref: raw.slice(at + 1) };
}

async function resolveAll(
  client: HubClient,
  pins: Pin[],
  by: "human" | "agent",
  note: string,
): Promise<Pin[]> {
  const out: Pin[] = [];
  for (const pin of pins) out.push(await client.resolve(pin.id, by, note));
  return out;
}

async function runResolveLinked(raw: string, opts: ResolveOptions): Promise<void> {
  try {
    const by = parseRole(opts.as, "resolve");
    const { connector, ref } = parseLink(raw);
    const client = await connectClient();
    const open = await client.list("open");
    const linked = open.filter((p) =>
      (p.links ?? []).some((l) => l.connector === connector && l.ref === ref),
    );
    const resolved = await resolveAll(client, linked, by, opts.note ?? `shipped in ${raw}`);
    emit(resolved, opts, (pins) => pins.map((p) => `${p.id} resolved`).join("\n"));
    if (!isJsonMode(opts)) console.error(`${resolved.length} pin(s) resolved for ${raw}`);
  } catch (err) {
    fail(err, opts);
  }
}
