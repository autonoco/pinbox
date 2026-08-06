#!/usr/bin/env bun
// e2e fixture — the fake `claude` binary the resume adapter spawns in delivery.test.ts.
// Records its invocation (argv after the script, plus cwd) as ONE json file per spawn in
// PINBOX_E2E_CLAUDE_LOG_DIR — a file per invocation instead of an append log, so two
// concurrent spawns (the immediate dispatch and a drain-tick escalation) can never
// interleave writes. Exits 0: a successful resume, as far as the adapter is concerned.
export {}; // no imports — the export makes this a module so top-level await typechecks

const dir = process.env["PINBOX_E2E_CLAUDE_LOG_DIR"] ?? process.cwd();
const entry = { argv: process.argv.slice(2), cwd: process.cwd() };
await Bun.write(`${dir}/claude-${process.pid}-${Date.now()}.json`, `${JSON.stringify(entry)}\n`, {
  createPath: true,
});
