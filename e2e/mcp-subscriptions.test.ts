// e2e — a pin dropped from the CLI reaches a subscribed MCP client, over the hub's socket.
//
// This is the one flow no per-package test can cover: it needs the real CLI to start a real hub,
// the real MCP server to hold a socket to it, and a change made completely outside MCP. It is
// also the drift guard on hub discovery — the MCP server locates `hub.json` by re-deriving the
// CLI's state-path rule (it may not import from `cli`), and if that rule ever moves, the socket
// silently never connects and this is what notices.
import { afterAll, beforeAll, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const BINARY = `${repoRoot}packages/cli/dist/pinbox`;
const MCP_MAIN = `${repoRoot}packages/mcp/src/main.ts`;

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

let tmp = "";
let projectDir = "";
let env: Record<string, string>;

beforeAll(async () => {
  tmp = (await Bun.$`mktemp -d`.text()).trim();
  projectDir = `${tmp}/project`;
  await Bun.$`mkdir -p ${projectDir}`;
  await Bun.$`git init -q`.cwd(projectDir);
  await Bun.$`git config user.email e2e@example.com`.cwd(projectDir);
  await Bun.$`git config user.name e2e`.cwd(projectDir);
  await Bun.write(`${projectDir}/README.md`, "e2e\n");
  await Bun.$`git add -A`.cwd(projectDir);
  await Bun.$`git commit -qm init`.cwd(projectDir);
  env = {
    ...(process.env as Record<string, string>),
    HOME: tmp,
    XDG_STATE_HOME: `${tmp}/state`,
    PINBOX_BIN: BINARY,
  };
});

afterAll(async () => {
  await Bun.$`${BINARY} serve --stop`.cwd(projectDir).env(env).nothrow().quiet();
  if (tmp !== "") await Bun.$`rm -rf ${tmp}`.nothrow();
});

test("a pin created through the CLI notifies a subscribed MCP client", async () => {
  const proc = Bun.spawn(["bun", MCP_MAIN, "--project", projectDir], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env,
  });

  const frames: { method?: string; id?: number; error?: unknown }[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value);
      let newline = buffered.indexOf("\n");
      for (; newline >= 0; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) frames.push(JSON.parse(line));
      }
    }
  })();

  const send = (id: number, method: string, params: Record<string, unknown> = {}): void => {
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } })}\n`,
    );
  };

  // The first tool call is what starts the hub; the socket connects once it is up.
  send(1, "tools/call", { name: "pinbox_summary", arguments: {} });
  send(2, "subscriptions/listen", { notifications: { resourcesListChanged: true } });
  await proc.stdin.flush();

  await until(() => frames.some((f) => f.method === "notifications/subscriptions/acknowledged"));
  const listen = frames.find((f) => f.id === 2);
  expect(listen?.error, JSON.stringify(listen?.error)).toBeUndefined();

  // A client that just arrived is told about what happens next, not about the whole history.
  const before = frames.filter((f) => f.method === "notifications/resources/list_changed").length;
  expect(before).toBe(0);

  // Made entirely outside MCP — this is the point.
  await Bun.$`${BINARY} pin "socket delivered this" --url http://localhost/x --selector .y --json`
    .cwd(projectDir)
    .env(env)
    .quiet();

  await until(
    () => frames.some((f) => f.method === "notifications/resources/list_changed"),
    "no resources/list_changed arrived after the pin was created",
  );

  proc.kill();
}, 30_000);

async function until(predicate: () => boolean, message = "timed out"): Promise<void> {
  for (let waited = 0; waited < 15_000; waited += 100) {
    if (predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}
