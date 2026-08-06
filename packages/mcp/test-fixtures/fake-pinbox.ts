#!/usr/bin/env bun
// Test fixture — a fake `pinbox` binary for the stdio round-trip test.
// Echoes canned machine-output envelopes; refuses anything the real CLI would.
// Pointed at via PINBOX_BIN, so the MCP server under test spawns this instead of pinbox.

const args = process.argv.slice(2);

function emit(envelope: unknown, code: number): never {
  console.log(JSON.stringify(envelope, null, 2));
  process.exit(code);
}

if (!args.includes("--json")) {
  // The MCP server must always ask for machine output; a human-mode call is a bug.
  emit(
    {
      ok: false,
      error: { code: "E_INVALID_INPUT", message: "fixture requires --json", hint: "bug in caller" },
    },
    2,
  );
}

switch (args[0]) {
  case "summary":
    emit({ ok: true, data: { open: 2, resolved: 1, lastEventSeq: 42 } }, 0);
    break;
  case "list":
    emit({ ok: true, data: [] }, 0);
    break;
  default:
    emit(
      {
        ok: false,
        error: {
          code: "E_INVALID_INPUT",
          message: `fixture does not implement: ${args[0] ?? "(none)"}`,
          hint: "fixture supports summary and list",
        },
      },
      2,
    );
}
