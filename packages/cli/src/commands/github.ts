// pinbox CLI — `pinbox github setup`: create, install and wire the GitHub App a cloud hub
// needs, in one sitting. The local hub never needs this (it rides your own `gh`); the
// Worker cannot shell out, so it authenticates as an App. The flow itself lives in
// github-app/flow.ts behind seams; this file binds the real browser, receiver, wrangler and
// git, and speaks the CLI's output contract (facts stdout, messaging stderr, --json envelope).
import type { Command } from "commander";
import { CliError } from "../errors.ts";
import { runGithubSetup, type SetupResult, type SetupSeams } from "../github-app/flow.ts";
import { hubFromWranglerConfig, repoFromRemote } from "../github-app/manifest.ts";
import { startReceiver } from "../github-app/receiver.ts";
import { configIn, findWorkerDir, putSecret, writeWranglerVars } from "../github-app/wrangler.ts";
import { askLine } from "../init/prompt.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";

type GithubSetupOptions = OutputFlags & {
  hub?: string;
  repo?: string;
  name?: string;
  worker?: string;
  printSecrets?: boolean;
};

export function registerGithub(program: Command): void {
  const github = program
    .command("github")
    .summary("connect a cloud hub to GitHub")
    .description(
      "Connect a cloud hub to GitHub. The local hub uses your own gh login; a cloud hub " +
        "authenticates as a GitHub App that these commands create and wire up.",
    );
  github
    .command("setup")
    .summary("create and install the GitHub App, then configure the worker")
    .description(
      "Create the GitHub App from a manifest (one click in your browser), install it on the " +
        "repo (one more click), then write GITHUB_APP_ID / GITHUB_INSTALLATION_ID / GITHUB_REPO " +
        "into the worker's wrangler config and push the private key and webhook secret through " +
        "wrangler. Interactive: run it yourself, not from an agent.",
    )
    .option(
      "--hub <url>",
      "the cloud hub's URL, mount included (default: the worker's custom domain, else asked)",
    )
    .option("--repo <owner/name>", "the repository (default: this checkout's origin remote)")
    .option("--name <name>", "App name, unique across GitHub (default: pinbox-<owner>-<repo>)")
    .option("--worker <dir>", "the scaffolded hub worker directory (default: detected)")
    .option(
      "--print-secrets",
      "print the private key and webhook secret instead of running wrangler",
    )
    .option("--json", "machine output")
    .action(async (_opts: GithubSetupOptions, cmd: Command) => {
      await runGithubSetupCommand(cmd.optsWithGlobals() as GithubSetupOptions);
    });
}

async function runGithubSetupCommand(
  opts: GithubSetupOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  try {
    if (isJsonMode(opts) && !process.stdin.isTTY) {
      // Nothing may prompt in front of an envelope, and this flow needs a browser.
      throw new CliError(
        "E_INVALID_INPUT",
        "github setup is interactive: it opens your browser twice",
        "run it from a terminal; --json is fine there and prints the result envelope",
      );
    }
    const repo = opts.repo ?? (await repoFromGit(cwd));
    if (repo === null) {
      throw new CliError(
        "E_INVALID_INPUT",
        "could not determine the repository from the origin remote",
        "pass --repo owner/name",
      );
    }
    const [owner, name] = repo.split("/") as [string, string];
    const workerDir = await findWorkerDir(cwd, opts.worker);
    const seams = await realSeams(workerDir);
    const result = await runGithubSetup(
      {
        hubUrl: await hubUrlFor(opts, workerDir),
        repo,
        appName: opts.name ?? `pinbox-${owner}-${name}`,
        printSecrets: opts.printSecrets === true || workerDir === null,
      },
      seams,
    );
    emit(result, opts, renderSetup);
    if (!isJsonMode(opts)) console.error(nextSteps(result));
  } catch (err) {
    fail(err, opts);
  }
}

/**
 * The hub's public URL, which the App manifest must carry as its webhook target. From the
 * flag, else the worker's custom-domain route, else the person at the terminal — a
 * workers.dev subdomain is not in any config we can read.
 */
