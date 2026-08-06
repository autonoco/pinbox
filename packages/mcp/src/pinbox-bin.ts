// @autono/pinbox-mcp — locating and invoking the pinbox CLI.
// The MCP server shells out to `pinbox --json` rather than duplicating an HTTP client +
// daemon lifecycle: the CLI's machine-output contract IS the API (design principle 3),
// and the fallow boundary keeps HubClient/ensureHub inside packages/cli.

/** PINBOX_BIN env override → `pinbox` on PATH → throw with the install hint. */
export function resolvePinboxBin(): string {
  const fromEnv = process.env["PINBOX_BIN"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const fromPath = Bun.which("pinbox");
  if (fromPath !== null) return fromPath;
  throw new Error(
    "pinbox CLI not found on PATH. Install it (`bunx @autono/pinbox`) or set PINBOX_BIN.",
  );
}

/**
 * Run the pinbox CLI and capture its machine output. `--json` is guaranteed on the
 * argv (appended unless the caller already included it). Stdout is read to EOF —
 * the close event, never the exit event: a probe awaiting exit first lost 65,538 of
 * 200,000 bytes still in flight (deep-dive §1.8).
 */
export async function runPinbox(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ code: number; stdout: string }> {
  const bin = resolvePinboxBin();
  const argv = args.includes("--json") ? [bin, ...args] : [bin, ...args, "--json"];
  const proc = Bun.spawn(argv, {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}
