// @autono/pinbox-core — build script: emit dist/schema.json.
// The package.json "./schema.json" export points at dist/schema.json; without this
// step no build produces it and the published export is broken. Wired as the tsdown
// onSuccess command (`bun ./scripts/emit-schema.ts`) so it always runs under Bun —
// the tsdown bin carries a node shebang, so an in-process onSuccess function would
// execute wherever node points and `Bun.write` would not exist there.
import { pinJsonSchema } from "../src/schema.ts";

export async function emitSchema(
  outFile: URL | string = new URL("../dist/schema.json", import.meta.url),
): Promise<void> {
  await Bun.write(outFile, `${JSON.stringify(pinJsonSchema(), null, 2)}\n`);
}

if (import.meta.main) await emitSchema();
