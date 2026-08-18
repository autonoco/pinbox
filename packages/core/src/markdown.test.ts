// Byte-for-byte against docs/design/cli/v1-transcripts.md §export — the transcripts
// are the UX spec; every expected string below is lifted from them verbatim.
import { describe, expect, test } from "bun:test";
import { pinsToMarkdown } from "./markdown.ts";
import type { Pin } from "./schema.ts";

const env = {
  viewport: { w: 1440, h: 900, dpr: 2 },
  browser: "Chrome 130",
  os: "macOS",
  colorScheme: "light",
  branch: "main",
  commit: "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b",
} as const;

const pinCta: Pin = {
  id: "pin_ab12cd34ef",
  schemaVersion: 1,
  text: "button is cut off",
  kind: "note",
  status: "open",
  target: {
    url: "http://localhost:3000/",
    selector: "main > button.cta",
    tag: "button",
    rect: { x: 120, y: 480, width: 200, height: 48 },
    fixed: false,
    context: { nearbyText: "Get started free" },
  },
  env,
  author: { userId: "bobak" },
  createdAt: "2026-08-03T17:12:45.120Z",
};

const pinLogo: Pin = {
  id: "pin_9k3j2h1g0f",
  schemaVersion: 1,
  text: "logo is blurry on retina",
  kind: "note",
  status: "open",
  target: {
    url: "http://localhost:3000/",
    selector: "header img.logo",
    tag: "img",
    rect: { x: 24, y: 12, width: 96, height: 32 },
    fixed: true,
  },
  env,
  author: { userId: "bobak" },
  createdAt: "2026-08-03T16:09:02.881Z",
};

describe("pinsToMarkdown", () => {
  test("compact: one line per pin", () => {
    expect(pinsToMarkdown([pinCta, pinLogo], "compact")).toBe(
      [
        "- [open] main > button.cta — button is cut off (pin_ab12cd34ef)",
        "- [open] header img.logo — logo is blurry on retina (pin_9k3j2h1g0f)",
      ].join("\n"),
    );
  });

  test("compact: status renders resolved pins as [resolved]", () => {
    const resolved: Pin = { ...pinCta, status: "resolved" };
    expect(pinsToMarkdown([resolved], "compact")).toBe(
      "- [resolved] main > button.cta — button is cut off (pin_ab12cd34ef)",
    );
  });

  test("standard: indented facts, each present only when it exists", () => {
    expect(pinsToMarkdown([pinCta, pinLogo], "standard")).toBe(
      [
        "- [open] main > button.cta — button is cut off (pin_ab12cd34ef)",
        "  - url: http://localhost:3000/",
        "  - rect: 120,480 200x48",
        '  - nearby: "Get started free"',
        "- [open] header img.logo — logo is blurry on retina (pin_9k3j2h1g0f)",
        "  - url: http://localhost:3000/",
        "  - rect: 24,12 96x32",
      ].join("\n"),
    );
  });

  test("standard: a captured source file renders between url and rect", () => {
    const withSource: Pin = {
      ...pinCta,
      target: {
        ...pinCta.target,
        source: { file: "src/components/Cta.tsx", line: 42, via: "plugin" },
      },
    };
    expect(pinsToMarkdown([withSource], "standard")).toBe(
      [
        "- [open] main > button.cta — button is cut off (pin_ab12cd34ef)",
        "  - url: http://localhost:3000/",
        "  - source: src/components/Cta.tsx:42",
        "  - rect: 120,480 200x48",
        '  - nearby: "Get started free"',
      ].join("\n"),
    );
  });

  test("forensic: fenced JSON block per pin with target.context + env", () => {
    expect(pinsToMarkdown([pinCta, pinLogo], "forensic")).toBe(
      [
        "- [open] main > button.cta — button is cut off (pin_ab12cd34ef)",
        "  - url: http://localhost:3000/",
        "  - rect: 120,480 200x48",
        '  - nearby: "Get started free"',
        "",
        "  ```json",
        "  {",
        '    "context": { "nearbyText": "Get started free" },',
        '    "env": {',
        '      "viewport": { "w": 1440, "h": 900, "dpr": 2 },',
        '      "browser": "Chrome 130",',
        '      "os": "macOS",',
        '      "colorScheme": "light",',
        '      "branch": "main",',
        '      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"',
        "    }",
        "  }",
        "  ```",
        "- [open] header img.logo — logo is blurry on retina (pin_9k3j2h1g0f)",
        "  - url: http://localhost:3000/",
        "  - rect: 24,12 96x32",
        "",
        "  ```json",
        "  {",
        '    "env": {',
        '      "viewport": { "w": 1440, "h": 900, "dpr": 2 },',
        '      "browser": "Chrome 130",',
        '      "os": "macOS",',
        '      "colorScheme": "light",',
        '      "branch": "main",',
        '      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"',
        "    }",
        "  }",
        "  ```",
      ].join("\n"),
    );
  });

  test("empty pin list renders an empty document", () => {
    expect(pinsToMarkdown([], "compact")).toBe("");
    expect(pinsToMarkdown([], "forensic")).toBe("");
  });
});

