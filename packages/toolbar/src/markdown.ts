// @autono/pinbox-toolbar — copy-as-markdown fallback
// Self-contained serializer (core is a type-only dep) — the zero-setup path into
// any chat agent, wired to the command bar's "copy open pins" affordance. One
// compact block per open pin: status, label, selector, url, text, thread tail.
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";

/** Newest TAIL_LENGTH thread messages make the block; older ones are summarized. */
const TAIL_LENGTH = 3;

/** Squash any text to a single markdown-safe line. */
function line(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function label(pin: Pin): string {
  // A terminal `pinbox pin` captured no element: no anchor, no tag.
  return pin.target?.anchor ?? pin.target?.tag?.toUpperCase() ?? "PIN";
}

function threadTail(thread: ThreadMessage[]): string[] {
  if (thread.length === 0) return [];
  const tail = thread.slice(-TAIL_LENGTH);
  const skipped = thread.length - tail.length;
  return [
    "",
    "Thread:",
    ...(skipped > 0 ? [`- … ${skipped} earlier message${skipped === 1 ? "" : "s"}`] : []),
    ...tail.map((m) => `- ${m.role}: ${line(m.text)}`),
  ];
}

function block(pin: Pin, thread: ThreadMessage[]): string {
  const { selector, url, source } = pin.target ?? {};
  return [
    `## Pin ${pin.id} — OPEN`,
    `- label: ${line(label(pin))}`,
    // Each locus line is present only when the fact is — a terminal pin has a
    // source anchor and no selector; a pin created with no anchor at all has none.
    ...(selector === undefined ? [] : [`- selector: \`${line(selector)}\``]),
    ...(source === undefined
      ? []
      : [
          `- source: ${line(source.line === undefined ? source.file : `${source.file}:${source.line}`)}`,
        ]),
    ...(url === undefined ? [] : [`- url: ${line(url)}`]),
    "",
    `> ${line(pin.text)}`,
    ...threadTail(thread),
  ].join("\n");
}

/** Serialize the open pins (resolved excluded) for pasting into any agent chat. */
export function pinsToMarkdown(pins: Pin[], threads: Map<string, ThreadMessage[]>): string {
  const open = pins.filter((p) => p.status === "open");
  if (open.length === 0) return "No open pins.\n";
  return `${open.map((p) => block(p, threads.get(p.id) ?? [])).join("\n\n")}\n`;
}
