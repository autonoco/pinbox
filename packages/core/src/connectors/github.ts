// @autono/pinbox-core/connectors — GitHub connector.
// Transport is host-injected: `gh` CLI shell-out locally (packages/cli), App-token fetch on
// the Worker. The op vocabulary below is pinned so both transports implement the same names:
//   "issue.create"  { title, body }  → { number: number, url: string }
//   "issue.comment" { number, body } → void
//   "issue.view"    { number }       → { state: "open" | "closed",
//                                        comments: { author, body, createdAt }[] }
//   "issue.close"   { number } → void   ·   "issue.reopen" { number } → void
// No Bun.* here — core is host-agnostic (this file also runs on workerd).
import { pinsToMarkdown } from "../markdown.ts";
import type { Link } from "../schema.ts";
import type { Connector, ConnectorTransport } from "./types.ts";

const TITLE_MAX = 72;
// Trailer marking bodies we authored: issue bodies end "— pinbox pin <id>", mirrored
// comments end "— pinbox <msgId>". sync skips them remote-side too (belt-and-braces with
// the origin-tag rule in mirror.ts).
const PINBOX_TRAILER = "— pinbox";

type IssueCreated = { number: number; url: string };
type IssueView = {
  state: "open" | "closed";
  comments: { author: string; body: string; createdAt: string }[];
};

export function createGithubConnector(transport: ConnectorTransport): Connector {
  return {
    name: "github",

    async createItem(pin, _thread): Promise<Link> {
      const title = (pin.text.split("\n", 1)[0] ?? pin.text).slice(0, TITLE_MAX);
      const body = `${pinsToMarkdown([pin], "standard")}\n\n${PINBOX_TRAILER} pin ${pin.id}`;
      const created = (await transport.request("issue.create", { title, body })) as IssueCreated;
      return { connector: "github", ref: String(created.number), url: created.url };
    },

    async postComment(link, message): Promise<void> {
      await transport.request("issue.comment", {
        number: Number(link.ref),
        body: `${message.text}\n\n${PINBOX_TRAILER} ${message.id}`,
      });
    },

    async sync(link, events): Promise<void> {
      const view = (await transport.request("issue.view", {
        number: Number(link.ref),
      })) as IssueView;
      for (const comment of view.comments) {
        if (isOwnMirror(comment.body)) continue;
        await events.onRemoteComment(link, {
          origin: `github:${comment.author}`,
          text: comment.body,
          at: comment.createdAt,
        });
      }
      await events.onRemoteStatus(link, view.state === "closed" ? "closed" : "open");
    },

    async setRemoteStatus(link, status): Promise<void> {
      const op = status === "closed" ? "issue.close" : "issue.reopen";
      await transport.request(op, { number: Number(link.ref) });
    },
  };
}

function isOwnMirror(body: string): boolean {
  const lastLine = body.trimEnd().split("\n").at(-1) ?? "";
  return lastLine.startsWith(PINBOX_TRAILER);
}
