// readHubToken — XDG parity with packages/cli/src/paths.ts. The CLI computes the state
// dir id as sha256(physical project path).slice(0, 12) via Bun.CryptoHasher + `pwd -P`;
// the plugin (guest rule: node: shared subset) must land on the SAME directory via
// node:crypto + realpathSync. The fixture id below is computed the CLI way on purpose —
// the assertion passing IS the parity proof.
//
// `readServerPort` and `probeHub` are covered here too: they are the module's two discovery
// seams — the halves `ensureHub` composes — and they are exported so this file (and any future
// plugin host) can exercise them without spawning a daemon. Their contract is "never throw,
// return undefined/false on anything unexpected", which is only worth asserting directly.
//
// The tests themselves are OUR process (bun test), so Bun APIs are correct here — the guest
// rule binds daemon.ts, not its test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeHub, readHubToken, readServerPort } from "./daemon.ts";

let root: string;
let projectDir: string;
let stateHome: string;
let savedXdg: string | undefined;

/** The CLI way (paths.ts): Bun.CryptoHasher over the `pwd -P` physical path. */
function cliProjectId(dir: string): string {
  const result = Bun.spawnSync(["pwd", "-P"], { cwd: dir });
  const physical = result.success ? result.stdout.toString().trim() : dir;
  return new Bun.CryptoHasher("sha256").update(physical).digest("hex").slice(0, 12);
}

function writeHubJson(id: string, content: string): void {
  const dir = join(stateHome, "pinbox", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hub.json"), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pinbox-daemon-test-"));
  projectDir = join(root, "project");
  stateHome = join(root, "state");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  savedXdg = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = stateHome;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = savedXdg;
  rmSync(root, { recursive: true, force: true });
});

describe("readHubToken", () => {
  test("reads the token from a CLI-id'd XDG tree (hash parity with paths.ts)", () => {
    writeHubJson(
      cliProjectId(projectDir),
      JSON.stringify({ pid: 123, port: 4242, token: "tok_parity", version: "0.0.0" }),
    );
    expect(readHubToken(projectDir)).toBe("tok_parity");
  });

  test("resolves symlinked project roots to the same state dir (physical path rule)", () => {
    // tmpdir() on macOS is /var/... which is itself a symlink into /private — the fixture id
    // computed via `pwd -P` only matches if readHubToken resolves the physical path too.
    writeHubJson(
      cliProjectId(projectDir),
      JSON.stringify({ pid: 1, port: 1, token: "tok_sym", version: "0.0.0" }),
    );
    expect(readHubToken(projectDir)).toBe("tok_sym");
  });

  test("returns undefined when hub.json is missing", () => {
    expect(readHubToken(projectDir)).toBeUndefined();
  });

  test("returns undefined on garbled JSON", () => {
    writeHubJson(cliProjectId(projectDir), "{not json");
    expect(readHubToken(projectDir)).toBeUndefined();
  });

  test("returns undefined when the token field is missing or not a string", () => {
    writeHubJson(cliProjectId(projectDir), JSON.stringify({ pid: 1, port: 1, token: 42 }));
    expect(readHubToken(projectDir)).toBeUndefined();
  });

  test("returns undefined (never throws) when the project dir does not exist", () => {
    expect(readHubToken(join(root, "no-such-dir"))).toBeUndefined();
  });
});

/** `.pinbox/server.json` is the in-repo half: the PORT ONLY, never the token. */
function writeServerJson(content: string): void {
  mkdirSync(join(projectDir, ".pinbox"), { recursive: true });
  writeFileSync(join(projectDir, ".pinbox", "server.json"), content);
}

describe("readServerPort", () => {
  test("reads the port from .pinbox/server.json", () => {
    writeServerJson(JSON.stringify({ port: 4242 }));
    expect(readServerPort(projectDir)).toBe(4242);
  });

  test("ignores any other field the daemon may add", () => {
    writeServerJson(JSON.stringify({ port: 4242, startedAt: "2026-08-05T00:00:00.000Z" }));
    expect(readServerPort(projectDir)).toBe(4242);
  });

  test("returns undefined when server.json is missing", () => {
    expect(readServerPort(projectDir)).toBeUndefined();
  });

  test("returns undefined on garbled JSON", () => {
    writeServerJson("{not json");
    expect(readServerPort(projectDir)).toBeUndefined();
  });

  test("returns undefined for a JSON scalar (parses, but is not an object)", () => {
    writeServerJson("4242");
    expect(readServerPort(projectDir)).toBeUndefined();
  });

  test("rejects a port that is not a usable TCP port", () => {
    for (const port of [0, -1, 65536, 1.5, "4242", null]) {
      writeServerJson(JSON.stringify({ port }));
      expect(readServerPort(projectDir)).toBeUndefined();
    }
  });

  test("returns undefined (never throws) when the project dir does not exist", () => {
    expect(readServerPort(join(root, "no-such-dir"))).toBeUndefined();
  });
});

describe("probeHub", () => {
  test("true when /health answers 2xx", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      expect(await probeHub(server.url.origin)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("false when /health answers non-2xx (something else owns the port)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      expect(await probeHub(server.url.origin)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("false when nothing is listening", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const origin = server.url.origin;
    server.stop(true);
    expect(await probeHub(origin)).toBe(false);
  });

  test("false when the hub hangs past the timeout (never throws AbortError)", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      expect(await probeHub(server.url.origin, 50)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
