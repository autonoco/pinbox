// @autono/pinbox-toolbar — SPA view-change watcher.
// Pin markers are anchor-gated (ui/pins.ts): each render re-resolves the
// captured selector and compares the captured URL to the live location. That
// gate only helps if a render actually RUNS when the view changes — and SPA
// tab switches mutate the DOM without any store update. This watcher turns
// "the page changed under us" into one render per frame, max: a MutationObserver
// on document.body (shadow trees are invisible to it, so our own rendering
// never feeds back) plus popstate for history-driven swaps.
export interface AnchorWatch {
  destroy(): void;
}

export function watchAnchors(win: Window, onChange: () => void): AnchorWatch {
  let frame = 0;
  const schedule = (): void => {
    if (frame !== 0) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      onChange();
    });
  };
  // The window's own constructor when it has one (per-test happy-dom Windows
  // are not the global realm), else the global.
  const Observer =
    (win as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver ??
    MutationObserver;
  const observer = new Observer(schedule);
  observer.observe(win.document.body, { childList: true, subtree: true });
  win.addEventListener("popstate", schedule);
  return {
    destroy() {
      observer.disconnect();
      win.removeEventListener("popstate", schedule);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
