// pinbox CLI — the interactive seams `init` uses when a human is at a terminal.
//
// Bun's global `confirm()` and `prompt()` write the question AND the ` [y/N] ` suffix to
// **stdout**, which is the one thing our output contract forbids: stdout carries facts, and
// only facts (docs/design/cli/v1-transcripts.md; output.ts). A question interleaved with the
// `ok  .pinbox  created` lines corrupts the very stream a user may be reading or piping.
// So the question goes to stderr and we read the answer ourselves.
//
// The read is `sh -c 'IFS= read -r line'` over inherited stdin: POSIX `read` consumes one
// byte at a time, so — unlike `head -n1` — it cannot swallow input belonging to the *next*
// question, and it keeps these seams synchronous, which is what their two call sites
// (selectTargets, pickHandoffAgent) need. Bun APIs plus POSIX only, as in agents.ts/paths.ts.

/** Ask a yes/no question on stderr. Anything but an explicit yes — including EOF — is no. */
export function askYesNo(question: string): boolean {
  const answer = askLine(`${question} [y/N] `, { newline: false });
  if (answer === null) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/**
 * Write `question` to stderr and read one line from stdin.
 * Returns null at EOF — distinct from `""`, which is the user pressing enter.
 */
export function askLine(question: string, opts?: { newline?: boolean }): string | null {
  process.stderr.write(opts?.newline === false ? question : `${question}\n`);
  const result = Bun.spawnSync(["sh", "-c", 'IFS= read -r line || exit 1; printf %s "$line"'], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}
