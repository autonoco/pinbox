// `pinbox pin` — creating a pin from the terminal. Two halves:
//   1. buildPinInput: pure-ish input assembly (file anchor resolution, flag
//      validation, terminal author). No hub.
//   2. runPin against an IN-PROCESS hub (startHubServer + openStore(":memory:")),
//      pinned to the UX spec transcripts (docs/design/cli/v1-transcripts.md §pin).
// The contract under test is "nothing invented": a terminal pin carries the text,
// the anchor the user named, the author git knows, and the hub's git stamp — and
// no viewport, browser, os or rect it could not have measured.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { startHubServer } from "@autono/pinbox-core/hub-server";
import type { Pin } from "@autono/pinbox-core/schema";
import { openStore, type PinStore } from "@autono/pinbox-core/store";
import { setConnectionForTests } from "../daemon.ts";
import { CliError } from "../errors.ts";
import { buildPinInput, runPin } from "./pin.ts";

/** A throwaway git repo with one committed file — the real shape `--file` resolves against. */
async function tempRepo(): Promise<string> {
  // Join deliberately, never concatenate: macOS sets TMPDIR with a trailing slash and Linux
  // usually leaves it unset, so `${TMPDIR ?? "/tmp"}name` yields `/tmpname` on CI and the repo
  // lands (or fails to) at the filesystem root.
  // `||` not `??`: TMPDIR can be set-but-empty, which `??` would happily accept and turn the
  // path into `/pinbox-pin-…` at the filesystem root.
  const base = (process.env["TMPDIR"] || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/pinbox-pin-${Bun.randomUUIDv7()}`;
  await Bun.write(`${dir}/src/app.tsx`, "export const App = () => null;\n");
  const run = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  run("init", "-q");
  run("config", "user.name", "Terminal Tester");
  run("config", "user.email", "tester@example.com");
  return dir;
}

let repo = "";
beforeAll(async () => {
  repo = await tempRepo();
});

describe("buildPinInput", () => {
  test("--file resolves to a repo-relative source anchor with via:'none'", async () => {
    const input = await buildPinInput(
      "the footer overlaps on mobile",
      { file: "src/app.tsx:42" },
      repo,
    );
    expect(input.target?.source).toEqual({ file: "src/app.tsx", line: 42, via: "none" });
    expect(input.text).toBe("the footer overlaps on mobile");
  });

  test("--file without a line number omits line rather than guessing one", async () => {
    const input = await buildPinInput("x", { file: "src/app.tsx" }, repo);
    expect(input.target?.source).toEqual({ file: "src/app.tsx", via: "none" });
  });

  test("--file normalizes a path given relative to a subdirectory", async () => {
    const input = await buildPinInput("x", { file: "../src/app.tsx:7" }, `${repo}/src`);
    expect(input.target?.source?.file).toBe("src/app.tsx");
  });

  test("a terminal pin invents no env and no rect", async () => {
    const input = await buildPinInput("x", { file: "src/app.tsx:42" }, repo);
    expect(input.env).toBeUndefined();
    expect(input.target?.rect).toBeUndefined();
    expect(input.target?.url).toBeUndefined();
    expect(input.target?.selector).toBeUndefined();
  });

  test("no anchor flags at all: the pin carries no target", async () => {
    const input = await buildPinInput("make the onboarding shorter", {}, repo);
    expect(input.target).toBeUndefined();
  });

  test("--url and --selector build a target with neither rect nor tag", async () => {
    const input = await buildPinInput(
      "pricing page 404s",
      { url: "https://example.com/pricing", selector: "a.pricing" },
      repo,
    );
    expect(input.target).toEqual({ url: "https://example.com/pricing", selector: "a.pricing" });
  });

  test("author comes from git config, falling back to $USER for userId", async () => {
    const input = await buildPinInput("x", {}, repo);
    expect(input.author).toEqual({
      userId: "tester@example.com",
      name: "Terminal Tester",
      email: "tester@example.com",
    });
  });

  test("a nonexistent --file path is E_INVALID_INPUT with a real hint", async () => {
    const err = await buildPinInput("x", { file: "src/nope.tsx:42" }, repo).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    const cliError = err as CliError;
    expect(cliError.code).toBe("E_INVALID_INPUT");
    expect(cliError.message).toBe('no such file: "src/nope.tsx"');
    expect(cliError.hint).toBe("--file takes a path that exists, optionally with :line");
  });

  test("--file pointing at a directory is rejected the same way", async () => {
    const err = await buildPinInput("x", { file: "src" }, repo).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("E_INVALID_INPUT");
    expect((err as CliError).message).toBe('no such file: "src"');
  });

  test("--selector without --url is E_INVALID_INPUT", async () => {
    const err = await buildPinInput("x", { selector: "a.cta" }, repo).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("E_INVALID_INPUT");
    expect((err as CliError).message).toBe(
      "--selector needs --url (a selector without a page is not a target)",
    );
    expect((err as CliError).hint).toBe("run `pinbox pin --help` for usage");
  });

  test("empty text is E_INVALID_INPUT with the quoting hint", async () => {
    const err = await buildPinInput("   ", {}, repo).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("E_INVALID_INPUT");
    expect((err as CliError).message).toBe("pin text must not be empty");
    expect((err as CliError).hint).toBe('quote the text: pinbox pin "your text"');
  });

  test("a --url that is not an absolute URL is E_INVALID_INPUT", async () => {
    const err = await buildPinInput("x", { url: "localhost:3000" }, repo).catch((e: unknown) => e);
    expect((err as CliError).code).toBe("E_INVALID_INPUT");
    expect((err as CliError).message).toBe(
      'invalid --url: "localhost:3000" (expected an absolute URL)',
    );
  });
});

// ── runPin against a real hub ───────────────────────────────────────────────────
class ExitSignal extends Error {}

let store: PinStore;
let server: Awaited<ReturnType<typeof startHubServer>>;

beforeAll(async () => {
  store = openStore(":memory:");
  server = await startHubServer({
    store,
    token: "t-test",
    idleMs: 60_000,
    // The hub's git enrichment: the ONE env a terminal pin legitimately carries.
    enrichEnv: () => ({ branch: "main", commit: "9c2f1b8d0e4a" }),
  });
  setConnectionForTests({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t-test" });
});

afterAll(async () => {
  setConnectionForTests(null);
  await server.close();
  store.close();
});

type Captured = { out: string[]; err: string[]; exitCode: number | undefined };

/** stdout is data, stderr is messaging — capture both, plus the mapped exit code. */
async function capture(run: () => Promise<void>, tty = false): Promise<Captured> {
  const originalIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  let exitCode: number | undefined;
  const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new ExitSignal();
  }) as typeof process.exit);
  try {
    await run().catch((e: unknown) => {
      if (!(e instanceof ExitSignal)) throw e;
    });
    return {
      out: out.mock.calls.map((c) => String(c[0])),
      err: err.mock.calls.map((c) => String(c[0])),
      exitCode,
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    process.exitCode = 0;
  }
}

describe("runPin", () => {
  test("--json emits the envelope carrying the created Pin", async () => {
    const { out } = await capture(() =>
      runPin("the footer overlaps on mobile", { file: "src/app.tsx:42", json: true }, repo),
    );
    const body = JSON.parse(out.at(-1) ?? "") as { ok: boolean; data: Pin };
    expect(body.ok).toBe(true);
    expect(body.data.id).toMatch(/^pin_[a-z0-9]{10}$/);
    expect(body.data.status).toBe("open");
    expect(body.data.schemaVersion).toBe(1);
    expect(body.data.text).toBe("the footer overlaps on mobile");
    expect(body.data.target).toEqual({ source: { file: "src/app.tsx", line: 42, via: "none" } });
    // The hub's git stamp rode along; nothing else did.
    expect(body.data.env).toEqual({ branch: "main", commit: "9c2f1b8d0e4a" });
    expect(body.data.author.userId).toBe("tester@example.com");
  });

  test("the created pin is readable back through the store", async () => {
    const { out } = await capture(() => runPin("second terminal pin", { json: true }, repo));
    const body = JSON.parse(out.at(-1) ?? "") as { data: Pin };
    const stored = store.getPin(body.data.id);
    expect(stored?.text).toBe("second terminal pin");
    expect(stored?.target).toBeUndefined();
  });

  test("human mode: the pin id is the fact (stdout), the confirmation is stderr", async () => {
    const { out, err } = await capture(
      () => runPin("human mode pin", { file: "src/app.tsx:12", json: false }, repo),
      true,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^pin_[a-z0-9]{10}$/);
    expect(err).toEqual(["pinned to src/app.tsx:12"]);
  });

  test("human mode with no anchor confirms without claiming a place", async () => {
    const { err } = await capture(() => runPin("unanchored", { json: false }, repo), true);
    expect(err).toEqual(["pinned"]);
  });

  test("a bad --file fails the contract way: envelope, code, hint, exit 2", async () => {
    const { out, exitCode } = await capture(() =>
      runPin("x", { file: "src/nope.tsx:42", json: true }, repo),
    );
    expect(JSON.parse(out.at(-1) ?? "")).toEqual({
      ok: false,
      error: {
        code: "E_INVALID_INPUT",
        message: 'no such file: "src/nope.tsx"',
        hint: "--file takes a path that exists, optionally with :line",
      },
    });
    expect(exitCode).toBe(2);
  });

  test("human mode error: message and hint on stderr, nothing on stdout", async () => {
    const { out, err, exitCode } = await capture(
      () => runPin("x", { selector: "a.cta", json: false }, repo),
      true,
    );
    expect(out).toEqual([]);
    expect(err).toEqual([
      "pinbox: --selector needs --url (a selector without a page is not a target)",
      "run `pinbox pin --help` for usage",
    ]);
    expect(exitCode).toBe(2);
  });
});
