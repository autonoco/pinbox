# @autono/pinbox-mcp

Standalone stdio MCP server for the pinbox pin queue — a **compatibility fallback**, never the
documented default. Agents are markedly better at CLI tools than MCP: use the `pinbox` CLI and
the pinbox skill; this server exists for environments that cannot shell out. Mutating tools
require `--allow-mutations`.

## Protocol

Implements MCP: protocol version `2026-07-28`, the string a client carries in each request's
`_meta`. MCP is stateless — no handshake, no session — so a client may send `tools/call` as its
very first message, and requests are answered independently of one another. `server/discover`
reports supported versions, capabilities, and identity.

Requests naming any other protocol version are refused with `-32022` and the supported list.

Every tool declares an output schema and returns its data in `structuredContent`, so a client
reads fields rather than parsing a JSON string out of message text. The schemas are permissive by
design: the CLI's machine output is a versioned contract that gains fields, and a strict schema
would strip anything new on the way through.

Pins are published as resources — `pinbox://pins` for the queue, `pinbox://pins/{id}` for one pin
and its thread — and this server holds a socket to the local hub, which broadcasts every store
change. Subscribe with `subscriptions/listen` and a new pin arrives as a notification instead of
something you have to poll for. Reads still go through the CLI: the socket is a change signal, not
a second way to read the database.

Not implemented, because nothing here needs them: mid-request user input (no tool asks the user
anything — pin text arrives with the pin) and background tasks (every call is a local SQLite read
behind a CLI invocation).

`protocol.test.ts` is the contract: it drives the server as raw JSON-RPC, with no client library
in between.

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
