// @autono/pinbox-mcp — stdio round-trip test, driven by a **2025-era** client on purpose.
//
// The server speaks 2026-07-28 (see protocol-2026.test.ts). This file is the other half of that
// promise: the v1 SDK client still opens with `initialize`, and every host we have today is that
// client. If serving both eras ever regresses, this is what goes red — which is why the old SDK
// stays on as a dev dependency after the runtime moved off it.
// Spawns src/main.ts over real stdio with PINBOX_BIN pointed at a fixture script that
// echoes canned envelopes: initialize → tools/list (3 default, 5 gated) → tools/call.
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("stdio server", () => {
  test("initialize → tools/list: three read-only tools by default", async () => {
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
