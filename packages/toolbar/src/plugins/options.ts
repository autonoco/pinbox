// @autono/pinbox-toolbar — shared dev-plugin options (internal to ./vite and ./next)
// Exports VIRTUAL_ID, RESOLVED_VIRTUAL_ID, PinboxPluginOptions, ResolvedPinboxOptions, resolveOptions().
// Pure data + defaults: no I/O, no Bun or node: APIs, so it is safe in any consumer toolchain.

/** Virtual module the injected inline script imports. */
export const VIRTUAL_ID = "virtual:pinbox-toolbar";

/** Rollup/Vite convention: a leading NUL marks the id as owned by this plugin. */
export const RESOLVED_VIRTUAL_ID = "\0virtual:pinbox-toolbar";

/** User-facing plugin options. Every field is optional. */
export interface PinboxPluginOptions {
  /** Explicit hub base URL. When set, `.pinbox/server.json` discovery is skipped entirely. */
  hub?: string;
  /** Directory containing `.pinbox/server.json`. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Spawn `pinbox serve` when no healthy hub is found. Defaults to true. */
  spawnDaemon?: boolean;
  /** Hard off switch: the plugin becomes fully inert. Defaults to false. */
  disabled?: boolean;
}

/**
 * Fully-defaulted options.
 *
 * NOTE: under `exactOptionalPropertyTypes`, `hub` is a REQUIRED property whose value may be
 * `undefined` — it is deliberately not written `hub?: string`. `undefined` means "discover the
 * port from `.pinbox/server.json` at request time" rather than "unset".
 */
export interface ResolvedPinboxOptions {
  hub: string | undefined;
  projectRoot: string;
  spawnDaemon: boolean;
  disabled: boolean;
}

/** Strip trailing slashes so callers can append `/health` unconditionally. */
function normalizeHub(hub: string): string | undefined {
  const trimmed = hub.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Apply defaults. Never throws; unknown/empty values fall back to the documented default. */
export function resolveOptions(options?: PinboxPluginOptions): ResolvedPinboxOptions {
  const hub = options?.hub === undefined ? undefined : normalizeHub(options.hub);
  return {
    hub,
    projectRoot: options?.projectRoot ?? process.cwd(),
    spawnDaemon: options?.spawnDaemon ?? true,
    disabled: options?.disabled ?? false,
  };
}
