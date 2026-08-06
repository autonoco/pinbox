// @autono/pinbox-core — JWT/JWKS verifier (the `jwt` auth strategy behind HubOptions.verify).
// Three knobs: { issuer, jwksUrl, audience }; EdDSA + RS256 only via jose. Works with any
// standards-compliant identity provider, hosted or self-run. That includes private issuers
// that mint narrowly-scoped tokens — audience like `tool:pinbox`, identity carried by `sub`
// with an optional `tenant` claim, and no `name`/`email` at all — which is why `sub` is the
// only claim required below and the rest are read opportunistically.
// Vendored-verifier discipline: this file stays small; jose owns JWKS refetch/cooldown.
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Identity, VerifyFn } from "../hub.ts";

export type JwtVerifyOptions = { issuer: string; jwksUrl: string; audience: string };

// Portable everywhere the hub runs (Bun + workerd): jose v6 is WebCrypto-only.
export function verifyJwt(opts: JwtVerifyOptions): VerifyFn {
  // One JWKS instance per options object — jose caches keys and handles
  // refetch/cooldown internally, so every request reuses this closure's set.
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return async (req) => {
    const token = bearerToken(req);
    if (token === null) return null;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["EdDSA", "RS256"],
      });
      if (typeof payload["sub"] !== "string") return null;
      const identity: Identity = { userId: payload["sub"] };
      if (typeof payload["tenant"] === "string") identity.tenantId = payload["tenant"];
      if (typeof payload["name"] === "string") identity.name = payload["name"];
      if (typeof payload["email"] === "string") identity.email = payload["email"];
      return identity;
    } catch {
      // A VerifyFn never throws: any verification failure (bad signature, wrong
      // issuer/audience, expired, disallowed alg, malformed token) is a null ⇒ 401 E_AUTH.
      return null;
    }
  };
}

// Shared bearer extraction (verify.ts imports this; the reverse would be a cycle).
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}
