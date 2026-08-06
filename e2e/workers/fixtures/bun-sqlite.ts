// Stand-in for `bun:sqlite` in the workerd module graph (aliased in vitest.config.ts and
// tsconfig paths). store.ts imports it at top level; the DO adapter never calls openStore,
// so nothing here ever executes — constructing Database throws with a pointed message.
function shimError(): Error {
  return new Error("bun:sqlite is the LOCAL store; the Worker uses DO SQLite (openDoStore)");
}

export class Statement<T = Record<string, unknown>> {
  as<U>(_Class: new () => U): Statement<U> {
    throw shimError();
  }
  get(..._params: unknown[]): T | null {
    throw shimError();
  }
  all(..._params: unknown[]): T[] {
    throw shimError();
  }
  run(..._params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    throw shimError();
  }
}

export class Database {
  constructor(_path?: string) {
    throw shimError();
  }
  query<T = Record<string, unknown>>(_sql: string): Statement<T> {
    throw shimError();
  }
  exec(_sql: string): void {
    throw shimError();
  }
  transaction<A extends unknown[], R>(
    _fn: (...args: A) => R,
  ): ((...args: A) => R) & { immediate: (...args: A) => R } {
    throw shimError();
  }
  close(): void {
    throw shimError();
  }
}
