// pinbox CLI — marker-managed agent blocks.
// Survives ONLY for the non-plugin long tail (research §3.6): Cursor, Copilot.
// CLAUDE.md/AGENTS.md blocks are dead — the plugin skill is the payload now (research §3:
// "the marker block was the delivery hack"). Idempotent section writing between
// <!-- <MARKER>:START --> / <!-- <MARKER>:END --> pairs; user content outside the
// markers is never touched.
import { CliError } from "../errors.ts";
import { PLUGIN_FILES } from "./plugin-assets.ts";

export type MarkerResult = "created" | "replaced" | "appended" | "unchanged";

export const MARKER_TARGETS: readonly { agent: "cursor" | "copilot"; path: string }[] = [
  { agent: "cursor", path: ".cursor/rules/pinbox.mdc" },
  { agent: "copilot", path: ".github/copilot-instructions.md" },
];

/**
 * Create the file if missing; replace the content between this marker's pair;
 * append the block otherwise. Byte-identical result ⇒ "unchanged" (idempotency).
 * Returns a Promise (plan pins a sync signature, but sync fs is `node:`-only and
 * the guest rule keeps `node:` out of pinbox-owned processes).
 * @throws CliError E_CONFLICT when the markers do not form exactly one well-formed pair.
 */
export async function upsertMarkerBlock(
  filePath: string,
  marker: "PINBOX" | "PINBOX:STATUS",
  content: string,
): Promise<MarkerResult> {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const block = `${start}\n${content}\n${end}`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    await Bun.write(filePath, `${block}\n`, { createPath: true });
    return "created";
  }
  const existing = await file.text();
  const span = markerSpan(existing, { filePath, marker, start, end });
  if (span !== null) {
    const next = existing.slice(0, span.startAt) + block + existing.slice(span.endAt + end.length);
    if (next === existing) return "unchanged";
    await Bun.write(filePath, next);
    return "replaced";
  }
  const separator = existing === "" || existing.endsWith("\n") ? "\n" : "\n\n";
  await Bun.write(filePath, `${existing}${separator}${block}\n`);
  return "appended";
}

type MarkerNames = { filePath: string; marker: string; start: string; end: string };

/**
 * The one well-formed `START…END` span to replace, or null when the file has neither marker
 * (⇒ append). Anything else is refused rather than guessed at.
 *
 * This is the guarantee in this file's header, enforced. A hand-edited file can lose its END
 * line; the writer used to fall through to the append branch, leaving TWO STARTs, and the
 * *next* run would then match the orphan START against the appended block's END and replace
 * every byte in between — deleting whatever the user had written there. There is no safe
 * conservative repair: which START opens our block is exactly the information the damage
 * destroyed. So we refuse, touch nothing, and say which line to fix.
 * @throws CliError E_CONFLICT
 */
function markerSpan(
  existing: string,
  names: MarkerNames,
): { startAt: number; endAt: number } | null {
  const { start, end } = names;
  const starts = countOccurrences(existing, start);
  const ends = countOccurrences(existing, end);
  if (starts === 0 && ends === 0) return null;
  if (starts === 1 && ends === 1) {
    const startAt = existing.indexOf(start);
    const endAt = existing.indexOf(end);
    if (endAt > startAt) return { startAt, endAt };
  }
  throw malformedMarkers(names, starts, ends);
}

function malformedMarkers(names: MarkerNames, starts: number, ends: number): CliError {
  const { filePath, marker, start, end } = names;
  const detail =
    starts > 1 || ends > 1
      ? `${starts} ${start} and ${ends} ${end} markers`
      : starts === 1 && ends === 0
        ? `a ${start} with no matching ${end}`
        : starts === 0
          ? `a ${end} with no matching ${start}`
          : `${end} before ${start}`;
  return new CliError(
    "E_CONFLICT",
    `${filePath} has ${detail} — refusing to guess where the ${marker} block ends`,
    `edit ${filePath} so it holds exactly one ${start} … ${end} pair (or delete both lines), then re-run`,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

/**
 * Compact CLI cheatsheet for the marker targets, derived from the embedded generated
 * skill (PLUGIN_FILES) — same source as the plugin payload, so it can never document
 * a command the CLI does not ship.
 */
export function agentCheatsheet(): string {
  const skill = PLUGIN_FILES.find((file) => file.path === "skills/pinbox/SKILL.md")?.contents ?? "";
  const commands = [...skillSection(skill, "Commands").matchAll(/^### pinbox (\S+)\n\n([^\n]+)/gm)]
    .map(([, verb, description]) => `- \`pinbox ${verb}\` - ${description}`)
    .join("\n");
  return [
    "# Pinbox - feedback pins on the live app",
    "",
    skillSection(skill, "Core contract"),
    "",
    "Commands (always pass `--json` and parse the envelope):",
    "",
    commands,
    "",
    "Run `pinbox <command> --help` for options.",
  ].join("\n");
}

/** The body of one `## <name>` section of the generated skill, trimmed. */
function skillSection(skill: string, name: string): string {
  const heading = `\n## ${name}\n`;
  const start = skill.indexOf(heading);
  if (start === -1) return "";
  const from = start + heading.length;
  const next = skill.indexOf("\n## ", from);
  return skill.slice(from, next === -1 ? skill.length : next).trim();
}
