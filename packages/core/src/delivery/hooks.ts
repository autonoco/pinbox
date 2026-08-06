// @autono/pinbox-core/delivery/hooks — the pull-based hooks adapter.
// deliver() has no side effect beyond the row's pending state + escalation due_at
// (both written by the router): the row IS the delivery. The agent's next turn pulls
// it via `pinbox session inject` (UserPromptSubmit hook), and the Stop hook holds the
// agent via `pinbox session pending` while pending rows exist.
// Workers-safe: no Bun APIs — ships in the ./delivery bundle beside the router.
import type { Session } from "../sessions.ts";
import type { DeliveryAdapter } from "./router.ts";

/** Agents whose hook systems can register + pull (research §1: shared hooks schema). */
export const HOOK_CAPABLE_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "hermes"]);

export function createHooksAdapter(): DeliveryAdapter {
  return {
    name: "hooks",
    matches(session: Session): boolean {
      // Liveness ordering is the router's job: hooks precedes resume in the serve
      // adapter array, so live sessions pull and ended ones fall through to resume.
      return session.endedAt === undefined && HOOK_CAPABLE_AGENTS.has(session.agent);
    },
    async deliver(): Promise<void> {
      // Intentionally empty — pull-based (see the header). Marking anything here
      // would turn the pull model into a push and double-deliver on inject.
    },
  };
}
