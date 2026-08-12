// @autono/pinbox-core/schema — Zod v4 single-source schemas: Pin, ThreadMessage, SessionRef.
// Produces the exported TS types, trust-boundary validation, and dist/schema.json via z.toJSONSchema().
import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const RectSchema: z.ZodType<{ x: number; y: number; width: number; height: number }> =
  z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  });

export const SessionRefSchema = z.object({
  agent: z.string(),
  key: z.string(),
  cwd: z.string().optional(),
});

// An attachment carries a path or a URL, never bytes — no base64 field exists at any
// version (delivery re-injects open pins every turn; inline bytes would be re-paid
// each time). Declared above ThreadMessageSchema, which references it.
export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["screenshot", "file"]),
  path: z.string().optional(), // local: filesystem path the hub and the agent both can read
  url: z.string().optional(), // cloud: R2 object URL
  contentType: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

/**
 * A change an agent made directly to the live page, rather than to a file.
 *
 * On a project with a repo the agent edits source and the dev server reloads, so the change needs
 * no wire representation. A hosted page has no repo to edit, so the only way an agent can actually
 * change what you are looking at is to say which element and what it should now read.
 *
 * `selector` is the pin's own captured selector, never one the agent chose. `texts` lines up with
 * that element's captured `textRuns`, so pinning a nav bar and asking for all four labels to
 * change is a single edit. Text only, never markup, so this can carry no script.
 */
export const AppliedEditSchema = z.object({
  selector: z.string(),
  /** New text for each of the element's text runs, in order. Length must match, or nothing is applied. */
  texts: z.array(z.string()),
});

export const ThreadMessageSchema = z.object({
  id: z.string(),
  pinId: z.string(),
  role: z.enum(["human", "agent", "mirror"]),
  origin: z.string().optional(),
  text: z.string(),
  edit: AppliedEditSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  at: z.string(),
});

const SourceSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  via: z.enum(["plugin", "framework", "none"]),
});

const ContextSchema = z.object({
  classes: z.array(z.string()).optional(),
  styles: z.record(z.string(), z.string()).optional(),
  aria: z.record(z.string(), z.string()).optional(),
  nearbyText: z.string().optional(),
  selectedText: z.string().optional(),
  /**
   * The pinned element's text, split the way the markup splits it — one entry per element that
   * actually holds words. A heading is one entry; a nav bar is one per link.
   *
   * `nearbyText` runs them together, which is fine to read and useless to edit: it cannot tell an
   * agent that "work approach people contact" is four separate elements. This can, and it is what
   * lets feedback on a group ("capitalise these") reach every item in it.
   */
  textRuns: z.array(z.string()).optional(),
});

// ── Widened in place at v1 — `pinbox pin` (terminal-created pins) ────────────────
// WHAT WIDENED: every browser-derived field below is `.optional()`. On the target:
// url, selector, tag, rect, fixed. On the env: viewport, browser, os, colorScheme.
// And on PinInputSchema itself, `target` and `env` as wholes.
//
// WHY, and why it is not a break: a terminal user has no browser, so there is no
// honest value for a viewport or a bounding rect. Synthesizing `browser: "cli"`,
// `viewport: {w:0,h:0,dpr:1}` would write lies into a versioned contract that agents
// then read back as fact. Absence is the truthful encoding of "not measured".
//
// Relaxing a required field to optional is backwards-compatible in BOTH directions,
// which is why `SCHEMA_VERSION` stays 1 rather than bumping:
//   - old → new: every pin ever written still validates; nothing was removed, no
//     type changed, no field renamed. A stored v1 pin reparses byte-identically.
//   - new → old: the only pins a v1-strict reader would reject are ones created by
//     this new verb, which did not exist before it.
// A version bump would instead force a migration on a store where nothing needs
// migrating — the schema got *more* permissive, and permissiveness is not a break.
//
// WHAT IS STILL EXPECTED: a browser pin sends the full shape. The toolbar has a
// viewport, a rect and a selector, and it must keep sending all of them — these
// fields are optional because one client genuinely lacks them, not because they
// became nice-to-have. Present-but-wrong is still rejected: a `rect` that is present
// must be a complete Rect, a `source` that is present must have `file` and `via`.
// Readers therefore branch on presence (`pin.target?.rect`), never on a sentinel.
const TargetSchema = z.object({
  url: z.string().optional(),
  selector: z.string().optional(),
  tag: z.string().optional(),
  rect: RectSchema.optional(),
  /** Where inside `rect` the click landed, 0–1 on each axis. Absent ⇒ anchor at the centre. */
  spot: z.object({ x: z.number(), y: z.number() }).optional(),
  fixed: z.boolean().optional(),
  anchor: z.string().optional(),
  source: SourceSchema.optional(),
  context: ContextSchema.optional(),
});

const EnvSchema = z.object({
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }).optional(),
  browser: z.string().optional(),
  os: z.string().optional(),
  colorScheme: z.enum(["light", "dark"]).optional(),
  // Not browser-derived: the hub stamps these from git for every pin, terminal
  // or browser, so a terminal pin carries real branch/commit and nothing invented.
  branch: z.string().optional(),
  commit: z.string().optional(),
});

const AuthorSchema = z.object({
  userId: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
});

const ResolutionSchema = z.object({
  by: z.enum(["human", "agent"]),
  note: z.string().optional(),
  commit: z.string().optional(),
  at: z.string(),
});

const VerificationSchema = z.object({
  outcome: z.enum(["accepted", "reopened"]),
  at: z.string(),
});

export const LinkSchema = z.object({
  connector: z.string(),
  ref: z.string(),
  url: z.string(),
});

// What POST /pins accepts: everything user-suppliable — no id/schemaVersion/status/
// createdAt/resolution (those are hub-assigned).
// `target` and `env` are optional per the v1 widening documented at TargetSchema:
// `pinbox pin` creates pins from a terminal, where neither exists to be measured.
// `text` and `author` stay required — both are honest from any client.
export const PinInputSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(["note", "move"]).default("note"),
  target: TargetSchema.optional(),
  move: z.object({ from: RectSchema, to: RectSchema }).optional(),
  env: EnvSchema.optional(),
  author: AuthorSchema,
  agentSession: SessionRefSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
});

export const PinSchema = PinInputSchema.extend({
  id: z.string().regex(/^pin_[a-z0-9]{10}$/),
  schemaVersion: z.literal(1),
  status: z.enum(["open", "resolved"]).default("open"),
  createdAt: z.string(),
  resolution: ResolutionSchema.optional(),
  verification: VerificationSchema.optional(),
  links: z.array(LinkSchema).optional(),
});

export type Rect = z.infer<typeof RectSchema>;
export type Pin = z.infer<typeof PinSchema>;
export type PinInput = z.infer<typeof PinInputSchema>;
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
export type AppliedEdit = z.infer<typeof AppliedEditSchema>;
export type SessionRef = z.infer<typeof SessionRefSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type Link = z.infer<typeof LinkSchema>;

export function pinJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PinSchema) as Record<string, unknown>;
}
