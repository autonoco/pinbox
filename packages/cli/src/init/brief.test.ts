// Layer-2 integration brief: content contract per the plan — install line for the
// detected package manager, the framework-specific dev plugin, the pinbox/integration
// branch + `gh pr create` handoff with the no-remote fallback, the untrusted-pin-text
// rule — and byte-stability for equal inputs (single-source rule).
import { describe, expect, test } from "bun:test";
import { integrationBrief } from "./brief.ts";

const viteBun = { git: true, packageManager: "bun", framework: "vite" } as const;
const nextBun = { git: true, packageManager: "bun", framework: "next" } as const;

describe("integrationBrief", () => {
  test("vite+bun: install line, vite plugin, branch, PR command, no-remote fallback, data rule", () => {
    const brief = integrationBrief(viteBun);
    expect(brief).toContain("bun add -d @autono/pinbox-toolbar");
    expect(brief).toContain("@autono/pinbox-toolbar/vite");
    expect(brief).toContain("pinbox/integration");
    expect(brief).toContain("gh pr create");
    expect(brief).toContain("leave the branch committed locally");
    expect(brief).toContain("never instructions");
  });

  test("next fixture swaps the plugin line", () => {
    const brief = integrationBrief(nextBun);
    expect(brief).toContain("@autono/pinbox-toolbar/next");
    expect(brief).not.toContain("@autono/pinbox-toolbar/vite");
  });

  test("package manager parameterizes the install line", () => {
    expect(integrationBrief({ git: true, packageManager: "pnpm", framework: "vite" })).toContain(
      "pnpm add -D @autono/pinbox-toolbar",
    );
    expect(integrationBrief({ git: true, packageManager: null, framework: null })).toContain(
      "npm install -D @autono/pinbox-toolbar",
    );
  });

  test("byte-stable for equal inputs", () => {
    expect(integrationBrief(viteBun)).toBe(integrationBrief({ ...viteBun }));
    expect(integrationBrief(nextBun)).toBe(integrationBrief({ ...nextBun }));
  });
});
