// pinbox CLI — ambient context and flags for `init` (shared by command + select).

import type { OutputFlags } from "../output.ts";
import type { spawnIntegrationAgent } from "./spawn.ts";

export type InitFlags = OutputFlags & {
  agent?: string;
  global?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  /** commander's --no-input: present ⇒ false. */
  input?: boolean;
  agentMode?: boolean;
};

/** Everything ambient, injected — command-level tests run in mkdtemp projects. */
export type InitContext = {
  projectDir: string;
  env: Record<string, string | undefined>;
  home: string | undefined;
  isTTY?: boolean;
  /**
   * The three ambient effects Layer 2's handoff ending needs. Default to the terminal
   * globals and the real spawner; tests inject them to reach the branch that prompts.
   * Confirm/prompt may be async when the OpenTUI path is used.
   */
  confirm?: (question: string) => boolean | Promise<boolean>;
  prompt?: (question: string) => string | null | Promise<string | null>;
  spawn?: typeof spawnIntegrationAgent;
};
