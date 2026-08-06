// @autono/pinbox-core — the LOCAL (Bun) attachment sink, split out of attachments.ts.
//
// Workers-safety split (same rule as the `resume.ts` bar): the
// import chain do.ts → hub.ts → routes-toolbar.ts → attachments.ts is static, so
// anything with a `Bun.*` global in attachments.ts lands in the workerd bundle where
// it cannot run. `attachments.ts` therefore keeps only the host-agnostic registry
// (AttachmentSink, the WeakMap, the cap) and this file — imported by the Bun host
// (hub-server.ts) ONLY — holds the Bun.write sink.
import type { AttachmentSink } from "./attachments.ts";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "text/plain": "txt",
};

function extensionFor(contentType: string): string {
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return EXTENSIONS[essence] ?? "bin";
}

/** Bytes to `${dir}/${id}.${ext}`; Bun.write creates the directory tree on demand. */
export function localDirSink(dir: string): AttachmentSink {
  return {
    async write(meta, bytes) {
      const path = `${dir}/${meta.id}.${extensionFor(meta.contentType)}`;
      await Bun.write(path, bytes);
      return {
        attachment: { id: meta.id, kind: meta.kind, path, contentType: meta.contentType },
      };
    },
  };
}
