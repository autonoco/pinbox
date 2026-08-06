// pinbox CLI — pin command: creating a pin from the terminal.
// Until this verb, only the toolbar (or raw HTTP) could create a pin, so the
// CLI-first product could not be used from a CLI.
//
// THE CONTRACT RULE, and it is the whole design: a terminal has no browser, so a
// terminal pin records NOTHING it could not measure. No synthesized viewport, no
// `browser: "cli"`, no zero rect — those would be lies written into a versioned
// contract that agents read back as fact. Schema v1 was widened instead (core
// schema.ts §"widened in place"): target and env are optional, so absence is
// expressible. What a terminal pin does carry is all honest:
//   text      what the human typed
//   target    only what they named — --file (source anchor) and/or --url/--selector
//   author    git config user.name/user.email, falling back to $USER
//   env       nothing from here; the hub stamps branch/commit from git (serve.ts)
// UX spec: docs/design/cli/v1-transcripts.md §pin.
import type { PinInput } from "@autono/pinbox-core/schema";
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { CliError } from "../errors.ts";
import { emit, fail, isJsonMode, type OutputFlags } from "../output.ts";
import { usageHint } from "./flags.ts";

export type PinOptions = OutputFlags & { file?: string; url?: string; selector?: string };

export function registerPin(program: Command): void {
  program
    .command("pin")
    .summary("create a pin from the terminal")
    .description(
      "Create a pin from the terminal. No browser is involved, so nothing about one is " +
        "recorded: anchor the pin to a source location with --file, or to a web surface " +
        "with --url.",
    )
    .argument("<text>", "what needs to change, in your words")
    .option("--file <path[:line]>", "anchor to a source location (recorded repo-relative)")
    .option("--url <url>", "the web surface this pin is about")
    .option("--selector <sel>", "CSS selector on that surface (needs --url)")
    .option("--json", "machine output")
    .action(async (text: string, _opts: PinOptions, cmd: Command) => {
      await runPin(text, cmd.optsWithGlobals() as PinOptions);
    });
}

export async function runPin(
  text: string,
  opts: PinOptions,
  cwd: string = process.cwd(),
): Promise<void> {
  try {
    const input = await buildPinInput(text, opts, cwd);
    const client = await connectClient();
    const pin = await client.createPin(input);
    emit(pin, opts, (p) => p.id);
    // The id is the fact (stdout); the confirmation is messaging (stderr) — same
    // split as `reply`, so `pinbox pin … | xargs pinbox show` works.
    if (!isJsonMode(opts)) console.error(confirmation(input));
  } catch (err) {
    fail(err, opts);
  }
}

/**
 * Assemble the PinInput a terminal can honestly produce. Every failure here is
 * E_INVALID_INPUT (exit 2) with a hint naming the next thing to do.
 */
export async function buildPinInput(
  text: string,
  opts: PinOptions,
  cwd: string,
): Promise<PinInput> {
  const body = text.trim();
  if (body === "") {
    throw new CliError(
      "E_INVALID_INPUT",
      "pin text must not be empty",
      'quote the text: pinbox pin "your text"',
    );
  }
  const target = await buildTarget(opts, cwd);
  return {
    text: body,
    kind: "note",
    ...(target === undefined ? {} : { target }),
    author: terminalAuthor(cwd),
    // No `env` key at all: the hub stamps branch/commit, and a terminal knows
    // nothing else that belongs there.
  };
}

type Target = NonNullable<PinInput["target"]>;

async function buildTarget(opts: PinOptions, cwd: string): Promise<Target | undefined> {
  if (opts.selector !== undefined && opts.url === undefined) {
    throw new CliError(
      "E_INVALID_INPUT",
      "--selector needs --url (a selector without a page is not a target)",
      usageHint("pin"),
    );
  }
  const target: Target = {};
  if (opts.url !== undefined) target.url = parseUrl(opts.url);
  if (opts.selector !== undefined) target.selector = opts.selector;
  if (opts.file !== undefined) target.source = await resolveSource(opts.file, cwd);
  return Object.keys(target).length === 0 ? undefined : target;
}