async function hubUrlFor(opts: GithubSetupOptions, workerDir: string | null): Promise<string> {
  if (opts.hub !== undefined) return opts.hub;
  const configPath = workerDir === null ? null : await configIn(workerDir);
  if (configPath !== null) {
    const derived = hubFromWranglerConfig(await Bun.file(configPath).text());
    if (derived !== null) {
      console.error(`hub: ${derived} (from ${configPath})`);
      return derived;
    }
  }
  if (!process.stdin.isTTY) {
    throw new CliError(
      "E_INVALID_INPUT",
      "the worker's public URL is not in its config",
      "pass --hub https://<worker-host>/_pinbox",
    );
  }
  const answer = askLine(
    "Hub URL, mount included (e.g. https://my-hub.example.workers.dev/_pinbox): ",
    {
      newline: false,
    },
  );
  if (answer === null || answer.trim() === "") {
    throw new CliError(
      "E_INVALID_INPUT",
      "no hub URL given",
      "pass --hub https://<worker-host>/_pinbox",
    );
  }
  return answer.trim();
}

/** Facts: what was created and where it was written. Secrets print only when asked. */
function renderSetup(r: SetupResult): string {
  const lines = [
    `app ${r.appId} ${r.slug} ${r.appUrl}`,
    `installation ${r.installationId} ${r.repo}`,
    `webhook ${r.webhookUrl}`,
    r.vars.written
      ? `vars written ${r.workerDir ?? ""}${r.vars.missing.length ? ` (add by hand: ${r.vars.missing.join(", ")})` : ""}`
      : "vars not written (no worker found)",
    `secrets ${r.secrets}`,
    `verified ${r.verified ? "yes" : "no"}`,
  ];
  if (r.secretValues !== undefined) {
    lines.push(
      "",
      `GITHUB_WEBHOOK_SECRET=${r.secretValues.GITHUB_WEBHOOK_SECRET}`,
      "GITHUB_APP_PRIVATE_KEY:",
      r.secretValues.GITHUB_APP_PRIVATE_KEY.trimEnd(),
    );
  }
  return lines.join("\n");
}

function nextSteps(r: SetupResult): string {
  const steps: string[] = [];
  if (r.vars.written && r.vars.missing.length > 0) {
    steps.push(`add ${r.vars.missing.join(", ")} to the vars in ${r.workerDir}/wrangler.jsonc`);
  }
  if (!r.vars.written) {
    steps.push(
      `set GITHUB_APP_ID=${r.appId} GITHUB_INSTALLATION_ID=${r.installationId} GITHUB_REPO=${r.repo} as worker vars`,
    );
  }
  if (r.secrets === "printed") {
    steps.push(
      "wrangler secret put GITHUB_APP_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET with the values above",
    );
  }
  steps.push(
    `deploy the worker (vars take effect on deploy): cd ${r.workerDir ?? "<worker>"} && bun run deploy`,
  );
  return `next:\n${steps.map((s) => `  - ${s}`).join("\n")}`;
}

async function repoFromGit(cwd: string): Promise<string | null> {
  try {
    const result = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd });
    if (!result.success) return null;
    return repoFromRemote(result.stdout.toString());
  } catch {
    return null;
  }
}

async function realSeams(workerDir: string | null): Promise<SetupSeams> {
  let receiver: ReturnType<typeof startReceiver> | null = null;
  const configPath = workerDir === null ? null : await configIn(workerDir);
  return {
    fetchImpl: (input, init) => fetch(input, init),
    async open(url) {
      await openBrowser(url);
    },
    async receive(formHtml, state) {
      receiver = startReceiver(formHtml);
      try {
        await openBrowser(receiver.origin);
        return await receiver.waitForCode(state, 10 * 60_000);
      } finally {
        receiver.close();
      }
    },
    say: (line) => console.error(line),
    worker:
      workerDir === null || configPath === null
        ? null
        : {
            dir: workerDir,
            writeVars: (vars) => writeWranglerVars(configPath, vars),
            putSecret: (name, value) => putSecret(workerDir, name, value),
          },
  };
}

/** Open in the default browser when we can; always print the URL so a headless box can too. */
async function openBrowser(url: string): Promise<void> {
  console.error(`  open: ${url}`);
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  if (Bun.which(opener) === null) return;
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // printed above — the user can click it
  }
}
