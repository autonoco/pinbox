// A newly mounted chat can apply its own initial scroll after the first reveal.
// Keep the selected target visible briefly; any human input immediately wins.
const pending = new WeakMap<Document, () => void>();

export function cancelRevealSettle(doc: Document): void {
  pending.get(doc)?.();
}

export function settlePinReveal(doc: Document, reveal: () => void): void {
  cancelRevealSettle(doc);
  const win = doc.defaultView;
  if (!win) return;
  let attempts = 0;
  let timer = 0;
  const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const stop = () => {
    win.clearTimeout(timer);
    for (const event of events) doc.removeEventListener(event, stop, true);
    pending.delete(doc);
  };
  for (const event of events) doc.addEventListener(event, stop, { capture: true, passive: true });
  const tick = () => {
    reveal();
    if (++attempts >= 10) stop();
    else timer = win.setTimeout(tick, 150);
  };
  pending.set(doc, stop);
  timer = win.setTimeout(tick, 150);
}