// `URL.canParse("localhost:3000")` is true — it parses as scheme "localhost:". A
// web surface is http(s), and accepting anything else would let a typo through.
const WEB_PROTOCOLS = new Set(["http:", "https:"]);

function parseUrl(raw: string): string {
  if (!URL.canParse(raw) || !WEB_PROTOCOLS.has(new URL(raw).protocol)) {
    throw new CliError(
      "E_INVALID_INPUT",
      `invalid --url: "${raw}" (expected an absolute URL)`,
      usageHint("pin"),
    );
  }
  return raw;
}

/**
 * `--file <path[:line]>` → `target.source`. via is "none": a human named this
 * location, no targeting adapter derived it.
 * The path must exist (a pin pointing at nothing is worse than no anchor) and is
 * recorded repo-relative, so the anchor survives being read on another machine.
 */
async function resolveSource(spec: string, cwd: string): Promise<NonNullable<Target["source"]>> {
  const match = /^(.*):(\d+)$/.exec(spec);
  const rawPath = match?.[1] ?? spec;
  const line = match?.[2];
  const absolute = absolutePath(rawPath, cwd);
  if (!(await Bun.file(absolute).exists())) {
    throw new CliError(
      "E_INVALID_INPUT",
      `no such file: "${rawPath}"`,
      "--file takes a path that exists, optionally with :line",
    );
  }
  return {
    file: repoRelative(absolute, cwd),
    ...(line === undefined ? {} : { line: Number(line) }),
    via: "none",
  };
}

/** POSIX path join + normalization without node:path — the URL parser does both. */
function absolutePath(rawPath: string, cwd: string): string {
  const base = `file://${cwd.endsWith("/") ? cwd : `${cwd}/`}`;
  return decodeURIComponent(new URL(rawPath, base).pathname);
}

/** Relative to the git top level when there is one, else to the cwd; absolute otherwise. */
function repoRelative(absolute: string, cwd: string): string {
  const slash = absolute.lastIndexOf("/");
  const dir = slash <= 0 ? "/" : absolute.slice(0, slash);
  // `--show-prefix` is that directory's path relative to the repo root ("" at the
  // root itself), resolved by git rather than by comparing strings. That matters:
  // a symlinked path (macOS TMPDIR: /var → /private/var) makes `--show-toplevel`
  // and a locally built absolute path disagree, and prefix matching then fails.
  const prefix = gitOutput(dir, ["rev-parse", "--show-prefix"]);
  if (prefix !== undefined) return `${prefix}${absolute.slice(slash + 1)}`;
  return absolute.startsWith(`${cwd}/`) ? absolute.slice(cwd.length + 1) : absolute;
}

/**
 * Honest terminal identity: what git already knows about who is typing. `userId`
 * prefers the email because it is the stable id across machines; $USER is the
 * fallback when git has no identity configured.
 */
function terminalAuthor(cwd: string): PinInput["author"] {
  const name = gitValue(cwd, "user.name");
  const email = gitValue(cwd, "user.email");
  return {
    userId: email ?? process.env["USER"] ?? "unknown",
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
  };
}

/** A configured, non-empty git config value; undefined when git or the key is absent. */
function gitValue(cwd: string, key: string): string | undefined {
  const value = gitOutput(cwd, ["config", "--get", key]);
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Trimmed git stdout, or undefined for a missing git / a non-repo cwd / a failed
 * command. An empty string is a RESULT, not a failure — `rev-parse --show-prefix`
 * answers "" at the repo root.
 */
function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
    return result.success ? result.stdout.toString().trim() : undefined;
  } catch {
    return undefined;
  }
}

/** "pinned to src/app.tsx:42" · "pinned to https://…" · "pinned" when nothing was named. */
function confirmation(input: PinInput): string {
  const source = input.target?.source;
  const where =
    source === undefined
      ? input.target?.url
      : source.line === undefined
        ? source.file
        : `${source.file}:${source.line}`;
  return where === undefined ? "pinned" : `pinned to ${where}`;
}
