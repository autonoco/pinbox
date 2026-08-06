// pinbox CLI — export command.
// THE exception to the TTY auto-switch: stdout IS the artifact, so --format alone
// decides what stdout carries. --format md (default) writes raw markdown even when
// piped; --format json writes the envelope-and-Pin[] shape list uses (--json is an
// alias for it). Errors follow the chosen format — human errors stay on stderr so a
// piped .md is never polluted with an envelope. UX spec: transcripts §export.
import { type DetailLevel, pinsToMarkdown } from "@autono/pinbox-core/markdown";
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { CliError } from "../errors.ts";
import { emit, fail } from "../output.ts";
import { parseStatus, usageHint } from "./flags.ts";

export type ExportOptions = { format: string; detail: string; status?: string; json?: boolean };

export function registerExport(program: Command): void {
  program
    .command("export")
    .summary("write pins to stdout as markdown or JSON")
    .description("Write pins to stdout as markdown or JSON.")
    .option("--format <format>", "md or json", "md")
    .option("--detail <level>", "compact, standard, or forensic", "standard")
    .option("--status <status>", "filter: open or resolved (default: all)")
    .option("--json", "same as --format json")
    .action(async (_opts: ExportOptions, cmd: Command) => {
      await runExport(cmd.optsWithGlobals() as ExportOptions);
    });
}

export async function runExport(opts: ExportOptions): Promise<void> {
  const wantsJson = opts.json === true || opts.format === "json";
  try {
    const format = parseFormat(opts);
    const detail = parseDetail(opts.detail);
    const status = parseStatus(opts.status, "export");
    const client = await connectClient();
    const pins = await client.list(status);
    if (format === "json") {
      emit(pins, { json: true }, () => "");
    } else {
      const markdown = pinsToMarkdown(pins, detail);
      if (markdown !== "") console.log(markdown);
    }
  } catch (err) {
    fail(err, {}, wantsJson ? "json" : "human");
  }
}

function parseFormat(opts: ExportOptions): "md" | "json" {
  if (opts.json === true || opts.format === "json") return "json";
  if (opts.format === "md") return "md";
  throw new CliError(
    "E_INVALID_INPUT",
    `invalid --format: "${opts.format}" (expected md or json)`,
    usageHint("export"),
  );
}

function parseDetail(raw: string): DetailLevel {
  if (raw === "compact" || raw === "standard" || raw === "forensic") return raw;
  throw new CliError(
    "E_INVALID_INPUT",
    `invalid --detail: "${raw}" (expected compact, standard, or forensic)`,
    usageHint("export"),
  );
}
