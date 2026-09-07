import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { CliError } from "../errors.ts";
import { emit, fail, type OutputFlags } from "../output.ts";
export function registerVerify(program: Command) {
  program
    .command("verify")
    .summary("accept a resolution or reopen a pin")
    .argument("<id>", "pin id")
    .requiredOption("--outcome <outcome>", "accepted or reopened")
    .option("--json", "machine output")
    .action(async (id: string, opts: OutputFlags & { outcome: string }) => {
      try {
        if (opts.outcome !== "accepted" && opts.outcome !== "reopened")
          throw new CliError("E_INVALID_INPUT", "--outcome must be accepted or reopened");
        const pin = await (await connectClient()).verify(id, opts.outcome);
        emit(pin, opts, (p) => `${p.id} ${opts.outcome}`);
      } catch (e) {
        fail(e, opts);
      }
    });
}
