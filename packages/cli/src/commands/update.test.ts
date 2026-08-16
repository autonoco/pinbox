import { afterEach, describe, expect, test } from "bun:test";
import { performUpdate } from "./update.ts";

afterEach(() => {
  delete process.env["PINBOX_NO_UPDATE"];
  delete process.env["CI"];
});

function githubFetch(latest: string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return Response.json({ tag_name: `v${latest}` });
    return new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("performUpdate", () => {
  test("--check reports a newer release without applying", async () => {
    const applied: string[] = [];
    const data = await performUpdate(true, {
      current: "1.0.0",
      channel: "binary",
      fetchImpl: githubFetch("1.2.0"),
      apply: async (opts) => {
        applied.push(opts.latest);
        return { current: opts.current, latest: opts.latest, updated: true };
      },
    });
    expect(data).toEqual({
      current: "1.0.0",
      latest: "1.2.0",
      available: true,
      updated: false,
    });
    expect(applied).toEqual([]);
  });

  test("applies when the compiled binary is behind", async () => {
    const data = await performUpdate(false, {
      current: "1.0.0",
      channel: "binary",
      fetchImpl: githubFetch("1.2.0"),
      apply: async (opts) => ({ current: opts.current, latest: opts.latest, updated: true }),
    });
    expect(data.updated).toBe(true);
    expect(data.latest).toBe("1.2.0");
  });

  test("source installs can --check but cannot replace Bun", async () => {
    const check = await performUpdate(true, {
      current: "1.0.0",
      channel: "npm",
      fetchImpl: githubFetch("1.2.0"),
    });
    expect(check.available).toBe(true);
    await expect(
      performUpdate(false, { current: "1.0.0", channel: "npm", fetchImpl: githubFetch("1.2.0") }),
    ).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  test("current version is already up to date", async () => {
    const data = await performUpdate(false, {
      current: "1.2.0",
      channel: "binary",
      fetchImpl: githubFetch("1.2.0"),
      apply: async () => {
        throw new Error("should not apply");
      },
    });
    expect(data).toEqual({
      current: "1.2.0",
      latest: "1.2.0",
      available: false,
      updated: false,
    });
  });
});
