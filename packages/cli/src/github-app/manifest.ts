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
    throw new CliError("E_INVALID_INPUT", `--hub is not a URL: "${raw}"`, usage());
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new CliError("E_INVALID_INPUT", "--hub must be https", usage());
  }
  if (!url.pathname.endsWith("/_pinbox")) {
    throw new CliError(
      "E_INVALID_INPUT",
      `--hub must include the hub mount, e.g. ${url.origin}/_pinbox`,
      "the Worker mounts the hub under /_pinbox; the origin root deliberately 404s",
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
  // JSONC, so no parser: one route object at a time, host from its pattern.
  const routes = /"routes"\s*:\s*\[([\s\S]*?)\]/.exec(jsonc)?.[1];
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
 * Set the three GitHub vars in a `wrangler.jsonc` without parsing it (comments). Each var
 * present as `"NAME": "<anything>"` is replaced; missing ones are reported so the caller
 * can print them for manual insertion.
 */
export function patchWranglerVars(
  jsonc: string,
  vars: Record<string, string>,
): { text: string; missing: string[] } {
  let text = jsonc;
  const missing: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    const re = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`);
    if (!re.test(text)) {
      missing.push(name);
      continue;
    }
    text = text.replace(re, `$1${JSON.stringify(value)}`);
  }
  return { text, missing };
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
