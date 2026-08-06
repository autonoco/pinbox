// @autono/pinbox-core/routes-toolbar — the toolbar's route module.
// Mounted in hub.ts's ROUTES array; returns null for paths outside its namespace.
// Ships POST /pins/:id/verify and POST /attachments.
// NOTE: import this module only via hub.ts (the route array) — hub.ts and this file
// are mutually dependent by pinned design, and hub.ts is the evaluation root.
import { z } from "zod";
import { attachmentSinkFor, MAX_ATTACHMENT_BYTES } from "./attachments.ts";
import type { RouteModule } from "./hub.ts";
import { err, match, ok, readJson } from "./hub.ts";
import { newId } from "./id.ts";

const VerifyPostSchema = z.object({ outcome: z.enum(["accepted", "reopened"]) });
const AttachmentKindSchema = z.enum(["screenshot", "file"]);

export const routeToolbar: RouteModule = async (req, url, opts) => {
  const verifyPinId = match(url.pathname, /^\/pins\/([a-z0-9_]+)\/verify$/);
  if (verifyPinId !== null && req.method === "POST") {
    const body = VerifyPostSchema.parse(await readJson(req));
    return ok(200, opts.store.verifyPin(verifyPinId, body.outcome));
  }
  if (url.pathname === "/attachments" && req.method === "POST") {
    return postAttachment(req, url, opts);
  }
  return null;
};

// Raw body ≤ 5 MB, content-type header, ?kind=screenshot|file → 201
// {attachment, uploadUrl?}; 413 E_ATTACHMENT over cap. No streaming: the 5 MB cap
// makes buffering correct and `server.timeout` irrelevant on this route.
async function postAttachment(
  req: Request,
  url: URL,
  opts: Parameters<RouteModule>[2],
): Promise<Response> {
  const kind = AttachmentKindSchema.parse(url.searchParams.get("kind"));
  const contentType = req.headers.get("content-type");
  if (contentType === null || contentType === "") {
    return err(400, "E_INVALID_INPUT", "content-type header is required", {
      hint: "send the attachment's MIME type, e.g. content-type: image/webp",
    });
  }
  const tooLarge = () =>
    err(413, "E_ATTACHMENT", `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`, {
      hint: "attachments are capped at 5 MB; downscale or compress before uploading",
    });
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) return tooLarge();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return tooLarge();
  const sink = attachmentSinkFor(opts.store);
  if (sink === undefined) {
    return err(500, "E_INTERNAL", "no attachment sink registered for this store", {
      hint: "the host must call registerAttachmentSink(store, sink) before serving /attachments",
    });
  }
  const { attachment, uploadUrl } = await sink.write(
    { id: newId("att"), kind, contentType },
    bytes,
  );
  return ok(201, uploadUrl === undefined ? { attachment } : { attachment, uploadUrl });
}