// A `pinbox pin` pin has no browser, so target/env are absent or partial (the v1
// widening — schema.ts). Every level must render it as facts-that-exist, never as
// the string "undefined". Same rule the standard level already applied per-line,
// now applied to the headline and to env too.
describe("pinsToMarkdown: terminal pins (no browser context)", () => {
  const terminal: Pin = {
    id: "pin_t1t2t3t4t5",
    schemaVersion: 1,
    text: "the footer overlaps on mobile",
    kind: "note",
    status: "open",
    target: { source: { file: "src/app.tsx", line: 42, via: "none" } },
    env: { branch: "main", commit: "9c2f1b8" },
    author: { userId: "bobak" },
    createdAt: "2026-08-05T09:00:00.000Z",
  };

  const bare: Pin = {
    id: "pin_b1b2b3b4b5",
    schemaVersion: 1,
    text: "make the onboarding shorter",
    kind: "note",
    status: "open",
    author: { userId: "bobak" },
    createdAt: "2026-08-05T09:05:00.000Z",
  };

  test("compact: the source anchor stands in for the selector", () => {
    expect(pinsToMarkdown([terminal], "compact")).toBe(
      "- [open] src/app.tsx:42 — the footer overlaps on mobile (pin_t1t2t3t4t5)",
    );
  });

  test("compact: no target at all drops the locus, never prints undefined", () => {
    expect(pinsToMarkdown([bare], "compact")).toBe(
      "- [open] make the onboarding shorter (pin_b1b2b3b4b5)",
    );
  });

  test("standard: only the facts that exist — no url line, no rect line", () => {
    expect(pinsToMarkdown([terminal], "standard")).toBe(
      [
        "- [open] src/app.tsx:42 — the footer overlaps on mobile (pin_t1t2t3t4t5)",
        "  - source: src/app.tsx:42",
      ].join("\n"),
    );
    expect(pinsToMarkdown([bare], "standard")).toBe(
      "- [open] make the onboarding shorter (pin_b1b2b3b4b5)",
    );
  });

  test("forensic: env block carries the real git stamp and nothing invented", () => {
    expect(pinsToMarkdown([terminal], "forensic")).toBe(
      [
        "- [open] src/app.tsx:42 — the footer overlaps on mobile (pin_t1t2t3t4t5)",
        "  - source: src/app.tsx:42",
        "",
        "  ```json",
        // The house pretty-printer inlines an object that fits in 80 columns — a
        // terminal pin's whole forensic record does, where a browser env never does.
        '  { "env": { "branch": "main", "commit": "9c2f1b8" } }',
        "  ```",
      ].join("\n"),
    );
  });

  test("forensic: nothing to record emits no empty fence", () => {
    expect(pinsToMarkdown([bare], "forensic")).toBe(
      "- [open] make the onboarding shorter (pin_b1b2b3b4b5)",
    );
    const emptyEnv: Pin = { ...bare, env: {} };
    expect(pinsToMarkdown([emptyEnv], "forensic")).toBe(
      "- [open] make the onboarding shorter (pin_b1b2b3b4b5)",
    );
  });

  test("a --url pin with no rect: url renders, rect does not", () => {
    const urlOnly: Pin = { ...bare, target: { url: "https://example.com/pricing" } };
    expect(pinsToMarkdown([urlOnly], "standard")).toBe(
      [
        "- [open] https://example.com/pricing — make the onboarding shorter (pin_b1b2b3b4b5)",
        "  - url: https://example.com/pricing",
      ].join("\n"),
    );
  });

  test("no level ever emits the string undefined", () => {
    for (const level of ["compact", "standard", "forensic"] as const) {
      expect(pinsToMarkdown([terminal, bare], level)).not.toContain("undefined");
    }
  });
});

describe("multi-target pins", () => {
  test("compact headline carries every extra locus — briefs must show the pattern", () => {
    const pin: Pin = {
      ...pinCta,
      target: {
        ...pinCta.target,
        targets: [{ selector: "main > button.cta:nth-of-type(2)" }, { tag: "button" }],
      },
    };
    expect(pinsToMarkdown([pin], "compact")).toBe(
      "- [open] main > button.cta (+main > button.cta:nth-of-type(2), button) — button is cut off (pin_ab12cd34ef)",
    );
    // single-target pins keep the exact old headline
    expect(pinsToMarkdown([pinCta], "compact")).toBe(
      "- [open] main > button.cta — button is cut off (pin_ab12cd34ef)",
    );
  });
});
