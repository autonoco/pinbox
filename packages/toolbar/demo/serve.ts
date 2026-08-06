#!/usr/bin/env bun
// pinbox toolbar demo — real hub + static fixture page.
//
// `bun demo/serve.ts` from packages/toolbar. Two loopback servers:
//   * the REAL hub (core's startHubServer, realtime + local attachment sink) on an ephemeral port
//   * a static server for demo/index.html and the built dist/ ESM bundle
// Both are loopback, so the hub's origin gate lets the page through.
//
// This is OUR process (not a guest in someone else's runtime), so it is Bun-native throughout —
// the `node:` guest rule stops at src/plugins/, and nothing here ships to npm.
//
// It also writes the two discovery files `pinbox` looks for (./discovery.ts), so the CLI ADOPTS
// this hub instead of spawning a second one: `cd packages/toolbar/demo && pinbox resolve <id>`
// drives the very toolbar you are looking at.
import {
  gitEnv,
  localDirSink,
  registerAttachmentSink,
  startHubServer,
} from "@autono/pinbox-core/hub-server";
import { openStore } from "@autono/pinbox-core/store";
import { $ } from "bun";
import { projectId, publishDiscoveryFiles } from "./discovery.ts";

const demoDir = import.meta.dir;
const distDir = `${demoDir}/../dist`;
const pagePort = Number(process.env["PINBOX_DEMO_PORT"] ?? 5175);

if (!(await Bun.file(`${distDir}/index.js`).exists())) {
  console.error("demo: dist/index.js is missing — run `bun run build` in packages/toolbar first.");
  process.exit(1);
}

const token = crypto.randomUUID().replaceAll("-", "");
// bun:sqlite will not create the parent directory (SQLITE_CANTOPEN); `pinbox serve` mkdir -p's
// the same path for the same reason.
await $`mkdir -p ${`${demoDir}/.pinbox`}`.quiet();
const store = openStore(`${demoDir}/.pinbox/pinbox.db`);
registerAttachmentSink(store, localDirSink(`${demoDir}/.pinbox/media`));

const hub = await startHubServer({
  store,
  token,
  enrichEnv: () => gitEnv(demoDir),
  // Long idle window: a demo sits untouched while you read the checklist.
  idleMs: 8 * 60 * 60_000,
  realtime: { projectId: projectId(demoDir) },
});

await publishDiscoveryFiles({ demoDir, port: hub.port, token, pid: process.pid });

const page = Bun.serve({
  hostname: "127.0.0.1",
  port: pagePort,
  fetch: servePage,
});

console.log(`\n  pinbox toolbar demo`);
console.log(`  page   ${page.url.href}`);
console.log(`  hub    ${hub.url}`);
console.log(`  db     ${demoDir}/.pinbox/pinbox.db`);
console.log(`\n  CLI against this hub:  cd ${demoDir} && pinbox list`);
console.log(`  checklist:             ${demoDir}/README.md\n`);

const FRESH = { "cache-control": "no-store" };

async function servePage(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(Bun.file(`${demoDir}/index.html`), {
      headers: { ...FRESH, "content-type": "text/html; charset=utf-8" },
    });
  }
  if (pathname === "/config.json") {
    return Response.json({ endpoint: hub.url, token }, { headers: FRESH });
  }
  if (pathname.startsWith("/dist/")) return serveDist(pathname.slice("/dist/".length));
  return new Response("not found", { status: 404 });
}

/** Static file out of the built bundle dir; the ESM entry's sibling chunks resolve through here. */
async function serveDist(relative: string): Promise<Response> {
  // Traversal cannot escape dist/: `new URL` already normalized the path, so a surviving "…/.."
  // just names a file outside dist that does not exist and 404s below.
  const file = Bun.file(`${distDir}/${relative}`);
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: FRESH });
}

// Ctrl-C tears down both servers and the store; the discovery files are left behind on purpose
// so a stale-hub probe (connection refused) is what the CLI sees, matching daemon behavior.
const shutdown = async (): Promise<void> => {
  page.stop(true);
  await hub.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
