import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import {
  applyBinaryUpdate,
  atomicReplace,
  isHomebrewManaged,
  parseSha256,
  releaseAssetName,
  sha256Hex,
} from "./update-apply.ts";

let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await $`rm -rf ${dir}`.quiet();
  dirs = [];
});

describe("releaseAssetName", () => {
  test("maps the four shipped platforms", () => {
    expect(releaseAssetName("darwin", "arm64")).toBe("pinbox-darwin-arm64");
    expect(releaseAssetName("linux", "x64")).toBe("pinbox-linux-x64");
  });
  test("rejects platforms we do not ship", () => {
    expect(releaseAssetName("win32", "x64")).toBeNull();
  });
});

describe("parseSha256 / sha256Hex", () => {
  test("reads the install.sh checksum line", () => {
    expect(parseSha256("abc123  pinbox-darwin-arm64\n", "pinbox-darwin-arm64")).toBe("abc123");
    expect(parseSha256("abc123  other\n", "pinbox-darwin-arm64")).toBeNull();
  });
  test("hashes match the known SHA-256 vector", () => {
    const bytes = new TextEncoder().encode("pinbox");
    // printf 'pinbox' | sha256sum
    expect(sha256Hex(bytes)).toBe(
      "aba2bdae61359f8be90ab24c275a7c7fcc817ef2c48615d96ce585f3c190aa2e",
    );
  });
});

test("isHomebrewManaged", () => {
  expect(isHomebrewManaged("/opt/homebrew/bin/pinbox")).toBe(true);
  expect(isHomebrewManaged("/usr/local/Cellar/pinbox/0.7.0/bin/pinbox")).toBe(true);
  expect(isHomebrewManaged("/Users/x/.local/bin/pinbox")).toBe(false);
});

test("applyBinaryUpdate verifies the checksum then replaces dest", async () => {
  const dir = `${await $`mktemp -d`.text()}`.trim();
  dirs.push(dir);
  const dest = `${dir}/pinbox`;
  await Bun.write(dest, "old");
  const asset = releaseAssetName();
  if (asset === null) return;
  const bytes = new TextEncoder().encode("new-bin");
  const hash = sha256Hex(bytes);
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(".sha256")) return new Response(`${hash}  ${asset}\n`);
    if (url.endsWith(`/${asset}`)) return new Response(bytes);
    return new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
  const result = await applyBinaryUpdate({
    current: "1.0.0",
    latest: "1.1.0",
    dest,
    fetchImpl,
  });
  expect(result.updated).toBe(true);
  expect(await Bun.file(dest).text()).toBe("new-bin");
});

test("atomicReplace swaps the file and leaves the new bytes", async () => {
  const dir = `${await $`mktemp -d`.text()}`.trim();
  dirs.push(dir);
  const dest = `${dir}/pinbox`;
  await Bun.write(dest, "old");
  await $`chmod 755 ${dest}`.quiet();
  await atomicReplace(dest, new TextEncoder().encode("new"));
  expect(await Bun.file(dest).text()).toBe("new");
  // Nothing but the installed binary is left behind: no temp file, no .old copy.
  expect((await $`ls -A ${dir}`.text()).trim()).toBe("pinbox");
});
