// pinbox CLI — shared flag validation and hub-error remapping for the verbs.
// Every message and hint here is transcript-exact (docs/design/cli/v1-transcripts.md):
// hints name the next command to run, and pin ids are exact — a prefix is E_NOT_FOUND.
import { CliError } from "../errors.ts";

export function usageHint(command: string): string {
  return `run \`pinbox ${command} --help\` for usage`;
}

export function parseStatus(
  raw: string | undefined,
  command: string,
): "open" | "resolved" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "open" || raw === "resolved") return raw;
  throw new CliError(
    "E_INVALID_INPUT",
    `invalid --status: "${raw}" (expected open or resolved)`,
    usageHint(command),
  );
}

export function parseRole(raw: string, command: string): "human" | "agent" {
  if (raw === "human" || raw === "agent") return raw;
  throw new CliError(
    "E_INVALID_INPUT",
    `invalid --as: "${raw}" (expected human or agent)`,
    usageHint(command),
  );
}

/** Replace the hub's E_NOT_FOUND wording with the transcript's (§show). */
export function remapNotFound(err: unknown, id: string): unknown {
  return err instanceof CliError && err.code === "E_NOT_FOUND"
    ? new CliError(
        "E_NOT_FOUND",
        `no pin with id ${id}`,
        "run `pinbox list` to see valid ids (full ids only — prefixes don't match)",
      )
    : err;
}

/** Replace the hub's E_CONFLICT wording with the transcript's (§resolve). */
export function remapConflict(err: unknown, id: string): unknown {
  return err instanceof CliError && err.code === "E_CONFLICT"
    ? new CliError(
        "E_CONFLICT",
        `${id} is already resolved`,
        `run \`pinbox show ${id}\` to see who resolved it and why`,
      )
    : err;
}
