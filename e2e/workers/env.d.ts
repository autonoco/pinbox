import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    STORE_DO: DurableObjectNamespace;
    HUB_DO: DurableObjectNamespace;
    HUB_DO_NONE: DurableObjectNamespace;
    HUB_DO_NONE_REFUSED: DurableObjectNamespace;
    HUB_DO_JWT: DurableObjectNamespace;
    MEDIA: R2Bucket;
    // Present only in the "template" pool project (bound by examples/worker/wrangler.jsonc);
    // loop-parity uses its presence to detect which project is running the file.
    PINBOX_HUB?: DurableObjectNamespace;
  }
}
