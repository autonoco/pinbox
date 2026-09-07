import { captureKey, saveCaptureMode } from "./capture-mode.ts";
import type { Store } from "./state.ts";

type CaptureOwner = { store: Store };
type CaptureHandler = {
  run: () => void | Promise<void>;
  error: (error: unknown) => void;
  busy: boolean;
};
const handlers = new WeakMap<CaptureOwner, CaptureHandler[]>();

/** The first viewer owns the camera until another registered surface is entered. */
export function registerModelCapture(
  owner: CaptureOwner,
  run: CaptureHandler["run"],
  error: CaptureHandler["error"],
) {
  const entry: CaptureHandler = { run, error, busy: false };
  const entries = handlers.get(owner) ?? [];
  entries.push(entry);
  handlers.set(owner, entries);
  owner.store.update({ captureLabel: "Capture model screenshot (S)" });
  return {
    activate() {
      const index = entries.indexOf(entry);
      if (index < 0) return;
      entries.splice(index, 1);
      entries.unshift(entry);
    },
    destroy() {
      const index = entries.indexOf(entry);
      if (index < 0) return;
      entries.splice(index, 1);
      if (!entries.length) {
        handlers.delete(owner);
        owner.store.update({ captureLabel: undefined });
      }
    },
  };
}

function runModelCapture(owner: CaptureOwner): boolean {
  const entries = handlers.get(owner);
  const entry = entries?.[0];
  if (!entries || !entry) return false;
  if (entries.some((candidate) => candidate.busy)) return true;
  entry.busy = true;
  try {
    Promise.resolve(entry.run())
      .catch(entry.error)
      .finally(() => {
        entry.busy = false;
      });
  } catch (error) {
    entry.busy = false;
    entry.error(error);
  }
  return true;
}

/** Shared by the camera button, puck and S shortcut; preserve the 2D fallback. */
export function toggleToolbarCapture(
  owner: CaptureOwner,
  endpoint: string,
  release: () => void,
): true {
  if (runModelCapture(owner)) return true;
  const next = owner.store.get().captureMode === "tab" ? "dom" : "tab";
  owner.store.update({ captureMode: next });
  if (next === "dom") release();
  saveCaptureMode(globalThis.localStorage, captureKey(`pinbox:${endpoint}`), next);
  return true;
}
