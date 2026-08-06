// pinbox CLI — agent-grade output contract.
// JSON mode: exactly one pretty-printed JSON document on stdout, nothing on stderr.
//   success  {"ok":true,"data":…}
//   failure  {"ok":false,"error":{"code":…,"message":…,"hint":…}}
// Human mode: facts on stdout; counts, confirmations, and errors on stderr.
// Spec: docs/design/cli/v1-transcripts.md (byte-for-byte where it shows output).

import { CliError, type ErrorCode, EXIT_CODES } from "./errors.ts";

export type OutputFlags = { json?: boolean };

/** `--json` or a non-TTY stdout selects JSON mode; most-explicit wins. */
export function isJsonMode(flags: OutputFlags): boolean {
  return Boolean(flags.json) || !process.stdout.isTTY;
}

/**
 * Print a success. JSON mode emits the envelope; human mode emits `human(data)`.
 * Human renderings that split facts (stdout) from messaging (stderr) do the stderr
 * part themselves — `human` returns only the facts.
 */
export function emit<T>(data: T, flags: OutputFlags, human: (d: T) => string): void {
  if (isJsonMode(flags)) {
    console.log(JSON.stringify({ ok: true, data }, null, 2));
  } else {
    const facts = human(data);
    // Absent facts print nothing: an empty rendering emits no stdout line at all
    // (transcripts §list — an empty list leaves stdout empty; the count is stderr).
    if (facts !== "") console.log(facts);
  }
}

export type OutputMode = "json" | "human";

/**
 * Print a failure and exit with the mapped code. Never returns.
 * Non-CliError values are wrapped as E_INTERNAL. `mode` overrides the TTY
 * auto-switch — `export` errors human-style even when piped, because its
 * stdout carries the markdown artifact, never an envelope (transcripts §export).
 */
export function fail(err: unknown, flags: OutputFlags, mode?: OutputMode): never {
  const cliError = toCliError(err);
  const json = mode === undefined ? isJsonMode(flags) : mode === "json";
  if (json) {
    const error: { code: ErrorCode; message: string; hint?: string } = {
      code: cliError.code,
      message: cliError.message,
    };
    if (cliError.hint !== undefined) error.hint = cliError.hint;
    console.log(JSON.stringify({ ok: false, error }, null, 2));
  } else {
    console.error(`pinbox: ${cliError.message}`);
    if (cliError.hint !== undefined) console.error(cliError.hint);
  }
  const exitCode = EXIT_CODES[cliError.code];
  process.exitCode = exitCode;
  return process.exit(exitCode);
}

function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CliError("E_INTERNAL", message);
}
