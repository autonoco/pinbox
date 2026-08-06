// @autono/pinbox-core — git env stamping.
// gitEnv(cwd) shells out via Bun.spawnSync; a missing git, a non-repo cwd, or any
// spawn failure yields {} — git absence must never break pin creation.

export function gitEnv(cwd: string): { branch?: string; commit?: string } {
  const branch = revParse(cwd, "--abbrev-ref", "HEAD");
  const commit = revParse(cwd, "HEAD");
  if (branch === null || commit === null) return {};
  return { branch, commit };
}

function revParse(cwd: string, ...args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", ...args], { cwd });
    if (!result.success) return null;
    const out = result.stdout.toString().trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}
