// @autono/pinbox-core/r2 — portable SigV4 presigner for R2 PUT uploads.
// WebCrypto only: this runs on workerd, where Bun.S3Client does not exist and the R2
// Worker binding has NO presign method (deep-dive §5.6). Bun.S3Client is the reference
// oracle in r2.test.ts — this implementation mirrors its exact construction: path-style
// URL, region "auto", SignedHeaders=host, UNSIGNED-PAYLOAD, and the content type signed
// as the `response-content-type` query parameter.
//
// `contentLength` is the one deliberate departure from the oracle, because the oracle
// cannot express it: adding `content-length` to the signed header set makes R2 verify
// the uploaded body's length against the signature, which is how the 5 MB attachment
// cap reaches a leg the DO never sees. A PUT of any other length — or a chunked PUT
// carrying no content-length at all — fails the signature check at R2.

export type R2PresignOptions = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  key: string;
  contentType: string;
  contentLength?: number; // when set, `content-length` joins the signed headers
  expiresSeconds?: number; // default 900, clamped to the SigV4 ceiling (7 days)
  now?: Date; // injectable clock for tests
};

const REGION = "auto";
const SERVICE = "s3";
const MAX_EXPIRES = 604_800; // SigV4 ceiling: 7 days

export async function presignR2Put(opts: R2PresignOptions): Promise<string> {
  const now = opts.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const expires = Math.min(Math.max(Math.trunc(opts.expiresSeconds ?? 900), 1), MAX_EXPIRES);
  const host = `${opts.accountId}.r2.cloudflarestorage.com`;
  const credential = `${opts.accessKeyId}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const canonicalPath = `/${uriEncodePath(opts.bucket)}/${uriEncodePath(opts.key)}`;

  // Canonical headers: lowercase names, sorted, each `name:value\n`. `host` is always
  // signed; `content-length` joins it when a length is pinned (and sorts ahead of it).
  const headers: [string, string][] = [["host", host]];
  if (opts.contentLength !== undefined) {
    headers.push(["content-length", String(Math.trunc(opts.contentLength))]);
  }
  headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = headers.map(([name]) => name).join(";");

  const params: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
    ["response-content-type", opts.contentType],
  ];
  const canonicalQuery = params
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    "PUT",
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${dateStamp}/${REGION}/${SERVICE}/aws4_request`,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveSigningKey(opts.secretAccessKey, dateStamp);
  const signature = toHex(await hmac(signingKey, stringToSign));
  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function toAmzDate(date: Date): string {
  return `${date.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "")}Z`;
}

// AWS SigV4 URI encoding (RFC 3986): unreserved characters stay; everything else is
// percent-encoded with uppercase hex. encodeURIComponent leaves !'()* unencoded — fix up.
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Object-key encoding: each path segment encoded, "/" separators preserved.
function uriEncodePath(path: string): string {
  return path.split("/").map(uriEncode).join("/");
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function deriveSigningKey(secret: string, dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
