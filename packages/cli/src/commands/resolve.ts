// pinbox CLI — resolve command.
// The explicit path (commit trailers are the primary path). Resolve is
// once-only: a second attempt is E_CONFLICT, not a no-op — an agent must notice it
// raced another resolver. JSON `data` is the full updated Pin. UX spec: §resolve.
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { parseRole, remapConflict, remapNotFound } from "./flags.ts";

export type ResolveOptions = OutputFlags & { as: string; note?: string };

export function registerResolve(program: Command): void {
  program
    .command("resolve")
    .summary("mark a pin resolved")
    .description("Mark a pin resolved.")
    .argument("<id>", "pin id (pin_xxxxxxxxxx)")
    .option("--note <text>", "resolution note (e.g. what changed, or why it won't)")
    .option("--as <role>", "resolver: human or agent", "human")
    .option("--json", "machine output")
    .action(async (id: string, _opts: ResolveOptions, cmd: Command) => {
      await runResolve(id, cmd.optsWithGlobals() as ResolveOptions);
    });
}

export async function runResolve(id: string, opts: ResolveOptions): Promise<void> {
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
