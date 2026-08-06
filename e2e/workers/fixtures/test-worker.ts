// Miniflare main for the workerd suite: re-exports every DO class the test bindings
// name. STORE_DO exercises the store adapter directly; HUB_DO is the real product DO.
import { PinboxHubDO } from "../../../packages/core/src/do.ts";

export { StoreDo } from "./store-do.ts";
export { PinboxHubDO };

// The same DO under the "none" strategy: bindings are per-namespace, not per-object,
// so strategy-parity coverage (tokenless upgrade must consult verifyNone) gets its
// own class that overrides the auth env before the base constructor reads it.
// ConstructorParameters keeps the ctx/env types identical to core's own workers-types
// pin — e2e resolves a newer @cloudflare/workers-types major, and mixing the two
// DurableObjectState declarations fails under exactOptionalPropertyTypes.
export class PinboxHubDONone extends PinboxHubDO {
  constructor(...[ctx, env]: ConstructorParameters<typeof PinboxHubDO>) {
    super(ctx, { ...env, AUTH_STRATEGY: "none", ALLOW_UNAUTHENTICATED: "1" });
  }
}

// The refusal half of the none row: AUTH_STRATEGY=none WITHOUT the explicit opt-in must
// fail closed on every request ("no unauthenticated writes in any configuration").
export class PinboxHubDONoneRefused extends PinboxHubDO {
  constructor(...[ctx, env]: ConstructorParameters<typeof PinboxHubDO>) {
    super(ctx, { ...env, AUTH_STRATEGY: "none" });
  }
}

// The jwt row: three knobs pointed at a test issuer whose JWKS the suite serves from a
// stubbed global fetch (same-isolate, like SELF's origin stubbing). Values must match
// loop-parity.worker-test.ts.
export class PinboxHubDOJwt extends PinboxHubDO {
  constructor(...[ctx, env]: ConstructorParameters<typeof PinboxHubDO>) {
    super(ctx, {
      ...env,
      AUTH_STRATEGY: "jwt",
      JWT_ISSUER: "https://issuer.test",
      JWT_JWKS_URL: "https://issuer.test/.well-known/jwks.json",
      JWT_AUDIENCE: "tool:pinbox",
    });
  }
}

export default {
  fetch(): Response {
    return new Response("test fixture worker — use the STORE_DO / HUB_DO bindings", {
      status: 404,
    });
  },
};
