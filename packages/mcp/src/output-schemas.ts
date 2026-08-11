// @autono/pinbox-mcp — declared output shapes for the meta-tools.
//
// Without these a tool hands back a JSON *string* and the model has to parse it. With them the
// shape is advertised in `tools/list` and the data rides in `structuredContent`, so a client can
// read a field instead of a blob.
//
// Every object is **loose**: the CLI's machine output is a versioned contract that gains fields
// over time, and a strict schema would silently strip anything new on its way to the caller.
// Only what the CLI always emits is required; anything conditional is optional.
import { z } from "zod";

const targetSchema = z.looseObject({
  url: z.string().optional(),
  selector: z.string().optional(),
  file: z.string().optional(),
  line: z.number().optional(),
});

/** A pin as `pinbox … --json` emits it. `env`/`author` depend on where the pin was created. */
const pinSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["open", "resolved"]),
  kind: z.string(),
  text: z.string(),
  createdAt: z.string(),
  schemaVersion: z.number(),
  target: targetSchema.optional(),
  env: z.looseObject({ branch: z.string().optional(), commit: z.string().optional() }).optional(),
  author: z
    .looseObject({
      userId: z.string().optional(),
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  resolution: z.looseObject({}).optional(),
});

/** One message on a pin's thread. */
const messageSchema = z.looseObject({
  id: z.string(),
  pinId: z.string(),
  role: z.string(),
  text: z.string(),
  at: z.string(),
});

export const summaryOutput = z.looseObject({
  open: z.number(),
  resolved: z.number(),
  lastEventSeq: z.number(),
  sessions: z.number().optional(),
  connectedToolbars: z.number().optional(),
});

export const listOutput = z.array(pinSchema);
export const showOutput = z.looseObject({ pin: pinSchema, thread: z.array(messageSchema) });
export const replyOutput = messageSchema;
export const resolveOutput = pinSchema;
