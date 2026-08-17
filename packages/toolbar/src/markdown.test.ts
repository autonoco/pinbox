// @autono/pinbox-toolbar — copy-as-markdown tests.
import { describe, expect, test } from "bun:test";
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import { pinsToMarkdown, pinToMarkdown } from "./markdown.ts";

function makePin(id: string, overrides: Partial<Pin> = {}): Pin {
  return {
    id,
    schemaVersion: 1,
    status: "open",
    createdAt: "2026-08-04T00:00:00.000Z",
    text: "Break the headline onto two lines.",
    kind: "note",
    target: {
      url: "http://localhost:5173/",
      selector: "#hero",
      tag: "div",
      rect: { x: 100, y: 200, width: 50, height: 20 },
      fixed: false,
    },
    env: {
      viewport: { w: 1280, h: 800, dpr: 2 },
      browser: "test",
      os: "test",
      colorScheme: "dark",
    },
    author: { userId: "u1" },
    ...overrides,
  };
}

function makeMsg(
  id: string,
  pinId: string,
  role: ThreadMessage["role"],
  text: string,
): ThreadMessage {
  return { id, pinId, role, text, at: "2026-08-04T10:00:00.000Z" };
}

describe("pinsToMarkdown", () => {
  test("one compact block per open pin, exact shape", () => {
    const pin = makePin("pin_aaaaaaaaaa");
    const resolved = makePin("pin_bbbbbbbbbb", {
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T11:00:00.000Z" },
    });
    const threads = new Map([
      [
        pin.id,
        [
          makeMsg("msg_1111111111", pin.id, "human", "Any progress?"),
          makeMsg("msg_2222222222", pin.id, "agent", "Split it at the comma."),
        ],
      ],
    ]);
    expect(pinsToMarkdown([pin, resolved], threads)).toBe(
      "## Pin pin_aaaaaaaaaa — OPEN\n" +
        "- label: DIV\n" +
        "- selector: `#hero`\n" +
        "- url: http://localhost:5173/\n" +
        "\n" +
        "> Break the headline onto two lines.\n" +
        "\n" +
        "Thread:\n" +
        "- human: Any progress?\n" +
        "- agent: Split it at the comma.\n",
    );
  });

  test("resolved pins are excluded entirely", () => {
    const resolved = makePin("pin_bbbbbbbbbb", {
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T11:00:00.000Z" },
    });
    expect(pinsToMarkdown([resolved], new Map())).toBe("No open pins.\n");
  });
});

describe("pinToMarkdown", () => {
  test("one block, any status — you copy exactly the pin you are looking at", () => {
    const resolved = makePin("pin_bbbbbbbbbb", {
      status: "resolved",
      resolution: { by: "agent", at: "2026-08-04T11:00:00.000Z" },
    });
    const md = pinToMarkdown(resolved, [
      makeMsg("msg_1111111111", resolved.id, "human", "Any progress?"),
    ]);
    expect(md).toContain("## Pin pin_bbbbbbbbbb — RESOLVED");
    expect(md).toContain("- human: Any progress?");
    expect(md.endsWith("\n")).toBe(true);
  });
});
