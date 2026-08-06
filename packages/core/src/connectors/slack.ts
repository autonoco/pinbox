// @autono/pinbox-core — Slack connector, on the frozen Connector interface.
// Fetch-based transport ⇒ ONE transport serves both hosts (unlike github's gh-CLI local /
// App-token cloud split). The pin thread is the source of truth; the origin-tag anti-echo
// rule is enforced in core at the mirror call sites — this connector posts blindly and
// never second-guesses it.
import { z } from "zod";
import { pinsToMarkdown } from "../markdown.ts";
import type { Link, Pin, ThreadMessage } from "../schema.ts";
import type { Connector, ConnectorEvents, ConnectorTransport } from "./types.ts";

export type SlackTransportOptions = { botToken: string; fetchImpl?: typeof fetch };

/**
 * request(op, params) → POST https://slack.com/api/<op> (JSON, bearer botToken).
 * Slack's `{ok:false, error}` becomes a rejection carrying the Slack error string —
 * the route layer surfaces it as 502 E_CONNECTOR.
 */
export function createSlackTransport(opts: SlackTransportOptions): ConnectorTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async request(op, params) {
      const res = await fetchImpl(`https://slack.com/api/${op}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(params),
      });
      if (!res.ok) throw new Error(`slack ${op} failed: HTTP ${res.status}`);
      const data: unknown = await res.json();
      const envelope = SlackEnvelopeSchema.parse(data);
      if (!envelope.ok) throw new Error(`slack ${op} failed: ${envelope.error ?? "unknown_error"}`);
      return data;
    },
  };
}

export type SlackConnectorOptions = { channel: string };

/** Links are `ref: "<channel>/<thread_ts>"`; every thread op derives channel + ts from the ref. */
export function createSlackConnector(
  transport: ConnectorTransport,
  opts: SlackConnectorOptions,
): Connector {
  return {
    name: "slack",

    async createItem(pin: Pin, thread: ThreadMessage[]): Promise<Link> {
      const text = [pinsToMarkdown([pin], "standard"), ...thread.map((m) => `${m.role}: ${m.text}`)]
        .join("\n")
        .trimEnd();
      const posted = PostMessageSchema.parse(
        await transport.request("chat.postMessage", { channel: opts.channel, text }),
      );
      const channel = posted.channel ?? opts.channel;
      const permalink = PermalinkSchema.parse(
        await transport.request("chat.getPermalink", { channel, message_ts: posted.ts }),
      );
      return { connector: "slack", ref: `${channel}/${posted.ts}`, url: permalink.permalink };
    },

    async postComment(link: Link, message: ThreadMessage): Promise<void> {
      const { channel, ts } = parseRef(link.ref);
      await transport.request("chat.postMessage", {
        channel,
        thread_ts: ts,
        text: message.text,
      });
    },

    async sync(link: Link, events: ConnectorEvents): Promise<void> {
      const { channel, ts } = parseRef(link.ref);
      const replies = RepliesSchema.parse(
        await transport.request("conversations.replies", { channel, ts }),
      );
      for (const reply of replies.messages) {
        if (reply.ts === ts) continue; // the thread parent is the pin itself, never a comment
        // Every reply, every poll: replay filtering is core (inbound.ts) and is matched
        // against the durable thread, never against a clock. A cursor comparison HERE would
        // compare Slack timestamps to OUR lastSyncedAt and silently drop a genuinely new
        // reply whenever the workspace clock runs behind ours.
        const atMs = slackTsToMs(reply.ts);
        await events.onRemoteComment(link, {
          origin: `slack:${reply.user}`,
          text: reply.text ?? "",
          at: new Date(atMs).toISOString(),
        });
      }
      // Slack threads have no open/closed vocabulary ⇒ onRemoteStatus is never called in v1.
    },

    // Documented no-op — Slack threads have no open/closed vocabulary,
    // so there is no remote status to set on resolve/reopen.
    async setRemoteStatus(): Promise<void> {},
  };
}

const SlackEnvelopeSchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() });
const PostMessageSchema = z.looseObject({ channel: z.string().optional(), ts: z.string() });
const PermalinkSchema = z.looseObject({ permalink: z.string() });
const RepliesSchema = z.looseObject({
  messages: z.array(
    z.looseObject({ ts: z.string(), user: z.string(), text: z.string().optional() }),
  ),
});

function parseRef(ref: string): { channel: string; ts: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`slack link ref must be "<channel>/<thread_ts>", got "${ref}"`);
  }
  return { channel: ref.slice(0, slash), ts: ref.slice(slash + 1) };
}

/** Slack ts is "<epoch-seconds>.<suffix>" — epoch milliseconds for the reported `at`. */
function slackTsToMs(ts: string): number {
  return Number(ts) * 1000;
}
