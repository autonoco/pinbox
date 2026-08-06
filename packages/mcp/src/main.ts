// @autono/pinbox-mcp — stdio MCP server entry. The built entry gets
// its `#!/usr/bin/env bun` shebang from the tsdown banner (a source shebang would duplicate it).
// The documented FALLBACK: agents that can shell out use the pinbox CLI + skill instead
// (CLI-first, design principle 3). Flags: --allow-mutations (or PINBOX_MCP_MUTATIONS=1)
// gates the mutating tools into the registry; --project <dir> sets the CLI working dir.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runPinbox } from "./pinbox-bin.ts";
import { registerTools } from "./tools.ts";

function parseFlags(argv: string[]): { allowMutations: boolean; projectDir: string } {
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

const { allowMutations, projectDir } = parseFlags(process.argv.slice(2));
const server = new McpServer({ name: "pinbox-mcp", version: "0.0.0" });
registerTools(server, { run: runPinbox, projectDir }, { allowMutations });
await server.connect(new StdioServerTransport());
