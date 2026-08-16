// Human renderings and help text, byte-for-byte from the UX spec transcripts
// (docs/design/cli/v1-transcripts.md). Pure functions — no hub, no daemon.
// setSystemTime pins Date.now so relative ages match the transcripts exactly.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ThreadMessage } from "@autono/pinbox-core/schema";
import { buildProgram } from "../main.ts";
import { countLine, renderList } from "./list.ts";
import { renderShow } from "./show.ts";
import { renderSummary } from "./summary.ts";
import {
  pinBare,
  pinCta,
  pinLogo,
  pinTerminal,
  pinTerms,
  TRANSCRIPT_NOW,
} from "./transcript-fixtures.ts";

afterEach(() => {
  setSystemTime();
});

describe("human renderings", () => {
  test("summary columns", () => {
    expect(renderSummary({ open: 3, resolved: 12, lastEventSeq: 42, sessions: 1 })).toBe(
      ["open        3", "resolved    12", "sessions    1", "last event  #42"].join("\n"),
    );
  });

  test("list columns, all statuses", () => {
    setSystemTime(TRANSCRIPT_NOW);
    expect(renderList([pinCta, pinLogo, pinTerms])).toBe(
      [
        "pin_ab12cd34ef  open      2m ago   main > button.cta  button is cut off",
        "pin_9k3j2h1g0f  open      1h ago   header img.logo    logo is blurry on retina",
        "pin_q8w7e6r5t4  resolved  3h ago   footer a.terms     terms link 404s",
      ].join("\n"),
    );
    expect(countLine([pinCta, pinLogo, pinTerms])).toBe("3 pins (2 open, 1 resolved)");
  });

  test("list columns narrow when only open pins are shown", () => {
    setSystemTime(TRANSCRIPT_NOW);
    expect(renderList([pinCta, pinLogo])).toBe(
      [
        "pin_ab12cd34ef  open  2m ago   main > button.cta  button is cut off",
        "pin_9k3j2h1g0f  open  1h ago   header img.logo    logo is blurry on retina",
      ].join("\n"),
    );
    expect(countLine([pinCta, pinLogo])).toBe("2 pins (2 open)");
  });

  test("empty list renders nothing; the count line stands alone", () => {
    expect(renderList([])).toBe("");
    expect(countLine([])).toBe("0 pins");
  });

  test("show: open pin with thread", () => {
    setSystemTime(TRANSCRIPT_NOW);
    const thread: ThreadMessage[] = [
      {
        id: "msg_7f2k9d3m1p",
        pinId: pinCta.id,
        role: "human",
        text: "button is cut off",
        at: "2026-08-03T17:12:45.120Z",
      },
      {
        id: "msg_2c8n4x6v0b",
        pinId: pinCta.id,
        role: "agent",
        text: "Found it — the CTA overflows its flex parent at <=1280px. Fixing.",
        at: "2026-08-03T17:13:45.120Z",
      },
    ];
    expect(renderShow({ pin: pinCta, thread })).toBe(
      [
        "pin_ab12cd34ef  open  note",
        "text      button is cut off",
        "target    main > button.cta  <button>",
        "url       http://localhost:3000/",
        "rect      120,480 200x48",
        'nearby    "Get started free"',
        "env       1440x900@2x  Chrome 130  macOS  light",
        "git       main @ 9c2f1b8",
        "author    bobak",
        "created   2026-08-03T17:12:45.120Z (2m ago)",
        "",
        "human  2m ago  button is cut off",
        "agent  1m ago  Found it — the CTA overflows its flex parent at <=1280px. Fixing.",
      ].join("\n"),
    );
  });

  test("show: resolved pin adds the resolution facts", () => {
    setSystemTime(TRANSCRIPT_NOW);
    const thread: ThreadMessage[] = [
      {
        id: "msg_7f2k9d3m1p",
        pinId: pinTerms.id,
        role: "human",
        text: "terms link 404s",
        at: "2026-08-03T14:20:11.410Z",
      },
      {
        id: "msg_2c8n4x6v0b",
        pinId: pinTerms.id,
        role: "agent",
        text: "The route moved in the nav refactor. Restoring redirect.",
        at: "2026-08-03T14:58:40.005Z",
      },
    ];
    expect(renderShow({ pin: pinTerms, thread })).toBe(
      [
        "pin_q8w7e6r5t4  resolved  note",
        "text      terms link 404s",
        "target    footer a.terms  <a>",
        "url       http://localhost:3000/",
        "rect      310,2044 64x18",
        "env       1440x900@2x  Chrome 130  macOS  light",
        "git       main @ 9c2f1b8",
        "author    bobak",
        "created   2026-08-03T14:20:11.410Z (3h ago)",
        "resolved  by agent, 2h ago — routed /terms to the new legal page",
        "",
        "human  3h ago  terms link 404s",
        "agent  2h ago  The route moved in the nav refactor. Restoring redirect.",
      ].join("\n"),
    );
  });
});

