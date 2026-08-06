// attachments — localDirSink writes bytes to disk and returns a path-carrying
// Attachment; the sink registry is a store-keyed sidecar (WeakMap), so no test
// here touches HubOptions or PinStore (both pinned final by the freeze).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentSinkFor, registerAttachmentSink } from "./attachments.ts";
import { localDirSink } from "./attachments-local.ts";
import { openStore } from "./store.ts";

const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x2a, 0x00, 0x00, 0x00]);

describe("localDirSink", () => {
  test("writes bytes and returns a .webp path for image/webp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinbox-att-"));
    const sink = localDirSink(dir);
    const result = await sink.write(
      { id: "att_abcdefghij", kind: "screenshot", contentType: "image/webp" },
      WEBP_BYTES,
    );
    expect(result.uploadUrl).toBeUndefined();
    const { attachment } = result;
    expect(attachment.id).toBe("att_abcdefghij");
    expect(attachment.kind).toBe("screenshot");
    expect(attachment.contentType).toBe("image/webp");
    expect(attachment.path).toBe(join(dir, "att_abcdefghij.webp"));
    expect(attachment.width).toBeUndefined();
    expect(attachment.height).toBeUndefined();
    const written = new Uint8Array(await Bun.file(attachment.path as string).arrayBuffer());
    expect(written).toEqual(WEBP_BYTES);
  });

  test("mkdirs on demand — dir need not exist", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pinbox-att-")), "media", "nested");
    const sink = localDirSink(dir);
    const { attachment } = await sink.write(
      { id: "att_0000000000", kind: "file", contentType: "text/plain" },
      new Uint8Array([104, 105]),
    );
    expect(attachment.path).toBe(join(dir, "att_0000000000.txt"));
    expect(await Bun.file(attachment.path as string).text()).toBe("hi");
  });

  test("extension map covers the pinned types and falls back to bin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pinbox-att-"));
    const sink = localDirSink(dir);
    const cases: [string, string][] = [
      ["image/png", "png"],
      ["image/webp", "webp"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["text/plain", "txt"],
      ["application/octet-stream", "bin"],
    ];
    for (const [contentType, ext] of cases) {
      const id = `att_${ext.padEnd(10, "x")}`;
      const { attachment } = await sink.write({ id, kind: "file", contentType }, WEBP_BYTES);
      expect(attachment.path).toBe(join(dir, `${id}.${ext}`));
    }
  });
});

describe("sink registry", () => {
  test("registerAttachmentSink round-trips per store; unregistered store has none", () => {
    const a = openStore(":memory:");
    const b = openStore(":memory:");
    const sink = localDirSink(mkdtempSync(join(tmpdir(), "pinbox-att-")));
    registerAttachmentSink(a, sink);
    expect(attachmentSinkFor(a)).toBe(sink);
    expect(attachmentSinkFor(b)).toBeUndefined();
  });
});
