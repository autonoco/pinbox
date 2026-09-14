import type { Command } from "commander";
import { emit, fail, type OutputFlags } from "../output.ts";
import { listPreviews, type PreviewRegistration, registerPreview } from "../previews.ts";

export function registerPreviewCommand(program: Command): void {
  const preview = program
    .command("preview")
    .description(
      "Register and discover local worktree previews. Never switches branches or starts a backend.",
    );
  preview
    .command("register")
    .description("Register this worktree's running frontend preview. State is local to .pinbox/.")
    .requiredOption("--url <origin>", "browser-facing HTTP(S) origin")
    .requiredOption("--local-url <origin>", "loopback origin for readiness checks")
    .requiredOption("--label <text>", "display label, for example PR #104 — Inbox")
    .option("--backend <text>", "backend sharing label", "")
    .option("--pr <url>", "pull request URL")
    .option("--json", "machine output")
    .action(async (_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as Omit<PreviewRegistration, "branch"> & OutputFlags;
      try {
        const { url, localUrl, label, backend, pr } = opts;
        emit(
          await registerPreview(process.cwd(), {
            url,
            localUrl,
            label,
            backend,
            ...(pr ? { pr } : {}),
          }),
          opts,
          (d) => d.url,
        );
      } catch (e) {
        fail(e, opts);
      }
    });
  preview
    .command("list")
    .description(
      "List this repository's worktrees and preview readiness. Missing or stopped previews remain visible.",
    )
    .option("--json", "machine output")
    .action(async (_opts: unknown, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as OutputFlags;
      try {
        emit(await listPreviews(process.cwd()), opts, (items) =>
          items
            .map((p) => `${p.current ? "*" : " "} ${p.label} — ${p.ready ? p.url : "unavailable"}`)
            .join("\n"),
        );
      } catch (e) {
        fail(e, opts);
      }
    });
}
