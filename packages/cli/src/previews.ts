// Local preview registration belongs to a worktree, never a branch checkout mutation.
import { CliError } from "./errors.ts";
import { projectId } from "./paths.ts";

export type PreviewRegistration = {
  url: string;
  localUrl: string;
  label: string;
  backend: string;
  branch: string;
  pr?: string;
};
export type Preview = {
  id: string;
  branch: string;
  commit: string;
  current: boolean;
  label: string;
  backend: string;
  url?: string;
  pr?: string;
  ready: boolean;
};

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, timeout: 3000 });
  if (!result.success) throw new CliError("E_INVALID_INPUT", "preview requires a Git worktree");
  return result.stdout.toString().trimEnd();
}

export function previewOrigin(value: string, loopback = false): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (loopback && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
  ) {
    throw new CliError(
      "E_INVALID_INPUT",
      loopback
        ? "local URL must be a loopback HTTP(S) origin"
        : "preview URL must be an HTTP(S) origin without credentials or a path",
    );
  }
  return url.origin;
}

export function worktrees(cwd: string): Array<{ path: string; branch: string; commit: string }> {
  return git(cwd, ["worktree", "list", "--porcelain", "-z"])
    .split("\0\0")
    .filter(Boolean)
    .map((block) => {
      const fields = block.split("\0");
      const value = (key: string) =>
        fields.find((f) => f.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
      return {
        path: value("worktree"),
        branch: value("branch").replace(/^refs\/heads\//, "") || "(detached)",
        commit: value("HEAD"),
      };
    })
    .filter((w) => w.path && w.commit);
}

export async function registerPreview(
  cwd: string,
  input: Omit<PreviewRegistration, "branch">,
): Promise<PreviewRegistration> {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const branch = git(root, ["branch", "--show-current"]);
  if (!branch) throw new CliError("E_INVALID_INPUT", "register previews on a named branch");
  if (!input.label.trim() || input.label.length > 160 || input.backend.length > 160) {
    throw new CliError("E_INVALID_INPUT", "label and backend must be short display text");
  }
  if (input.pr) previewOrigin(new URL(input.pr).origin);
  const registration = {
    ...input,
    url: previewOrigin(input.url),
    localUrl: previewOrigin(input.localUrl, true),
    branch,
  };
  await Bun.write(`${root}/.pinbox/preview.json`, `${JSON.stringify(registration, null, 2)}\n`);
  return registration;
}

export async function listPreviews(cwd: string): Promise<Preview[]> {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  return Promise.all(
    worktrees(root).map(async (w) => {
      const preview: Preview = {
        id: projectId(w.path),
        branch: w.branch,
        commit: w.commit,
        current: projectId(w.path) === projectId(root),
        label: w.branch,
        backend: "",
        ready: false,
      };
      try {
        const record: PreviewRegistration = await Bun.file(`${w.path}/.pinbox/preview.json`).json();
        // A checkout that changed branch must be registered again; never mislabel its code.
        if (
          record.branch !== w.branch ||
          typeof record.label !== "string" ||
          typeof record.backend !== "string"
        )
          return preview;
        preview.url = previewOrigin(record.url);
        preview.label = record.label;
        preview.backend = record.backend;
        if (record.pr && /^https:\/\//.test(record.pr)) preview.pr = record.pr;
        const res = await fetch(
          `${previewOrigin(record.localUrl, true)}/__pinbox_previews/identity`,
          {
            signal: AbortSignal.timeout(1500),
            redirect: "manual",
          },
        );
        preview.ready = res.ok && ((await res.json()) as { id?: string }).id === preview.id;
      } catch {
        /* Missing registration or a stopped preview is a normal list entry. */
      }
      return preview;
    }),
  );
}