// `pinbox pin` writes pins with no browser context (core schema.ts §"widened in
// place"). Human rendering keeps its rule — one line per fact THAT EXISTS — so a
// terminal pin never shows an empty column or the string "undefined".
describe("human renderings: terminal pins", () => {
  test("list: the source anchor fills the locus column", () => {
    setSystemTime(TRANSCRIPT_NOW);
    expect(renderList([pinCta, pinTerminal, pinBare])).toBe(
      [
        "pin_ab12cd34ef  open  2m ago   main > button.cta  button is cut off",
        "pin_7x2m9k4d1e  open  1m ago   src/app.tsx:42     the footer overlaps on mobile",
        "pin_3n8v5c2z0q  open  1m ago   —                  make the onboarding shorter",
      ].join("\n"),
    );
  });

  test("show: only the facts a terminal pin has", () => {
    setSystemTime(TRANSCRIPT_NOW);
    expect(renderShow({ pin: pinTerminal, thread: [] })).toBe(
      [
        "pin_7x2m9k4d1e  open  note",
        "text      the footer overlaps on mobile",
        "source    src/app.tsx:42",
        "git       main @ 9c2f1b8",
        "author    bobak@autono.co",
        "created   2026-08-03T17:13:45.120Z (1m ago)",
      ].join("\n"),
    );
  });

  test("show: a pin with no target at all still renders", () => {
    setSystemTime(TRANSCRIPT_NOW);
    const out = renderShow({ pin: pinBare, thread: [] });
    expect(out).toBe(
      [
        "pin_3n8v5c2z0q  open  note",
        "text      make the onboarding shorter",
        "git       main @ 9c2f1b8",
        "author    bobak@autono.co",
        "created   2026-08-03T17:14:15.120Z (1m ago)",
      ].join("\n"),
    );
  });

  test("no rendering ever emits the string undefined", () => {
    setSystemTime(TRANSCRIPT_NOW);
    expect(renderList([pinTerminal, pinBare])).not.toContain("undefined");
    expect(renderShow({ pin: pinTerminal, thread: [] })).not.toContain("undefined");
    expect(renderShow({ pin: pinBare, thread: [] })).not.toContain("undefined");
  });
});

describe("help text", () => {
  test("main help lists the verbs in transcript order with transcript wording", () => {
    const help = buildProgram().helpInformation();
    const lines = [
      /^ {2}pin \[options\] <text>\s+create a pin from the terminal$/m,
      /^ {2}summary\s+counts and the event cursor, in one call$/m,
      /^ {2}list \[options\]\s+list pins, newest first$/m,
      /^ {2}show <id>\s+one pin with its full thread$/m,
      /^ {2}reply \[options\] <id> <text>\s+add a thread message to a pin$/m,
      /^ {2}resolve \[options\] <id>\s+mark a pin resolved$/m,
      /^ {2}export \[options\]\s+write pins to stdout as markdown or JSON$/m,
      /^ {2}doctor\s+probe this machine's capabilities$/m,
      /^ {2}update \[options\]\s+install the latest pinbox CLI$/m,
      /^ {2}help \[command\]\s+display help for command$/m,
    ];
    for (const line of lines) expect(help).toMatch(line);
    const order = [
      "pin",
      "summary",
      "list",
      "show",
      "reply",
      "resolve",
      "export",
      "doctor",
      "update",
    ];
    const positions = order.map((name) => help.indexOf(`\n  ${name}`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(help).not.toContain("\n  serve"); // hidden plumbing stays invisible
  });

  test("per-verb help carries the transcript wording", () => {
    const program = buildProgram();
    const helpFor = (name: string) =>
      program.commands.find((c) => c.name() === name)?.helpInformation() ?? "";

    expect(helpFor("summary")).toContain("Counts and the event cursor, in one call.");
    expect(helpFor("list")).toMatch(
      /--status <status>\s+filter: open or resolved \(default: all\)/,
    );
    expect(helpFor("show")).toMatch(/id\s+pin id \(pin_xxxxxxxxxx\)/);
    expect(helpFor("reply")).toContain("Add a thread message to a pin. Replying never resolves.");
    expect(helpFor("reply")).toMatch(
      /--as <role>\s+author role: human or agent \(default: "human"\)/,
    );
    expect(helpFor("reply")).toMatch(/text\s+the message/);
    expect(helpFor("resolve")).toMatch(
      /--note <text>\s+resolution note \(e\.g\. what changed, or why it won't\)/,
    );
    expect(helpFor("resolve")).toMatch(
      /--as <role>\s+resolver: human or agent \(default: "human"\)/,
    );
    expect(helpFor("export")).toMatch(/--format <format>\s+md or json \(default: "md"\)/);
    expect(helpFor("export")).toMatch(
      /--detail <level>\s+compact, standard, or forensic \(default: "standard"\)/,
    );
    expect(helpFor("export")).toMatch(/--json\s+same as --format json/);
  });

  test("pin help documents the anchor flags and never a browser field", () => {
    const help =
      buildProgram()
        .commands.find((c) => c.name() === "pin")
        ?.helpInformation() ?? "";
    expect(help).toContain("Usage: pinbox pin [options] <text>");
    expect(help).toMatch(/text\s+what needs to change, in your words/);
    expect(help).toMatch(
      /--file <path\[:line\]>\s+anchor to a source location \(recorded repo-relative\)/,
    );
    expect(help).toMatch(/--url <url>\s+the web surface this pin is about/);
    expect(help).toMatch(/--selector <sel>\s+CSS selector on that surface \(needs --url\)/);
    // No flag offers to supply a field a terminal cannot honestly measure —
    // there is no way to hand-write a viewport or a rect through this verb.
    for (const absent of ["--viewport", "--rect", "--browser", "--env", "--os"]) {
      expect(help).not.toContain(absent);
    }
  });
});
