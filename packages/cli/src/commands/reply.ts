// pinbox CLI — reply command.
// Pins are conversations; replying never resolves. Human mode: the created message
// id is the fact (stdout), the confirmation is messaging (stderr). JSON `data` is
// the created ThreadMessage, verbatim. UX spec: transcripts §reply.
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { CliError } from "../errors.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { parseRole, remapNotFound } from "./flags.ts";

export type ReplyOptions = OutputFlags & { as: string };

export function registerReply(program: Command): void {
  program
    .command("reply")
    .summary("add a thread message to a pin")
    .description("Add a thread message to a pin. Replying never resolves.")
    .argument("<id>", "pin id (pin_xxxxxxxxxx)")
    .argument("<text>", "the message")
    .option("--as <role>", "author role: human or agent", "human")
    .option("--json", "machine output")
    .action(async (id: string, text: string, _opts: ReplyOptions, cmd: Command) => {
      await runReply(id, text, cmd.optsWithGlobals() as ReplyOptions);
    });
}

export async function runReply(id: string, text: string, opts: ReplyOptions): Promise<void> {
  try {
    if (text === "") {
      throw new CliError(
        "E_INVALID_INPUT",
        "reply text must not be empty",
        'quote the message: pinbox reply <id> "your text"',
      );
    }
    const role = parseRole(opts.as, "reply");
    const client = await connectClient();
    const message = await client.reply(id, text, role);
    emit(message, opts, (m) => m.id);
    if (!isJsonMode(opts)) console.error(`replied to ${id} as ${role}`);
  } catch (err) {
    fail(remapNotFound(err, id), opts);
  }
}
