// pinbox CLI — summary command.
// The one-call orientation: counts and the event cursor, so an agent learns the
// whole workspace state without running `list` first. UX spec: transcripts §summary.
import type { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { connectClient, type HubSummary } from "../client.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { statePaths } from "../paths.ts";
import { updateHint } from "../update.ts";

export function registerSummary(program: Command): void {
  program
    .command("summary")
    .summary("counts and the event cursor, in one call")
    .description("Counts and the event cursor, in one call.")
    .option("--json", "machine output")
    .action(async (_opts: OutputFlags, cmd: Command) => {
      await runSummary(cmd.optsWithGlobals() as OutputFlags);
    });
}

export async function runSummary(opts: OutputFlags): Promise<void> {
  try {
    const client = await connectClient();
    emit(await client.summary(), opts, renderSummary);
    // Update messaging on stderr, human TTY mode only; agents and
    // --json consumers never see it (facts stdout, messaging stderr).
    if (!isJsonMode(opts)) printUpdateHint();
  } catch (err) {
    fail(err, opts);
  }
}

function printUpdateHint(): void {
  const hint = updateHint(statePaths(process.cwd()).stateDir, packageJson.version);
  if (hint !== null) console.error(hint);
}

export function renderSummary(data: HubSummary): string {
  return [
    `${"open".padEnd(10)}  ${data.open}`,
    `${"resolved".padEnd(10)}  ${data.resolved}`,
    `${"sessions".padEnd(10)}  ${data.sessions}`, // count of not-ended agent sessions
    `${"last event".padEnd(10)}  #${data.lastEventSeq}`,
  ].join("\n");
}
