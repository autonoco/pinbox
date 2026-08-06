// pinbox CLI — the `.pinbox/` state dir, the first thing `init` writes.
// POSIX via Bun.spawnSync — Bun APIs plus POSIX only (agents.ts/paths.ts precedent).
// Every exit code here is checked: this used to `mkdir -p` and return "created" without
// looking, so on an unwritable project dir init printed `ok  .pinbox  created` while the
// directory did not exist and every later write into it failed for reasons that made no
// sense. A writer that cannot fail is a writer you cannot trust.
import { CliError } from "../errors.ts";

export type StateDirResult = "created" | "unchanged";

/**
 * Idempotently create `<projectDir>/.pinbox`. `dryRun` predicts the outcome without
 * writing — but still refuses to predict "created" for a dir it could not create.
 * @throws CliError E_INTERNAL when the dir is missing and cannot be made.
 */
export function ensurePinboxDir(projectDir: string, dryRun: boolean): StateDirResult {
  const dir = `${projectDir}/.pinbox`;
  if (isDir(dir)) return "unchanged";
  if (dryRun) {
    if (!isWritable(projectDir)) throw cannotCreate(dir, `${projectDir} is not writable`);
    return "created";
  }
  const result = Bun.spawnSync(["mkdir", "-p", dir], { stderr: "pipe" });
  if (result.exitCode !== 0 || !isDir(dir)) {
    throw cannotCreate(
      dir,
      result.stderr.toString().trim() || `mkdir -p exited ${result.exitCode}`,
    );
  }
  return "created";
}

function cannotCreate(dir: string, detail: string): CliError {
  return new CliError(
    "E_INTERNAL",
    `could not create ${dir}: ${detail}`,
    "check that the project directory exists and is writable, then re-run `pinbox init`",
  );
}

function isDir(path: string): boolean {
  return Bun.spawnSync(["test", "-d", path]).exitCode === 0;
}

function isWritable(path: string): boolean {
  return Bun.spawnSync(["test", "-w", path]).exitCode === 0;
}
