// pinbox CLI — error codes and exit-code mapping.
// The machine output contract and exit codes are versioned; change them deliberately.
// Spec: docs/design/cli/v1-transcripts.md §"Cross-cutting reference".
// Codes 6–11 are a reserved block (append-only; exit codes never renumber).

export type ErrorCode =
  | "E_HUB_UNREACHABLE"
  | "E_NOT_FOUND"
  | "E_INVALID_INPUT"
  | "E_CONFLICT"
  | "E_INTERNAL"
  | "E_SESSION_GONE"
  | "E_DELIVERY"
  | "E_WS_PROTOCOL"
  | "E_ATTACHMENT"
  | "E_CONNECTOR"
  | "E_AUTH";

/** Exit codes map 1:1 from error codes; 0 is success. Append-only; exits never renumber. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  E_INTERNAL: 1,
  E_INVALID_INPUT: 2,
  E_NOT_FOUND: 3,
  E_CONFLICT: 4,
  E_HUB_UNREACHABLE: 5,
  E_SESSION_GONE: 6,
  E_DELIVERY: 7,
  E_WS_PROTOCOL: 8,
  E_ATTACHMENT: 9,
  E_CONNECTOR: 10,
  E_AUTH: 11,
};

export class CliError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    /** The next command to run, not just what went wrong. Every user-facing error should carry one. */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}
