// @autono/pinbox-mcp — meta-tool unit tests.
// A fake `run` captures the CLI argv each tool builds; canned envelopes drive the
// success and error paths. Mutation gating is asserted at the registry level: the
// gated tools are absent from tools/list without the flag, not registered-but-erroring.
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { type McpToolDeps, registerTools } from "./tools.ts";

type Call = { args: string[]; cwd: string | undefined };
type CannedResult = { code: number; stdout: string };

const okEnvelope = (data: unknown): CannedResult => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data }, null, 2),
});

async function connectHarness(opts: {
  allowMutations: boolean;
  respond?: (args: string[]) => CannedResult;
}): Promise<{ client: Client; calls: Call[] }> {
  const calls: Call[] = [];
  const run: McpToolDeps["run"] = (args, runOpts) => {
    calls.push({ args, cwd: runOpts?.cwd });
    return Promise.resolve(opts.respond?.(args) ?? okEnvelope(null));
  };
  const server = new McpServer({ name: "pinbox-mcp-test", version: "0.0.0" });
  registerTools(server, { run, projectDir: "/work/project" }, opts);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

function firstText(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  const first = content[0];
  if (first === undefined || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

describe("mutation gating", () => {
  test("read-only registry without the flag: exactly the three read tools", async () => {
    const { client } = await connectHarness({ allowMutations: false });
    expect(await toolNames(client)).toEqual(["pinbox_list", "pinbox_show", "pinbox_summary"]);
  });

  test("gated registry with the flag: reply and resolve appear", async () => {
    const { client } = await connectHarness({ allowMutations: true });
    expect(await toolNames(client)).toEqual([
      "pinbox_list",
      "pinbox_reply",
      "pinbox_resolve",
      "pinbox_show",
      "pinbox_summary",
    ]);
  });
});

describe("argv mapping", () => {
  test("pinbox_summary → summary --json, in the project dir", async () => {
    const { client, calls } = await connectHarness({ allowMutations: false });
    await client.callTool({ name: "pinbox_summary", arguments: {} });
    expect(calls).toEqual([{ args: ["summary", "--json"], cwd: "/work/project" }]);
  });

  test("pinbox_list with status filter → list --status open --json", async () => {
    const { client, calls } = await connectHarness({
      allowMutations: false,
      respond: () => okEnvelope([]),
    });
    await client.callTool({ name: "pinbox_list", arguments: { status: "open" } });
    expect(calls[0]?.args).toEqual(["list", "--status", "open", "--json"]);
  });

  test("pinbox_list with search → list --search <q> --json", async () => {
    const { client, calls } = await connectHarness({
      allowMutations: false,
      respond: () => okEnvelope([]),
    });
    await client.callTool({ name: "pinbox_list", arguments: { search: "dark mode" } });
    expect(calls[0]?.args).toEqual(["list", "--search", "dark mode", "--json"]);
  });

  test("pinbox_show → show <id> --json", async () => {
    const { client, calls } = await connectHarness({ allowMutations: false });
    await client.callTool({ name: "pinbox_show", arguments: { id: "pin_0123456789" } });
    expect(calls[0]?.args).toEqual(["show", "pin_0123456789", "--json"]);
  });

  test("pinbox_reply → reply <id> <text> --as agent --json", async () => {
    const { client, calls } = await connectHarness({ allowMutations: true });
    await client.callTool({
      name: "pinbox_reply",
      arguments: { id: "pin_0123456789", text: "done — shipped in a1b2c3" },
    });
    expect(calls[0]?.args).toEqual([
      "reply",
      "pin_0123456789",
      "done — shipped in a1b2c3",
      "--as",
      "agent",
      "--json",
    ]);
  });

  test("pinbox_resolve with note → resolve <id> --note <note> --as agent --json", async () => {
    const { client, calls } = await connectHarness({ allowMutations: true });
    await client.callTool({
      name: "pinbox_resolve",
      arguments: { id: "pin_0123456789", note: "fixed padding" },
    });
    expect(calls[0]?.args).toEqual([
      "resolve",
      "pin_0123456789",
      "--note",
      "fixed padding",
      "--as",
      "agent",
      "--json",
    ]);
  });

  test("pinbox_resolve without note omits --note", async () => {
    const { client, calls } = await connectHarness({ allowMutations: true });
    await client.callTool({ name: "pinbox_resolve", arguments: { id: "pin_0123456789" } });
    expect(calls[0]?.args).toEqual(["resolve", "pin_0123456789", "--as", "agent", "--json"]);
  });
});

describe("envelope mapping", () => {
  test("success data round-trips as the tool result text", async () => {
    const pins = [{ id: "pin_0123456789", status: "open" }];
    const { client } = await connectHarness({
      allowMutations: false,
      respond: () => okEnvelope(pins),
    });
    const result = await client.callTool({ name: "pinbox_list", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(pins);
  });

  test("failure envelope surfaces as a tool error carrying code/message/hint verbatim", async () => {
    const { client } = await connectHarness({
      allowMutations: false,
      respond: () => ({
        code: 3,
        stdout: JSON.stringify({
          ok: false,
          error: {
            code: "E_NOT_FOUND",
            message: "no pin with id pin_zzzzzzzzzz",
            hint: "run `pinbox list` to see current ids",
          },
        }),
      }),
    });
    const result = await client.callTool({
      name: "pinbox_show",
      arguments: { id: "pin_zzzzzzzzzz" },
    });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("E_NOT_FOUND");
    expect(text).toContain("no pin with id pin_zzzzzzzzzz");
    expect(text).toContain("run `pinbox list` to see current ids");
  });

  test("non-envelope stdout surfaces as an E_INTERNAL tool error with the exit code", async () => {
    const { client } = await connectHarness({
      allowMutations: false,
      respond: () => ({ code: 1, stdout: "segfault-ish garbage\n" }),
    });
    const result = await client.callTool({ name: "pinbox_summary", arguments: {} });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("E_INTERNAL");
    expect(text).toContain("exit 1");
  });
});
