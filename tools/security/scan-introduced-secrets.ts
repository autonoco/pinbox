// Scans only the commits a push or pull request *introduces*, not the whole tree. A full-tree
// scan re-reports the same historical false positives on every run until people stop reading the
// job; a range scan is silent until someone adds something new, which is the only signal worth
// making a required check.
//
// Pinned image, no shell: the argument vector is fixed and the SHAs are validated before they
// reach it, because BASE_SHA/HEAD_SHA arrive from workflow context and are attacker-shaped on a
// fork PR.
// Tag *and* digest: the tag documents the version, the digest is what Docker actually resolves.
// A tag is mutable — `v8.30.1` can be repushed at any time, and a scanner that silently becomes a
// different binary is the one tool in CI where that matters most. Bump both together; read the
// new digest from `docker buildx imagetools inspect ghcr.io/gitleaks/gitleaks:<tag>`.
const GITLEAKS_IMAGE =
  "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
const SHA_RE = /^[0-9a-f]{40,64}$/u;
const ZERO_SHA_RE = /^0+$/u;

/**
 * The `--log-opts` range to hand gitleaks. A branch's first push reports an all-zero base and a
 * `workflow_dispatch` reports none at all; both mean "there is no predecessor", and scanning the
 * single head commit is the honest answer — `..HEAD` from nothing would scan the entire history.
 */
export function selectGitleaksLogOpts(baseSha: string | undefined, headSha: string): string {
  if (!SHA_RE.test(headSha)) throw new Error("invalid HEAD_SHA");
  if (!baseSha || ZERO_SHA_RE.test(baseSha)) return headSha;
  if (!SHA_RE.test(baseSha)) throw new Error("invalid BASE_SHA");
  return `${baseSha}..${headSha}`;
}

const SCAN_FLAGS = ["git", "--redact", "--no-banner"] as const;

/** CI has Docker and no gitleaks; a developer machine usually has the reverse. */
export function buildGitleaksDockerArgs(workspace: string, logOpts: string): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "-v",
    `${workspace}:/repo`,
    "-w",
    "/repo",
    GITLEAKS_IMAGE,
    ...SCAN_FLAGS,
    `--log-opts=${logOpts}`,
    ".",
  ];
}

export function buildGitleaksLocalArgs(bin: string, workspace: string, logOpts: string): string[] {
  return [bin, ...SCAN_FLAGS, `--log-opts=${logOpts}`, workspace];
}

export function buildGitleaksArgs(
  bin: string | null,
  workspace: string,
  logOpts: string,
): string[] {
  return bin === null
    ? buildGitleaksDockerArgs(workspace, logOpts)
    : buildGitleaksLocalArgs(bin, workspace, logOpts);
}

if (import.meta.main) {
  const logOpts = selectGitleaksLogOpts(process.env["BASE_SHA"], process.env["HEAD_SHA"] ?? "");
  const args = buildGitleaksArgs(Bun.which("gitleaks"), process.cwd(), logOpts);
  const child = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
}
