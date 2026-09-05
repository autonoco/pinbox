// @autono/pinbox-toolbar — client state
// Plain observable store, no framework. Pin creation is transactional: a placed
// pin is a client-only Draft until its first comment submits (commitDraft); an
// abandoned draft (esc / click-away / close) is discarded and never reaches the
// hub — ports dropEmpty from docs/design/toolbar/v2-command-bar.html (lines 466–472).
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import type { Session } from "@autono/pinbox-core/sessions";
import type { CaptureResult } from "./capture.ts";

export type UiStatus = "open" | "waiting" | "replied" | "resolved" | "verify" | "note" | "stale";

/** While the last word is yours and this young, the card shows the THINKING dots. */
export const THINKING_MS = 90_000;
/** Past this with no reply, the pin is stale: NO RESPONSE, with Nudge and Resolve. */
export const STALE_AFTER_MS = 10 * 60_000;
/** A session seen more recently than this counts as an agent that is listening. */
const AGENT_LIVE_MS = 15 * 60_000;

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
  /**
   * Bar collapsed to the floating puck. The RESTING state only — the minimize
   * controller owns transitions and writes this when a toggle settles; pins,
   * chips, and cards stay live either way.
   */
  minimized: boolean;
  /**
   * Pin markers hidden (dogfood ask: "usually you can hide comments"). The
   * overlay layer only — the drawer still lists everything, and placing a new
   * pin unhides so the marker you just dropped is never invisible.
   */
  pinsHidden: boolean;
  /**
   * Wall clock, refreshed by the element every 30 s while connected (and on connect). 0 until
   * then, which means "unknown": nothing is ever stale against an unknown clock, so tests that
   * never tick see exactly the pre-clock behaviour. Living in state, a tick is a render.
   */
  clock: number;
  /**
   * Is an agent session listening on the hub? From GET /sessions on each (re)connect; null
   * until the first answer. With nobody listening, a pin goes stale after THINKING_MS instead
   * of STALE_AFTER_MS — there is no point telling you an agent is thinking when none is there.
   */
  agentLive: boolean | null;
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
    minimized: false,
    pinsHidden: false,
    clock: 0,
    agentLive: null,
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
      // Placing unhides: the marker you just dropped must never be invisible.
      commit({ ...state, draft, mode: "idle", activePinId: null, pinsHidden: false });
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

/** What the status derivation needs from state besides the pin: the clock and agent liveness. */
export type StatusView = Pick<ToolbarState, "clock" | "agentLive">;

/** Unknown clock, unknown agent — the pre-clock derivation. */
const NO_VIEW: StatusView = { clock: 0, agentLive: null };

export type PendingKind = "thinking" | "waiting" | "stale" | "none";

/** When the human last spoke on this pin: the last message if it is theirs, else the pin itself. */
function lastHumanAt(pin: Pin, thread: ThreadMessage[]): number {
  const last = thread[thread.length - 1];
  return Date.parse(last === undefined ? pin.createdAt : last.at);
}

/**
 * How long the agent has owed a reply, as a state the card can draw.
 *
 * Dogfood: a THINKING row spun for two weeks on a pin nobody ever answered, because the row
 * meant only "the last word is yours". Now that means thinking for 90 s, then a quiet WAITING
 * FOR AGENT, then NO RESPONSE after ten minutes — or after those 90 s when the hub reports no
 * agent listening at all. "none" for anything not owed a reply. A 0 clock never goes stale.
 */
export function pendingKind(
  pin: Pin,
  thread: ThreadMessage[],
  view: StatusView = NO_VIEW,
): PendingKind {
  if (pin.status !== "open" || pin.kind === "comment") return "none";
  const last = thread[thread.length - 1];
  if (last !== undefined && last.role !== "human") return "none";
  if (view.clock === 0) return "thinking";
  const age = view.clock - lastHumanAt(pin, thread);
  if (age < THINKING_MS) return "thinking";
  if (view.agentLive === false || age >= STALE_AFTER_MS) return "stale";
  return "waiting";
}

/**
 * Wire-status → UI-status mapping:
 * resolved + no verification ⇒ "verify" (accept/reopen prompt);
 * resolved + verification ⇒ "resolved";
 * open comment pin ⇒ "note" (nobody owes a reply — never "waiting");
 * open + reply owed too long (pendingKind "stale") ⇒ "stale";
 * open + empty thread or last message human ⇒ "waiting";
 * open + last message agent|mirror ⇒ "replied".
 * The prototype's WORKING/APPLIED chips need an event vocabulary the hub does not emit — excluded here.
 */
export function deriveUiStatus(
  pin: Pin,
  thread: ThreadMessage[],
  view: StatusView = NO_VIEW,
): UiStatus {
  if (pin.status === "resolved") return pin.verification ? "resolved" : "verify";
  if (pin.kind === "comment") return "note";
  const pending = pendingKind(pin, thread, view);
  if (pending === "stale") return "stale";
  if (pending !== "none") return "waiting";
  return "replied";
}

/** Is anyone listening? A session not ended and seen within AGENT_LIVE_MS. */
export function agentIsLive(sessions: Session[], now: number): boolean {
  return sessions.some(
    (s) => s.endedAt === undefined && now - Date.parse(s.lastSeenAt) < AGENT_LIVE_MS,
  );
}

/** Open pins that ask something of someone — comment pins are remarks, so the badges skip them. */
export function openTaskCount(pins: Pin[]): number {
  return pins.filter((p) => p.status !== "resolved" && p.kind !== "comment").length;
}
