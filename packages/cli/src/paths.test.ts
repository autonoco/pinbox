import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { projectId, statePaths } from "./paths.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-paths-${crypto.randomUUID()}`;
const dirA = `${tmpRoot}/a`;
const dirB = `${tmpRoot}/b`;
const linkToA = `${tmpRoot}/link-to-a`;

beforeAll(async () => {
  await $`mkdir -p ${dirA} ${dirB}`.quiet();
  await $`ln -s ${dirA} ${linkToA}`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("projectId", () => {
  test("is 12 hex chars, stable for the same dir, distinct across dirs", () => {
    const a = projectId(dirA);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(projectId(dirA)).toBe(a);
    expect(projectId(dirB)).not.toBe(a);
  });

  test("resolves symlinks: a link and its target share one id", () => {
    expect(projectId(linkToA)).toBe(projectId(dirA));
  });
});

describe("statePaths", () => {
  test("respects XDG_STATE_HOME and splits secrets from the repo", () => {
    const prev = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = `${tmpRoot}/xdg-state`;
    try {
      const paths = statePaths(dirA);
      const id = projectId(dirA);
      expect(paths.stateDir).toBe(`${tmpRoot}/xdg-state/pinbox/${id}`);
      expect(paths.stateFile).toBe(`${paths.stateDir}/hub.json`);
      // Only non-secrets live under the project dir.
      expect(paths.dbFile).toBe(`${dirA}/.pinbox/pinbox.db`);
      expect(paths.serverJson).toBe(`${dirA}/.pinbox/server.json`);
    } finally {
      if (prev === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = prev;
    }
  });

  test("defaults to ~/.local/state when XDG_STATE_HOME is unset", () => {
    const prev = process.env["XDG_STATE_HOME"];
    delete process.env["XDG_STATE_HOME"];
    try {
      const paths = statePaths(dirA);
      expect(paths.stateDir).toBe(`${process.env["HOME"]}/.local/state/pinbox/${projectId(dirA)}`);
    } finally {
      if (prev !== undefined) process.env["XDG_STATE_HOME"] = prev;
    }
  });
});
