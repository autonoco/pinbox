import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { StatePaths } from "./paths.ts";
import { detectChannel, scheduleUpdateCheck, updateHint } from "./update.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-08-04T12:00:00.000Z");

let dirs: string[] = [];

afterEach(async () => {
  delete process.env["PINBOX_NO_UPDATE"];
  delete process.env["CI"];
  for (const dir of dirs) await $`rm -rf ${dir}`.quiet();
  dirs = [];
});

async function tempPaths(): Promise<StatePaths> {
  const stateDir = `${await $`mktemp -d`.text()}`.trim();
  dirs.push(stateDir);
  return {
    stateDir,
    stateFile: `${stateDir}/hub.json`,
    dbFile: `${stateDir}/pinbox.db`,
    serverJson: `${stateDir}/server.json`,
  };
}

function countingFetch(latest = "9.9.9"): { calls: number[]; fetchImpl: typeof fetch } {
  const calls: number[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(1);
    const url = String(input);
    if (url.includes("api.github.com")) return Response.json({ tag_name: `v${latest}` });
    return Response.json({ latest });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("detectChannel", () => {
  test("compiled binary entry (/$bunfs/) is the binary channel", () => {
    expect(detectChannel("/$bunfs/root/pinbox")).toBe("binary");
  });
  test("source/npm entry is the npm channel", () => {
    expect(detectChannel("/Users/x/pinbox/packages/cli/src/main.ts")).toBe("npm");
  });
});

describe("scheduleUpdateCheck", () => {
  test("writes {latest, checkedAt, channel} to stateDir/update.json", async () => {
    const paths = await tempPaths();
    const { calls, fetchImpl } = countingFetch("1.2.3");
    await scheduleUpdateCheck(paths, { fetchImpl, now: () => T0 });
    expect(calls).toHaveLength(1);
    const written = (await Bun.file(`${paths.stateDir}/update.json`).json()) as {
      latest: string;
      checkedAt: string;
      channel: string;
    };
    expect(written.latest).toBe("1.2.3");
    expect(written.checkedAt).toBe(new Date(T0).toISOString());
    expect(written.channel).toBe("npm");
  });

  test("a fresh update.json short-circuits; 6h+1s later it fetches again", async () => {
    const paths = await tempPaths();
    const first = countingFetch();
    await scheduleUpdateCheck(paths, { fetchImpl: first.fetchImpl, now: () => T0 });
    expect(first.calls).toHaveLength(1);

    const fresh = countingFetch();
    await scheduleUpdateCheck(paths, { fetchImpl: fresh.fetchImpl, now: () => T0 + 6 * HOUR });
    expect(fresh.calls).toHaveLength(0);

    const stale = countingFetch();
    await scheduleUpdateCheck(paths, {
      fetchImpl: stale.fetchImpl,
      now: () => T0 + 6 * HOUR + 1_000,
    });
    expect(stale.calls).toHaveLength(1);
  });

  test.each(["PINBOX_NO_UPDATE", "CI"])("%s=1 disables the check entirely", async (name) => {
    const paths = await tempPaths();
    process.env[name] = "1";
    const { calls, fetchImpl } = countingFetch();
    await scheduleUpdateCheck(paths, { fetchImpl, now: () => T0 });
    expect(calls).toHaveLength(0);
    expect(await Bun.file(`${paths.stateDir}/update.json`).exists()).toBe(false);
  });

  test("a never-resolving fetch returns within the hard cap without throwing", async () => {
    const paths = await tempPaths();
    const fetchImpl = (() => new Promise(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    await scheduleUpdateCheck(paths, { fetchImpl, now: () => T0 });
    expect(Date.now() - started).toBeLessThan(4_500);
  }, 10_000);

  test("a failing fetch is a silent no-op", async () => {
    const paths = await tempPaths();
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await scheduleUpdateCheck(paths, { fetchImpl, now: () => T0 });
    expect(await Bun.file(`${paths.stateDir}/update.json`).exists()).toBe(false);
  });
});

describe("updateHint", () => {
  async function seed(stateDir: string, latest: string): Promise<void> {
    await Bun.write(
      `${stateDir}/update.json`,
      JSON.stringify({ latest, checkedAt: new Date(T0).toISOString(), channel: "npm" }),
    );
  }

  test("newer latest formats the one-line hint", async () => {
    const paths = await tempPaths();
    await seed(paths.stateDir, "1.2.3");
    const hint = updateHint(paths.stateDir, "1.0.0");
    expect(hint).toContain("pinbox 1.2.3 is available");
    expect(hint).toContain("installed 1.0.0");
    expect(hint).toContain("releases");
  });

  test("equal or older latest is null", async () => {
    const paths = await tempPaths();
    await seed(paths.stateDir, "1.0.0");
    expect(updateHint(paths.stateDir, "1.0.0")).toBeNull();
    expect(updateHint(paths.stateDir, "1.0.1")).toBeNull();
  });

  test("absent or unreadable update.json is null", async () => {
    const paths = await tempPaths();
    expect(updateHint(paths.stateDir, "1.0.0")).toBeNull();
    await Bun.write(`${paths.stateDir}/update.json`, "not json");
    expect(updateHint(paths.stateDir, "1.0.0")).toBeNull();
  });
});
