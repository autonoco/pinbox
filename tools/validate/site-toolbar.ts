// tools/validate — the toolbar bundle the site serves must be the one this repo builds.
//
// apps/web has no build step on purpose: `public/` deploys byte for byte. That means the demo's
// toolbar is a *copy*, and a copy drifts. The failure is quiet and bad: pinbox.sh keeps
// demonstrating an old build while the repo has moved on, so the one page whose job is to be the
// product is showing something that is not the product.
//
// `--write` refreshes the copy (run before deploy); with no flag it asserts and exits non-zero.
const root = new URL("../..", import.meta.url).pathname;
const built = `${root}packages/toolbar/dist/toolbar.iife.js`;
const shipped = `${root}apps/web/public/pinbox/toolbar.iife.js`;
const write = process.argv.includes("--write");

const source = Bun.file(built);
if (!(await source.exists())) {
  console.error(`toolbar bundle missing: ${built}`);
  console.error("build it first: bun run --filter '@autono/pinbox-toolbar' build");
  process.exit(1);
}

const wanted = await source.arrayBuffer();

if (write) {
  await Bun.write(shipped, wanted);
  console.log(`apps/web: toolbar bundle synced (${wanted.byteLength} bytes).`);
  process.exit(0);
}

const target = Bun.file(shipped);
const current = (await target.exists()) ? await target.arrayBuffer() : new ArrayBuffer(0);
const same =
  current.byteLength === wanted.byteLength &&
  Buffer.from(current).equals(Buffer.from(wanted as ArrayBuffer));

if (!same) {
  console.error("apps/web ships a stale toolbar bundle.");
  console.error(`  built:   ${wanted.byteLength} bytes`);
  console.error(`  shipped: ${current.byteLength} bytes`);
  console.error("\nfix: bun run --filter '@autono/pinbox-site' sync:toolbar");
  process.exit(1);
}

console.log("apps/web: the toolbar bundle it serves is the one this repo builds.");
