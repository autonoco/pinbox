// Interactive handoff picker — choose which on-PATH agent gets the integration brief.
import type { AgentSpec } from "../../agents.ts";
import { pickOne } from "./pick.ts";

/** Pick a handoff agent, or null to decline / cancel. */
export async function pickHandoffAgentTui(candidates: readonly AgentSpec[]): Promise<AgentSpec | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const only = candidates[0] as AgentSpec;
    const choice = await pickOne<"yes" | "no">({
      eyebrow: "PINBOX · INIT",
      title: `Have ${only.id} wire the toolbar and open a PR?`,
      subtitle: "Adds the dev plugin on pinbox/integration — not just agent skills",
      options: [
        {
          name: `Yes — ${only.id} opens the PR`,
          description: "Install @autono/pinbox-toolbar and wire the Vite/Next plugin",
          value: "yes",
        },
        {
          name: "Skip for now",
          description: "Print the brief — paste it into an agent later",
          value: "no",
        },
      ],
    });
    return choice === "yes" ? only : null;
  }

  const choice = await pickOne<AgentSpec | null>({
    eyebrow: "PINBOX · INIT",
    title: "Which agent should wire the toolbar and open a PR?",
    subtitle: "Adds the dev plugin on pinbox/integration — not just agent skills",
    options: [
      ...candidates.map((spec) => ({
        name: spec.id,
        description: "Install @autono/pinbox-toolbar and wire the Vite/Next plugin",
        value: spec as AgentSpec | null,
      })),
      {
        name: "Skip for now",
        description: "Print the brief — paste it into an agent later",
        value: null,
      },
    ],
  });
  return choice;
}
