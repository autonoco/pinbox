# @autono/pinbox-mcp

Standalone stdio MCP server for the pinbox pin queue — a **compatibility fallback**, never the
documented default. Agents are markedly better at CLI tools than MCP: use the `pinbox` CLI and
the pinbox skill; this server exists for environments that cannot shell out. Mutating tools
require `--allow-mutations`.

## Protocol

Speaks **2026-07-28, and only that**. That revision removed the `initialize` handshake and
protocol sessions, so a client may send `tools/call` as its very first message; `server/discover`
reports what this server supports.

A client that opens with `initialize` is **refused** — error `-32022`, with the supported revision
in the payload — not quietly downgraded. Serving the old handshake as a fallback would mean
advertising a revision this server is not actually on.

That has a consequence worth knowing before you wire this up: **most hosts today still open with
`initialize`, and so will fail to connect.** That includes clients built on the current SDK —
`@modelcontextprotocol/client` defaults to the 2025 era and must be pinned:

```ts
new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
```

The CLI is unaffected and remains the documented path (see below).

Both halves are tested: `protocol-2026.test.ts` drives the wire as raw JSON-RPC with no client at
all — including the rejection — and `stdio.test.ts` drives a real pinned SDK client.

## Usage

```jsonc
// .mcp.json
{
  "mcpServers": {
    "pinbox": {
      "command": "bunx",
      "args": ["@autono/pinbox-mcp", "--project", "/path/to/your/project"]
    }
  }
}
```

Flags:

- `--project <dir>` — working directory for the underlying CLI calls (defaults to the server's cwd).
- `--allow-mutations` (or env `PINBOX_MCP_MUTATIONS=1`) — registers the mutating tools. Without
  it they are absent from `tools/list` entirely, not registered-but-erroring.

The server locates the CLI via `PINBOX_BIN`, then `pinbox` on `PATH`; install it with
`bunx @autono/pinbox` if missing.

## Tools

Meta-tools over the pin queue — never one tool per pin:

| Tool | Gated | CLI equivalent |
| --- | --- | --- |
| `pinbox_summary` | no | `pinbox summary --json` |
| `pinbox_list` | no | `pinbox list [--status s] [--search q] --json` |
| `pinbox_show` | no | `pinbox show <id> --json` |
| `pinbox_reply` | `--allow-mutations` | `pinbox reply <id> <text> --as agent --json` |
| `pinbox_resolve` | `--allow-mutations` | `pinbox resolve <id> [--note n] --as agent --json` |

## Design rules

- **No business logic here** — anything this server can do is expressible as a CLI call; both are
  clients of the hub. Each tool call shells out to `pinbox … --json` and maps the machine-output
  envelope 1:1: `{"ok":false,"error":{code,message,hint}}` becomes an MCP tool error carrying
  `code`/`message`/`hint` verbatim, so the error language stays one language.
- Replies and resolutions made through this server are authored `--as agent` — the MCP client is
  an agent host.
