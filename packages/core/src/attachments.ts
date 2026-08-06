// @autono/pinbox-core/attachments — the byte sink for POST /attachments.
// HubOptions and PinStore are pinned final and carry no
// media member, so the sink is injected as a store-keyed sidecar: a
// WeakMap<PinStore, AttachmentSink> the host populates (serve.ts registers
// localDirSink; the cloud host registers an R2 sink). An Attachment carries a
// path or a URL, never bytes. Local media lands under
// `.pinbox/media/`, which is already gitignored via the `.pinbox/` entry — media
// inherits the ignore, nothing to add.
//
// Host-agnostic BY CONSTRUCTION: routes-toolbar.ts imports this file and do.ts reaches
// it through hub.ts, so a `Bun.*` global here would land in the workerd bundle. The Bun
// sink lives in attachments-local.ts (the same Workers-safety split as resume.ts).
import type { Attachment } from "./schema.ts";
import type { PinStore } from "./store.ts";

export interface AttachmentSink {
  /** Persist bytes; return the finished Attachment (local: path set; cloud R2: url + uploadUrl). */
  write(
    meta: { id: string; kind: "screenshot" | "file"; contentType: string },
    bytes: Uint8Array,
  ): Promise<{ attachment: Attachment; uploadUrl?: string }>;
}

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const sinks = new WeakMap<PinStore, AttachmentSink>();

export function registerAttachmentSink(store: PinStore, sink: AttachmentSink): void {
  sinks.set(store, sink);
}

export function attachmentSinkFor(store: PinStore): AttachmentSink | undefined {
  return sinks.get(store);
}
