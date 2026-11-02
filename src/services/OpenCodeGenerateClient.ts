import { OutputChannelService } from "./OutputChannelService";

/**
 * Stateless text generation client for OpenCode, used by changelog
 * translation. Deliberately separate from `OpenCodeApiClient`: that client
 * retries ten times with a five second timeout, which is the wrong policy for
 * a single long-running generation request.
 */
export interface OpenCodeGenerateConnection {
  protocol: "v1" | "v2";
  baseUrl: string;
  password?: string;
  directory?: string;
}

/**
 * Failure classes surfaced to the translation service. They map to short
 * user-facing reasons; the raw message stays in the log.
 */
export type OpenCodeGenerateFailure =
  | "aborted"
  | "unreachable"
  | "not-ready"
  | "rate-limit"
  | "timeout"
  | "http"
  | "empty"
  | "invalid";

export class OpenCodeGenerateError extends Error {
  public constructor(
    public readonly failure: OpenCodeGenerateFailure,
    message: string,
    public readonly status?: number,
    public readonly providerID?: string,
  ) {
    super(message);
    this.name = "OpenCodeGenerateError";
  }
}

/** One generation request may legitimately take tens of seconds. */
const GENERATE_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const LOG_PREFIX = "[ChangelogTranslation]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads `{ data: { text } }` from the v2 generate endpoint. */
function readV2Text(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.data)) {
    return undefined;
  }
  return typeof body.data.text === "string" ? body.data.text : undefined;
}

/** Reads the created session id from a v1 `POST /session` response. */
function readSessionId(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return typeof body.id === "string" && body.id ? body.id : undefined;
}

/** Joins every text part of a v1 session message response. */
function readMessageText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.parts)) {
    return "";
  }
  return body.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

interface ErrorDetail {
  message: string;
  reason?: string;
  /** Provider status carried inside a gateway-style error body. */
  status?: number;
  /** Provider id carried inside a gateway-style error body. */
  providerID?: string;
}

/** Pulls a short provider message and real status out of an error body. */
async function readErrorDetail(response: Response): Promise<ErrorDetail> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      return {
        message:
          typeof body.message === "string" ? body.message.slice(0, 200) : "",
        reason: typeof body.reason === "string" ? body.reason : undefined,
        status: typeof body.status === "number" ? body.status : undefined,
        providerID:
          typeof body.providerID === "string" ? body.providerID : undefined,
      };
    }
  } catch {
    // Non-JSON error bodies carry no useful detail.
  }
  return { message: "" };
}

export class OpenCodeGenerateClient {
  public constructor(
    private readonly connection: OpenCodeGenerateConnection,
    private readonly logger: OutputChannelService,
  ) {}

  /**
   * Runs one generation prompt and returns the raw model text. The caller's
   * abort signal is combined with a 90 second per-request timeout. Every
   * failure is wrapped in `OpenCodeGenerateError` so the caller can map it to
   * a short reason without parsing messages.
   */
  public async generate(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    ]);
    try {
      const text =
        this.connection.protocol === "v2"
          ? await this.generateV2(prompt, requestSignal)
          : await this.generateV1(prompt, requestSignal);
      if (!text.trim()) {
        throw new OpenCodeGenerateError(
          "empty",
          "generation returned empty text",
        );
      }
      return text;
    } catch (error) {
      if (error instanceof OpenCodeGenerateError) {
        throw error;
      }
      if (signal.aborted) {
        throw new OpenCodeGenerateError("aborted", "generation cancelled");
      }
      if (requestSignal.aborted) {
        throw new OpenCodeGenerateError("timeout", "generation timed out");
      }
      throw new OpenCodeGenerateError("unreachable", errorMessage(error));
    }
  }

  private baseUrl(): string {
    return this.connection.baseUrl.replace(/\/$/, "");
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.connection.directory) {
      headers["x-opencode-directory"] = this.connection.directory;
    }
    return headers;
  }

  private authHeaders(): Record<string, string> {
    const headers = this.baseHeaders();
    if (this.connection.password) {
      const token = Buffer.from(
        `opencode:${this.connection.password}`,
        "utf8",
      ).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  /**
   * Resolves the model the server would use for a prompt without one. Only
   * v2 exposes this endpoint; failures return undefined so a diagnostic hint
   * never breaks the failure path.
   */
  public async getDefaultModel(): Promise<string | undefined> {
    if (this.connection.protocol !== "v2") {
      return undefined;
    }
    try {
      const response = await fetch(`${this.baseUrl()}/api/model/default`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return undefined;
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !isRecord(body.data)) {
        return undefined;
      }
      const providerID = body.data.providerID;
      const id = body.data.id;
      if (typeof providerID === "string" && typeof id === "string") {
        return `${providerID}/${id}`;
      }
    } catch {
      // The diagnostic hint is optional.
    }
    return undefined;
  }

  private async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const status = detail.status ?? response.status;
      const reason = detail.reason?.toLowerCase() ?? "";
      const text = `${reason} ${detail.message.toLowerCase()}`;
      const rateLimited =
        status === 429 ||
        text.includes("rate_limit") ||
        text.includes("rate limit") ||
        text.includes("usage limit");
      const failure: OpenCodeGenerateFailure = rateLimited
        ? "rate-limit"
        : status === 503
          ? "not-ready"
          : "http";
      throw new OpenCodeGenerateError(
        failure,
        detail.message || `request returned HTTP ${status}`,
        status,
        detail.providerID,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new OpenCodeGenerateError("invalid", "response body was not JSON");
    }
  }

  private async generateV2(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const headers = this.authHeaders();

    this.logger.debug(`${LOG_PREFIX} v2 generate request`);
    const body = await this.postJson(
      `${this.baseUrl()}/api/experimental/generate/text`,
      { prompt },
      headers,
      signal,
    );
    const text = readV2Text(body);
    if (text === undefined) {
      throw new OpenCodeGenerateError(
        "invalid",
        "generate/text response did not contain data.text",
      );
    }
    return text;
  }

  private async generateV1(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    const baseUrl = this.baseUrl();
    const headers = this.baseHeaders();

    this.logger.debug(`${LOG_PREFIX} v1 session create request`);
    const sessionBody = await this.postJson(
      `${baseUrl}/session`,
      {},
      headers,
      signal,
    );
    const sessionId = readSessionId(sessionBody);
    if (!sessionId) {
      throw new OpenCodeGenerateError(
        "invalid",
        "session create response did not contain an id",
      );
    }

    try {
      this.logger.debug(
        `${LOG_PREFIX} v1 session message request (${sessionId})`,
      );
      const messageBody = await this.postJson(
        `${baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
        {
          parts: [{ type: "text", text: prompt }],
          tools: {},
        },
        headers,
        signal,
      );
      return readMessageText(messageBody);
    } finally {
      // Cleanup must not delay a cancelled or failed response.
      void this.deleteSession(baseUrl, sessionId, headers);
    }
  }

  /** Best-effort cleanup; a failed delete only logs at debug level. */
  private async deleteSession(
    baseUrl: string,
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<void> {
    try {
      const response = await fetch(
        `${baseUrl}/session/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        this.logger.debug(
          `${LOG_PREFIX} session cleanup returned HTTP ${response.status}`,
        );
      }
    } catch (error) {
      this.logger.debug(
        `${LOG_PREFIX} session cleanup failed: ${errorMessage(error)}`,
      );
    }
  }
}
