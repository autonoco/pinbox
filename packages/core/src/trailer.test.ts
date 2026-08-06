// parseTrailers — the commit-trailer grammar. Pure parser: the
// grammar table below IS the contract — each keyword, with/without colon, with/without
// the `pin ` prefix, case-insensitive, deduped, order of appearance, and the rejects
// (short ids, lookalikes inside words, keyword-less mentions).
import { describe, expect, test } from "bun:test";
import { parseTrailers } from "./trailer.ts";

const idA = "pin_abcdefghij";
const idB = "pin_0123456789";

describe("parseTrailers grammar", () => {
  const accepted: Array<[string, string]> = [
    ["bare keyword", `Fixes ${idA}`],
    ["keyword + colon", `Fixes: ${idA}`],
    ["keyword + pin prefix", `Fixes pin ${idA}`],
    ["resolves", `Resolves ${idA}`],
    ["resolves + colon (git trailer)", `Resolves: ${idA}`],
    ["resolves + colon + pin prefix", `Resolves: pin ${idA}`],
    ["closes", `Closes ${idA}`],
    ["closes + colon", `closes: ${idA}`],
    ["lowercase keyword", `fixes ${idA}`],
    ["uppercase keyword", `FIXES ${idA}`],
    ["mixed-case keyword", `ReSoLvEs: ${idA}`],
    ["multiline trailer block", `fix: cta padding\n\nResolves: ${idA}`],
  ];
  for (const [name, message] of accepted) {
    test(`accepts ${name}`, () => {
      expect(parseTrailers(message)).toEqual([idA]);
    });
  }

  const rejected: Array<[string, string]> = [
    ["short id", "Fixes pin_abc"],
    ["overlong id (11 chars)", "Fixes pin_abcdefghij1"],
    ["keyword inside a word", `prefixes ${idA}`],
    ["keyword glued to the id", `Fixes${idA}`],
    ["mention without a keyword", `see ${idA} for context`],
    ["wrong prefix", "Fixes msg_abcdefghij"],
    ["empty message", ""],
  ];
  for (const [name, message] of rejected) {
    test(`rejects ${name}`, () => {
      expect(parseTrailers(message)).toEqual([]);
    });
  }

  test("multi-id commit returns both, in order of appearance", () => {
    expect(parseTrailers(`Fixes ${idB}, closes pin ${idA}`)).toEqual([idB, idA]);
  });

  test("duplicate mentions dedupe to the first appearance", () => {
    expect(parseTrailers(`Fixes ${idA}\n\nResolves: ${idA}`)).toEqual([idA]);
  });

  test("id mentioned twice via different keywords keeps order across ids", () => {
    expect(parseTrailers(`Resolves: ${idA}\nFixes ${idB}\ncloses ${idA}`)).toEqual([idA, idB]);
  });
});
