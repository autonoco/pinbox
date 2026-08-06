// @autono/pinbox-toolbar — tiny HTML helpers shared by the ui/* renderers.
// Ports the prototype's esc() (docs/design/toolbar/v2-command-bar.html line 330):
// every hub- or user-supplied string is escaped before entering innerHTML.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Escape text for safe inclusion in innerHTML strings. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"]/g, (m) => ESCAPES[m] as string);
}

/**
 * Allowlist a URL for use in href/src attributes. `esc()` alone is NOT enough for URL
 * attributes: `javascript:alert(1)` contains no `&<>"` characters, so it survives HTML
 * escaping intact — and link/attachment URLs are hub data that connectors (and, in cloud,
 * other users) populate. Relative URLs and http(s) pass; every other scheme yields "".
 */
export function safeUrl(value: unknown): string {
  // Strip ASCII control characters FIRST: the URL parser in every browser deletes TAB/LF/CR
  // (and leading C0 controls) before scheme detection, so `java\tscript:alert(1)` reads as a
  // relative URL to a naive regex while the browser executes it. Match the browser: remove
  // C0 controls everywhere, then trim, then detect the scheme on what the browser would see.
  const raw = String(value ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate — mirrors the WHATWG URL parser's control-char stripping
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  if (raw === "") return "";
  // Scheme present? Only http/https survive. (Scheme-less = relative URL, allowed.)
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (scheme !== null && !/^https?$/i.test(scheme[1] as string)) return "";
  return raw;
}

/** Two-digit pin number, prototype-style: 1 → "01". */
export function pinNumber(n: number): string {
  return String(n).padStart(2, "0");
}
