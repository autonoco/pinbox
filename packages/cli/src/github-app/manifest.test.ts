// The pure half of `pinbox github setup`: manifest shape, URL rules, remote parsing,
// installation picking, wrangler.jsonc var patching without a JSON parser.
import { describe, expect, test } from "bun:test";
import { CliError } from "../errors.ts";
import {
  buildManifest,
  manifestFormHtml,
  manifestTarget,
  normalizeHubUrl,
  patchWranglerVars,
  pickInstallation,
  repoFromRemote,
} from "./manifest.ts";

describe("manifest", () => {
  test("asks for exactly what the connector needs and points the webhook at the hub", () => {
    const m = buildManifest({
      name: "pinbox-app",
      hubUrl: "https://app.example/_pinbox/",
      redirectUrl: "http://127.0.0.1:4242/callback",
    });
    expect(m.default_permissions).toEqual({ issues: "write", metadata: "read" });
    expect(m.default_events).toEqual(["issues", "issue_comment"]);
    expect(m.hook_attributes).toEqual({
      url: "https://app.example/_pinbox/webhooks/github",
      active: true,
    });
    expect(m.url).toBe("https://app.example/_pinbox");
    expect(m.public).toBe(false);
  });

  test("the form posts the manifest as one hidden field, HTML-escaped, and submits itself", () => {
    const html = manifestFormHtml(
      manifestTarget("autonoco", "abc"),
      buildManifest({
        name: 'x"y',
        hubUrl: "https://h/_pinbox",
        redirectUrl: "http://127.0.0.1:1/callback",
      }),
    );
    expect(html).toContain(
      'action="https://github.com/organizations/autonoco/settings/apps/new?state=abc"',
    );
    expect(html).toContain('name=manifest value="');
    expect(html).toContain("&quot;x\\&quot;y&quot;"); // the name's quote survives as JSON, escaped for HTML
    expect(html).toContain("submit()");
    expect(manifestTarget(null, "s")).toBe("https://github.com/settings/apps/new?state=s");
  });
});

describe("normalizeHubUrl", () => {
  test("requires https (or loopback) and the /_pinbox mount", () => {
    expect(normalizeHubUrl("https://app.example/_pinbox///")).toBe("https://app.example/_pinbox");
    expect(normalizeHubUrl("http://127.0.0.1:8787/_pinbox")).toBe("http://127.0.0.1:8787/_pinbox");
    expect(() => normalizeHubUrl("https://app.example")).toThrow(CliError);
    expect(() => normalizeHubUrl("http://app.example/_pinbox")).toThrow("https");
    expect(() => normalizeHubUrl("nope")).toThrow("not a URL");
  });
});

describe("repoFromRemote", () => {
  test("ssh, https, .git, trailing slash, bare owner/name", () => {
    expect(repoFromRemote("git@github.com:autonoco/pinbox.git")).toBe("autonoco/pinbox");
    expect(repoFromRemote("https://github.com/autonoco/pinbox")).toBe("autonoco/pinbox");
    expect(repoFromRemote("https://github.com/autonoco/pinbox.git/\n")).toBe("autonoco/pinbox");
    expect(repoFromRemote("autonoco/pinbox")).toBe("autonoco/pinbox");
    expect(repoFromRemote("https://gitlab.com/a/b")).toBeNull();
  });
});

describe("pickInstallation", () => {
  test("matches the owner case-insensitively; null when absent", () => {
    const list = [
      { id: 1, account: { login: "Someone" } },
      { id: 2, account: null },
      { id: 3, account: { login: "AutonoCo" } },
    ];
    expect(pickInstallation(list, "autonoco")?.id).toBe(3);
    expect(pickInstallation(list, "nobody")).toBeNull();
  });
});

describe("patchWranglerVars", () => {
  test("replaces present vars in place, keeps comments, reports the missing", () => {
    const jsonc = `{
  // comment
  "vars": {
    "AUTH_STRATEGY": "token",
    "GITHUB_APP_ID": "",
    "GITHUB_REPO":   "old/one"
  }
}`;
    const { text, missing } = patchWranglerVars(jsonc, {
      GITHUB_APP_ID: "123",
      GITHUB_INSTALLATION_ID: "9",
      GITHUB_REPO: "autonoco/pinbox",
    });
    expect(text).toContain('"GITHUB_APP_ID": "123"');
    expect(text).toContain('"GITHUB_REPO":   "autonoco/pinbox"');
    expect(text).toContain("// comment");
    expect(text).toContain('"AUTH_STRATEGY": "token"');
    expect(missing).toEqual(["GITHUB_INSTALLATION_ID"]);
  });
});
