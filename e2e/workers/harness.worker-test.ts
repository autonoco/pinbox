// Proves the workerd pool boots: workerd runtime, DO binding present, SQLite-backed
// storage available inside the Durable Object.
import { env, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import type { StoreDo } from "./fixtures/store-do.ts";

test("the pool boots", () => {
  expect(1).toBe(1);
});

test("STORE_DO binding exists and runs on workerd with DO SQLite", async () => {
  expect(env.STORE_DO).toBeDefined();
  const stub = env.STORE_DO.get(env.STORE_DO.idFromName("harness"));
  const size = await runInDurableObject(stub, (instance: StoreDo) => {
    return instance.ctx.storage.sql.databaseSize;
  });
  expect(size).toBeGreaterThan(0);
});
