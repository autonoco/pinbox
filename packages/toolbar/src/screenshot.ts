// @autono/pinbox-toolbar — best-effort element screenshots.
// Evidence: bun-flagged-deep-dive §2.1 — the crop happens IN THE TOOLBAR
// (`createImageBitmap(source, r.x, r.y, r.w, r.h)` → `OffscreenCanvas` →
// `convertToBlob({type:"image/webp",quality:0.7})`); Bun.Image cannot crop and
// Bun.WebView.screenshot() ignores clip options, so browser-side is the only
// place with both live pixels and target.rect. The hub never sees full-page
// pixels; a pin carries a path, never bytes.
//
// v1 capture source: dependency-free element rasterization does not portably
// exist (no html2canvas-class dep under the zero-dependency rule), so we capture
// the element's VISIBLE VIEWPORT REGION via navigator.mediaDevices when present,
// else resolve null — the pin ships without a screenshot and structured capture
// (capture.ts) still carries Phases 1–2.
import type { Attachment, Rect } from "@autono/pinbox-core/schema";

export interface CapturedImage {
  blob: Blob;
  width: number;
  height: number;
  /** ≤32px downscale data URL for instant drawer thumbs (zero extra requests). */
  placeholder?: string;
}

const WEBP_QUALITY = 0.7;
const PLACEHOLDER_MAX = 32;

/** Element rect clamped to the viewport (CSS px); null when nothing is visible. */
export function visibleCropRect(el: Element): Rect | null {
  const win = el.ownerDocument.defaultView;
  if (!win) return null;
  const r = el.getBoundingClientRect();
  const x = Math.max(r.left, 0);
  const y = Math.max(r.top, 0);
  const right = Math.min(r.right, win.innerWidth);
  const bottom = Math.min(r.bottom, win.innerHeight);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

type DisplayMediaDevices = MediaDevices & {
  getDisplayMedia(constraints: object): Promise<MediaStream>;
};

function captureSource(el: Element): { win: Window; media: DisplayMediaDevices } | null {
  const win = el.ownerDocument.defaultView;
  if (!win) return null;
  const g = globalThis as { OffscreenCanvas?: unknown; createImageBitmap?: unknown };
  if (typeof g.OffscreenCanvas !== "function" || typeof g.createImageBitmap !== "function") {
    return null;
  }
  const media = win.navigator?.mediaDevices as DisplayMediaDevices | undefined;
  if (typeof media?.getDisplayMedia !== "function") return null;
  return { win, media };
}

/** Play the stream into an off-DOM video element and wait for the first frame. */
async function firstFrame(win: Window, stream: MediaStream): Promise<HTMLVideoElement> {
  const video = win.document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
  }
  return video;
}

/** webp-encode a bitmap; also emit the ≤32px placeholder data URL. */
async function encode(bmp: ImageBitmap): Promise<CapturedImage> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d")?.drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  const image: CapturedImage = { blob, width: bmp.width, height: bmp.height };
  const scale = PLACEHOLDER_MAX / Math.max(bmp.width, bmp.height);
  const tw = Math.max(1, Math.round(bmp.width * Math.min(scale, 1)));
  const th = Math.max(1, Math.round(bmp.height * Math.min(scale, 1)));
  const thumb = new OffscreenCanvas(tw, th);
  thumb.getContext("2d")?.drawImage(bmp, 0, 0, tw, th);
  const thumbBlob = await thumb.convertToBlob({ type: "image/webp", quality: 0.5 });
  image.placeholder = `data:image/webp;base64,${toBase64(await thumbBlob.arrayBuffer())}`;
  return image;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Best-effort capture of the element's visible viewport region. Resolves null
 * whenever the environment cannot capture (no OffscreenCanvas/createImageBitmap,
 * no getDisplayMedia, element off-screen, user denies the prompt) — never throws.
 */
export async function captureElement(el: Element): Promise<CapturedImage | null> {
  const source = captureSource(el);
  const crop = visibleCropRect(el);
  if (source === null || crop === null) return null;
  const { win, media } = source;
  let stream: MediaStream | null = null;
  try {
    stream = await media.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true });
    const video = await firstFrame(win, stream);
    // Current-tab frames are the viewport at capture scale; map CSS px → frame px.
    const sx = video.videoWidth / win.innerWidth;
    const sy = video.videoHeight / win.innerHeight;
    const bmp = await createImageBitmap(
      video,
      Math.round(crop.x * sx),
      Math.round(crop.y * sy),
      Math.max(1, Math.round(crop.width * sx)),
      Math.max(1, Math.round(crop.height * sy)),
    );
    return await encode(bmp);
  } catch {
    return null;
  } finally {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
}

/**
 * POST /attachments?kind=screenshot — raw webp body, bearer auth; unwraps the
 * hub envelope `{ok:true,data:{attachment}}` and surfaces its error envelope.
 */
export async function uploadAttachment(
  endpoint: string,
  token: string,
  img: CapturedImage,
): Promise<Attachment> {
  const base = endpoint.replace(/\/+$/, "");
  const res = await fetch(`${base}/attachments?kind=screenshot`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": img.blob.type || "image/webp",
    },
    body: img.blob,
  });
  const body = (await res.json()) as {
    ok?: boolean;
    data?: { attachment: Attachment };
    error?: { code?: string; message?: string };
  };
  if (!res.ok || body.ok !== true || body.data === undefined) {
    const e = body.error;
    throw new Error(
      e?.code !== undefined
        ? `${e.code}: ${e.message ?? "attachment upload failed"}`
        : `attachment upload failed (HTTP ${res.status})`,
    );
  }
  return body.data.attachment;
}
