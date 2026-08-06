// `.pinbox/` state-dir writer: create / unchanged / dry-run, and — the reason this module
// exists — a mkdir that FAILS must be reported, not reported as "created".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { CliError } from "../errors.ts";
import { ensurePinboxDir } from "./state-dir.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-statedir-${crypto.randomUUID()}`;

async function project(name: string): Promise<string> {
  const dir = `${tmpRoot}/${name}`;
  await $`mkdir -p ${dir}`.quiet();
  return dir;
}

/** `Bun.file().exists()` is false for directories — ask the filesystem directly. */
function dirExists(path: string): boolean {
  return Bun.spawnSync(["test", "-d", path]).exitCode === 0;
}

beforeAll(async () => {
  await $`mkdir -p ${tmpRoot}`.quiet();
});

afterAll(async () => {
  // The read-only fixture has to be made writable again or rm -rf cannot descend.
  await $`chmod -R u+w ${tmpRoot}`.quiet().nothrow();
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("ensurePinboxDir", () => {
  test("creates the dir, and the directory really exists afterwards", async () => {
    const dir = await project("fresh");
    expect(ensurePinboxDir(dir, false)).toBe("created");
    expect(dirExists(`${dir}/.pinbox`)).toBe(true);
  });

  test("an existing dir is unchanged", async () => {
    const dir = await project("again");
    ensurePinboxDir(dir, false);
    expect(ensurePinboxDir(dir, false)).toBe("unchanged");
  });

  test("--dry-run predicts 'created' and writes nothing", async () => {
    const dir = await project("dry");
    expect(ensurePinboxDir(dir, true)).toBe("created");
    expect(dirExists(`${dir}/.pinbox`)).toBe(false);
  });

  test("an unwritable project dir fails loudly instead of reporting 'created'", async () => {
    const dir = await project("readonly");
    await $`chmod 0500 ${dir}`.quiet();
    let thrown: unknown;
    try {
      ensurePinboxDir(dir, false);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).message).toContain(".pinbox");
    expect((thrown as CliError).hint).toBeDefined();
    // And it was not a lie: nothing was created.
    expect(dirExists(`${dir}/.pinbox`)).toBe(false);
  });

  test("--dry-run over an unwritable dir still fails loudly — the prediction would be wrong", async () => {
    const dir = await project("readonly-dry");
    await $`chmod 0500 ${dir}`.quiet();
    expect(() => ensurePinboxDir(dir, true)).toThrow(CliError);
  });
});
