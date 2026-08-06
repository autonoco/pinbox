import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CliError } from "./errors.ts";
import { emit, fail, isJsonMode } from "./output.ts";

/** Sentinel thrown by the process.exit spy so `fail` actually stops. */
class ExitSignal extends Error {
  constructor(public exitCode: number | undefined) {
    super(`exit ${exitCode}`);
  }
}

function setTTY(isTTY: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
}

const originalIsTTY = process.stdout.isTTY;
const spies: Array<{ mockRestore: () => void }> = [];

function spyStdout() {
  const s = spyOn(console, "log").mockImplementation(() => {});
  spies.push(s);
  return s;
}
function spyStderr() {
  const s = spyOn(console, "error").mockImplementation(() => {});
  spies.push(s);
  return s;
}
function spyExit() {
  const s = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code);
  }) as typeof process.exit);
  spies.push(s);
  return s;
}

afterEach(() => {
  setTTY(originalIsTTY);
  for (const s of spies.splice(0)) s.mockRestore();
  process.exitCode = 0;
});

describe("isJsonMode", () => {
  test("--json forces JSON mode even on a TTY", () => {
    setTTY(true);
    expect(isJsonMode({ json: true })).toBe(true);
  });
  test("non-TTY stdout auto-switches to JSON mode", () => {
    setTTY(undefined);
    expect(isJsonMode({})).toBe(true);
  });
  test("TTY without the flag is human mode", () => {
    setTTY(true);
    expect(isJsonMode({})).toBe(false);
  });
});

describe("emit", () => {
  test("JSON mode prints exactly one pretty-printed {ok:true,data} envelope on stdout", () => {
    setTTY(false);
    const out = spyStdout();
    const err = spyStderr();
    emit({ open: 3, resolved: 12, lastEventSeq: 42 }, {}, () => "unused");
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toBe(
      [
        "{",
        '  "ok": true,',
        '  "data": {',
        '    "open": 3,',
        '    "resolved": 12,',
        '    "lastEventSeq": 42',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(err).not.toHaveBeenCalled();
  });

  test("human mode prints the human rendering on stdout", () => {
    setTTY(true);
    const out = spyStdout();
    const err = spyStderr();
    emit({ open: 3 }, {}, (d) => `open        ${d.open}`);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toBe("open        3");
    expect(err).not.toHaveBeenCalled();
  });
});

describe("fail", () => {
  test("JSON mode prints the error envelope on stdout, nothing on stderr, exits mapped code", () => {
    setTTY(true);
    const out = spyStdout();
    const err = spyStderr();
    const exit = spyExit();
    expect(() =>
      fail(
        new CliError(
          "E_HUB_UNREACHABLE",
          "cannot reach the hub and could not start one",
          "run `pinbox doctor` to find out why",
        ),
        { json: true },
      ),
    ).toThrow(ExitSignal);
    expect(out).toHaveBeenCalledTimes(1);
    expect(out.mock.calls[0]?.[0]).toBe(
      [
        "{",
        '  "ok": false,',
        '  "error": {',
        '    "code": "E_HUB_UNREACHABLE",',
        '    "message": "cannot reach the hub and could not start one",',
        '    "hint": "run `pinbox doctor` to find out why"',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(err).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(5);
    expect(process.exitCode).toBe(5);
  });

  test("human mode prints message and hint on stderr, nothing on stdout", () => {
    setTTY(true);
    const out = spyStdout();
    const err = spyStderr();
    spyExit();
    expect(() =>
      fail(
        new CliError(
          "E_HUB_UNREACHABLE",
          "cannot reach the hub and could not start one",
          "run `pinbox doctor` to find out why",
        ),
        {},
      ),
    ).toThrow(ExitSignal);
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      "pinbox: cannot reach the hub and could not start one",
      "run `pinbox doctor` to find out why",
    ]);
  });

  test("hint is omitted from the JSON envelope when absent", () => {
    setTTY(true);
    const out = spyStdout();
    spyExit();
    expect(() => fail(new CliError("E_NOT_FOUND", "no pin with id pin_x"), { json: true })).toThrow(
      ExitSignal,
    );
    const doc = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(doc).toEqual({
      ok: false,
      error: { code: "E_NOT_FOUND", message: "no pin with id pin_x" },
    });
  });

  test("human mode without a hint prints only the message line", () => {
    setTTY(true);
    const err = spyStderr();
    spyExit();
    expect(() => fail(new CliError("E_NOT_FOUND", "no pin with id pin_x"), {})).toThrow(ExitSignal);
    expect(err.mock.calls.map((c) => c[0])).toEqual(["pinbox: no pin with id pin_x"]);
  });

  test("non-CliError values are wrapped as E_INTERNAL and exit 1", () => {
    setTTY(true);
    const out = spyStdout();
    const exit = spyExit();
    expect(() => fail(new Error("boom"), { json: true })).toThrow(ExitSignal);
    const doc = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe("E_INTERNAL");
    expect(doc.error.message).toBe("boom");
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("exit codes map 1:1 from error codes", () => {
    setTTY(true);
    spyStdout();
    const exit = spyExit();
    const cases = [
      ["E_INTERNAL", 1],
      ["E_INVALID_INPUT", 2],
      ["E_NOT_FOUND", 3],
      ["E_CONFLICT", 4],
      ["E_HUB_UNREACHABLE", 5],
    ] as const;
    for (const [code, expected] of cases) {
      expect(() => fail(new CliError(code, "x"), { json: true })).toThrow(ExitSignal);
      expect(exit).toHaveBeenLastCalledWith(expected);
    }
  });
});

describe("CliError", () => {
  test("carries code, message, and optional hint", () => {
    const e = new CliError("E_CONFLICT", "already resolved", "run `pinbox show` to see why");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("E_CONFLICT");
    expect(e.message).toBe("already resolved");
    expect(e.hint).toBe("run `pinbox show` to see why");
    expect(new CliError("E_INTERNAL", "x").hint).toBeUndefined();
  });
});
