// @autono/pinbox-core — id generation
// newId("pin" | "msg" | "ses" | "att") — prefix + 10 base36 chars from crypto.getRandomValues.
// Prefix union is pinned final ("ses" sessions, "att" attachments).
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(prefix: "pin" | "msg" | "ses" | "att"): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return `${prefix}_${out}`;
}
