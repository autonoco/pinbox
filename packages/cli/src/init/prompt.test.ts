// The interactive seams `init` uses when a human is at a terminal.
// The contract under test is the one Bun's global `confirm()`/`prompt()` break: the question
// is MESSAGING and belongs on stderr, because stdout carries the fact lines. These run in a
// child process — the question, the echo suffix and the stdin read are all real, and the
// assertion is on the child's actual stdout/stderr bytes, which is the only place the bug
// was ever visible.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-prompt-${crypto.randomUUID()}`;
const driver = `${tmpRoot}/driver.ts`;

beforeAll(async () => {
  await $`mkdir -p ${tmpRoot}`.quiet();
  await Bun.write(
    driver,
    [
      `import { askLine, askYesNo } from "${import.meta.dir}/prompt.ts";`,
      `const [mode, question] = process.argv.slice(2) as [string, string];`,
      `const answer = mode === "yesno" ? askYesNo(question) : askLine(question);`,
      `console.log(JSON.stringify(answer));`,
      ``,
    ].join("\n"),
  );
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

/** Run the driver with `input` on stdin; returns the child's raw streams. */
async function run(
  mode: "yesno" | "line",
  question: string,
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", driver, mode, question], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr };
}

describe("askYesNo", () => {
  test("the question goes to stderr — stdout carries only the answer, nothing conversational", async () => {
    const { stdout, stderr } = await run("yesno", "install pinbox for: claude?", "y\n");
    expect(stderr).toContain("install pinbox for: claude?");
    expect(stderr).toContain("[y/N]");
    // The whole point: not one byte of the prompt reached stdout.
    expect(stdout.trim()).toBe("true");
    expect(stdout).not.toContain("install pinbox");
    expect(stdout).not.toContain("[y/N]");
  });

  test("only an explicit yes is a yes; blank, no and EOF all decline", async () => {
    expect((await run("yesno", "q?", "yes\n")).stdout.trim()).toBe("true");
    expect((await run("yesno", "q?", "Y\n")).stdout.trim()).toBe("true");
    expect((await run("yesno", "q?", "\n")).stdout.trim()).toBe("false");
    expect((await run("yesno", "q?", "n\n")).stdout.trim()).toBe("false");
    expect((await run("yesno", "q?", "")).stdout.trim()).toBe("false");
  });
});

describe("askLine", () => {
  test("the menu goes to stderr; the typed line comes back verbatim", async () => {
    const { stdout, stderr } = await run("line", "which agent?\n1. claude", "2\n");
    expect(stderr).toContain("1. claude");
    expect(stdout.trim()).toBe('"2"');
    expect(stdout).not.toContain("which agent?");
  });

  test("EOF is null, not an empty string — 'no answer' and 'blank answer' differ", async () => {
    expect((await run("line", "q?", "")).stdout.trim()).toBe("null");
    expect((await run("line", "q?", "\n")).stdout.trim()).toBe('""');
  });
});
