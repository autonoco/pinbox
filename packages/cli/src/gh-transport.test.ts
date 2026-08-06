// pinbox CLI — gh transport tests. A stub `gh` script prepended to PATH (mkdtemp bin dir)
// records argv one-per-line and replays canned stdout/stderr/exit, so every §7 op is
// asserted against its exact `gh` argv with no network and no real gh install.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { ghTransport, localConnectors } from "./gh-transport.ts";

const STUB = `#!/bin/sh
dir="$GH_STUB_DIR"
n=$(cat "$dir/count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s' "$n" > "$dir/count"
for arg in "$@"; do printf '%s\\0' "$arg"; done > "$dir/argv-$n"
if [ -f "$dir/no-create-json" ]; then
  case " $* " in
    *" --json "*) printf 'unknown flag: --json\\n' >&2; exit 1 ;;
  esac
fi
[ -f "$dir/stderr" ] && cat "$dir/stderr" >&2
[ -f "$dir/stdout" ] && cat "$dir/stdout"
exit "$(cat "$dir/exit" 2>/dev/null || echo 0)"
`;

let stubDir = ""; // stub state: argv logs + canned stdout/stderr/exit files
const originalPath = process.env["PATH"] ?? "";

beforeEach(async () => {
  stubDir = (await $`mktemp -d`.text()).trim();
  await Bun.write(`${stubDir}/bin/gh`, STUB);
  await $`chmod 755 ${`${stubDir}/bin/gh`}`.quiet();
  process.env["PATH"] = `${stubDir}/bin:${originalPath}`;
  process.env["GH_STUB_DIR"] = stubDir;
});

afterEach(async () => {
  process.env["PATH"] = originalPath;
  delete process.env["GH_STUB_DIR"];
  await $`rm -rf ${stubDir}`.quiet();
});

async function recordedArgv(call: number): Promise<string[]> {
  // NUL-separated: argv elements (issue bodies) legitimately contain newlines.
  const text = await Bun.file(`${stubDir}/argv-${call}`).text();
  return text.split("\0").slice(0, -1);
}

describe("ghTransport op → argv mapping", () => {
  test("issue.create maps to the exact argv and parses gh's JSON", async () => {
    await Bun.write(
      `${stubDir}/stdout`,
      '{"number":123,"url":"https://github.com/acme/app/issues/123"}',
    );
    const result = await ghTransport(stubDir).request("issue.create", {
      title: "button is cut off",
      body: "pin body\n\n— pinbox pin pin_ab12cd34ef",
    });
    expect(result).toEqual({ number: 123, url: "https://github.com/acme/app/issues/123" });
    expect(await recordedArgv(1)).toEqual([
      "issue",
      "create",
      "--title",
      "button is cut off",
      "--body",
      "pin body\n\n— pinbox pin pin_ab12cd34ef",
      "--json",
      "number,url",
    ]);
  });

  test("issue.create falls back to URL-on-stdout parsing when gh lacks --json", async () => {
    await Bun.write(`${stubDir}/no-create-json`, "");
    await Bun.write(`${stubDir}/stdout`, "https://github.com/acme/app/issues/7\n");
    const result = await ghTransport(stubDir).request("issue.create", {
      title: "t",
      body: "b",
    });
    expect(result).toEqual({ number: 7, url: "https://github.com/acme/app/issues/7" });
    // first attempt carried --json; the retry dropped it
    expect(await recordedArgv(1)).toContain("--json");
    expect(await recordedArgv(2)).toEqual(["issue", "create", "--title", "t", "--body", "b"]);
  });

  test("issue.comment maps to gh issue comment <n> --body", async () => {
    await ghTransport(stubDir).request("issue.comment", { number: 42, body: "mirrored" });
    expect(await recordedArgv(1)).toEqual(["issue", "comment", "42", "--body", "mirrored"]);
  });

  test("issue.view maps argv and normalizes gh's shape (state case, author.login)", async () => {
    await Bun.write(
      `${stubDir}/stdout`,
      JSON.stringify({
        state: "CLOSED",
        comments: [
          { author: { login: "benji" }, body: "ship it", createdAt: "2026-08-04T00:00:00Z" },
        ],
      }),
    );
    const result = await ghTransport(stubDir).request("issue.view", { number: 42 });
    expect(result).toEqual({
      state: "closed",
      comments: [{ author: "benji", body: "ship it", createdAt: "2026-08-04T00:00:00Z" }],
    });
    expect(await recordedArgv(1)).toEqual(["issue", "view", "42", "--json", "state,comments"]);
  });

  test("issue.close and issue.reopen map to their argv", async () => {
    const transport = ghTransport(stubDir);
    await transport.request("issue.close", { number: 9 });
    await transport.request("issue.reopen", { number: 9 });
    expect(await recordedArgv(1)).toEqual(["issue", "close", "9"]);
    expect(await recordedArgv(2)).toEqual(["issue", "reopen", "9"]);
  });

  test("non-zero exit throws an Error carrying gh's stderr", async () => {
    await Bun.write(`${stubDir}/exit`, "1");
    await Bun.write(`${stubDir}/stderr`, "gh: To get started with GitHub CLI, run gh auth login\n");
    expect(ghTransport(stubDir).request("issue.view", { number: 1 })).rejects.toThrow(
      /gh auth login/,
    );
  });

  test("unknown op throws", async () => {
    expect(ghTransport(stubDir).request("issue.transfer", { number: 1 })).rejects.toThrow(
      /unknown gh op/,
    );
  });
});

describe("localConnectors", () => {
  test("returns the github connector when gh is on PATH", () => {
    const connectors = localConnectors(stubDir);
    expect(connectors.map((c) => c.name)).toEqual(["github"]);
  });

  test("returns [] when PATH has no gh", async () => {
    const empty = (await $`mktemp -d`.text()).trim();
    process.env["PATH"] = empty;
    try {
      expect(localConnectors(stubDir)).toEqual([]);
    } finally {
      process.env["PATH"] = `${stubDir}/bin:${originalPath}`;
      await $`rm -rf ${empty}`.quiet();
    }
  });
});
