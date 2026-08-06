// tools/skillgen — single source for BOTH plugin manifests: the two agent formats are generated from one table, so they cannot drift.
// Codex REPLACES (never merges with) the Claude manifest, so any drift between the two
// is a generator bug by definition — they render from this one meta object.
// `name: "pinbox"` is a public contract (skill namespace, marketplace entry key) and
// must equal the marketplace entry name — Codex hard-errors otherwise (research §2A).

export type PluginMeta = {
  name: string;
  version: string;
  description: string;
  authorName: string;
  skills: string;
  hooks: string;
  mcpServers: string;
  displayName: string;
  logo: string;
};

export function pluginMeta(version: string): PluginMeta {
  return {
    name: "pinbox",
    version,
    description: "Pinbox feedback pins — CLI-first pin queue for coding agents",
    authorName: "Autono",
    skills: "./skills/",
    hooks: "./hooks/hooks.json",
    mcpServers: "./.mcp.json",
    displayName: "Pinbox",
    logo: "./assets/logo.svg",
  };
}

/** Claude Code manifest (research §2A schema: `name` required; wrong-typed keys hard-error). */
export function renderClaudeManifest(meta: PluginMeta): string {
  return `${JSON.stringify(baseManifest(meta), null, 2)}\n`;
}

/** Codex manifest: base fields with ./-confined paths plus the `interface` block. */
export function renderCodexManifest(meta: PluginMeta): string {
  const manifest = {
    ...baseManifest(meta),
    interface: { displayName: meta.displayName, logo: meta.logo },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function baseManifest(meta: PluginMeta): Record<string, unknown> {
  return {
    name: meta.name,
    version: meta.version,
    description: meta.description,
    author: { name: meta.authorName },
    skills: meta.skills,
    hooks: meta.hooks,
    mcpServers: meta.mcpServers,
  };
}
