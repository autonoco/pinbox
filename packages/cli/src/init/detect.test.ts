import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { detectRepo, invocationMode } from "./detect.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-detect-${crypto.randomUUID()}`;
const viteBunRepo = `${tmpRoot}/vite-bun`;
const nextPnpmDir = `${tmpRoot}/next-pnpm`;
const emptyDir = `${tmpRoot}/empty`;

beforeAll(async () => {
  await $`mkdir -p ${viteBunRepo}/.git ${nextPnpmDir} ${emptyDir}`.quiet();
  await Bun.write(`${viteBunRepo}/bun.lock`, "");
  await Bun.write(`${viteBunRepo}/vite.config.ts`, "export default {};\n");
  await Bun.write(`${nextPnpmDir}/pnpm-lock.yaml`, "");
  await Bun.write(`${nextPnpmDir}/next.config.js`, "module.exports = {};\n");
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("invocationMode", () => {
  test("--agent-mode on a TTY with no env fingerprint is agent (flags win)", () => {
    expect(invocationMode({ flags: { agentMode: true }, env: {}, isTTY: true })).toBe("agent");
  });

  test("--no-input and --yes are explicit agent signals too", () => {
    expect(invocationMode({ flags: { noInput: true }, env: {}, isTTY: true })).toBe("agent");
    expect(invocationMode({ flags: { yes: true }, env: {}, isTTY: true })).toBe("agent");
  });

  test("CLAUDECODE=1 on a TTY fingerprints as agent", () => {
    expect(invocationMode({ flags: {}, env: { CLAUDECODE: "1" }, isTTY: true })).toBe("agent");
  });

  test("CI=true fingerprints as agent", () => {
    expect(invocationMode({ flags: {}, env: { CI: "true" }, isTTY: true })).toBe("agent");
  });

  test("a bare TTY with no flags and no fingerprint is human", () => {
    expect(invocationMode({ flags: {}, env: {}, isTTY: true })).toBe("human");
  });

  test("non-TTY is never human, even with nothing else set", () => {
    expect(invocationMode({ flags: {}, env: {}, isTTY: false })).toBe("agent");
  });
});

describe("detectRepo", () => {
  test("git dir + bun.lock + vite.config.ts maps to git/bun/vite", () => {
    expect(detectRepo(viteBunRepo)).toEqual({
      git: true,
      packageManager: "bun",
      framework: "vite",
    });
  });

  test("pnpm-lock.yaml + next.config.js maps to pnpm/next, no git", () => {
    expect(detectRepo(nextPnpmDir)).toEqual({
      git: false,
      packageManager: "pnpm",
      framework: "next",
    });
  });

  test("an empty dir yields nulls and never throws", () => {
    expect(detectRepo(emptyDir)).toEqual({ git: false, packageManager: null, framework: null });
    expect(detectRepo(`${tmpRoot}/does-not-exist`)).toEqual({
      git: false,
      packageManager: null,
      framework: null,
    });
  });
});
