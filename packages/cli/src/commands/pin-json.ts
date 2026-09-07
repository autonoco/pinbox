import {
  type ModelAnchor,
  ModelAnchorSchema,
  type PinInput,
  PinInputSchema,
} from "@autono/pinbox-core/schema";
import { CliError } from "../errors.ts";
import { usageHint } from "./flags.ts";
export function modelFromJson(raw: string): ModelAnchor {
  try {
    return ModelAnchorSchema.parse(JSON.parse(raw));
  } catch {
    throw new CliError(
      "E_INVALID_INPUT",
      "--model-anchor needs valid modelId, revision, partId, position [x,y,z] and units JSON",
      usageHint("pin"),
    );
  }
}
/** Intended for a trusted server bridging its authenticated user into the local CLI.
 * This is an asserted identity, not an authentication mechanism. JWT-authenticated hubs
 * retain authority to replace it with the verified identity. */
export function authorFromJson(raw: string): PinInput["author"] {
  try {
    return PinInputSchema.shape.author.parse(JSON.parse(raw));
  } catch {
    throw new CliError(
      "E_INVALID_INPUT",
      "--author-json needs a userId and optional name/email JSON",
      usageHint("pin"),
    );
  }
}
