// @autono/pinbox-mcp — meta-tool unit tests.
// A fake `run` captures the CLI argv each tool builds; canned envelopes drive the
// success and error paths. Mutation gating is asserted at the registry level: the
// gated tools are absent from tools/list without the flag, not registered-but-erroring.
import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/server";
import { type McpToolDeps, registerTools } from "./tools.ts";

type Call = { args: string[]; cwd: string | undefined };
type CannedResult = { code: number; stdout: string };
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const okEnvelope = (data: unknown): CannedResult => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, data }, null, 2),
});

/**
 * These are unit tests for what each tool does with its arguments — which argv it builds, and how
 * the CLI's envelope becomes a tool result. None of that is protocol, so no server, transport, or
 * client is involved: the registry is a recording stand-in and the handlers are called directly.
 */
function harness(opts: { allowMutations: boolean; respond?: (args: string[]) => CannedResult }): {
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  names: string[];
  calls: Call[];
} {
  const calls: Call[] = [];
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  const run: McpToolDeps["run"] = (args, runOpts) => {
    calls.push({ args, cwd: runOpts?.cwd });
    return Promise.resolve(opts.respond?.(args) ?? okEnvelope(null));
  };
  const registry = {
    registerTool: (
      name: string,
      _config: unknown,
      cb: (args: Record<string, unknown>) => unknown,
    ) => {
      handlers.set(name, async (args) => (await cb(args)) as ToolResult);
      return {};
    },
  } as unknown as McpServer;
  registerTools(registry, { run, projectDir: "/work/project" }, opts);
  return {
    calls,
    names: [...handlers.keys()].sort(),
    call: async (name, args = {}) => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`${name} is not registered`);
      return handler(args);
    },
  };
}

function firstText(result: ToolResult): string {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") throw new Error("expected text content");
  return first.text;
}

describe("mutation gating", () => {
  test("read-only registry without the flag: exactly the three read tools", async () => {
    const { names } = harness({ allowMutations: false });
    expect(names).toEqual(["pinbox_list", "pinbox_show", "pinbox_summary"]);
  });

  test("gated registry with the flag: reply and resolve appear", async () => {
    const { names } = harness({ allowMutations: true });
    expect(names).toEqual([
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
    const { call, calls } = harness({ allowMutations: false });
    await call("pinbox_summary", {});
    expect(calls).toEqual([{ args: ["summary", "--json"], cwd: "/work/project" }]);
  });

  test("pinbox_list with status filter → list --status open --json", async () => {
    const { call, calls } = harness({
      allowMutations: false,
      respond: () => okEnvelope([]),
    });
    await call("pinbox_list", { status: "open" });
    expect(calls[0]?.args).toEqual(["list", "--status", "open", "--json"]);
  });

  test("pinbox_list with search → list --search <q> --json", async () => {
    const { call, calls } = harness({
      allowMutations: false,
      respond: () => okEnvelope([]),
    });
    await call("pinbox_list", { search: "dark mode" });
    expect(calls[0]?.args).toEqual(["list", "--search", "dark mode", "--json"]);
  });

  test("pinbox_show → show <id> --json", async () => {
    const { call, calls } = harness({ allowMutations: false });
    await call("pinbox_show", { id: "pin_0123456789" });
    expect(calls[0]?.args).toEqual(["show", "pin_0123456789", "--json"]);
  });

  test("pinbox_reply → reply <id> <text> --as agent --json", async () => {
    const { call, calls } = harness({ allowMutations: true });
    await call("pinbox_reply", { id: "pin_0123456789", text: "done — shipped in a1b2c3" });
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
    const { call, calls } = harness({ allowMutations: true });
    await call("pinbox_resolve", { id: "pin_0123456789", note: "fixed padding" });
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
    const { call, calls } = harness({ allowMutations: true });
    await call("pinbox_resolve", { id: "pin_0123456789" });
    expect(calls[0]?.args).toEqual(["resolve", "pin_0123456789", "--as", "agent", "--json"]);
  });
});

describe("envelope mapping", () => {
  test("success data round-trips as the tool result text", async () => {
    const pins = [{ id: "pin_0123456789", status: "open" }];
    const { call } = harness({
      allowMutations: false,
      respond: () => okEnvelope(pins),
    });
    const result: ToolResult = await call("pinbox_list", {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(firstText(result))).toEqual(pins);
  });

  test("failure envelope surfaces as a tool error carrying code/message/hint verbatim", async () => {
    const { call } = harness({
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
    const result: ToolResult = await call("pinbox_show", { id: "pin_zzzzzzzzzz" });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("E_NOT_FOUND");
    expect(text).toContain("no pin with id pin_zzzzzzzzzz");
    expect(text).toContain("run `pinbox list` to see current ids");
  });

  test("non-envelope stdout surfaces as an E_INTERNAL tool error with the exit code", async () => {
    const { call } = harness({
      allowMutations: false,
      respond: () => ({ code: 1, stdout: "segfault-ish garbage\n" }),
    });
    const result: ToolResult = await call("pinbox_summary", {});
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("E_INTERNAL");
    expect(text).toContain("exit 1");
  });
});
