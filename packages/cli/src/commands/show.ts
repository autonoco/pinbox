// pinbox CLI — show command.
// The pin plus its full thread — everything an agent needs to act on one pin.
// Human: one line per fact, absent optional fields print nothing. JSON `data` is
// { pin, thread }, the two resources show joins. UX spec: transcripts §show.
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import type { Command } from "commander";
import { connectClient } from "../client.ts";
import { emit, fail, type OutputFlags } from "../output.ts";
import { relativeAge } from "../render.ts";
import { remapNotFound } from "./flags.ts";

export function registerShow(program: Command): void {
  program
    .command("show")
    .summary("one pin with its full thread")
    .description("One pin with its full thread.")
    .argument("<id>", "pin id (pin_xxxxxxxxxx)")
    .option("--json", "machine output")
    .action(async (id: string, _opts: OutputFlags, cmd: Command) => {
      await runShow(id, cmd.optsWithGlobals() as OutputFlags);
    });
}

export async function runShow(id: string, opts: OutputFlags): Promise<void> {
  try {
    const client = await connectClient();
    const pin = await client.get(id);
    const thread = await client.thread(id);
    emit({ pin, thread }, opts, renderShow);
  } catch (err) {
    fail(remapNotFound(err, id), opts);
  }
}

export function renderShow(data: { pin: Pin; thread: ThreadMessage[] }): string {
  const { pin, thread } = data;
  const lines = [`${pin.id}  ${pin.status}  ${pin.kind}`, ...factLines(pin)];
  if (thread.length > 0) lines.push("", ...threadLines(thread));
  return lines.join("\n");
}

const row = (label: string, value: string) => `${label.padEnd(8)}  ${value}`;

// Every target/env fact is optional at v1 (core schema.ts §"widened in place"): a
// `pinbox pin` pin has no selector, no rect and no viewport. The rule this rendering
// already followed for `source` and `nearby` — print a fact only when it exists —
// now governs every line, so nothing ever renders as "undefined". Each group below
// answers "what do I know about X", and contributes zero lines when the answer is
// "nothing"; factLines is just their order.
function factLines(pin: Pin): string[] {
  return [
    row("text", pin.text),
    ...targetFacts(pin.target),
    ...envFacts(pin.env),
    row("author", pin.author.userId),
    row("created", `${pin.createdAt} (${relativeAge(pin.createdAt)})`),
    ...resolutionFacts(pin.resolution),
  ];
}

/** Where the pin points: element, source anchor, page, box, surrounding text. */
function targetFacts(target: Pin["target"]): string[] {
  if (target === undefined) return [];
  const lines: string[] = [];
  if (target.selector !== undefined) {
    const tag = target.tag === undefined ? "" : `  <${target.tag}>`;
    lines.push(row("target", `${target.selector}${tag}`));
  }
  if (target.source) {
    const line = target.source.line === undefined ? "" : `:${target.source.line}`;
    lines.push(row("source", `${target.source.file}${line}`));
  }
  if (target.url !== undefined) lines.push(row("url", target.url));
  const rect = target.rect;
  if (rect) lines.push(row("rect", `${rect.x},${rect.y} ${rect.width}x${rect.height}`));
  const nearby = target.context?.nearbyText;
  if (nearby !== undefined) lines.push(row("nearby", `"${nearby}"`));
  return lines;
}

/**
 * Two independent halves. `env` is what the browser measured — a terminal pin has
 * none of it, so the line is omitted rather than printed with holes. `git` is the
 * hub's stamp, which every pin carries inside a repo.
 */
function envFacts(env: Pin["env"]): string[] {
  if (env === undefined) return [];
  const lines: string[] = [];
  const { viewport } = env;
  if (viewport !== undefined) {
    const rest = [env.browser, env.os, env.colorScheme].filter((part) => part !== undefined);
    lines.push(row("env", [`${viewport.w}x${viewport.h}@${viewport.dpr}x`, ...rest].join("  ")));
  }
  const git = [env.branch, env.commit?.slice(0, 7)].filter((part) => part !== undefined);
  if (git.length > 0) lines.push(row("git", git.join(" @ ")));
  return lines;
}

function resolutionFacts(resolution: Pin["resolution"]): string[] {
  if (resolution === undefined) return [];
  const note = resolution.note === undefined ? "" : ` — ${resolution.note}`;
  return [row("resolved", `by ${resolution.by}, ${relativeAge(resolution.at)}${note}`)];
}

function threadLines(thread: ThreadMessage[]): string[] {
  const ages = thread.map((message) => relativeAge(message.at));
  const roleWidth = Math.max(...thread.map((message) => message.role.length));
  const ageWidth = Math.max(...ages.map((age) => age.length));
  return thread.map(
    (message, i) =>
      `${message.role.padEnd(roleWidth)}  ${(ages[i] ?? "").padEnd(ageWidth)}  ${message.text}`,
  );
}
