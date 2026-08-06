import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startHubServer } from "@autono/pinbox-core/hub-server";
import { openStore, type PinStore } from "@autono/pinbox-core/store";
import { $ } from "bun";
import { setConnectionForTests } from "../daemon.ts";
import { buildProgram } from "../main.ts";
import {
  checkAgents,
  checkFts5,
  checkGh,
  checkPluginDelivery,
  checkSqlite,
  checkStateDir,
} from "./doctor.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-doctor-${crypto.randomUUID()}`;
const savedXdg = process.env["XDG_STATE_HOME"];

afterEach(async () => {
  if (savedXdg === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = savedXdg;
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("doctor capability probes", () => {
  test("sqlite: creates and reads a table in :memory:", () => {
    expect(checkSqlite()).toEqual({
      name: "sqlite",
      ok: true,
      detail: "created and read a table in :memory:",
    });
  });

  test("fts5: answers a MATCH query on a virtual table", () => {
    expect(checkFts5()).toEqual({
      name: "fts5",
      ok: true,
      detail: "MATCH query answered on a virtual table",
    });
  });

  test("state-dir: healthy dir reports writable with mode 0700", async () => {
    process.env["XDG_STATE_HOME"] = `${tmpRoot}/xdg-state`;
    const check = await checkStateDir(`${tmpRoot}/proj`);
    expect(check.name).toBe("state-dir");
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/writable, mode 0700$/);
  });

  test("state-dir: an uncreatable path reports ok:false with a detail", async () => {
    // A regular file where a directory component must go — creation cannot succeed.
    await $`mkdir -p ${tmpRoot}`.quiet();
    await Bun.write(`${tmpRoot}/blocker`, "not a directory");
    process.env["XDG_STATE_HOME"] = `${tmpRoot}/blocker/xdg-state`;
    const check = await checkStateDir(`${tmpRoot}/proj`);
    expect(check.name).toBe("state-dir");
    expect(check.ok).toBe(false);
    expect(check.detail.length).toBeGreaterThan(0);
  });

  test("agents: informational, always ok", () => {
    const check = checkAgents();
    expect(check.name).toBe("agents");
    expect(check.ok).toBe(true);
    expect(check.detail.length).toBeGreaterThan(0);
  });
});

// A stub root that survives the per-test tmpRoot wipe above.
const probeRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-doctor-probe-${crypto.randomUUID()}`;

/** Write an executable stub script and return its path. */
async function stub(name: string, body: string): Promise<string> {
  const path = `${probeRoot}/${name}`;
  await Bun.write(path, body, { createPath: true });
  await $`chmod 755 ${path}`.quiet();
  return path;
}

describe("gh capability probe", () => {
  const savedPath = process.env["PATH"];
  afterEach(() => {
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  test("gh missing from PATH is informational and names what it costs", () => {
    process.env["PATH"] = "";
    expect(checkGh()).toEqual({
      name: "gh",
      ok: true,
      detail: "not found — `pinbox link` unavailable until gh is installed and authed",
    });
  });

  test("gh present but unauthenticated: still ok, with the auth command as the fix", async () => {
    // A stub gh keeps the assertion deterministic on machines with or without the real one.
    await stub(
      "gh",
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.62.0 (2026-01-01)"; exit 0; fi\nexit 1\n',
    );
    process.env["PATH"] = probeRoot;
    const check = checkGh();
    expect(check.name).toBe("gh");
    expect(check.ok).toBe(true);
    expect(check.detail).toStartWith("gh 2.62.0");
    expect(check.detail).toContain("gh auth login");
  });

  test("gh present and authenticated reports the version and says so", async () => {
    await stub(
      "gh",
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.62.0 (2026-01-01)"; fi\nexit 0\n',
    );
    process.env["PATH"] = probeRoot;
    expect(checkGh()).toEqual({ name: "gh", ok: true, detail: "gh 2.62.0, authenticated" });
  });
});

// The delivery probe verifies DELIVERY, never file existence: register a
// session → post a probe pin bound to it → prove `session inject` carries the pin.
describe("plugin delivery probe", () => {
  let store: PinStore;
  let server: Awaited<ReturnType<typeof startHubServer>>;
  let projectDir = "";

  beforeAll(async () => {
    projectDir = `${probeRoot}/project`;
    await $`mkdir -p ${projectDir}`.quiet();
    store = openStore(":memory:");
    server = await startHubServer({ store, token: "t-doctor", idleMs: 60_000 });
    setConnectionForTests({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t-doctor" });
  });

  afterAll(async () => {
    setConnectionForTests(null);
    await server.close();
    store.close();
    await $`rm -rf ${probeRoot}`.quiet();
  });

  test("register that fails: ok:false naming the hop, and no probe pin is ever created", async () => {
    // What the shipped binary prints on failure: the JSON envelope, because a piped
    // stdout selects machine mode.
    const script = await stub(
      "register-fails.ts",
      'console.log(JSON.stringify({ ok: false, error: { code: "E_HUB_UNREACHABLE", message: "hub unreachable" } }));\nprocess.exit(5);\n',
    );
    const check = await checkPluginDelivery(projectDir, {
      command: [process.execPath, script],
    });
    expect(check.name).toBe("delivery");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("session register");
    expect(store.listPins()).toHaveLength(0);
  });

  test("inject that carries nothing: ok:false naming the hop that dropped the pin", async () => {
    const script = await stub(
      "silent-inject.ts",
      'if (process.argv[3] === "inject") console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "" } }));\n',
    );
    const check = await checkPluginDelivery(projectDir, {
      command: [process.execPath, script],
    });
    expect(check.name).toBe("delivery");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("session inject");
  });

  test("full round trip: the probe pin reaches inject, then leaves nothing open behind", async () => {
    // The stub plays inject: it echoes the probe text the probe derives from the key,
    // which it reads from the `--key` flag.
    const script = await stub(
      "echo-inject.ts",
      "const argv = process.argv.slice(2);\n" +
        'const key = argv[argv.indexOf("--key") + 1] ?? "";\n' +
        'if (argv[1] === "inject") {\n' +
        '  const text = "pinbox doctor delivery probe " + key;\n' +
        '  const context = "open pins:\\n- " + text;\n' +
        "  console.log(JSON.stringify({ ok: true, data: { context, pins: [{}], delivered: 1 } }));\n" +
        "}\n",
    );
    const check = await checkPluginDelivery(projectDir, {
      command: [process.execPath, script],
    });
    expect(check.name).toBe("delivery");
    expect(check.ok, check.detail).toBe(true);
    expect(check.detail).toContain("round trip");
    // The probe cleans up after itself: no probe pin is left open in the user's queue.
    expect(store.listPins({ status: "open" })).toHaveLength(0);
  });

  // The session verb declares `--agent <name>` and `--key <key>` on
  // register/inject/pending, so argv — not the environment — is the published channel.
  // A stub that refuses env-supplied refs must still see a healthy round trip.
  test("argv is the ref channel: --agent/--key reach the verb", async () => {
    const script = await stub(
      "argv-ref.ts",
      "const argv = process.argv.slice(2);\n" +
        'if (argv[argv.indexOf("--agent") + 1] !== "doctor") {\n' +
        '  console.error("error: no --agent on argv");\n' +
        "  process.exit(2);\n" +
        "}\n" +
        'const key = argv[argv.indexOf("--key") + 1] ?? "";\n' +
        'if (argv[1] === "inject") {\n' +
        '  const context = "open pins:\\n- pinbox doctor delivery probe " + key;\n' +
        "  console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: context } }));\n" +
        "}\n",
    );
    const check = await checkPluginDelivery(projectDir, {
      command: [process.execPath, script],
    });
    expect(check).toEqual({
      name: "delivery",
      ok: true,
      detail: expect.stringContaining("round trip ok") as unknown as string,
    });
    expect(store.listPins({ status: "open" })).toHaveLength(0);
  });
});

describe("command registration", () => {
  test("doctor is visible with the transcript summary; serve exists but stays hidden", () => {
    const program = buildProgram();
    const help = program.helpInformation();
    // The transcript pins the term as bare `doctor` — --json alone earns no [options].
    expect(help).toMatch(/\n {2}doctor\s+probe this machine's capabilities\n/);
    expect(help).not.toContain("serve");
    expect(program.commands.some((c) => c.name() === "serve")).toBe(true);
  });
});
