// @autono/pinbox-core — store error types.
//
// These live in their own leaf module to break a real runtime import cycle: `store.ts` imports
// `SqliteSessionStore` from `sessions.ts` (a value, at line ~294), while `sessions.ts` needs
// `NotFoundError` to signal a missing session. Importing it from `store.ts` closed the loop
// (`sessions.ts → store.ts → sessions.ts`), which fallow reports as a circular dependency.
// Both now depend on this module, which depends on nothing.
//
// `store.ts` re-exports both classes, so the published `./store` subpath is unchanged and no
// consumer import breaks.

/** The addressed row does not exist. Mapped to 404 / `E_NOT_FOUND` by the hub. */
export class NotFoundError extends Error {}

/** The write conflicts with current state (e.g. resolving an already-resolved pin). 409 / `E_CONFLICT`. */
export class ConflictError extends Error {}
