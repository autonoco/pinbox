// pinbox CLI — GitHub connector transport, the "local = `gh` CLI shell-out
// (impl in packages/cli, Bun.$)". GitHub is never a dependency: every op shells to the
// user's own authenticated `gh`, so credentials, host config and enterprise setups ride
// gh's, not ours. The op vocabulary is pinned in core's connectors/github.ts so the
// App-token transport implements the same names.
import type { Connector, ConnectorTransport } from "@autono/pinbox-core/connectors";
import { createSlackConnector, createSlackTransport } from "@autono/pinbox-core/connectors";
import { createGithubConnector } from "@autono/pinbox-core/connectors/github";
import { $ } from "bun";

type GhRun = { exitCode: number; stdout: string; stderr: string };

export function ghTransport(cwd: string): ConnectorTransport {
  return {
    async request(op: string, params: Record<string, unknown>): Promise<unknown> {
      switch (op) {
        case "issue.create":
          return createIssue(cwd, str(params["title"]), str(params["body"]));
        case "issue.comment":
          await run(cwd, [
            "issue",
            "comment",
            str(params["number"]),
            "--body",
            str(params["body"]),
          ]);
          return undefined;
        case "issue.view":
          return viewIssue(cwd, str(params["number"]));
        case "issue.close":
          await run(cwd, ["issue", "close", str(params["number"])]);
          return undefined;
        case "issue.reopen":
          await run(cwd, ["issue", "reopen", str(params["number"])]);
          return undefined;
        default:
          throw new Error(`unknown gh op: ${op}`);
      }
    },
  };
}

/**
 * The connectors the local serve boot injects: github when `gh` is installed, slack when
 * both SLACK_BOT_TOKEN and SLACK_CHANNEL are set. A connector that is absent here answers
 * `pinbox link <id> <name>` with 502 E_CONNECTOR and the `pinbox doctor` hint — the hub
 * itself never learns transport details. The Slack entry lands here too.
 */
export function localConnectors(cwd: string): Connector[] {
  const connectors: Connector[] = [];
  if (ghOnPath() !== null) connectors.push(createGithubConnector(ghTransport(cwd)));
  const slack = slackConnector();
  if (slack) connectors.push(slack);
  return connectors;
}

/** Slack rides one fetch transport on both hosts; env supplies the bot token and channel. */
function slackConnector(): Connector | null {
  const botToken = process.env["SLACK_BOT_TOKEN"];
  const channel = process.env["SLACK_CHANNEL"];
  if (botToken === undefined || botToken === "" || channel === undefined || channel === "") {
    return null;
  }
  return createSlackConnector(createSlackTransport({ botToken }), { channel });
}

/** Bun.which against the CURRENT PATH — the default snapshots the startup environment. */
export function ghOnPath(): string | null {
  return Bun.which("gh", { PATH: process.env["PATH"] ?? "" });
}

/**
 * Why `gh` cannot be used right now, or null when it looks usable.
 *
 * `gh auth status` is the only honest probe — a stored token can be dead, and "installed" says
 * nothing about "logged in". Callers use this to attach a next command to a connector failure;
 * the hub can't, because it never learns transport details.
 */
export function ghUnusableReason(): "missing" | "unauthenticated" | null {
  const bin = ghOnPath();
  if (bin === null) return "missing";
  const status = Bun.spawnSync([bin, "auth", "status"], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5_000,
  }).exitCode;
  return status === 0 ? null : "unauthenticated";
}

/** issue.create → { number, url }; falls back to parsing the stdout URL on older gh (no --json). */
async function createIssue(
  cwd: string,
  title: string,
  body: string,
): Promise<{ number: number; url: string }> {
  const argv = ["issue", "create", "--title", title, "--body", body];
  const first = await raw(cwd, [...argv, "--json", "number,url"]);
  if (first.exitCode === 0) {
    const parsed = parseJson(first, "issue.create") as { number?: unknown; url?: unknown };
    return { number: Number(parsed.number), url: str(parsed.url) };
  }
  if (!/unknown flag/i.test(first.stderr)) throw ghError(first);
  // Older gh: no --json on create — the created issue's URL on stdout is the contract.
  const second = await run(cwd, argv);
  const url = second.stdout.trim().split("\n").at(-1) ?? "";
  const match = url.match(/\/issues\/(\d+)$/);
  if (match === null) throw new Error(`cannot parse issue URL from gh output: ${url}`);
  return { number: Number(match[1]), url };
}

/** issue.view → normalized { state, comments }: gh reports OPEN/CLOSED and author objects. */
async function viewIssue(
  cwd: string,
  number: string,
): Promise<{
  state: "open" | "closed";
  comments: { author: string; body: string; createdAt: string }[];
}> {
  const result = await run(cwd, ["issue", "view", number, "--json", "state,comments"]);
  const parsed = parseJson(result, "issue.view") as { state?: unknown; comments?: unknown };
  const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
  return {
    state: str(parsed.state).toLowerCase() === "closed" ? "closed" : "open",
    comments: comments.map((c: unknown) => {
      const row = (c ?? {}) as { author?: unknown; body?: unknown; createdAt?: unknown };
      const author =
        typeof row.author === "object" && row.author !== null
          ? str((row.author as { login?: unknown }).login)
          : str(row.author);
      return { author, body: str(row.body), createdAt: str(row.createdAt) };
    }),
  };
}

/** Run gh; non-zero exit throws an Error carrying gh's stderr. */
async function run(cwd: string, argv: string[]): Promise<GhRun> {
  const result = await raw(cwd, argv);
  if (result.exitCode !== 0) throw ghError(result);
  return result;
}

async function raw(cwd: string, argv: string[]): Promise<GhRun> {
  // Resolve gh to an absolute path against the CURRENT PATH ourselves: Bun.$ (and
  // Bun.which's default) resolve against the startup environment, which would ignore
  // runtime PATH changes (tests prepend a stub gh; users fix PATH mid-session).
  const gh = ghOnPath();
  if (gh === null) throw new Error("gh not found on PATH");
  const env = { ...process.env } as Record<string, string>;
  const result = await $`${gh} ${argv}`.cwd(cwd).env(env).nothrow().quiet();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function ghError(result: GhRun): Error {
  const stderr = result.stderr.trim();
  return new Error(stderr === "" ? `gh exited ${result.exitCode}` : stderr);
}

function parseJson(result: GhRun, op: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    const stderr = result.stderr.trim();
    throw new Error(`gh ${op}: unparseable JSON output${stderr === "" ? "" : ` — ${stderr}`}`);
  }
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
