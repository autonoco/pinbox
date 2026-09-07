/** Renderer-neutral 3D annotation adapter. The host owns raycasting, projection and
 * occlusion; Pinbox owns the durable, revision-qualified object-local anchor.
 * No runtime dependency on core or a particular 3D renderer. */
import type { ModelAnchor } from "@autono/pinbox-core/schema";

export type { ModelAnchor };
export type ModelScene = {
  modelId: string;
  revision: string;
  /** Column-major 4x4 object-to-world matrix (e.g. Three.js matrixWorld.elements). */
  partMatrix: (partId: string) => readonly number[] | undefined;
};
export type AnchorResolution =
  | { status: "visible"; worldPosition: [number, number, number] }
  | { status: "stale" | "missing" };
type Matrix16 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export function resolveModelAnchor(anchor: ModelAnchor, scene: ModelScene): AnchorResolution {
  if (anchor.modelId !== scene.modelId || anchor.revision !== scene.revision)
    return { status: "stale" };
  const values = scene.partMatrix(anchor.partId);
  if (values?.length !== 16 || !values.every(Number.isFinite)) return { status: "missing" };
  const m = values as Matrix16;
  const [x, y, z] = anchor.position;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return { status: "missing" };
  const worldPosition: [number, number, number] = [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
  if (!worldPosition.every(Number.isFinite)) return { status: "missing" };
  return { status: "visible", worldPosition };
}

export { attachModelViewer, type ModelViewerAdapter } from "./model-ui.ts";
