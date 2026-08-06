// Minimal Durable Object fixture holding the DO SQLite PinStore. Tests reach the store
// directly via runInDurableObject(stub, (instance) => …) from cloudflare:test.
// Plain class — no cloudflare:workers import (freeze/plan rule: hibernation and DO
// behavior need no RPC base class).
import type { DurableObjectState } from "@cloudflare/workers-types";
import { type DoPinStore, openDoStore } from "../../../packages/core/src/do-store.ts";

export class StoreDo {
  readonly ctx: DurableObjectState;
  readonly store: DoPinStore;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    this.store = openDoStore(ctx.storage.sql, ctx.storage);
  }

  fetch(_req: Request): Response {
    return new Response("store-do fixture", { status: 200 });
  }
}

export default {
  fetch(): Response {
    return new Response("test fixture worker — use the STORE_DO binding", { status: 404 });
  },
};
