// Layer-2 headless handoff, both rules learned the hard way:
// the brief travels as ONE argv element, output is collected by awaiting the STREAM's
// close (never `exit` — a probe lost 65,538 of 200,000 bytes), and a timeout kills the
// whole process group (agent CLIs spawn grandchildren; killing the direct pid orphans them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { AgentSpec } from "../agents.ts";
import { spawnIntegrationAgent } from "./spawn.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-spawn-${crypto.randomUUID()}`;

/** A brief-shaped payload: multi-line, quoted, backticked — must survive as one argv. */
const BRIEF = "line one\nline `two` with \"quotes\" and 'ticks'\n$(not a substitution)\n";

async function writeStub(name: string, body: string): Promise<string> {
  const path = `${tmpRoot}/${name}`;
  await Bun.write(path, `#!/bin/sh\n${body}`);
  await $`chmod 0755 ${path}`.quiet();
  return path;
}

/** Registry entry pointing at a stub binary; only `headless` matters to spawn. */
function specFor(path: string, headless: AgentSpec["headless"]): AgentSpec {
  return {
    id: "claude",
    bin: path,
    configDir: "~/.claude",
    envMarkers: [],
    headless,
    install: { kind: "skills-dir" },
  };
}

beforeAll(async () => {
  await $`mkdir -p ${tmpRoot}`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("spawnIntegrationAgent", () => {
  test("passes the brief as one argv element and captures the stream to close", async () => {
    const count = `${tmpRoot}/argc`;
    const arg1 = `${tmpRoot}/arg1`;
    const arg2 = `${tmpRoot}/arg2`;
    const stub = await writeStub(
      "capture",
      [
        `printf '%s' "$#" > ${count}`,
        `printf '%s' "$1" > ${arg1}`,
        `printf '%s' "$2" > ${arg2}`,
        // 200 KB before a delayed marker: `exit` fires before the pipe drains, so a
        // result that ends in the marker proves the stream (not exit) was awaited.
        "head -c 200000 /dev/zero | tr '\\0' x",
        "sleep 0.2",
        "printf 'DONE\\n'",
      ].join("\n"),
    );
    const spec = specFor(stub, (prompt) => [stub, "-p", prompt]);

    const result = await spawnIntegrationAgent(spec, BRIEF, { cwd: tmpRoot });

    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBe(200_005);
    expect(result.output.endsWith("DONE\n")).toBe(true);
    expect(await Bun.file(count).text()).toBe("2");
    expect(await Bun.file(arg1).text()).toBe("-p");
    expect(await Bun.file(arg2).text()).toBe(BRIEF);
  });

  test("timeout kills the whole group — grandchildren never outlive the spawn", async () => {
    const canary = `${tmpRoot}/canary`;
    const stub = await writeStub(
      "orphan",
      // A grandchild that would write the canary a second later, and a parent that
      // would outlive the timeout. Killing only the direct pid leaves the canary.
      [`( sleep 1; : > ${canary} ) &`, "sleep 5"].join("\n"),
    );
    const spec = specFor(stub, (prompt) => [stub, prompt]);

    const result = await spawnIntegrationAgent(spec, BRIEF, { cwd: tmpRoot, timeoutMs: 300 });

    expect(result.exitCode).not.toBe(0);
    await Bun.sleep(1500);
    expect(await Bun.file(canary).exists()).toBe(false);
  }, 10_000);

  test("a failing agent surfaces its stderr with the non-zero exit code", async () => {
    const stub = await writeStub(
      "boom",
      ["printf 'partial\\n'", "printf 'boom\\n' >&2", "exit 3"].join("\n"),
    );
    const spec = specFor(stub, (prompt) => [stub, prompt]);

    const result = await spawnIntegrationAgent(spec, BRIEF, { cwd: tmpRoot });

    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("partial");
    expect(result.output).toContain("boom");
  });

  test("an agent with no headless entry point is a loud E_INTERNAL, never a silent no-op", async () => {
    const spec = specFor(`${tmpRoot}/absent`, null);
    await expect(spawnIntegrationAgent(spec, BRIEF, { cwd: tmpRoot })).rejects.toThrow(/headless/);
  });
});
