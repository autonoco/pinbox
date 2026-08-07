// tools/release — the pack-and-install e2e.
// This is the dogfooded gate release.yml runs before anything is published: generate the
// launcher + the CURRENT platform package at 0.0.0-test, `bun pm pack` both, `npm install`
// the two tarballs into a throwaway project — the other three platform packages 404 and are
// SKIPPED SILENTLY, which is the whole mechanism under test — then drive the installed
// `pinbox` with **bun removed from PATH**, so the only thing that can be answering is the
// node shim spawning a binary with its runtime embedded.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { compileAll, compileTarget, currentTarget, freshBinary } from "./compile.ts";
import { launcherPackage, platformPackage, stageLauncher, stagePlatform } from "./manifests.ts";
import { publishAll, publishPlan } from "./publish.ts";
import { TARGETS } from "./targets.ts";

const VERSION = "0.0.0-test";

// npm and the shim both need node; nothing in this test may reach bun.
const nodePath = Bun.which("node");
const nodeDir = nodePath === null ? "" : nodePath.slice(0, nodePath.lastIndexOf("/"));
const INSTALL_PATH = `${nodeDir}:/usr/bin:/bin`;

let tmp = "";
let launcherTgz = "";
let platformTgz = "";
let projectDir = "";
let env: Record<string, string>;

beforeAll(async () => {
  tmp = (await Bun.$`mktemp -d`.text()).trim();
  projectDir = `${tmp}/project`;
  env = {
    PATH: INSTALL_PATH,
    HOME: `${tmp}/home`,
    XDG_STATE_HOME: `${tmp}/state`,
    PINBOX_IDLE_MS: "60000",
    PINBOX_NO_UPDATE: "1",
    npm_config_cache: `${tmp}/npm-cache`,
  };
  await Bun.$`mkdir -p ${projectDir} ${env["HOME"]} ${tmp}/tarballs`.quiet();
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir, env });

  const target = currentTarget();
  // CI points this at the artifact the compile job produced, so the smoke gate exercises the
  // exact bytes that are about to be published; locally it falls back to dist, then a build.
  const binary =
    process.env["PINBOX_RELEASE_BINARY"] ??
    (await freshBinary()) ??
    (await compileTarget(target, `${tmp}/build`));
  const platformDir = await stagePlatform(target, VERSION, binary, `${tmp}/stage`);
  const launcherDir = await stageLauncher(VERSION, `${tmp}/stage`);
  platformTgz = await pack(platformDir, "platform.tgz");
  launcherTgz = await pack(launcherDir, "launcher.tgz");
}, 300_000);

afterAll(async () => {
  const state = await readHubState();
  if (state !== null) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (tmp !== "") await Bun.$`rm -rf ${tmp}`.quiet();
});

test("the generated launcher is packaging glue: node shebang, exact pins, no engines", () => {
  const { manifest, shimJs } = launcherPackage(VERSION) as {
    manifest: Record<string, unknown>;
    shimJs: string;
  };
  expect(manifest["name"]).toBe("@autono/pinbox");
  expect(manifest["bin"]).toEqual({ pinbox: "bin/pinbox.js" });
  // The binary embeds Bun; an engines field would block the machines it exists to serve.
  expect(manifest).not.toHaveProperty("engines");

  const optional = manifest["optionalDependencies"] as Record<string, string>;
  expect(Object.keys(optional).sort()).toEqual(TARGETS.map((t) => t.pkgName).sort());
  // Exact pins, never a range — a range opens a broken-install window mid-publish.
  for (const spec of Object.values(optional)) expect(spec).toBe(VERSION);

  expect(shimJs.split("\n")[0]).toBe("#!/usr/bin/env node");
  // The four load-bearing shim details.
  expect(shimJs).toContain("require.resolve");
  expect(shimJs).toContain('stdio: "inherit"');
  expect(shimJs).toContain("process.kill(process.pid");
  expect(shimJs).toContain("--no-optional");
});

test("each platform package gates on os/cpu, ships one binary, and declares no engines", () => {
  for (const target of TARGETS) {
    const manifest = platformPackage(target, VERSION) as Record<string, unknown>;
    expect(manifest["name"]).toBe(target.pkgName);
    expect(manifest["version"]).toBe(VERSION);
    expect(manifest["os"]).toEqual([target.npmOs]);
    expect(manifest["cpu"]).toEqual([target.npmCpu]);
    expect(manifest["files"]).toEqual(["bin"]);
    expect(manifest).not.toHaveProperty("engines");
    // The launcher resolves the binary itself; npm must not link this one.
    expect(manifest).not.toHaveProperty("bin");
  }
});

