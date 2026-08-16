// pinbox CLI — install the latest compiled binary from GitHub Releases.
// `update --check` reports only. Passive apply lives in update.ts (TTY commands).
import type { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { CliError } from "../errors.ts";
import { emit, fail, type OutputFlags } from "../output.ts";
import { detectChannel, fetchLatestVersion, type UpdateChannel } from "../update.ts";
import { applyBinaryUpdate } from "../update-apply.ts";

export type UpdateData = {
  current: string;
  latest: string | null;
  available: boolean;
  updated: boolean;
};

export type UpdateDeps = {
  current?: string;
  channel?: UpdateChannel;
  dest?: string;
  fetchImpl?: typeof fetch;
  apply?: typeof applyBinaryUpdate;
};

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .summary("install the latest pinbox CLI")
    .description("Download the latest compiled CLI from GitHub Releases and replace this binary.")
    .option("--check", "report whether an update is available, do not install")
    .option("--json", "machine output")
    .action(async (_opts: OutputFlags & { check?: boolean }, cmd: Command) => {
      await runUpdate(cmd.optsWithGlobals() as OutputFlags & { check?: boolean });
    });
}

async function runUpdate(opts: OutputFlags & { check?: boolean }): Promise<void> {
  try {
    emit(await performUpdate(opts.check === true), opts, renderUpdate);
  } catch (err) {
    fail(err, opts);
  }
}

export async function performUpdate(checkOnly: boolean, deps?: UpdateDeps): Promise<UpdateData> {
  const current = deps?.current ?? packageJson.version;
  const latest = await fetchLatestVersion("binary", deps?.fetchImpl ?? fetch);
  if (latest === null) {
    throw new CliError(
      "E_HUB_UNREACHABLE",
      "could not read the latest GitHub Release",
      "check https://github.com/autonoco/pinbox/releases",
    );
  }
  const available = Bun.semver.order(latest, current) === 1;
  if (checkOnly || !available) {
    return { current, latest, available, updated: false };
  }
  const channel = deps?.channel ?? detectChannel();
  if (channel !== "binary") {
    throw new CliError(
      "E_INVALID_INPUT",
      "this install is not a compiled pinbox binary",
      "install from GitHub Releases or `npm i -g @autono/pinbox`, then re-run `pinbox update`",
    );
  }
  const apply = deps?.apply ?? applyBinaryUpdate;
  const result = await apply({
    current,
    latest,
    dest: deps?.dest ?? process.execPath,
    fetchImpl: deps?.fetchImpl,
  });
  return { current, latest: result.latest, available: true, updated: result.updated };
}

function renderUpdate(data: UpdateData): string {
  if (data.updated) return `updated pinbox ${data.current} -> ${data.latest}`;
  if (data.available) return `pinbox ${data.latest} is available (installed ${data.current})`;
  return `pinbox already up to date (${data.current})`;
}
