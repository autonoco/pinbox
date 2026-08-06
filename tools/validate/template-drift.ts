#!/usr/bin/env bun
// Template-drift gate (wired into ci:validate): `examples/worker` is the
// deploy-checked, byte-identical materialization of `packages/cli/templates/worker`.
// Any divergence between the two trees fails CI before release. The one sanctioned
// difference: the example README carries a two-line provenance header, after which it
// must reproduce the template README byte-for-byte.
import { $ } from "bun";

const root = new URL("../..", import.meta.url).pathname;
const templateDir = `${root}packages/cli/templates/worker`;
const exampleDir = `${root}examples/worker`;
const PROVENANCE = /^<!-- materialized copy of packages\/cli\/templates\/worker[^\n]*-->\n\n/;

let failed = false;

function report(message: string): void {
  failed = true;
  console.error(`template-drift: ${message}`);
}

// Everything except the README must be byte-identical, both directions (a file added
// to only one tree is drift too). diff -r covers content, additions, and removals;
// generated local artifacts are excluded.
const diff =
  await $`diff -r -x README.md -x node_modules -x .wrangler -x .dev.vars ${templateDir} ${exampleDir}`
    .nothrow()
    .quiet();
if (diff.exitCode !== 0) {
  report("trees differ (edit the template, then re-copy into examples/worker):");
  console.error(diff.stdout.toString() + diff.stderr.toString());
}

const templateReadme = await Bun.file(`${templateDir}/README.md`).text();
const exampleReadme = await Bun.file(`${exampleDir}/README.md`).text();
if (!PROVENANCE.test(exampleReadme)) {
  report("examples/worker/README.md is missing the provenance header comment");
} else if (exampleReadme.replace(PROVENANCE, "") !== templateReadme) {
  report("examples/worker/README.md drifted from the template README below its header");
}

if (failed) process.exit(1);
console.log("template-drift: examples/worker matches packages/cli/templates/worker");
