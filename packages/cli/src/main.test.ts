import { describe, expect, spyOn, test } from "bun:test";
import { buildProgram, runCli } from "./main.ts";

/** Sentinel thrown by the process.exit spy so `fail` actually stops. */
class ExitSignal extends Error {
  constructor(public exitCode: number | undefined) {
    super(`exit ${exitCode}`);
  }
}

// The commands list grows in Tasks 7–8; these tests pin only the skeleton facts
// the transcripts fix now: name, description, version, and the global --json flag.
describe("pinbox program skeleton", () => {
  test("name, description, and version match the transcripts", () => {
    const program = buildProgram();
    expect(program.name()).toBe("pinbox");
    expect(program.description()).toBe(
      "CLI-first feedback loop: pins dropped on a live app, fixed and resolved by agents.",
    );
    expect(program.version()).toBe("0.0.0");
  });

  test("global --json option exists with the transcript wording", () => {
    const program = buildProgram();
    const json = program.options.find((o) => o.long === "--json");
    expect(json?.description).toBe('machine output: {"ok":true,"data":…} envelope');
    // parseOptions, not parse: with subcommands registered, a bare `pinbox --json`
    // displays help — this test pins only that the flag itself parses.
    program.parseOptions(["--json"]);
    expect(program.opts()["json"]).toBe(true);
  });

  test("help text carries the usage line and options block", () => {
    const program = buildProgram();
    const help = program.helpInformation();
    // "[command]" joins the usage line when Tasks 7–8 register subcommands.
    expect(help).toContain("Usage: pinbox [options]");
    // helpWidth 100 keeps the 83-char description unwrapped, as the transcripts show it.
    expect(help).toContain(
      "CLI-first feedback loop: pins dropped on a live app, fixed and resolved by agents.\n",
    );
    expect(help).toContain("-V, --version");
    // Column padding widens as Tasks 7–8 register longer command terms — pin the
    // wording, not the alignment.
    expect(help).toMatch(/--json\s+machine output: \{"ok":true,"data":…\} envelope/);
    expect(help).toContain("-h, --help");
  });

  test("invocation errors carry a subcommand-scoped help hint", async () => {
    // Transcript §doctor: `pinbox doctor --fix` hints `pinbox doctor --help`, not `pinbox --help`.
    const out = spyOn(console, "log").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as typeof process.exit);
    try {
      await expect(runCli(["bun", "main.ts", "doctor", "--fix", "--json"])).rejects.toThrow(
        ExitSignal,
      );
      const doc = JSON.parse(String(out.mock.calls[0]?.[0]));
      expect(doc).toEqual({
        ok: false,
        error: {
          code: "E_INVALID_INPUT",
          message: "unknown option '--fix'",
          hint: "run `pinbox doctor --help` for usage",
        },
      });
    } finally {
      out.mockRestore();
      exit.mockRestore();
      process.exitCode = 0;
    }
  });
});
