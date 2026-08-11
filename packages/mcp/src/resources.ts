// @autono/pinbox-mcp — pins published as resources, so an agent can be *told* about a pin
// instead of asked to poll for one.
//
// Tools stay meta-tools: `pinbox_list` is one call for the whole queue, never one tool per pin.
// That rule was about not exploding the tool list, and resources are not tools — a resource is a
// thing a client can read and watch, which is exactly what a pin is.
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { HubEvent } from "./hub-events.ts";
import type { McpToolDeps } from "./tools.ts";

const PIN_LIST_URI = "pinbox://pins";

export function pinUri(id: string): string {
  return `pinbox://pins/${id}`;
}

/** The pin id an event concerns, or null if the payload does not name one. */
export function eventPinId(event: HubEvent): string | null {
  const payload = event.payload as { pinId?: unknown; id?: unknown } | null;
  if (typeof payload !== "object" || payload === null) return null;
  const id = payload.pinId ?? payload.id;
  return typeof id === "string" ? id : null;
}

async function readThroughCli(deps: McpToolDeps, args: string[]): Promise<unknown> {
  const { stdout } = await deps.run(args, { cwd: deps.projectDir });
  const parsed = JSON.parse(stdout) as { ok: boolean; data?: unknown };
  if (!parsed.ok) throw new Error(`pinbox ${args[0]} failed`);
  return parsed.data;
}

/**
 * Reads still go through the CLI — the socket is a change *signal*, not a second way to read the
 * database. One reader means one place for the answer to be wrong.
 */
export function registerResources(server: McpServer, deps: McpToolDeps): void {
  server.registerResource(
    "pins",
    PIN_LIST_URI,
    {
      title: "Open pins",
      description: "Every pin in this project, newest first. Changes as pins are dropped.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await readThroughCli(deps, ["list", "--json"]), null, 2),
        },
      ],
    }),
  );

  // One resource per pin, so a client can watch a single thread rather than the whole queue.
  server.registerResource(
    "pin",
    new ResourceTemplate("pinbox://pins/{id}", {
      list: async () => {
        const pins = (await readThroughCli(deps, ["list", "--json"])) as { id: string }[];
        return {
          resources: pins.map((pin) => ({
            uri: pinUri(pin.id),
            name: pin.id,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Pin",
      description: "One pin with its full thread. Changes when someone replies or resolves it.",
      mimeType: "application/json",
    },
    async (uri, { id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await readThroughCli(deps, ["show", String(id), "--json"]), null, 2),
        },
      ],
    }),
  );
}

/**
 * Turn hub events into MCP notifications.
 *
 * A new pin changes the list; anything else changes one pin, and only the pin's own resource. The
 * SDK drops these when no client has subscribed, so this costs nothing until someone listens.
 */
export function notifyFromEvent(server: McpServer, event: HubEvent): void {
  if (event.eventType === "pin.created") {
    server.server.sendResourceListChanged().catch(() => {});
    return;
  }
  const id = eventPinId(event);
  if (id === null) return;
  server.server.sendResourceUpdated({ uri: pinUri(id) }).catch(() => {});
}
