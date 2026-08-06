import { describe, expect, test } from "bun:test";
import { PinInputSchema, PinSchema, pinJsonSchema, SCHEMA_VERSION } from "./schema.ts";

/** The hub-assigned fields PinSchema adds on top of a PinInput. */
const stamps = {
  id: "pin_ab12cd34ef",
  schemaVersion: 1,
  status: "open",
  createdAt: "2026-08-05T10:00:00.000Z",
} as const;

const validInput = {
  text: "button is cut off",
  kind: "note",
  target: {
    url: "http://localhost:3000/",
    selector: "main > button.cta",
    tag: "button",
    rect: { x: 120, y: 480, width: 200, height: 48 },
    fixed: false,
  },
  env: {
    viewport: { w: 1440, h: 900, dpr: 2 },
    browser: "Chrome 130",
    os: "macOS",
    colorScheme: "light",
  },
  author: { userId: "bobak" },
};

describe("PinSchema", () => {
  test("accepts a valid input and a valid full pin", () => {
    expect(PinInputSchema.safeParse(validInput).success).toBe(true);
    const full = {
      ...validInput,
      id: "pin_ab12cd34ef",
      schemaVersion: 1,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    expect(PinSchema.safeParse(full).success).toBe(true);
  });
  test("rejects empty text and a bad status", () => {
    expect(PinInputSchema.safeParse({ ...validInput, text: "" }).success).toBe(false);
    expect(
      PinSchema.safeParse({
        ...validInput,
        id: "pin_x",
        schemaVersion: 1,
        status: "claimed",
        createdAt: "now",
      }).success,
    ).toBe(false);
  });
  test("move kind carries from/to rects", () => {
    const move = {
      ...validInput,
      kind: "move",
      move: {
        from: { x: 0, y: 0, width: 10, height: 10 },
        to: { x: 5, y: 5, width: 10, height: 10 },
      },
    };
    expect(PinInputSchema.safeParse(move).success).toBe(true);
  });
  test("attachments field is reserved and round-trips a path-only attachment", () => {
    const withShot = {
      ...validInput,
      attachments: [
        {
          id: "att_1",
          kind: "screenshot",
          path: "/tmp/pinbox/att_1.png",
          contentType: "image/png",
        },
      ],
    };
    const parsed = PinInputSchema.safeParse(withShot);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.attachments?.[0]?.path).toBe("/tmp/pinbox/att_1.png");
  });
  // The v1 widening (schema.ts §"widened in place"): a terminal pin has no browser,
  // so target/env are optional. Both directions must hold — every pin ever written
  // still validates, and a pin with no browser context at all validates too.
  describe("v1 widening: pins without browser context", () => {
    test("a full browser pin still validates unchanged", () => {
      expect(PinInputSchema.safeParse(validInput).success).toBe(true);
      expect(PinSchema.safeParse({ ...validInput, ...stamps }).success).toBe(true);
    });

    test("a terminal pin validates: source anchor, git-only env, no rect", () => {
      const terminal = {
        text: "the footer overlaps on mobile",
        kind: "note",
        target: { source: { file: "src/app.tsx", line: 42, via: "none" } },
        env: { branch: "main", commit: "9c2f1b8" },
        author: { userId: "bobak", name: "Bobak Emamian" },
      };
      const input = PinInputSchema.safeParse(terminal);
      expect(input.success).toBe(true);
      expect(input.data?.target?.source?.file).toBe("src/app.tsx");
      expect(input.data?.target?.url).toBeUndefined();
      expect(input.data?.env?.viewport).toBeUndefined();
      expect(PinSchema.safeParse({ ...terminal, ...stamps }).success).toBe(true);
    });

    test("a pin with neither target nor env validates", () => {
      const bare = { text: "make the onboarding shorter", kind: "note", author: { userId: "cli" } };
      const input = PinInputSchema.safeParse(bare);
      expect(input.success).toBe(true);
      expect(input.data?.target).toBeUndefined();
      expect(input.data?.env).toBeUndefined();
      expect(PinSchema.safeParse({ ...bare, ...stamps }).success).toBe(true);
    });

    test("--url without a browser: a target may carry url alone", () => {
      const urlOnly = {
        text: "pricing page 404s",
        kind: "note",
        target: { url: "https://example.com/pricing", selector: "a.pricing" },
        author: { userId: "bobak" },
      };
      expect(PinInputSchema.safeParse(urlOnly).success).toBe(true);
    });

    test("schemaVersion stays 1 — widening is not a version bump", () => {
      expect(SCHEMA_VERSION).toBe(1);
      expect(PinSchema.safeParse({ ...validInput, ...stamps, schemaVersion: 2 }).success).toBe(
        false,
      );
    });

    test("present-but-wrong fields are still rejected", () => {
      const badRect = { ...validInput, target: { ...validInput.target, rect: { x: 1 } } };
      expect(PinInputSchema.safeParse(badRect).success).toBe(false);
      const badSource = { text: "x", author: { userId: "u" }, target: { source: { line: 3 } } };
      expect(PinInputSchema.safeParse(badSource).success).toBe(false);
    });
  });

  test("emits JSON Schema", () => {
    const js = pinJsonSchema();
    expect(js).toHaveProperty("type", "object");
    expect(JSON.stringify(js)).toContain("attachments");
  });
});
