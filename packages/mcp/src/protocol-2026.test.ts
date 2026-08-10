// The 2026-07-28 wire contract, driven as raw JSON-RPC with no SDK client in the way.
//
// An SDK client would prove far less than it looks: it negotiates the era itself, and its
// ergonomic return values strip the protocol fields this revision added (`resultType`, the cache
// hints) before a test can see them. The failure that matters is silently still serving the 2025
// era — every SDK-mediated test keeps passing through that, because the SDK speaks both.
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

type Rpc = { result?: Record<string, unknown>; error?: { code: number; message: string } };

const running: { kill: () => void }[] = [];

/** Spawn the server and send `methods` as 2026-era requests — no `initialize`, no handshake. */
async function rawCall(methods: string[], args: string[] = []): Promise<Rpc[]> {
  const proc = Bun.spawn(["bun", mainPath, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, PINBOX_BIN: fixturePath },
  });
  running.push(proc);
  for (const [i, method] of methods.entries()) {
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params: { _meta: META } })}\n`,
    );
  }
  await proc.stdin.flush();

  const replies: Rpc[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (replies.length < methods.length) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value);
    let newline = buffered.indexOf("\n");
    for (; newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) replies.push(JSON.parse(line) as Rpc);
    }
  }
  return replies;
}

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill();
});

describe("2026-07-28 wire", () => {
  test("answers with no handshake at all — sessions and initialize are gone", async () => {
    const [discover, list] = await rawCall(["server/discover", "tools/list"]);
    // Under 2025 rules both of these would have been rejected as "not initialized".
    expect(discover?.error, JSON.stringify(discover?.error)).toBeUndefined();
    expect(list?.error, JSON.stringify(list?.error)).toBeUndefined();
    expect(discover?.result?.["supportedVersions"]).toContain("2026-07-28");
  });

  test("server/discover carries the identity that used to arrive in the handshake", async () => {
    const [discover] = await rawCall(["server/discover"]);
    expect(discover?.result?.["capabilities"]).toMatchObject({ tools: {} });
    const meta = discover?.result?.["_meta"] as Record<string, unknown> | undefined;
    expect(meta?.["io.modelcontextprotocol/serverInfo"]).toEqual({
      name: "pinbox-mcp",
      version: SERVER_VERSION,
    });
  });

  test("every result declares resultType, which this revision made required", async () => {
    const [discover, list] = await rawCall(["server/discover", "tools/list"]);
    expect(discover?.result?.["resultType"]).toBe("complete");
    expect(list?.result?.["resultType"]).toBe("complete");
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

  test("the mutation gate still works on the modern era, not just the legacy one", async () => {
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
