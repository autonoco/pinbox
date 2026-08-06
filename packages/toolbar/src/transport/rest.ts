// @autono/pinbox-toolbar — REST side of the hub transport: fetch + bearer against
// the pinned route surface. Every failure surfaces the hub's error
// envelope {ok:false,error:{code,message,hint}} as a HubError; network and parse
// failures use E_HUB_UNREACHABLE, the client-only error code.
import type { Attachment, Pin, PinInput, ThreadMessage } from "@autono/pinbox-core/schema";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HubError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;

  constructor(code: string, message: string, status: number, hint?: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; hint?: string };
}

/** Unwrap {ok:true,data} or throw the envelope's error as a HubError. */
async function decodeEnvelope<T>(res: Response): Promise<T> {
  let envelope: Envelope;
  try {
    envelope = (await res.json()) as Envelope;
  } catch {
    throw new HubError(
      "E_HUB_UNREACHABLE",
      `hub returned non-JSON (HTTP ${res.status})`,
      res.status,
    );
  }
  if (res.ok && envelope.ok === true) return envelope.data as T;
  const e = envelope.error;
  throw new HubError(
    e?.code ?? "E_INTERNAL",
    e?.message ?? `hub error (HTTP ${res.status})`,
    res.status,
    e?.hint,
  );
}

export class RestClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(endpoint: string, token: string, fetchFn?: FetchLike) {
    this.#base = endpoint.replace(/\/+$/, "");
    this.#token = token;
    this.#fetch = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "network failure";
      throw new HubError("E_HUB_UNREACHABLE", `hub unreachable: ${detail}`, 0);
    }
    return decodeEnvelope<T>(res);
  }

  listPins(): Promise<Pin[]> {
    return this.#request("GET", "/pins");
  }

  createPin(input: PinInput): Promise<Pin> {
    return this.#request("POST", "/pins", input);
  }

  getThread(pinId: string): Promise<ThreadMessage[]> {
    return this.#request("GET", `/pins/${pinId}/thread`);
  }

  reply(pinId: string, text: string, attachments?: Attachment[]): Promise<ThreadMessage> {
    return this.#request("POST", `/pins/${pinId}/thread`, {
      role: "human",
      text,
      ...(attachments === undefined ? {} : { attachments }),
    });
  }

  resolve(pinId: string, note?: string): Promise<Pin> {
    return this.#request("POST", `/pins/${pinId}/resolve`, {
      by: "human",
      ...(note === undefined ? {} : { note }),
    });
  }

  verify(pinId: string, outcome: "accepted" | "reopened"): Promise<Pin> {
    return this.#request("POST", `/pins/${pinId}/verify`, { outcome });
  }
}
