// Marker-block writer tests: the create/replace/append/unchanged matrix, user content
// safety (prose outside the markers is never touched), and START/END + STATUS coexistence.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { CliError } from "../errors.ts";
import { agentCheatsheet, MARKER_TARGETS, upsertMarkerBlock } from "./markers.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-markers-${crypto.randomUUID()}`;

beforeAll(async () => {
  await $`mkdir -p ${tmpRoot}`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("upsertMarkerBlock", () => {
  test("missing file is created with the block", async () => {
    const path = `${tmpRoot}/created.md`;
    expect(await upsertMarkerBlock(path, "PINBOX", "hello")).toBe("created");
    const text = await Bun.file(path).text();
    expect(text).toContain("<!-- PINBOX:START -->");
    expect(text).toContain("hello");
    expect(text).toContain("<!-- PINBOX:END -->");
  });

  test("byte-identical content reports unchanged and leaves the file byte-identical", async () => {
    const path = `${tmpRoot}/unchanged.md`;
    await upsertMarkerBlock(path, "PINBOX", "hello");
    const before = await Bun.file(path).text();
    expect(await upsertMarkerBlock(path, "PINBOX", "hello")).toBe("unchanged");
    expect(await Bun.file(path).text()).toBe(before);
  });

  test("existing block is replaced; prose above and below is never touched", async () => {
    const path = `${tmpRoot}/replace.md`;
    const fixture =
      "# My rules\n\nkeep me\n\n<!-- PINBOX:START -->\nold content\n<!-- PINBOX:END -->\n\ntrailing prose\n";
    await Bun.write(path, fixture);
    expect(await upsertMarkerBlock(path, "PINBOX", "new content")).toBe("replaced");
    const text = await Bun.file(path).text();
    expect(text).toStartWith("# My rules\n\nkeep me\n\n<!-- PINBOX:START -->");
    expect(text).toEndWith("<!-- PINBOX:END -->\n\ntrailing prose\n");
    expect(text).toContain("new content");
    expect(text).not.toContain("old content");
  });

  test("file without markers gets the block appended, prose preserved", async () => {
    const path = `${tmpRoot}/append.md`;
    await Bun.write(path, "# Existing instructions\n");
    expect(await upsertMarkerBlock(path, "PINBOX", "cheatsheet")).toBe("appended");
    const text = await Bun.file(path).text();
    expect(text).toStartWith("# Existing instructions\n");
    expect(text).toContain("<!-- PINBOX:START -->\ncheatsheet\n<!-- PINBOX:END -->");
  });

  test("PINBOX and PINBOX:STATUS blocks coexist without fighting", async () => {
    const path = `${tmpRoot}/coexist.md`;
    await upsertMarkerBlock(path, "PINBOX", "static cheatsheet");
    expect(await upsertMarkerBlock(path, "PINBOX:STATUS", "3 open pins")).toBe("appended");
    // Updating STATUS replaces only its own block.
    expect(await upsertMarkerBlock(path, "PINBOX:STATUS", "1 open pin")).toBe("replaced");
    const text = await Bun.file(path).text();
    expect(text).toContain("<!-- PINBOX:START -->\nstatic cheatsheet\n<!-- PINBOX:END -->");
    expect(text).toContain("<!-- PINBOX:STATUS:START -->\n1 open pin\n<!-- PINBOX:STATUS:END -->");
    expect(text).not.toContain("3 open pins");
    // And updating the main block leaves STATUS alone.
    expect(await upsertMarkerBlock(path, "PINBOX", "updated cheatsheet")).toBe("replaced");
    const after = await Bun.file(path).text();
    expect(after).toContain("updated cheatsheet");
    expect(after).toContain("<!-- PINBOX:STATUS:START -->\n1 open pin\n<!-- PINBOX:STATUS:END -->");
  });
});

/**
 * Regression: an orphan START (the user deleted the END line) used to make the writer
 * *append* a second block, leaving two STARTs. The next run then matched the orphan START
 * and the appended block's END and replaced everything between them — silently eating every
 * line of user prose in that span, in direct violation of the file header's guarantee.
 * A file we cannot delimit is refused, byte-for-byte untouched.
 */
describe("upsertMarkerBlock — malformed marker state", () => {
  const orphanStart =
    "# My rules\n\n<!-- PINBOX:START -->\nold cheatsheet\n\nmy carefully written prose\n";

  test("orphan START refuses instead of appending a second block", async () => {
    const path = `${tmpRoot}/orphan-start.md`;
    await Bun.write(path, orphanStart);
    const err = (await upsertMarkerBlock(path, "PINBOX", "new").catch(
      (e: unknown) => e,
    )) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("E_CONFLICT");
    expect(err.message).toContain("PINBOX:END");
    expect(err.hint).toBeDefined();
    // The whole point: not one byte moved.
    expect(await Bun.file(path).text()).toBe(orphanStart);
  });

  test("the second run over an orphan START cannot eat the prose between the markers", async () => {
    const path = `${tmpRoot}/orphan-twice.md`;
    await Bun.write(path, orphanStart);
    await upsertMarkerBlock(path, "PINBOX", "first").catch(() => undefined);
    await upsertMarkerBlock(path, "PINBOX", "second").catch(() => undefined);
    const text = await Bun.file(path).text();
    expect(text).toContain("my carefully written prose");
    expect(text).toBe(orphanStart);
  });

  test("orphan END refuses too — appending would create a block the next run mis-parses", async () => {
    const path = `${tmpRoot}/orphan-end.md`;
    const fixture = "# My rules\n\nkeep me\n<!-- PINBOX:END -->\n";
    await Bun.write(path, fixture);
    expect(upsertMarkerBlock(path, "PINBOX", "new")).rejects.toThrow(CliError);
    expect(await Bun.file(path).text()).toBe(fixture);
  });

  test("duplicate complete blocks refuse rather than update one and leave the other stale", async () => {
    const path = `${tmpRoot}/duplicate.md`;
    const fixture =
      "<!-- PINBOX:START -->\na\n<!-- PINBOX:END -->\nmiddle\n<!-- PINBOX:START -->\nb\n<!-- PINBOX:END -->\n";
    await Bun.write(path, fixture);
    expect(upsertMarkerBlock(path, "PINBOX", "new")).rejects.toThrow(CliError);
    expect(await Bun.file(path).text()).toBe(fixture);
  });

  test("END before START refuses — the span between them is user content, not our block", async () => {
    const path = `${tmpRoot}/inverted.md`;
    const fixture = "<!-- PINBOX:END -->\nmine\n<!-- PINBOX:START -->\n";
    await Bun.write(path, fixture);
    expect(upsertMarkerBlock(path, "PINBOX", "new")).rejects.toThrow(CliError);
    expect(await Bun.file(path).text()).toBe(fixture);
  });

  test("a PINBOX:STATUS block is not mistaken for a stray PINBOX marker", async () => {
    const path = `${tmpRoot}/status-only.md`;
    await Bun.write(path, "<!-- PINBOX:STATUS:START -->\n2 pins\n<!-- PINBOX:STATUS:END -->\n");
    expect(await upsertMarkerBlock(path, "PINBOX", "sheet")).toBe("appended");
    expect(await Bun.file(path).text()).toContain("2 pins");
  });
});

describe("MARKER_TARGETS", () => {
  test("covers exactly the non-plugin long tail: cursor and copilot", () => {
    expect(MARKER_TARGETS.map((t) => t.agent).sort()).toEqual(["copilot", "cursor"]);
    expect(MARKER_TARGETS.find((t) => t.agent === "cursor")?.path).toBe(".cursor/rules/pinbox.mdc");
    expect(MARKER_TARGETS.find((t) => t.agent === "copilot")?.path).toBe(
      ".github/copilot-instructions.md",
    );
  });
});

describe("agentCheatsheet", () => {
  test("is rendered from the embedded skill: untrusted sentence + every verb", () => {
    const sheet = agentCheatsheet();
    expect(sheet).toContain("UNTRUSTED");
    for (const verb of ["summary", "list", "show", "reply", "resolve", "link", "export"]) {
      expect(sheet).toContain(`pinbox ${verb}`);
    }
    expect(sheet).toContain("--json");
  });
});
