// pinbox CLI — list command.
// One line per pin, space-aligned and greppable; the count line goes to stderr so
// pipes stay clean. JSON `data` is the array of FULL pins — nothing summarized away.
// UX spec: transcripts §list.
// The locus column takes the most specific place a pin names: a browser pin's
// selector, a `pinbox pin --file` pin's source anchor, a `--url` pin's URL. A pin
// that names no place gets EM_DASH — the column stays aligned and never reads
// "undefined" (core schema.ts §"widened in place").
import { pinLocus } from "@autono/pinbox-core/markdown";
import type { Pin } from "@autono/pinbox-core/schema";
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { relativeAge } from "../render.ts";
import { parseStatus } from "./flags.ts";

export type ListOptions = OutputFlags & { status?: string };

export function registerList(program: Command): void {
  program
    .command("list")
    .summary("list pins, newest first")
    .description("List pins, newest first.")
    .option("--status <status>", "filter: open or resolved (default: all)")
    .option("--json", "machine output")
    .action(async (_opts: ListOptions, cmd: Command) => {
      await runList(cmd.optsWithGlobals() as ListOptions);
    });
}

export async function runList(opts: ListOptions): Promise<void> {
  try {
    const status = parseStatus(opts.status, "list");
    const client = await connectClient();
    const pins = await client.list(status);
    emit(pins, opts, renderList);
    if (!isJsonMode(opts)) console.error(countLine(pins));
  } catch (err) {
    fail(err, opts);
  }
}

/** What the locus column shows for a pin that names no place at all. */
const NO_LOCUS = "—";

/** Space-aligned columns: id, status, age, locus, comment. Empty list renders nothing. */
export function renderList(pins: Pin[]): string {
  if (pins.length === 0) return "";
  const rows = pins.map((pin) => ({
    id: pin.id,
    status: pin.status,
    age: relativeAge(pin.createdAt),
    locus: pinLocus(pin) ?? NO_LOCUS,
    text: pin.text,
  }));
  const statusWidth = Math.max(...rows.map((row) => row.status.length));
  // Age floor 7 ("59m ago") keeps single-digit ages from jittering the column.
  const ageWidth = Math.max(7, ...rows.map((row) => row.age.length));
  const locusWidth = Math.max(...rows.map((row) => row.locus.length));
  return rows
    .map(
      (row) =>
        `${row.id}  ${row.status.padEnd(statusWidth)}  ${row.age.padEnd(ageWidth)}  ` +
        `${row.locus.padEnd(locusWidth)}  ${row.text}`,
    )
    .join("\n");
}

/** The stderr count line: "3 pins (2 open, 1 resolved)" · "2 pins (2 open)" · "0 pins". */
export function countLine(pins: Pin[]): string {
  const open = pins.filter((pin) => pin.status === "open").length;
  const resolved = pins.length - open;
  const noun = pins.length === 1 ? "pin" : "pins";
  const parts: string[] = [];
  if (open > 0) parts.push(`${open} open`);
  if (resolved > 0) parts.push(`${resolved} resolved`);
  return parts.length === 0
    ? `${pins.length} ${noun}`
    : `${pins.length} ${noun} (${parts.join(", ")})`;
}
