import { describe, expect, test } from "bun:test";
import { safeUrl } from "./html.ts";

describe("safeUrl", () => {
  test("passes http/https and relative URLs through", () => {
    expect(safeUrl("https://github.com/o/r/issues/1")).toBe("https://github.com/o/r/issues/1");
    expect(safeUrl("http://127.0.0.1:4141/att/a1.png")).toBe("http://127.0.0.1:4141/att/a1.png");
    expect(safeUrl("/attachments/pin_x/shot.png")).toBe("/attachments/pin_x/shot.png");
  });

  test("rejects every non-http(s) scheme — esc() alone cannot (no &<>\" in 'javascript:')", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("JaVaScRiPt:alert(1)")).toBe("");
    expect(safeUrl(" javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<script>x</script>")).toBe("");
    expect(safeUrl("vbscript:x")).toBe("");
    expect(safeUrl(null)).toBe("");
  });

  test("rejects control-character scheme splits — browsers strip TAB/LF/CR before parsing", () => {
    expect(safeUrl("java\tscript:alert(1)")).toBe("");
    expect(safeUrl("java\nscript:alert(1)")).toBe("");
    expect(safeUrl("java\rscript:alert(1)")).toBe("");
    expect(safeUrl("\x01javascript:alert(1)")).toBe("");
    expect(safeUrl("jav\x00ascript:alert(1)")).toBe("");
    // control chars inside a LEGITIMATE url are stripped, not fatal (browser behavior)
    expect(safeUrl("https://exam\tple.com/x")).toBe("https://example.com/x");
  });
});
