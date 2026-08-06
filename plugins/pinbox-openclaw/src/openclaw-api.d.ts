// OpenClaw gateway plugin API — local typings for the guest artifact in index.ts.
// PluginNextTurnInjection and the enqueue signature are copied VERBATIM from
// OpenClaw's own shipped declaration file (hook-types-DQ9eTy2x.d.ts, verified against
// the installed OpenClaw 2026.7.1). Do not adjust those two by hand: if OpenClaw
// changes them, re-copy from its shipped types. Everything else is the minimal slice
// this plugin touches — never widen it speculatively.

export type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

export type PluginNextTurnInjection = {
  sessionKey: string;
  text: string;
  idempotencyKey?: string; // "pin:<pinId>:<seq>" — re-injecting an open pin every turn is safe
  placement?: "prepend_context" | "append_context";
  ttlMs?: number; // expires a stale pin instead of wedging it in context
  metadata?: PluginJsonValue;
};

export type EnqueueResult = { enqueued: boolean; id: string; sessionKey: string };

// Shipped shapes (hook-types): gateway_start carries only the port; sessions
// announce themselves through session_start / session_end lifecycle hooks.
export type GatewayStartEvent = { port: number };
export type SessionLifecycleEvent = { sessionId: string; sessionKey?: string };

export type PluginTool = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, PluginJsonValue>;
  execute(params: Record<string, unknown>): Promise<unknown>;
};

export type PluginLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerHook(
    event: "gateway_start",
    handler: (event: GatewayStartEvent) => void | Promise<void>,
  ): void;
  registerHook(
    event: "session_start" | "session_end",
    handler: (event: SessionLifecycleEvent) => void | Promise<void>,
  ): void;
  registerTool(tool: PluginTool): void;
  session: {
    workflow: {
      enqueueNextTurnInjection(injection: PluginNextTurnInjection): Promise<EnqueueResult>;
    };
  };
};

// Entry-object contract (plugin-entry model): the module default-exports this
// object; the gateway calls register(api) after load.
export type PluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: Record<string, PluginJsonValue>;
  register(api: OpenClawPluginApi): void;
};
