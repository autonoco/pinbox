// Shared TEST fixtures lifted verbatim from the UX spec transcripts
// (docs/design/cli/v1-transcripts.md). Imported only by *.test.ts files.
import type { Pin, PinInput } from "@autono/pinbox-core/schema";

/** The "now" every transcript age is relative to: pin_ab12cd34ef is "2m ago". */
export const TRANSCRIPT_NOW = new Date("2026-08-03T17:14:45.120Z");

const transcriptEnv = {
  viewport: { w: 1440, h: 900, dpr: 2 },
  browser: "Chrome 130",
  os: "macOS",
  colorScheme: "light",
  branch: "main",
  commit: "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b",
} as const;

export const pinCta: Pin = {
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
  env: transcriptEnv,
  author: { userId: "bobak" },
  createdAt: "2026-08-03T17:12:45.120Z",
};

export const pinLogo: Pin = {
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
  env: transcriptEnv,
  author: { userId: "bobak" },
  createdAt: "2026-08-03T16:09:02.881Z",
};

export const pinTerms: Pin = {
  id: "pin_q8w7e6r5t4",
  schemaVersion: 1,
  text: "terms link 404s",
  kind: "note",
  status: "resolved",
  target: {
    url: "http://localhost:3000/",
    selector: "footer a.terms",
    tag: "a",
    rect: { x: 310, y: 2044, width: 64, height: 18 },
    fixed: false,
  },
  env: transcriptEnv,
  author: { userId: "bobak" },
  resolution: {
    by: "agent",
    note: "routed /terms to the new legal page",
    at: "2026-08-03T15:03:27.940Z",
  },
  createdAt: "2026-08-03T14:20:11.410Z",
};

/**
 * A `pinbox pin` pin: no browser, so no viewport and no rect (core schema.ts
 * §"widened in place"). env carries only the hub's git stamp — nothing invented.
 */
export const pinTerminal: Pin = {
  id: "pin_7x2m9k4d1e",
  schemaVersion: 1,
  text: "the footer overlaps on mobile",
  kind: "note",
  status: "open",
  target: { source: { file: "src/app.tsx", line: 42, via: "none" } },
  env: { branch: "main", commit: "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b" },
  author: { userId: "bobak@autono.co", name: "Bobak Emamian", email: "bobak@autono.co" },
  createdAt: "2026-08-03T17:13:45.120Z",
};

/** The same verb with no anchor at all: text, author, git stamp, nothing else. */
export const pinBare: Pin = {
  id: "pin_3n8v5c2z0q",
  schemaVersion: 1,
  text: "make the onboarding shorter",
  kind: "note",
  status: "open",
  env: { branch: "main", commit: "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b" },
  author: { userId: "bobak@autono.co" },
  createdAt: "2026-08-03T17:14:15.120Z",
};

export const validInput: PinInput = {
  text: "button is cut off",
  kind: "note",
  target: pinCta.target,
  env: transcriptEnv,
  author: { userId: "bobak" },
};
