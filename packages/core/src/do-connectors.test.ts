// buildConnectors (do.ts): the cloud connector set is derived from the environment alone.
// A partial GitHub App quartet is ignored, not half-configured.
import { describe, expect, test } from "bun:test";
import { buildConnectors } from "./do.ts";

const APP = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAA==\n-----END RSA PRIVATE KEY-----",
  GITHUB_INSTALLATION_ID: "2",
  GITHUB_REPO: "autonoco/pinbox",
};

describe("buildConnectors", () => {
  test("nothing configured ⇒ no connectors", () => {
    expect(buildConnectors({})).toEqual([]);
  });

  test("the full GitHub App quartet ⇒ a github connector; any piece missing or empty ⇒ none", () => {
    expect(buildConnectors(APP).map((c) => c.name)).toEqual(["github"]);
    for (const key of Object.keys(APP) as (keyof typeof APP)[]) {
      expect(buildConnectors({ ...APP, [key]: undefined })).toEqual([]);
      expect(buildConnectors({ ...APP, [key]: "" })).toEqual([]);
    }
  });

  test("slack rides its pair; both connectors can coexist", () => {
    const names = buildConnectors({ ...APP, SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "C1" }).map(
      (c) => c.name,
    );
    expect(names).toEqual(["github", "slack"]);
    expect(buildConnectors({ SLACK_BOT_TOKEN: "xoxb" })).toEqual([]);
  });

  test("a malformed GITHUB_REPO fails at construction, loudly, not at the first link", () => {
    expect(() => buildConnectors({ ...APP, GITHUB_REPO: "pinbox" })).toThrow('"owner/name"');
  });
});
