// @autono/pinbox-mcp — stdio round-trip test through a real SDK client.
//
// The client has to be told which protocol version to speak: `@modelcontextprotocol/client` does
// not send the current one unless it is pinned. That is a property of the client library, not of
// this server.
//
// Spawns src/main.ts over real stdio with PINBOX_BIN pointed at a fixture script that
// echoes canned envelopes: tools/list (3 default, 5 gated) → tools/call.
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const mainPath = new URL("./main.ts", import.meta.url).pathname;
const fixturePath = new URL("../test-fixtures/fake-pinbox.ts", import.meta.url).pathname;

const openClients: Client[] = [];

async function connectStdio(opts: {
  args?: string[];
  env?: Record<string, string>;
}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [mainPath, ...(opts.args ?? [])],
    env: {
      ...(process.env as Record<string, string>),
      PINBOX_BIN: fixturePath,
      ...opts.env,
    },
  });
  const client = new Client(
    { name: "stdio-test", version: "0.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("stdio server", () => {
  test("tools/list: three read-only tools by default", async () => {
    const client = await connectStdio({});
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "pinbox_list",
      "pinbox_show",
      "pinbox_summary",
    ]);
  });

  test("--allow-mutations gates in reply and resolve (5 tools)", async () => {
    const client = await connectStdio({ args: ["--allow-mutations"] });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("pinbox_reply");
    expect(names).toContain("pinbox_resolve");
  });

  test("PINBOX_MCP_MUTATIONS=1 gates in the mutating tools too", async () => {
    const client = await connectStdio({ env: { PINBOX_MCP_MUTATIONS: "1" } });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
  });

  test("tools/call pinbox_summary round-trips the fixture envelope", async () => {
    const client = await connectStdio({});
    const result = await client.callTool({ name: "pinbox_summary", arguments: {} });
    expect(result.isError).toBeFalsy();
    const content = (result as { content: { type: string; text: string }[] }).content;
    const first = content[0];
    if (first === undefined || first.type !== "text") throw new Error("expected text content");
    expect(JSON.parse(first.text)).toEqual({ open: 2, resolved: 1, lastEventSeq: 42 });
  });
});
