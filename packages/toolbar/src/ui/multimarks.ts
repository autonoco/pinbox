// @autono/pinbox-toolbar — shift+click accumulation marks.
// While placing, each shift+click captures an extra target into the pending
// multi-target set (dogfood #29: "there are 3 similar records but I can only
// click on one"). These numbered dashed outlines are the only feedback that the
// capture landed, so they render immediately and live in the viewport-space
// pin layer (captured rects are document-space, so they shift by the scroll
// offset); the placement controller redraws them per frame while placing and
// clears them on commit and on dismiss.
import type { Rect } from "@autono/pinbox-core/schema";

const MARK_CLASS = "pb-multi-mark";

/** Replace the mark set to mirror `targets`; entries with no rect draw nothing. */
export function renderMultiMarks(
  layer: HTMLElement,
  targets: { rect?: Rect }[],
  scroll: { x: number; y: number } = { x: 0, y: 0 },
): void {
  for (const node of [...layer.querySelectorAll(`.${MARK_CLASS}`)]) node.remove();
  targets.forEach((target, i) => {
    const rect = target.rect;
    if (rect === undefined) return;
    const mark = layer.ownerDocument.createElement("div");
    mark.className = MARK_CLASS;
    mark.style.left = `${rect.x - scroll.x}px`;
    mark.style.top = `${rect.y - scroll.y}px`;
    mark.style.width = `${rect.width}px`;
    mark.style.height = `${rect.height}px`;
    mark.innerHTML = `<span>${i + 1}</span>`;
    layer.appendChild(mark);
  });
}
