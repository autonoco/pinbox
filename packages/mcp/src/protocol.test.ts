// The MCP wire contract, driven as raw JSON-RPC with no SDK client in the way.
//
// An SDK client proves less than it looks here: `@modelcontextprotocol/client` still opens with
// the removed handshake unless it is pinned, and it never surfaces `resultType` at all. A test
// written through it can pass without the server ever having spoken MCP as it stands today.
// So these send bytes.
import { afterEach, describe, expect, test } from "bun:test";
import { SERVER_VERSION } from "./main.ts";

const mainPath = new URL("./main.ts", import.meta.url).pathname;
const fixturePath = new URL("../test-fixtures/fake-pinbox.ts", import.meta.url).pathname;

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw-wire-test", version: "0.0.0" },
};

type Rpc = {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

type Sent = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };

const running: { kill: () => void }[] = [];

/**
 * Spawn the server, write `messages` verbatim, and return the replies **in request order** —
 * correlated by `id`, not by arrival. JSON-RPC lets a server answer in any order, and it will:
 * `tools/call` shells out to the CLI while `tools/list` is answered from memory. Indexing by
 * arrival would quietly assert one request's payload against another's expectations.
 */
async function rawExchange(messages: Sent[], args: string[] = []): Promise<Rpc[]> {
  const proc = Bun.spawn(["bun", mainPath, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, PINBOX_BIN: fixturePath },
  });
  running.push(proc);
  for (const message of messages) proc.stdin.write(`${JSON.stringify(message)}\n`);
  await proc.stdin.flush();

  const byId = new Map<Rpc["id"], Rpc>();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (byId.size < messages.length) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value);
    let newline = buffered.indexOf("\n");
    for (; newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      const reply = JSON.parse(line) as Rpc;
      // The version tag is part of the contract, so it gets checked rather than discarded.
      if (reply.jsonrpc !== "2.0") throw new Error(`reply is not JSON-RPC 2.0: ${line}`);
      byId.set(reply.id, reply);
    }
  }
  return messages.map((sent) => {
    const reply = byId.get(sent.id);
    if (reply === undefined) throw new Error(`no reply for ${sent.method} (id ${sent.id})`);
    return reply;
  });
}

/** Send `methods` as ordinary MCP requests: no handshake, just the `_meta` envelope. */
function rawCall(methods: string[], args: string[] = []): Promise<Rpc[]> {
  return rawExchange(
    methods.map((method, i) => ({ jsonrpc: "2.0", id: i + 1, method, params: { _meta: META } })),
    args,
  );
}

/** A `tools/call` alongside a `tools/list`: one shells out to the CLI, the other does not. */
function rawCallToolThenList(): Promise<Rpc[]> {
  return rawExchange([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pinbox_summary", arguments: {}, _meta: META },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: META } },
  ]);
}

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill();
});

describe("MCP wire", () => {
  test("answers immediately — there is no handshake to complete first", async () => {
    const [discover, list] = await rawCall(["server/discover", "tools/list"]);
    expect(discover?.error, JSON.stringify(discover?.error)).toBeUndefined();
    expect(list?.error, JSON.stringify(list?.error)).toBeUndefined();
    expect(discover?.result?.["supportedVersions"]).toContain("2026-07-28");
  });

  test("server/discover reports supported versions, capabilities, and identity", async () => {
    const [discover] = await rawCall(["server/discover"]);
    expect(discover?.result?.["capabilities"]).toMatchObject({ tools: {} });
    const meta = discover?.result?.["_meta"] as Record<string, unknown> | undefined;
    expect(meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "pinbox-mcp",
      version: SERVER_VERSION,
    });
  });

  test("every result declares resultType, which MCP requires", async () => {
    const [discover, list] = await rawCall(["server/discover", "tools/list"]);
    expect(discover?.result?.["resultType"]).toBe("complete");
    expect(list?.result?.["resultType"]).toBe("complete");
  });

  test("concurrent requests are answered independently, and each reply names its request", async () => {
    // No sessions and no handshake means requests are self-contained: the server may answer them
    // in any order, and does — `tools/call` waits on the CLI while `tools/list` returns at once.
    const [call, list] = await rawCallToolThenList();
    expect(call?.id).toBe(1);
    expect(list?.id).toBe(2);
    // Correlated by id, so this is the tool call's payload even if it arrived second.
    const content = call?.result?.["content"] as { type: string; text: string }[];
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual({
      open: 2,
      resolved: 1,
      lastEventSeq: 42,
    });
    expect(list?.result?.["tools"]).toBeArray();
  });

  test("we do not advertise a capability we never exercise", async () => {
    // The tool list is fixed at launch, so a list-changed notification will never be sent. The
    // SDK turns `listChanged` on by default, which would tell clients to wait for one forever.
    const [discover] = await rawCall(["server/discover"]);
    const capabilities = discover?.result?.["capabilities"] as { tools?: Record<string, unknown> };
    expect(capabilities.tools?.["listChanged"]).toBe(false);
  });

  test("the tool list is cacheable, and scoped so the mutation gate cannot leak", async () => {
    const [list] = await rawCall(["tools/list"]);
    // The SDK's default is ttlMs: 0 — "never cache" — which wastes a list that cannot change
    // for the life of the process. A hint has to be configured for this to be non-zero.
    expect(list?.result?.["ttlMs"]).toBeGreaterThan(0);
    // Two servers from this binary expose different tool lists depending on --allow-mutations,
    // so a shared cache must never serve one client's list to another.
    expect(list?.result?.["cacheScope"]).toBe("private");
  });

  test("tools come back in a stable order, so clients can cache and prompts stay warm", async () => {
    const runs = await Promise.all([rawCall(["tools/list"]), rawCall(["tools/list"])]);
    const orders = runs.map(([list]) =>
      ((list?.result?.["tools"] ?? []) as { name: string }[]).map((tool) => tool.name),
    );
    expect(orders[0]).toEqual(["pinbox_summary", "pinbox_list", "pinbox_show"]);
    expect(orders[1]).toEqual(orders[0]);
  });

  test("--allow-mutations gates the mutating tools into the list", async () => {
    const [list] = await rawCall(["tools/list"], ["--allow-mutations"]);
    const names = ((list?.result?.["tools"] ?? []) as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual([
      "pinbox_summary",
      "pinbox_list",
      "pinbox_show",
      "pinbox_reply",
      "pinbox_resolve",
    ]);
  });
});

test("the version on the wire is the version we publish", async () => {
  const manifest = (await Bun.file(
    new URL("../package.json", import.meta.url).pathname,
  ).json()) as {
    version: string;
  };
  expect(SERVER_VERSION).toBe(manifest.version);
});
