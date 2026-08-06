// @autono/pinbox-core/delivery/openclaw — OpenClaw live-session push adapter.
//
// BUN-ONLY (Bun.spawn, Bun.which) — imported by the CLI serve path ONLY,
// never statically by router.ts, and never part of the Worker adapter set (which is
// [webhook]). The verified push:
//   openclaw system event --mode next-heartbeat --session-key <k> --text <payload>
// NOT `openclaw agent --message` (interrupts instead of joins), and NOT POST
// /hooks/agent (research 2026-08-02-agent-plugin-formats.md: no such gateway endpoint).
//
// Dedup rides the deliveries ledger (a delivered row is never re-sent); the native
// plugin's enqueueNextTurnInjection idempotencyKey ("pin:<pinId>:<seq>") is the
// artifact-C concern, not this adapter's.
import type { Session } from "../sessions.ts";
import type { StoredEvent } from "../store.ts";
import { type GetPin, payloadForEvent } from "./payload.ts";
import { drainToExit, resolveBinary } from "./proc.ts";
import type { DeliveryAdapter } from "./router.ts";

const PUSH_ARGS = ["system", "event", "--mode", "next-heartbeat", "--session-key"] as const;

export function createOpenclawAdapter(opts?: {
  command?: string[]; // test seam, default ["openclaw"]
  /** Pin lookup for reply payloads — see payloadForEvent; serve passes store.getPin. */
  getPin?: GetPin;
}): DeliveryAdapter {
  const command = opts?.command ?? ["openclaw"];
  const getPin = opts?.getPin;
  return {
    name: "openclaw",
    matches(session: Session): boolean {
      // Liveness beyond "the gateway binary exists" is unknowable cheaply; the
      // next-heartbeat push is queue-and-join, so a not-currently-live session key
      // still receives it on its next heartbeat.
      if (session.agent !== "openclaw") return false;
      const binary = command.at(0);
      return binary !== undefined && resolveBinary(binary) !== null;
    },
    async deliver(event: StoredEvent, session: Session): Promise<void> {
      const payload = payloadForEvent(event, "openclaw", getPin);
      await push(command, session.key, payload);
    },
  };
}

async function push(command: string[], key: string, payload: string): Promise<void> {
  const binary = command.at(0);
  if (binary === undefined) throw new Error("openclaw command resolved to an empty argv");
  const resolved = resolveBinary(binary);
  if (resolved === null) {
    // Retryable, deliberately NOT E_SESSION_GONE: a missing gateway binary proves
    // nothing about the session — the queue retries (terminal E_DELIVERY after 5).
    throw new Error(`${binary} not found on PATH to push to session key ${key}`);
  }
  const proc = Bun.spawn([resolved, ...command.slice(1), ...PUSH_ARGS, key, "--text", payload], {
    env: { ...process.env }, // runtime env mutations do not reach children otherwise
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { code, stderr } = await drainToExit(proc);
  if (code !== 0) {
    throw new Error(
      `${binary} exited ${code} pushing to session key ${key}` +
        (stderr === "" ? "" : ` — ${stderr}`),
    );
  }
}
