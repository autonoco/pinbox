import { afterEach, describe, expect, test } from "bun:test";
import { assertReleaseVersion, bumpVersion, VERSIONED_PACKAGES } from "./bump-version.ts";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch !== undefined) await Bun.$`rm -rf ${scratch}`.quiet();
  scratch = undefined;
});

async function fixture(): Promise<string> {
  scratch = (await Bun.$`mktemp -d`.text()).trim();
  for (const dir of VERSIONED_PACKAGES) {
    await Bun.$`mkdir -p ${scratch}/${dir}`.quiet();
    await Bun.write(
      `${scratch}/${dir}/package.json`,
      `${JSON.stringify({ name: dir, version: "0.1.0" }, null, 2)}\n`,
    );
  }
  return `${scratch}/`;
}

describe("assertReleaseVersion", () => {
  test("accepts plain and prerelease semver", () => {
    assertReleaseVersion("0.2.0");
    assertReleaseVersion("1.0.0-rc.1");
  });

  test("rejects garbage", () => {
    expect(() => assertReleaseVersion("v0.2.0")).toThrow(/not a release version/);
    expect(() => assertReleaseVersion("0.2")).toThrow(/not a release version/);
  });
});

describe("bumpVersion", () => {
  test("writes the same version into every shipped package", async () => {
    const root = await fixture();
    const touched = await bumpVersion("0.2.0", root);
    expect(touched).toHaveLength(VERSIONED_PACKAGES.length);
    for (const dir of VERSIONED_PACKAGES) {
      const manifest = (await Bun.file(`${root}${dir}/package.json`).json()) as {
        version: string;
      };
      expect(manifest.version).toBe("0.2.0");
    }
  });
});
