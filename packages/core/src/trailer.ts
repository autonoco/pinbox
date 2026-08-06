// @autono/pinbox-core — commit-trailer resolution.
// Pure parser: no git, no I/O. "Fixes pin_x" in a commit message names a pin the
// trailer verb auto-resolves with the SHA attached. The grammar covers the
// "Fixes pin abc123" idiom, the git-trailer "Resolves: pin_x", and bare "closes pin_x";
// keywords are case-insensitive and word-bounded ("prefixes pin_x" never fires), ids
// are exactly `pin_` + 10 [a-z0-9] with a trailing boundary (lookalikes reject).
// Consumed by the CLI through the `./sessions` subpath — the core
// export table as final, and it has no `./trailer` entry.

const TRAILER = /\b(?:fixes|resolves|closes):?\s+(?:pin\s+)?(pin_[a-z0-9]{10})\b/gi;

/** Unique pin ids named by resolution trailers, in order of appearance. */
export function parseTrailers(message: string): string[] {
  const ids: string[] = [];
  for (const match of message.matchAll(TRAILER)) {
    const id = match[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
