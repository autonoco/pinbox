// pinbox CLI — GitHub App manifest flow, the pure parts.
// GitHub can create an App from a manifest: a form POSTs the JSON to
// github.com/settings/apps/new, the user clicks Create, GitHub redirects to our
// redirect_url with a one-time code, and POST /app-manifests/:code/conversions returns the
// App's id, slug, private key and webhook secret — no dashboard clicking, no key download.
// Everything here is string and record shaping; the I/O lives in flow.ts.
import { CliError } from "../errors.ts";

export type Manifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
  description: string;
};

/** The App as the connector needs it: Issues write, Metadata read, the two issue events. */
export function buildManifest(opts: {
  name: string;
  hubUrl: string;
  redirectUrl: string;
}): Manifest {
  const hub = normalizeHubUrl(opts.hubUrl);
  return {
    name: opts.name,
    url: hub,
    hook_attributes: { url: webhookUrl(hub), active: true },
    redirect_url: opts.redirectUrl,
    public: false,
    default_permissions: { issues: "write", metadata: "read" },
    default_events: ["issues", "issue_comment"],
    description: "Mirrors pinbox pins to GitHub issues and back.",
  };
}

/** `https://<host>/_pinbox` — trailing slashes dropped; the mount is required. */
export function normalizeHubUrl(raw: string): string {
  const hub = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(hub);
  } catch {
    throw new CliError("E_INVALID_INPUT", `hub URL is not a URL: "${raw}"`, usage());
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new CliError("E_INVALID_INPUT", "the hub URL must be https", usage());
  }
  if (!url.pathname.endsWith("/_pinbox")) {
    throw new CliError(
      "E_INVALID_INPUT",
      `the hub URL must include the hub mount, e.g. ${url.origin}/_pinbox`,
      "the Worker mounts the hub under /_pinbox; the origin root deliberately 404s",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    // webhookUrl() appends a path; a query or fragment would end up in the middle of it.
    throw new CliError(
      "E_INVALID_INPUT",
      `the hub URL must not carry a query string or fragment: "${raw}"`,
      `use ${url.origin}${url.pathname}`,
    );
  }
  return hub;
}

/**
 * The hub URL a worker config already states: a `routes` entry with `custom_domain: true`
 * names the public host (pinbox.sh's own worker is configured this way). Null when the
 * worker is on workers.dev — that subdomain is not in the config, so the caller must ask.
 */
export function hubFromWranglerConfig(jsonc: string): string | null {
  // JSONC, so no parser: comments blanked, then one route object at a time, host from its
  // pattern. A commented-out routes example must not name the hub.
  const routes = /"routes"\s*:\s*\[([\s\S]*?)\]/.exec(maskComments(jsonc))?.[1];
  if (routes === undefined) return null;
  for (const entry of routes.match(/\{[^{}]*\}/g) ?? []) {
    if (!/"custom_domain"\s*:\s*true/.test(entry)) continue;
    const host = /"pattern"\s*:\s*"([^"]+)"/.exec(entry)?.[1];
    if (host !== undefined) return `https://${host.replace(/\/.*$/, "")}/_pinbox`;
  }
  return null;
}

export function webhookUrl(hub: string): string {
  return `${hub}/webhooks/github`;
}

/** Where the manifest is posted: an organization's Apps page, or the user's own. */
export function manifestTarget(org: string | null, state: string): string {
  const base =
    org === null
      ? "https://github.com/settings/apps/new"
      : `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** The page the local receiver serves at `/`: a form that submits itself to GitHub. */
export function manifestFormHtml(target: string, manifest: Manifest): string {
  const json = escapeAttr(JSON.stringify(manifest));
  return (
    "<!doctype html><meta charset=utf-8><title>pinbox — create GitHub App</title>" +
    '<body style="font:15px system-ui;padding:32px;max-width:560px">' +
    "<h1>Creating the pinbox GitHub App</h1>" +
    "<p>Redirecting you to GitHub. Review the App and click <b>Create GitHub App</b>.</p>" +
    `<form id=f method=post action="${escapeAttr(target)}">` +
    `<input type=hidden name=manifest value="${json}">` +
    "<button>Continue to GitHub</button></form>" +
    "<script>document.getElementById('f').submit()</script>"
  );
}

/** What the receiver shows after GitHub redirects back. */
export function donePageHtml(ok: boolean): string {
  return (
    "<!doctype html><meta charset=utf-8><title>pinbox</title>" +
    '<body style="font:15px system-ui;padding:32px">' +
    (ok
      ? "<h1>App created.</h1><p>Back to your terminal — pinbox is finishing setup.</p>"
      : "<h1>That did not match.</h1><p>The state did not match this run. Re-run <code>pinbox github setup</code>.</p>")
  );
}

/** "git@github.com:owner/name.git" · "https://github.com/owner/name(.git)" → "owner/name". */
export function repoFromRemote(remote: string): string | null {
  const m =
    /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim()) ??
    /^([^/\s]+)\/([^/\s]+)$/.exec(remote.trim());
  return m === null ? null : `${m[1]}/${m[2]}`;
}

export type Installation = { id: number; account: { login: string } | null };

/** The installation on the repo's owner, if GitHub lists one. */
export function pickInstallation(list: Installation[], owner: string): Installation | null {
  const wanted = owner.toLowerCase();
  return list.find((i) => i.account?.login.toLowerCase() === wanted) ?? null;
}

/**
 * Set the three GitHub vars in a `wrangler.jsonc` without parsing it, so comments survive.
 * Each var present as a live `"NAME": "<anything>"` is replaced in place; a commented-out
 * example is never the target. Missing ones are reported so the caller can print them for
 * manual insertion.
 */
export function patchWranglerVars(
  jsonc: string,
  vars: Record<string, string>,
): { text: string; missing: string[] } {
  let text = jsonc;
  const missing: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    // Match on the masked text (same offsets), splice into the real one.
    const m = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`).exec(maskComments(text));
    if (m === null) {
      missing.push(name);
      continue;
    }
    const valueAt = m.index + (m[1] as string).length;
    text = text.slice(0, valueAt) + JSON.stringify(value) + text.slice(m.index + m[0].length);
  }
  return { text, missing };
}

/**
 * The text with every `//` and `/* ... *\/` comment blanked to spaces — same length, same
 * offsets, newlines kept — so a regex over the result sees only live settings and a match
 * index addresses the original. String literals are skipped: `"https://x"` is not a comment.
 */
function maskComments(jsonc: string): string {
  let out = "";
  let i = 0;
  while (i < jsonc.length) {
    const ch = jsonc[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < jsonc.length && jsonc[j] !== '"') j += jsonc[j] === "\\" ? 2 : 1;
      out += jsonc.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && jsonc[i + 1] === "/") {
      const nl = jsonc.indexOf("\n", i);
      const end = nl === -1 ? jsonc.length : nl;
      out += " ".repeat(end - i);
      i = end;
    } else if (ch === "/" && jsonc[i + 1] === "*") {
      const close = jsonc.indexOf("*/", i + 2);
      const end = close === -1 ? jsonc.length : close + 2;
      out += jsonc.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** A URL-safe random state for the manifest round trip. */
export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function usage(): string {
  return "run `pinbox github setup --help` for usage";
}
