// pinbox CLI — hub HTTP client.
// HubClient is a thin fetch wrapper over the hub REST routes (core hub.ts); every
// hub error body maps to a CliError so commands speak one error language. Commands
// obtain a client via connectClient(), which rides the daemon lifecycle (ensureHub)
// or the test-injected connection.
import type { Pin, PinInput, SessionRef, ThreadMessage } from "@autono/pinbox-core/schema";
import type { Session } from "@autono/pinbox-core/sessions";
import { getConnection } from "./daemon.ts";
import { CliError, type ErrorCode, EXIT_CODES } from "./errors.ts";

export type HubSummary = { open: number; resolved: number; lastEventSeq: number; sessions: number };
export type SessionInjectResult = { context: string; pins: Pin[]; delivered: number };
export type SessionPendingResult = { count: number; pins: Pin[] };

type ErrorBody = { code?: string; message?: string; hint?: string };
type Envelope<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

export class HubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  createPin(input: PinInput): Promise<Pin> {
    return this.request("POST", "/pins", input);
  }

  list(status?: "open" | "resolved"): Promise<Pin[]> {
    return this.request("GET", status === undefined ? "/pins" : `/pins?status=${status}`);
  }

  get(id: string): Promise<Pin> {
    return this.request("GET", `/pins/${id}`);
  }

  thread(id: string): Promise<ThreadMessage[]> {
    return this.request("GET", `/pins/${id}/thread`);
  }

  reply(id: string, text: string, role: "human" | "agent"): Promise<ThreadMessage> {
    return this.request("POST", `/pins/${id}/thread`, { role, text });
  }

  // Trailing commit param — the trailer verb's write path for resolution.commit.
  resolve(id: string, by: "human" | "agent", note?: string, commit?: string): Promise<Pin> {
    return this.request("POST", `/pins/${id}/resolve`, {
      by,
      ...(note === undefined ? {} : { note }),
      ...(commit === undefined ? {} : { commit }),
    });
  }

  summary(): Promise<HubSummary> {
    return this.request("GET", "/summary");
  }

  // Session-method block — the hidden `session` verb's hub surface.
  registerSession(ref: SessionRef): Promise<Session> {
    return this.request("POST", "/sessions", ref);
  }

  listSessions(): Promise<Session[]> {
    return this.request("GET", "/sessions");
  }

  endSession(id: string): Promise<Session> {
    return this.request("DELETE", `/sessions/${id}`);
  }

  sessionInject(id: string): Promise<SessionInjectResult> {
    return this.request("POST", `/sessions/${id}/inject`);
  }

  sessionPending(id: string): Promise<SessionPendingResult> {
    return this.request("GET", `/sessions/${id}/pending`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return unwrapEnvelope<T>(res);
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      // The daemon answered /health moments ago and is gone now — same next step
      // as a failed spawn, so same error surface.
      throw new CliError(
        "E_HUB_UNREACHABLE",
        "cannot reach the hub and could not start one",
        "run `pinbox doctor` to find out why",
      );
    }
  }
}

async function unwrapEnvelope<T>(res: Response): Promise<T> {
  const envelope = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (envelope?.ok === true) return envelope.data;
  if (envelope?.ok === false) {
    const { code, message, hint } = envelope.error;
    throw new CliError(isErrorCode(code) ? code : "E_INTERNAL", message ?? "hub error", hint);
  }
  throw new CliError("E_INTERNAL", `unexpected hub response (${res.status})`);
}

/** The one way commands reach the hub: daemon lifecycle in, HubClient out. */
export async function connectClient(projectDir: string = process.cwd()): Promise<HubClient> {
  const { baseUrl, token } = await getConnection(projectDir);
  return new HubClient(baseUrl, token);
}

function isErrorCode(code: string | undefined): code is ErrorCode {
  return code !== undefined && code in EXIT_CODES;
}
