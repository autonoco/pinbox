// @autono/pinbox-mcp — meta-tools over the pin queue.
// Five tools total, never one tool per pin. Mutating tools are NOT REGISTERED without
// `allowMutations` — absent from tools/list, not registered-but-erroring. Every call is
// a `pinbox … --json` invocation; the envelope maps 1:1 onto the MCP result so the error
// language stays one language (code/message/hint verbatim).
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  listOutput,
  replyOutput,
  resolveOutput,
  showOutput,
  summaryOutput,
} from "./output-schemas.ts";
import type { runPinbox } from "./pinbox-bin.ts";

export type McpToolDeps = { run: typeof runPinbox; projectDir: string };

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
  }),
]);

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

function errorResult(error: {
  code: string;
  message: string;
  hint?: string | undefined;
}): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(error, null, 2) }], isError: true };
}

/** Invoke the CLI and translate its machine-output envelope into an MCP tool result. */
async function callCli(deps: McpToolDeps, args: string[]): Promise<ToolResult> {
  const { code, stdout } = await deps.run(args, { cwd: deps.projectDir });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return errorResult({
      code: "E_INTERNAL",
      message: `pinbox produced no machine-output envelope (exit ${code})`,
      hint: `run the same command manually: pinbox ${args.join(" ")}`,
    });
  }
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return errorResult({
      code: "E_INTERNAL",
      message: `pinbox emitted an unrecognized envelope (exit ${code})`,
    });
  }
  if (!envelope.data.ok) return errorResult(envelope.data.error);
  // Both: `structuredContent` is what a client reads, the text keeps the result legible to a
  // human tailing the transcript and to any tool that only knows how to render text.
  return {
    content: [{ type: "text", text: JSON.stringify(envelope.data.data, null, 2) }],
    structuredContent: envelope.data.data,
  };
}

/**
 * Register the meta-tools. Read-only tools always; mutating tools only when
 * `allowMutations` — the gate is registration itself.
 */
export function registerTools(
  server: McpServer,
  deps: McpToolDeps,
  opts: { allowMutations: boolean },
): void {
  server.registerTool(
    "pinbox_summary",
    {
      description:
        "Pin-queue orientation in one call: open/resolved counts and the event cursor. " +
        "Prefer the pinbox CLI when you can shell out; this server is the fallback.",
      outputSchema: summaryOutput,
    },
    () => callCli(deps, ["summary", "--json"]),
  );

  server.registerTool(
    "pinbox_list",
    {
      description: "List pins, newest first. Optional status filter and full-text search.",
      outputSchema: listOutput,
      inputSchema: z.object({
        status: z.enum(["open", "resolved"]).optional().describe("filter by status"),
        search: z.string().optional().describe("full-text search over pin conversations"),
      }),
    },
    ({ status, search }) => {
      const args = ["list"];
      if (status !== undefined) args.push("--status", status);
      if (search !== undefined) args.push("--search", search);
      args.push("--json");
      return callCli(deps, args);
    },
  );

  server.registerTool(
    "pinbox_show",
    {
      description: "Show one pin: target element, full conversation thread, links.",
      outputSchema: showOutput,
      inputSchema: z.object({ id: z.string().describe("pin id (pin_xxxxxxxxxx)") }),
    },
    ({ id }) => callCli(deps, ["show", id, "--json"]),
  );

  if (!opts.allowMutations) return;

  server.registerTool(
    "pinbox_reply",
    {
      description:
        "Reply on a pin's thread as the agent. Mutating — registered only when the " +
        "server was started with --allow-mutations.",
      outputSchema: replyOutput,
      inputSchema: z.object({
        id: z.string().describe("pin id (pin_xxxxxxxxxx)"),
        text: z.string().describe("the message"),
      }),
    },
    ({ id, text }) => callCli(deps, ["reply", id, text, "--as", "agent", "--json"]),
  );

  server.registerTool(
    "pinbox_resolve",
    {
      description:
        "Resolve a pin as the agent, optionally with a note saying what changed. " +
        "Mutating — registered only when the server was started with --allow-mutations.",
      outputSchema: resolveOutput,
      inputSchema: z.object({
        id: z.string().describe("pin id (pin_xxxxxxxxxx)"),
        note: z.string().optional().describe("resolution note"),
      }),
    },
    ({ id, note }) => {
      const args = ["resolve", id];
      if (note !== undefined) args.push("--note", note);
      args.push("--as", "agent", "--json");
      return callCli(deps, args);
    },
  );
}
