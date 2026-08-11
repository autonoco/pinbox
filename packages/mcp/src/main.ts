// @autono/pinbox-mcp — stdio MCP server entry. The built entry gets
// its `#!/usr/bin/env bun` shebang from the tsdown banner (a source shebang would duplicate it).
// The documented FALLBACK: agents that can shell out use the pinbox CLI + skill instead
// (CLI-first, design principle 3). Flags: --allow-mutations (or PINBOX_MCP_MUTATIONS=1)
// gates the mutating tools into the registry; --project <dir> sets the CLI working dir.
//
// MCP is stateless: there is no handshake and no session, and every request carries its own
// protocol version. The entry is therefore a *factory* — the SDK builds one server instance per
// connection and holds it for that connection's lifetime.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { watchHub } from "./hub-events.ts";
import { runPinbox } from "./pinbox-bin.ts";
import { notifyFromEvent, registerResources } from "./resources.ts";
import { registerTools } from "./tools.ts";

/** Kept in step with package.json by a unit test — the wire reports this as the server version. */
export const SERVER_VERSION = "0.1.0";

/**
 * Our tool list is decided once, at launch, by `--allow-mutations`, and cannot change while the
 * process lives — so there is nothing for a client to miss by caching it. Without a hint the SDK
 * emits `ttlMs: 0`, telling clients never to cache a list that is in fact constant.
 *
 * `private` is not paranoia: the list *does* differ between two servers started from the same
 * binary with different flags, so a shared cache could hand a read-only client the mutating list.
 */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 300_000, cacheScope: "private" },
  "server/discover": { ttlMs: 300_000, cacheScope: "private" },
  // Pins change under you; a stale list is a missed pin, so this one is not cached.
  "resources/list": { ttlMs: 0, cacheScope: "private" },
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
  // The SDK ships a handshake fallback that is ON by default; this is its off switch. It is the
  // only reachable way to get a stdio server that answers MCP alone — the module exports exactly
  // `serveStdio` and `StdioServerTransport`, and hand-wiring the transport replies in the older
  // result shape (no `resultType`, no cache fields). Verified, not assumed.
  serveStdio(
    () => {
      const server = new McpServer(
        { name: "pinbox-mcp", version: SERVER_VERSION },
        {
          // `tools.listChanged: false` is a fact, not a default: the tool list is fixed at launch.
          // Resources are the opposite — pins appear and change constantly, which is the whole
          // reason this server holds a socket to the hub.
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: true, subscribe: true },
          },
          cacheHints: CACHE_HINTS,
        },
      );
      const deps = { run: runPinbox, projectDir };
      registerTools(server, deps, { allowMutations });
      registerResources(server, deps);
      // The hub broadcasts every store change; this turns each one into a notification. It is
      // best-effort by construction — no hub, no events, and every tool still works.
      const watcher = watchHub({
        projectDir,
        onEvent: (event) => notifyFromEvent(server, event),
      });
      server.server.onclose = () => watcher.close();
      return server;
    },
    { legacy: "reject" },
  );
}