test("the publish plan is dependencies-first, platforms before the launcher", async () => {
  const plan = await publishPlan();
  expect(plan.map((step) => step.name)).toEqual([
    // libs, dependencies before dependents
    "@autono/pinbox-core",
    "@autono/pinbox-toolbar",
    "@autono/pinbox-mcp",
    // every exact pin the launcher declares must already resolve when it lands
    ...TARGETS.map((t) => t.pkgName),
    "@autono/pinbox",
  ]);
});

// The tag is the only thing that says which version a release IS; the manifests are what every
// artifact reads. Both entry points take that version as an argument so the two can be compared
// — called with no argument the check degenerates into comparing the manifest to itself.
test("compiling a version the CLI manifest does not claim fails before any build", async () => {
  await expect(compileAll("0.0.0-not-the-manifest", `${tmp}/never`)).rejects.toThrow(
    /version mismatch/,
  );
  expect(await Bun.file(`${tmp}/never`).exists()).toBe(false);
});

test("publishing a version the CLI manifest does not claim fails before any network call", async () => {
  await expect(
    publishAll({ dryRun: true, noProvenance: false, expectVersion: "0.0.0-not-the-manifest" }),
  ).rejects.toThrow(/version mismatch/);
});

test("the launcher tarball stays under 20 KB", async () => {
  expect(Bun.file(launcherTgz).size).toBeLessThan(20 * 1024);
});

test("npm install of two tarballs yields a working pinbox with bun off PATH", async () => {
  expect(nodePath, "node is required to exercise the npm launcher").not.toBeNull();
  expect(Bun.which("bun", { PATH: INSTALL_PATH })).toBeNull();

  const install = Bun.spawnSync(
    ["npm", "install", platformTgz, launcherTgz, "--no-audit", "--no-fund"],
    { cwd: projectDir, env, stdout: "pipe", stderr: "pipe" },
  );
  expect(
    install.exitCode,
    `npm install failed: ${install.stderr.toString()}${install.stdout.toString()}`,
  ).toBe(0);

  // The three foreign platform packages do not exist at 0.0.0-test: npm skips them.
  for (const target of TARGETS) {
    const installed = await Bun.file(
      `${projectDir}/node_modules/${target.pkgName}/package.json`,
    ).exists();
    expect(installed, `${target.pkgName} should be present iff it is this machine`).toBe(
      target === currentTarget(),
    );
  }

  // node shim → embedded-runtime binary
  const version = await run(["--version"]);
  expect(version.code, version.stderr).toBe(0);
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

  const summary = await run(["summary", "--json"]);
  expect(summary.code, summary.stderr).toBe(0);
  expect(JSON.parse(summary.stdout)).toMatchObject({ ok: true });

  // Exit-code passthrough: E_NOT_FOUND is 3 through the shim, not the shim's own status.
  const missing = await run(["show", "pin_0000000000", "--json"]);
  expect(missing.code).toBe(3);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    ok: false,
    error: { code: "E_NOT_FOUND" },
  });
}, 300_000);

async function pack(dir: string, filename: string): Promise<string> {
  const tarball = `${tmp}/tarballs/${filename}`;
  const packed = Bun.spawnSync(["bun", "pm", "pack", "--filename", tarball, "--quiet"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) throw new Error(`bun pm pack failed in ${dir}: ${packed.stderr}`);
  return tarball;
}

/** Run the npm-installed launcher in the temp project, bun-free. */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([`${projectDir}/node_modules/.bin/pinbox`, ...args], {
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Same shape as e2e/loop.test.ts — the daemon's state file, project id hashed. */
async function readHubState(): Promise<{ pid: number } | null> {
  try {
    const glob = new Bun.Glob("pinbox/*/hub.json");
    const first = [...glob.scanSync({ cwd: `${tmp}/state`, dot: true })][0];
    if (first === undefined) return null;
    return (await Bun.file(`${tmp}/state/${first}`).json()) as { pid: number };
  } catch {
    return null;
  }
}

// Publishing is eight sequential steps and npm refuses to overwrite a version, so without a
// registry check a failure partway leaves a release that can never be re-run: the retry dies on
// step one with EPUBLISHCONFLICT and the remaining packages never ship.
test("every publish step passes an identity so an already-published version is skipped", async () => {
  const source = await Bun.file(`${import.meta.dir}/publish.ts`).text();
  expect(source).toContain("alreadyPublished");
  // Three call sites: the workspace libraries, the platform packages, the launcher — the last
  // matters most, since its publish-last ordering is meaningless if a retry cannot reach it.
  expect(source).toContain("name: target.pkgName");
  expect(source).toContain('name: "@autono/pinbox"');
});

test("the registry probe treats only a 200 as published", async () => {
  const source = await Bun.file(`${import.meta.dir}/publish.ts`).text();
  // A 404 (never published) and a network error must both mean "publish anyway" — never the
  // reverse, which would silently skip a package that was never released.
  expect(source).toContain("res.status === 200");
  expect(source).toContain(".catch(() => null)");
});
