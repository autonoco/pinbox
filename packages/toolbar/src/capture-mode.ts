// @autono/pinbox-toolbar — screenshot capture-mode preference.
// "dom" (default): a no-permission element snapshot (screenshot-dom.ts). "tab": real
// pixels via tab capture, which makes Chrome ask to share the tab once per page load.
// Persisted per endpoint beside the puck's dock, mirror convention: storage never
// throws upward, and a missing/garbled value falls back to the config default.
import type { CaptureMode } from "./state.ts";

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function captureKey(prefix: string): string {
  return `${prefix}:capture`;
}

export function loadCaptureMode(
  storage: StorageLike | null | undefined,
  key: string,
  fallback: CaptureMode,
): CaptureMode {
  try {
    const raw = storage?.getItem(key);
    if (raw === "dom" || raw === "tab") return raw;
  } catch {
    // private mode / quota — the config default it is
  }
  return fallback;
}

export function saveCaptureMode(
  storage: StorageLike | null | undefined,
  key: string,
  mode: CaptureMode,
): void {
  try {
    storage?.setItem(key, mode);
  } catch {
    // session-only, then
  }
}
