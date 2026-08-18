// @autono/pinbox-core/markdown — markdown serializer for agents.
// pinsToMarkdown(pins, level) is the token-budget detail dial: compact is one line per
// pin; standard adds indented fact lines (each present only when the fact exists);
// forensic adds a fenced JSON block per pin carrying target.context + env.
// Output is byte-for-byte the UX spec: docs/design/cli/v1-transcripts.md §export.
// Attachments render as their PATH at standard and above — never inlined.
//
// Every field of `target` and `env` is optional at v1 (schema.ts §"widened in place"):
// a `pinbox pin` pin has no browser, so it has no selector, rect or viewport. The rule
// the standard level already followed per-line — print a fact only when it exists — now
// governs the headline and the forensic block too. Nothing here ever renders the string
// "undefined": a missing fact produces no line, not an empty one.
import type { Pin } from "./schema.ts";

export type DetailLevel = "compact" | "standard" | "forensic";

export function pinsToMarkdown(pins: Pin[], level: DetailLevel): string {
  return pins.map((pin) => pinToMarkdown(pin, level).join("\n")).join("\n");
}

function pinToMarkdown(pin: Pin, level: DetailLevel): string[] {
  const lines = [headline(pin)];
  if (level === "compact") return lines;
  lines.push(...standardFacts(pin));
  if (level === "standard") return lines;
  lines.push(...forensicBlock(pin));
  return lines;
}

/** `- [open] <where> — <text> (<id>)`, minus the locus when the pin names no place.
 * A multi-target pin's headline carries every extra locus inline — the compact dial
 * is what briefs inject, and the pattern ("three identical rows") IS the feedback. */
function headline(pin: Pin): string {
  const where = pinLocus(pin);
  const extras = extraLoci(pin);
  const plus = extras.length === 0 ? "" : ` (+${extras.join(", ")})`;
  const head = where === undefined ? "" : `${where}${plus} — `;
  return `- [${pin.status}] ${head}${pin.text} (${pin.id})`;
}

/** The extra loci of a multi-target pin, named like pinLocus names the anchor. */
function extraLoci(pin: Pin): string[] {
  return (pin.target?.targets ?? [])
    .map((t) => t.selector ?? t.anchor ?? t.tag)
    .filter((locus): locus is string => locus !== undefined);
}

/** The indented context lines, each present only when the fact behind it exists. */
function standardFacts(pin: Pin): string[] {
  const target = pin.target;
  const lines: string[] = [];
  if (target?.url !== undefined) lines.push(`  - url: ${target.url}`);
  const source = sourceRef(pin);
  if (source !== undefined) lines.push(`  - source: ${source}`);
  const rect = target?.rect;
  if (rect) lines.push(`  - rect: ${rect.x},${rect.y} ${rect.width}x${rect.height}`);
  const nearby = target?.context?.nearbyText;
  if (nearby !== undefined) lines.push(`  - nearby: "${nearby}"`);
  return lines;
}

/**
 * The fenced JSON record: target.context + env. A terminal pin with no git stamp and
 * no context has nothing to record — it gets no fence, because an empty one is noise
 * the agent still pays tokens for.
 */
function forensicBlock(pin: Pin): string[] {
  const forensic: Record<string, unknown> = {};
  if (pin.target?.context) forensic["context"] = pin.target.context;
  if (pin.env && Object.keys(pin.env).length > 0) forensic["env"] = pin.env;
  if (Object.keys(forensic).length === 0) return [];
  const block = renderJson(forensic, 0).split("\n");
  return ["", "  ```json", ...block.map((line) => `  ${line}`), "  ```"];
}

/**
 * The "where" in the headline, most specific first: a browser pin has a selector, a
 * terminal `--file` pin has a source anchor, a `--url` pin has a URL. A pin with none
 * of them is still a valid pin — the headline just drops the locus and its separator.
 * Exported so every one-line pin summary (delivery/context.ts, the CLI's list) names
 * a pin the same way.
 */
export function pinLocus(pin: Pin): string | undefined {
  return pin.target?.selector ?? sourceRef(pin) ?? pin.target?.url;
}

function sourceRef(pin: Pin): string | undefined {
  const source = pin.target?.source;
  if (source === undefined) return undefined;
  return source.line === undefined ? source.file : `${source.file}:${source.line}`;
}

// The transcripts pretty-print forensic JSON with leaf objects inlined when they fit
// (`"viewport": { "w": 1440, "h": 900, "dpr": 2 }`) — a plain JSON.stringify(_, null, 2)
// puts every key on its own line. `indent` is the structural indent multiline children
// hang from; `cursor` is the column the value starts at (after any `"key": ` prefix),
// which is what the fits-inline check measures.
const INLINE_WIDTH = 80;

function renderJson(value: unknown, indent: number, cursor: number = indent): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inline = inlineJson(value);
  if (cursor + inline.length <= INLINE_WIDTH) return inline;
  const pad = " ".repeat(indent + 2);
  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}${renderJson(item, indent + 2)}`);
    return `[\n${items.join(",\n")}\n${" ".repeat(indent)}]`;
  }
  const items = jsonEntries(value).map(([key, item]) => {
    const name = JSON.stringify(key);
    return `${pad}${name}: ${renderJson(item, indent + 2, indent + 2 + name.length + 2)}`;
  });
  return `{\n${items.join(",\n")}\n${" ".repeat(indent)}}`;
}

function inlineJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(", ")}]`;
  const entries = jsonEntries(value);
  if (entries.length === 0) return "{}";
  const items = entries.map(([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`);
  return `{ ${items.join(", ")} }`;
}

function jsonEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value).filter(([, item]) => item !== undefined);
}
