// Interactive install confirm — detected targets listed, yes/no in pinbox chrome.
import { pickOne } from "./pick.ts";

/** Ask whether to install for the detected agent set. null/cancel ⇒ decline. */
export async function confirmInstallTargets(targets: readonly string[]): Promise<boolean> {
  const label = targets.join(", ");
  const choice = await pickOne<"yes" | "no">({
    eyebrow: "PINBOX · INIT",
    title: "Install for the agents detected in this project?",
    subtitle: label.length > 0 ? label : "none detected",
    options: [
      {
        name: "Install",
        description: "Write skills, hooks, and settings for the detected set",
        value: "yes",
      },
      {
        name: "Skip agents",
        description: "Keep .pinbox/ only — install later with --agent",
        value: "no",
      },
    ],
  });
  return choice === "yes";
}
