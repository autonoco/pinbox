import { z } from "zod";

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
/** A point in a named part's LOCAL coordinates, pinned to an immutable model revision.
 * No implicit reprojection across edits: hosts must explicitly migrate stale anchors. */
export const ModelAnchorSchema = z
  .object({
    modelId: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    partId: z.string().min(1).max(256),
    position: vector,
    normal: vector.refine((v) => Math.hypot(...v) > 0, "normal must be nonzero").optional(),
    units: z.enum(["mm", "cm", "m", "in"]),
    faceIndex: z.number().int().nonnegative().optional(),
    camera: z.object({ position: vector, target: vector, up: vector }).optional(),
  })
  .strict();
export type ModelAnchor = z.infer<typeof ModelAnchorSchema>;
