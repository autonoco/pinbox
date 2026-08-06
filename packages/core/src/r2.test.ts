// r2.ts presigner tests — Bun.S3Client is the reference oracle:
// generate a presigned PUT with fixed fake credentials, parse its X-Amz-Date, recompute
// with presignR2Put for that exact instant, and require the byte-identical signature.
import { describe, expect, test } from "bun:test";
import { presignR2Put } from "./r2.ts";

const CREDS = {
  accountId: "acct1234",
  bucket: "pinbox-media",
  accessKeyId: "AKIDEXAMPLEKEY0001",
  secretAccessKey: "secretsecretsecretsecret0001",
};

function oracle(key: string, contentType: string, expiresSeconds: number): string {
  const client = new Bun.S3Client({
    accessKeyId: CREDS.accessKeyId,
    secretAccessKey: CREDS.secretAccessKey,
    bucket: CREDS.bucket,
    endpoint: `https://${CREDS.accountId}.r2.cloudflarestorage.com`,
  });
  return client.presign(key, { method: "PUT", expiresIn: expiresSeconds, type: contentType });
}

function amzDateOf(url: string): Date {
  const raw = new URL(url).searchParams.get("X-Amz-Date");
  if (raw === null) throw new Error(`oracle URL has no X-Amz-Date: ${url}`);
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (!m) throw new Error(`unparseable X-Amz-Date: ${raw}`);
  const [, year, month, day, hour, minute, second] = m.map(Number);
  return new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0),
  );
}

async function presignBoth(key: string, contentType: string, expiresSeconds = 900) {
  const oracleUrl = oracle(key, contentType, expiresSeconds);
  const ours = await presignR2Put({
    ...CREDS,
    key,
    contentType,
    expiresSeconds,
    now: amzDateOf(oracleUrl),
  });
  return { oracle: new URL(oracleUrl), ours: new URL(ours) };
}

describe("presignR2Put vs the Bun.S3Client oracle", () => {
  test("plain key: signature, credential, and path match byte-for-byte", async () => {
    const { oracle, ours } = await presignBoth("att_0123456789.png", "image/png");
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(
      oracle.searchParams.get("X-Amz-Signature"),
    );
    expect(ours.searchParams.get("X-Amz-Credential")).toBe(
      oracle.searchParams.get("X-Amz-Credential"),
    );
    expect(ours.host).toBe(oracle.host);
    expect(ours.pathname).toBe(oracle.pathname);
    expect(ours.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(ours.searchParams.get("X-Amz-Expires")).toBe("900");
  });

  test("key with slashes, unicode, and spaces follows the AWS URI-encoding rules", async () => {
    const { oracle, ours } = await presignBoth("some/dir/ünicode key.png", "image/png");
    expect(ours.pathname).toBe(oracle.pathname);
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(
      oracle.searchParams.get("X-Amz-Signature"),
    );
  });

  test("content-type participates in the signature", async () => {
    const { oracle, ours } = await presignBoth("att_0123456789", "application/octet-stream");
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(
      oracle.searchParams.get("X-Amz-Signature"),
    );
    // Same instant, different content type ⇒ different signature (the type is signed).
    const other = await presignR2Put({
      ...CREDS,
      key: "att_0123456789",
      contentType: "text/plain",
      expiresSeconds: 900,
      now: amzDateOf(String(oracle)),
    });
    expect(new URL(other).searchParams.get("X-Amz-Signature")).not.toBe(
      ours.searchParams.get("X-Amz-Signature"),
    );
  });

  test("expiry defaults to 900 and clamps to the SigV4 ceiling", async () => {
    const defaulted = await presignR2Put({ ...CREDS, key: "k", contentType: "text/plain" });
    expect(new URL(defaulted).searchParams.get("X-Amz-Expires")).toBe("900");
    const clamped = await presignR2Put({
      ...CREDS,
      key: "k",
      contentType: "text/plain",
      expiresSeconds: 10_000_000,
    });
    expect(new URL(clamped).searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  test("contentLength is absent from the signed scope unless asked for", async () => {
    const url = new URL(await presignR2Put({ ...CREDS, key: "k", contentType: "text/plain" }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  test("URL shape is https://<account>.r2.cloudflarestorage.com/<bucket>/<key>?X-Amz-…", async () => {
    const url = new URL(await presignR2Put({ ...CREDS, key: "a/b.png", contentType: "image/png" }));
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("acct1234.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/pinbox-media/a/b.png");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });
});

// The oracle above cannot reach here: Bun.S3Client's presign signs `host` only and
// exposes no way to add a header to the signed scope. These rows are therefore
// structural (what goes into the signature) plus a known-answer pin, cross-checked once
// against a from-the-spec recomputation done outside this file — a regression guard,
// not a live independent oracle. The canonical request the pin encodes, verbatim:
//
//   PUT
//   /pinbox-media/att_0123456789
//   <sorted query, X-Amz-SignedHeaders=content-length%3Bhost>
//   content-length:2097152
//   host:acct1234.r2.cloudflarestorage.com
//
//   content-length;host
//   UNSIGNED-PAYLOAD
describe("presignR2Put with a signed content-length", () => {
  const AT = new Date("2026-08-01T00:00:00Z");
  const base = { ...CREDS, key: "att_0123456789", contentType: "image/png", now: AT };

  test("content-length joins the signed headers, sorted before host", async () => {
    const url = new URL(await presignR2Put({ ...base, contentLength: 2 * 1024 * 1024 }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
  });

  test("the exact length is signed — one byte more is a different signature", async () => {
    const two = new URL(await presignR2Put({ ...base, contentLength: 2 * 1024 * 1024 }));
    const twoPlusOne = new URL(await presignR2Put({ ...base, contentLength: 2 * 1024 * 1024 + 1 }));
    expect(twoPlusOne.searchParams.get("X-Amz-Signature")).not.toBe(
      two.searchParams.get("X-Amz-Signature"),
    );
    // …and differs from the same request signed without the header at all, i.e. R2 is
    // being asked to verify something extra, not handed a cosmetic query parameter.
    const unbounded = new URL(await presignR2Put(base));
    expect(unbounded.searchParams.get("X-Amz-Signature")).not.toBe(
      two.searchParams.get("X-Amz-Signature"),
    );
  });

  test("known-answer pin at a fixed instant", async () => {
    const url = new URL(await presignR2Put({ ...base, contentLength: 2 * 1024 * 1024 }));
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260801T000000Z");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "fb35dad6418d9556dafd57a73b3abb2cd475f2d870420a95c243bcb0bccd2d10",
    );
  });
});
