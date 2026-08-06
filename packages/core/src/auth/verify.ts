// @autono/pinbox-core/auth — the auth strategy surface (the ./auth subpath export).
// Strategies produce a VerifyFn for HubOptions.verify: Identity ⇒ authorized,
// null ⇒ 401 E_AUTH. Absent verify keeps the shipped local bearer compare.
import type { VerifyFn } from "../hub.ts";
import { bearerToken } from "./jwt.ts";

export type { Identity, VerifyFn } from "../hub.ts";
export type { JwtVerifyOptions } from "./jwt.ts";
export { verifyJwt } from "./jwt.ts";

// Always { userId: "anonymous" } — loopback/dev ONLY; the Worker template refuses
// this strategy unless ALLOW_UNAUTHENTICATED=1 is set explicitly.
export function verifyNone(): VerifyFn {
  return async () => ({ userId: "anonymous" });
}

// Bearer compare ⇒ { userId: "token" }; null otherwise. Constant-time by construction.
export function verifyToken(expected: string): VerifyFn {
  return async (req) => {
    const token = bearerToken(req);
    if (token === null) return null;
    return (await digestsEqual(token, expected)) ? { userId: "token" } : null;
  };
}

// Identity passthrough — documents the escape hatch and keeps template wiring uniform.
export function verifyCustom(fn: VerifyFn): VerifyFn {
  return fn;
}

// Portable constant-time compare (Bun + workerd): hash both sides and compare the
// digests byte-wise — never === on secrets, never node:crypto.timingSafeEqual
// (absent on workerd). Hashing equalizes lengths, so the loop leaks nothing.
async function digestsEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= (ua[i] ?? 0) ^ (ub[i] ?? 0);
  return diff === 0;
}
