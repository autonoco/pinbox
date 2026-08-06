// @autono/pinbox-toolbar — client state
// Plain observable store, no framework. Pin creation is transactional: a placed
// pin is a client-only Draft until its first comment submits (commitDraft); an
// abandoned draft (esc / click-away / close) is discarded and never reaches the
// hub — ports dropEmpty from docs/design/toolbar/v2-command-bar.html (lines 466–472).
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import type { CaptureResult } from "./capture.ts";

export type UiStatus = "open" | "waiting" | "replied" | "resolved" | "verify";

export interface Draft {
  target: CaptureResult;
  placedAt: { x: number; y: number };
}

export interface ToolbarState {
  pins: Pin[];
  threads: Map<string, ThreadMessage[]>;
  draft: Draft | null;
  mode: "idle" | "placing";
  activePinId: string | null;
  inboxOpen: boolean;
  connection: "connecting" | "live" | "offline" | "incompatible";
  /** Outbox-queued pin ids (offline creates) — flagged "queued" in the UI until the flush. */
  queuedIds: ReadonlySet<string>;
}

export interface Store {
  get(): ToolbarState;
  /** Render subscribes once; every update() notifies each subscriber exactly once. */
  subscribe(fn: (state: ToolbarState) => void): () => void;
  update(patch: Partial<ToolbarState>): void;
  /** Placement click: sets the draft and leaves placing mode. Client-only — no hub call. */
  place(draft: Draft): void;
  /** Abandoned draft: cleared without touching pins; nothing ever reached the hub. */
  discardDraft(): void;
  /** First comment submitted: the hub-created Pin replaces the draft and becomes active. */
  commitDraft(pin: Pin): void;
}

export function initialState(): ToolbarState {
  return {
    pins: [],
    threads: new Map(),
    draft: null,
    mode: "idle",
    activePinId: null,
    inboxOpen: false,
    connection: "connecting",
    queuedIds: new Set(),
  };
}

export function createStore(): Store {
  let state = initialState();
  const subscribers = new Set<(s: ToolbarState) => void>();

  function commit(next: ToolbarState): void {
    state = next;
    for (const fn of subscribers) fn(state);
  }

  return {
    get: () => state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    update(patch) {
      commit({ ...state, ...patch });
    },
    place(draft) {
      commit({ ...state, draft, mode: "idle", activePinId: null });
    },
    discardDraft() {
      commit({ ...state, draft: null });
    },
    commitDraft(pin) {
      const pins = state.pins.some((p) => p.id === pin.id)
        ? state.pins.map((p) => (p.id === pin.id ? pin : p))
        : [...state.pins, pin];
      commit({ ...state, pins, draft: null, activePinId: pin.id });
    },
  };
}

/** Replace-by-id upsert; new pins append. */
export function upsertPin(store: Store, pin: Pin): void {
  const pins = store.get().pins;
  store.update({
    pins: pins.some((p) => p.id === pin.id)
      ? pins.map((p) => (p.id === pin.id ? pin : p))
      : [...pins, pin],
  });
}

/** Append to the pin's thread, deduping by message id (REST echo vs WS event). */
export function appendThreadMessage(store: Store, message: ThreadMessage): void {
  const state = store.get();
  const thread = state.threads.get(message.pinId) ?? [];
  if (thread.some((m) => m.id === message.id)) return;
  const threads = new Map(state.threads);
  threads.set(message.pinId, [...thread, message]);
  store.update({ threads });
}

/**
 * Wire events mutate the store: pin.created upserts;
 * pin.resolved / pin.verified / pin.linked replace the payload Pin;
 * thread.message appends — payloads are the full post-mutation objects.
 */
export function applyHubEvent(
  store: Store,
  event: { seq: number; eventType: string; at: string; payload: unknown },
): void {
  if (event.eventType === "thread.message") {
    appendThreadMessage(store, event.payload as ThreadMessage);
    return;
  }
  const pin = event.payload as Pin | undefined;
  if (typeof pin?.id !== "string") return; // unknown future event type — additive-safe
  upsertPin(store, pin);
}

/**
 * Wire-status → UI-status mapping:
 * resolved + no verification ⇒ "verify" (accept/reopen prompt);
 * resolved + verification ⇒ "resolved";
 * open + empty thread or last message human ⇒ "waiting";
 * open + last message agent|mirror ⇒ "replied".
 * The prototype's WORKING/APPLIED chips need an event vocabulary the hub does not emit — excluded here.
 */
export function deriveUiStatus(pin: Pin, thread: ThreadMessage[]): UiStatus {
  if (pin.status === "resolved") return pin.verification ? "resolved" : "verify";
  const last = thread[thread.length - 1];
  if (!last || last.role === "human") return "waiting";
  return "replied";
}
