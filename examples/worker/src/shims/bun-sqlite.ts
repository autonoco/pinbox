// Aliased in place of `bun:sqlite` by wrangler.jsonc — see THE LOAD-BEARING LINE there.
// hub.ts → store.ts imports { Database } at module top level, so the bundler must
// resolve the specifier even though the Worker only ever uses DO SQLite. Nothing here
// executes unless something wrongly reaches for the local store on workerd.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is the LOCAL store; the Worker uses DO SQLite (openDoStore)");
  }
}
