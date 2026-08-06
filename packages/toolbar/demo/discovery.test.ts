// Demo discovery files — the contract that lets `pinbox` ADOPT the demo's hub.
//
// This is the one thing about the demo that is not self-evident from running it: the CLI's
// ensureHub() compares the hub.json `version` against ITS OWN package version and SIGTERMs
// anything else as a stale daemon. A demo that writes any other string is killed by the first
// `pinbox` command, taking the browser page's hub with it — silently, and only at checklist time.
// So the version string is asserted here against packages/cli/package.json, read independently.
import { afterEach, describe, expect, test } from "bun:test";
import { projectId, publishDiscoveryFiles } from "./discovery.ts";

const cliPackageJson = `${import.meta.dir}/../../cli/package.json`;

const created: string[] = [];
const originalStateHome = process.env["XDG_STATE_HOME"];

afterEach(async () => {
  if (originalStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = originalStateHome;
  for (const dir of created.splice(0)) await Bun.$`rm -rf ${dir}`.quiet();
});

async function scratch(): Promise<{ demoDir: string; stateHome: string }> {
  const root = `${import.meta.dir}/.test-${crypto.randomUUID().slice(0, 8)}`;
  created.push(root);
  const demoDir = `${root}/demo`;
  const stateHome = `${root}/state`;
  await Bun.$`mkdir -p ${demoDir} ${stateHome}`.quiet();
  process.env["XDG_STATE_HOME"] = stateHome;
  return { demoDir, stateHome };
}

describe("publishDiscoveryFiles", () => {
  test("writes the CLI's own version so ensureHub adopts instead of SIGTERM", async () => {
    const { demoDir, stateHome } = await scratch();
    await publishDiscoveryFiles({ demoDir, port: 4242, token: "tok", pid: 1234 });

    const state = await Bun.file(`${stateHome}/pinbox/${projectId(demoDir)}/hub.json`).json();
    const cliVersion = ((await Bun.file(cliPackageJson).json()) as { version: string }).version;

    expect(state.version).toBe(cliVersion);
  });

  test("writes a hub.json of the shape readHubState accepts", async () => {
    const { demoDir, stateHome } = await scratch();
    await publishDiscoveryFiles({ demoDir, port: 4242, token: "tok", pid: 1234 });

    // Mirrors packages/cli/src/paths.ts's HubState guard: all four fields, all typed.
    const state = await Bun.file(`${stateHome}/pinbox/${projectId(demoDir)}/hub.json`).json();
    expect(state).toMatchObject({ pid: 1234, port: 4242, token: "tok" });
    expect(typeof state.version).toBe("string");
  });

  test("writes the in-repo server.json with the port", async () => {
    const { demoDir } = await scratch();
    await publishDiscoveryFiles({ demoDir, port: 4242, token: "tok", pid: 1234 });

    expect(await Bun.file(`${demoDir}/.pinbox/server.json`).json()).toEqual({ port: 4242 });
  });
});
