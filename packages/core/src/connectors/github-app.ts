// @autono/pinbox-core/connectors — GitHub App transport for the GitHub connector.
// The cloud half of the split github.ts documents: locally `gh` shells out with the
// developer's own login; on the Worker nothing can shell out and a personal token would
// author every issue as one human and span every repo they can see. A GitHub App instead:
// installed per repo, issues and comments authored by `<app>[bot]`, short-lived
// installation tokens minted from the App's private key, and (next PR) webhooks in place
// of polling. Same pinned op vocabulary as the `gh` transport, so github.ts is unchanged.
//
// Auth flow, per GitHub's docs: sign a 10-minute RS256 JWT with the App private key
// (iss = app id) → POST /app/installations/:id/access_tokens → a token good for an hour,
// cached here until a minute before it expires. GitHub hands out the private key as
// PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports PKCS#8 only, so the PKCS#1 body is
// wrapped in a PrivateKeyInfo envelope on the way in — no openssl step for the user.
// No Bun.* here — core is host-agnostic (this file runs on workerd).
import { importPKCS8, SignJWT } from "jose";
import type { ConnectorTransport } from "./types.ts";

/** The slice of fetch this transport uses — injectable without dragging in Bun's extras. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GithubAppTransportOptions = {
  /** The App's numeric id (the `iss` claim). */
  appId: string;
  /** PEM, PKCS#1 or PKCS#8 — GitHub downloads PKCS#1. */
  privateKeyPem: string;
  /** The installation on the target repo's owner. */
  installationId: string;
  /** "owner/name". */
  repo: string;
  /** Default https://api.github.com; GHES uses https://<host>/api/v3. */
  apiBase?: string;
  fetchImpl?: FetchLike;
  /** Test seam: epoch ms. */
  now?: () => number;
};

const API_VERSION = "2022-11-28";
const USER_AGENT = "pinbox";
/** Mint a fresh installation token this close to expiry. */
const REFRESH_MARGIN_MS = 60_000;
/** App JWTs may live 10 minutes; nine leaves room for clock skew on GitHub's side. */
const APP_JWT_TTL_S = 540;
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES = 10;

/** A transport failure carrying the hint the link route surfaces as E_CONNECTOR. */
export class GithubAppError extends Error {
  readonly hint: string | undefined;
  readonly status: number;
  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.name = "GithubAppError";
    this.status = status;
    this.hint = hint;
  }
}

export function createGithubAppTransport(opts: GithubAppTransportOptions): ConnectorTransport {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? (() => Date.now());
  const api = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const repo = opts.repo.replace(/^\/+|\/+$/g, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new GithubAppError(`GITHUB_REPO must be "owner/name", got "${opts.repo}"`, 0);
  }
  let keyPromise: Promise<CryptoKey> | null = null;
  let cached: { token: string; expiresAt: number } | null = null;

  function key(): Promise<CryptoKey> {
    keyPromise ??= importPKCS8(toPkcs8Pem(opts.privateKeyPem), "RS256");
    return keyPromise;
  }

  async function appJwt(): Promise<string> {
    const iat = Math.floor(now() / 1000) - 60; // a minute back: GitHub rejects iat in its future
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(opts.appId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60 + APP_JWT_TTL_S)
      .sign(await key());
  }

  async function installationToken(): Promise<string> {
    if (cached !== null && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.token;
    const res = await fetchImpl(`${api}/app/installations/${opts.installationId}/access_tokens`, {
      method: "POST",
      headers: headers(await appJwt()),
    });
    if (!res.ok) {
      throw new GithubAppError(
        `GitHub App token request failed: HTTP ${res.status}`,
        res.status,
        res.status === 401
          ? "check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY belong to the same App"
          : res.status === 404
            ? "check GITHUB_INSTALLATION_ID — the App may not be installed on this repo's owner"
            : undefined,
      );
    }
    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new GithubAppError("GitHub App token response was not { token, expires_at }", 502);
    }
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return cached.token;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: headers(await installationToken(), body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new GithubAppError(
        `GitHub ${method} ${path} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
        res.status,
        res.status === 403 || res.status === 404
          ? `check the App is installed on ${repo} with Issues: read & write`
          : undefined,
      );
    }
    return (await res.json()) as T;
  }

  type Issue = { number: number; html_url: string; state: string };
  type Comment = { user: { login: string } | null; body: string | null; created_at: string };

  async function allComments(number: number): Promise<Comment[]> {
    const out: Comment[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const batch = await call<Comment[]>(
        "GET",
        `/repos/${repo}/issues/${number}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`,
      );
      out.push(...batch);
      if (batch.length < COMMENTS_PER_PAGE) break;
    }
    return out;
  }

  return {
    async request(op, params) {
      const number = Number(params["number"]);
      switch (op) {
        case "issue.create": {
          const issue = await call<Issue>("POST", `/repos/${repo}/issues`, {
            title: params["title"],
            body: params["body"],
          });
          return { number: issue.number, url: issue.html_url };
        }
        case "issue.comment":
          await call("POST", `/repos/${repo}/issues/${number}/comments`, { body: params["body"] });
          return undefined;
        case "issue.view": {
          const issue = await call<Issue>("GET", `/repos/${repo}/issues/${number}`);
          const comments = await allComments(number);
          return {
            state: issue.state === "closed" ? "closed" : "open",
            comments: comments.map((c) => ({
              author: c.user?.login ?? "ghost",
              body: c.body ?? "",
              createdAt: c.created_at,
            })),
          };
        }
        case "issue.close":
          await call("PATCH", `/repos/${repo}/issues/${number}`, { state: "closed" });
          return undefined;
        case "issue.reopen":
          await call("PATCH", `/repos/${repo}/issues/${number}`, { state: "open" });
          return undefined;
        default:
          throw new GithubAppError(`unknown github op: ${op}`, 0);
      }
    },
  };
}

function headers(bearer: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": USER_AGENT,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/* ── PEM / DER ─────────────────────────────────────────────────────────────────────── */

/** PKCS#8 PEM in, PKCS#8 PEM out; PKCS#1 PEM (GitHub's download) is wrapped into PKCS#8. */
export function toPkcs8Pem(pem: string): string {
  const trimmed = pem.trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return trimmed;
  if (!trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    throw new GithubAppError(
      "GITHUB_APP_PRIVATE_KEY is not a PEM private key",
      0,
      'paste the whole file GitHub downloaded, "-----BEGIN RSA PRIVATE KEY-----" through the END line',
    );
  }
  const der = pemBody(trimmed);
  return toPem("PRIVATE KEY", pkcs1ToPkcs8(der));
}

function pemBody(pem: string): Uint8Array {
  const b64 = pem
    .split("\n")
    .filter((line) => !line.startsWith("-----"))
    .join("")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toPem(label: string, der: Uint8Array): string {
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin)
    .replace(/(.{64})/g, "$1\n")
    .trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

/** rsaEncryption AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }. */
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);
const VERSION_ZERO = new Uint8Array([0x02, 0x01, 0x00]);

/** PrivateKeyInfo ::= SEQUENCE { version 0, algorithm rsaEncryption, privateKey OCTET STRING }. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return derTlv(0x30, concat(VERSION_ZERO, RSA_ALGORITHM, derTlv(0x04, pkcs1)));
}

function derTlv(tag: number, body: Uint8Array): Uint8Array {
  const len = body.length;
  let header: number[];
  if (len < 0x80) header = [tag, len];
  else {
    const bytes: number[] = [];
    for (let v = len; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    header = [tag, 0x80 | bytes.length, ...bytes];
  }
  return concat(new Uint8Array(header), body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
