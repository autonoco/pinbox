import type { ModelAnchor } from "@autono/pinbox-core/schema";
export type ModelProjection = (anchor: ModelAnchor) => { x: number; y: number } | null;
const projectors = new WeakMap<Document, Set<ModelProjection>>();
export function registerModelProjection(doc: Document, project: ModelProjection): () => void {
  const set = projectors.get(doc) ?? new Set<ModelProjection>();
  // A fresh wrapper per registration: two viewers sharing one projector function stay
  // independently registered, so destroying either leaves the other's projections intact.
  const entry: ModelProjection = (anchor) => project(anchor);
  set.add(entry);
  projectors.set(doc, set);
  return () => {
    set.delete(entry);
    if (!set.size) projectors.delete(doc);
  };
}
export function projectModelTarget(doc: Document, anchor: ModelAnchor) {
  for (const project of projectors.get(doc) ?? []) {
    const p = project(anchor);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y))
      return { x: p.x, y: p.y, width: 0, height: 0 };
  }
  return null;
}
