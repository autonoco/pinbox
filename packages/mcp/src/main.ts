// @autono/pinbox-mcp — stdio MCP server entry. The built entry gets
// its `#!/usr/bin/env bun` shebang from the tsdown banner (a source shebang would duplicate it).
// The documented FALLBACK: agents that can shell out use the pinbox CLI + skill instead
// (CLI-first, design principle 3). Flags: --allow-mutations (or PINBOX_MCP_MUTATIONS=1)
// gates the mutating tools into the registry; --project <dir> sets the CLI working dir.
//
// Protocol revision 2026-07-28. That revision deleted the `initialize` handshake and protocol
// sessions outright — every request now carries its own version and capabilities — so the entry
// is a *factory* rather than a single connected server: the opening exchange decides which era
// the connection speaks, and one instance is pinned to it for its lifetime.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runPinbox } from "./pinbox-bin.ts";
import { registerTools } from "./tools.ts";

/** Kept in step with package.json by a unit test — the wire reports this as the server version. */
export const SERVER_VERSION = "0.1.0";

/**
 * Our tool list is decided once, at launch, by `--allow-mutations`. It cannot change while the
 * process lives, so there is nothing for a client to miss by caching it.
 *
 * `private` is not paranoia: the list *does* differ between two servers started from the same
 * binary with different flags, so a shared cache could hand a read-only client the mutating list.
 */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 300_000, cacheScope: "private" },
  "server/discover": { ttlMs: 300_000, cacheScope: "private" },
} as const;

export function parseFlags(argv: string[]): { allowMutations: boolean; projectDir: string } {
  let allowMutations = process.env["PINBOX_MCP_MUTATIONS"] === "1";
  let projectDir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--allow-mutations") {
      allowMutations = true;
    } else if (flag === "--project") {
      const dir = argv[i + 1];
      if (dir === undefined) throw new Error("--project requires a directory argument");
      projectDir = dir;
      i++;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return { allowMutations, projectDir };
}

if (import.meta.main) {
  const { allowMutations, projectDir } = parseFlags(process.argv.slice(2));
  // `legacy: 'reject'` — this server speaks 2026-07-28 and nothing else. A client that opens with
  // the removed `initialize` handshake gets an unsupported-protocol-version error naming what we
  // do support, not a quiet downgrade. The SDK would happily serve the 2025 era from this same
  // factory; serving it would mean claiming a revision we are not actually on.
  serveStdio(
    () => {
      const server = new McpServer(
        { name: "pinbox-mcp", version: SERVER_VERSION },
        { capabilities: { tools: {} }, cacheHints: CACHE_HINTS },
      );
      registerTools(server, { run: runPinbox, projectDir }, { allowMutations });
      return server;
    },
    { legacy: "reject" },
  );
}
