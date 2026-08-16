// pinbox CLI entry — commander program, global --json flag, subcommand registration.
// Subcommands land in Tasks 7–8; `serve` registers hidden. The built entry gets its
// `#!/usr/bin/env bun` shebang from the tsdown banner (Task 9).
// UX spec: docs/design/cli/v1-transcripts.md — help text is contract.

import { Command, CommanderError } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { registerDoctor } from "./commands/doctor.ts";
import { registerExport } from "./commands/export.ts";
import { registerInit } from "./commands/init.ts";
import { registerLink } from "./commands/link.ts";
import { registerList } from "./commands/list.ts";
import { registerPin } from "./commands/pin.ts";
import { registerReply } from "./commands/reply.ts";
import { registerResolve } from "./commands/resolve.ts";
import { registerServe } from "./commands/serve.ts";
import { registerSession } from "./commands/session.ts";
import { registerShow } from "./commands/show.ts";
import { registerSummary } from "./commands/summary.ts";
import { registerUpdate } from "./commands/update.ts";
import { CliError } from "./errors.ts";
import { fail } from "./output.ts";
import { installStateDir } from "./paths.ts";
import { maybePassiveUpdate } from "./update.ts";

export function buildProgram(): Command {
  const program = new Command("pinbox");
  program
    .description(
      "CLI-first feedback loop: pins dropped on a live app, fixed and resolved by agents.",
    )
    .version(packageJson.version)
    .option("--json", 'machine output: {"ok":true,"data":…} envelope')
    .exitOverride()
    // Deterministic help rendering at house width regardless of terminal size —
    // the transcripts (docs/design/cli/v1-transcripts.md) show unwrapped lines.
    // subcommandTerm: every verb carries --json, so it alone does not make a verb
    // "[options]"-worthy in the command list (transcripts show `doctor`, not
    // `doctor [options]`; `list [options]` earns its marker from --status).
    .configureHelp({ helpWidth: 100, subcommandTerm })
    // Commander's own stderr writes are suppressed: invocation errors are reported
    // through the output contract (fail → message + hint, mapped exit code) instead.
    .configureOutput({ writeErr: () => {} });
  // Help order is pinned: init first, link between resolve/export; serve stays hidden.
  registerInit(program);
  // `pin` leads the working verbs: it creates the thing every other verb reads.
  // Slotted after init so no existing verb's position changes.
  registerPin(program);
  registerSummary(program);
  registerList(program);
  registerShow(program);
  registerReply(program);
  registerResolve(program);
  registerLink(program);
  registerExport(program);
  registerDoctor(program);
  registerUpdate(program);
  registerSession(program); // hidden plumbing (slot: after doctor, before serve)
  registerServe(program);
  return program;
}

/** Parse argv and route commander invocation errors through the output contract. */
export async function runCli(argv: string[] = process.argv): Promise<void> {
  // Error paths can hit before flag parsing finishes, so JSON mode for them
  // comes from a raw argv scan — most-explicit wins, same rule as isJsonMode.
  const flags = { json: argv.includes("--json") };
  const program = buildProgram();
  // Passive-update state is install-global (keyed by the binary, not the project):
  // the throttle and lock must be shared by every project invoking this binary.
  await maybePassiveUpdate({
    current: packageJson.version,
    stateDir: installStateDir(),
    argv,
    tty: Boolean(process.stdout.isTTY) && !flags.json,
  });
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version display then throw; both are successful exits.
      if (err.exitCode === 0) return;
      fail(commanderToCliError(err, program, argv), flags);
    }
    fail(err, flags);
  }
}

function subcommandTerm(cmd: Command): string {
  const args = cmd.registeredArguments
    .map((arg) => (arg.required ? `<${arg.name()}>` : `[${arg.name()}]`))
    .join(" ");
  const hasListedOptions = cmd.options.some((option) => option.long !== "--json");
  return `${cmd.name()}${hasListedOptions ? " [options]" : ""}${args ? ` ${args}` : ""}`;
}

function commanderToCliError(err: CommanderError, program: Command, argv: string[]): CliError {
  // "error: unknown option '--fix'" → "unknown option '--fix'"
  const message = err.message.replace(/^error: /, "");
  // Scope the hint to the subcommand being invoked (transcripts:
  // `pinbox doctor --fix` hints `pinbox doctor --help`, not `pinbox --help`).
  const known = new Set(program.commands.map((cmd) => cmd.name()));
  const sub = argv.find((arg) => known.has(arg));
  const scope = sub === undefined ? "pinbox" : `pinbox ${sub}`;
  return new CliError("E_INVALID_INPUT", message, `run \`${scope} --help\` for usage`);
}

if (import.meta.main) {
  await runCli();
}
