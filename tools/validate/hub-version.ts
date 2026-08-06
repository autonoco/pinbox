#!/usr/bin/env bun
// HUB_VERSION drift gate (wired into ci:validate).
//
// `GET /health` reports HUB_VERSION, and the CLI compares it against its own version to
// decide whether a running daemon is stale and must be respawned. If HUB_VERSION stops
// tracking the core package version, that respawn silently stops firing — an already-running
// old daemon keeps serving a new CLI, which is exactly the failure mode the check exists to
// prevent. Cheap to assert, invisible when it breaks; hence a CI gate.
const root = new URL("../..", import.meta.url).pathname;
const HUB_TS = `${root}packages/core/src/hub.ts`;
const CORE_PKG = `${root}packages/core/package.json`;

const source = await Bun.file(HUB_TS).text();
const match = /^const HUB_VERSION = "([^"]*)";$/m.exec(source);
if (match === null) {
  console.error(
    `hub-version: could not find \`const HUB_VERSION = "…";\` in packages/core/src/hub.ts ` +
      "(the gate greps for that exact declaration — keep it on one line)",
  );
  process.exit(1);
}

const declared = match[1];
const { version } = (await Bun.file(CORE_PKG).json()) as { version: string };
if (declared !== version) {
  console.error(
    `hub-version: HUB_VERSION is "${declared}" but @autono/pinbox-core is "${version}" — ` +
      "the daemon's version-mismatch respawn depends on these matching. Update hub.ts.",
  );
  process.exit(1);
}

console.log(`hub-version: HUB_VERSION matches @autono/pinbox-core (${version})`);
