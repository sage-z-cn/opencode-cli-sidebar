import * as http from "node:http";
import * as https from "node:https";

/**
 * Minimal WebDAV client on top of node:http / node:https request with no
 * third-party dependencies. All public methods take paths relative to the
 * configured base path and report failures through exactly two error
 * classes so callers can pick a circuit-breaker strategy.
 */

/** Configuration/credential/policy problems: retrying cannot fix them. */
export class WebDavFatalError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WebDavFatalError";
  }
}

/** Network trouble, timeouts and 5xx responses: worth retrying later. */
export class WebDavTransientError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WebDavTransientError";
  }
}

/**
 * The remote resource changed since the last sync, so a conditional PUT
 * refused to overwrite it; the caller should surface a conflict.
 */
export class PreconditionFailedError extends WebDavTransientError {
  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message, status);
    this.name = "PreconditionFailedError";
  }
}

/**
 * The caller aborted the request or the wait for a pacing slot. Deliberately
 * not a `WebDavTransientError`: an abort is a decision, not a server
 * condition, so the circuit breaker must not count it as a failure.
 */
export class WebDavAbortError extends Error {
  public constructor(message = "WebDAV request aborted") {
    super(message);
    this.name = "WebDavAbortError";
  }
}

/**
 * Server-side rate limit (429/503): a cooldown to wait out, not a
 * failure. Carries the server's Retry-After hint when available.
 */
export class WebDavRateLimitedError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WebDavRateLimitedError";
  }
}

export interface WebDavClientOptions {
  /** Server root URL, e.g. https://dav.example.com. */
  url: string;
  username?: string;
  password?: string;
  /** Sync tree root on the server. Defaults to "/". */
  basePath?: string;
  /** Allow plain http:// URLs. */
  allowInsecureHttp?: boolean;
  /** Skip TLS certificate validation (self-signed servers). */
  acceptSelfSigned?: boolean;
  /** Per-request idle timeout in ms. Defaults to 15 seconds. */
  timeoutMs?: number;
  /** Hard total deadline per request in ms, redirects included. Defaults to 60 seconds. */
  totalTimeoutMs?: number;
  /** Max requests per sliding window; below 1 disables pacing. */
  maxRequests?: number;
  /** Sliding pacing window length in ms; below 1 disables pacing. */
  windowMs?: number;
  /** Fired once per request that had to wait for a pacing slot. */
  onRateLimitWait?: (waitedMs: number) => void;
  /**
   * Cancels the request and any pacing wait. Used by the launch path, which
   * cannot afford the minutes a rate-limit cooldown may sleep.
   */
  signal?: AbortSignal;
}

/** Optional conditional-request headers for PUT. */
export interface WebDavPutConditions {
  /** Overwrite only when the remote ETag still matches this value. */
  ifMatch?: string;
  /** Create only; the request fails when the remote resource exists. */
  ifNoneMatchStar?: boolean;
}

/** Optional conditional-request headers for DELETE. */
export interface WebDavDeleteConditions {
  /** Delete only while the remote ETag still matches this value. */
  ifMatch?: string;
}

/** One remote resource as reported by PROPFIND. */
export interface WebDavStat {
  /** Path relative to basePath (decoded); "" is the queried collection. */
  path: string;
  etag: string | null;
  size: number;
  lastModified: number | null;
  isDir: boolean;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Response bodies above this size abort the request. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:">' +
  "<d:prop>" +
  "<d:resourcetype/>" +
  "<d:getetag/>" +
  "<d:getcontentlength/>" +
  "<d:getlastmodified/>" +
  "</d:prop>" +
  "</d:propfind>";

/** Normalize a base path to "/segment/" form. */
export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath) {
    return "/";
  }
  let normalized = basePath.trim();
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }
  if (!normalized.endsWith("/")) {
    normalized = normalized + "/";
  }
  return normalized;
}

function encodeRelPath(relPath: string): string {
  return relPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse a Retry-After header: delta seconds or an HTTP date. */
function parseRetryAfterMs(
  header: string | string[] | undefined,
): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  const until = Date.parse(trimmed);
  if (Number.isFinite(until)) {
    return Math.max(until - Date.now(), 0);
  }
  return undefined;
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&amp;/g, "&");
}

/** Convert one multistatus <response> href into a basePath-relative path. */
export function hrefToRelativePath(
  href: string,
  basePath: string,
): string | null {
  let pathname = href.trim();
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  } else {
    pathname = pathname.replace(/[?#].*$/, "");
  }
  // Compare decoded segments: servers percent-encode non-ASCII or spaces
  // in hrefs while the configured base path is raw, so a literal string
  // prefix check would never match such trees.
  const baseSegments = normalizeBasePath(basePath)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);
  const pathSegments = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);
  if (pathSegments.length < baseSegments.length) {
    return null;
  }
  for (let i = 0; i < baseSegments.length; i++) {
    if (pathSegments[i] !== baseSegments[i]) {
      return null;
    }
  }
  const segments = pathSegments.slice(baseSegments.length);
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    // Percent-decoding can smuggle traversal segments past loose re:
    // patterns; a hostile server must never address files outside the
    // sync tree.
    return null;
  }
  return segments.join("/");
}

/**
 * Namespace-agnostic multistatus parser: matches local-name elements so
 * servers using `d:`, `D:`, `lp1:` or no prefix at all all parse the same.
 */
export function parseMultiStatus(xml: string, basePath: string): WebDavStat[] {
  const blocks =
    xml.match(
      /<(?:[A-Za-z][\w.-]*:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z][\w.-]*:)?response>/g,
    ) ?? [];
  const stats: WebDavStat[] = [];
  for (const block of blocks) {
    const hrefMatch = block.match(
      /<(?:[A-Za-z][\w.-]*:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?href>/,
    );
    if (!hrefMatch) {
      continue;
    }
    const rel = hrefToRelativePath(xmlUnescape(hrefMatch[1]), basePath);
    if (rel === null) {
      continue;
    }
    const etagMatch = block.match(
      /<(?:[A-Za-z][\w.-]*:)?getetag(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?getetag>/,
    );
    const etagRaw = etagMatch ? xmlUnescape(etagMatch[1]).trim() : "";
    const sizeMatch = block.match(
      /<(?:[A-Za-z][\w.-]*:)?getcontentlength(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?getcontentlength>/,
    );
    const size = sizeMatch ? Number.parseInt(sizeMatch[1].trim(), 10) : 0;
    const mtimeMatch = block.match(
      /<(?:[A-Za-z][\w.-]*:)?getlastmodified(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?getlastmodified>/,
    );
    const parsedMtime = mtimeMatch ? Date.parse(xmlUnescape(mtimeMatch[1]).trim()) : NaN;
    const isDir = /<(?:[A-Za-z][\w.-]*:)?resourcetype[^>]*>[\s\S]*?<(?:[A-Za-z][\w.-]*:)?collection[\s/>]/.test(
      block,
    );
    stats.push({
      path: rel,
      etag: etagRaw.length > 0 ? etagRaw : null,
      size: Number.isFinite(size) ? size : 0,
      lastModified: Number.isFinite(parsedMtime) ? parsedMtime : null,
      isDir,
    });
  }
  return stats;
}

export class WebDavClient {
  private readonly origin: URL;
  private readonly basePath: string;
  private readonly username: string;
  private readonly password: string;
  private readonly allowInsecureHttp: boolean;
  private readonly acceptSelfSigned: boolean;
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly onRateLimitWait: ((waitedMs: number) => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  /** Timestamps of paced requests still inside the sliding window. */
  private readonly requestTimestamps: number[] = [];

  public constructor(options: WebDavClientOptions) {
    const rawUrl = (options.url ?? "").trim();
    if (!rawUrl) {
      throw new WebDavFatalError("WebDAV server URL is not configured");
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new WebDavFatalError("WebDAV server URL is not valid");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new WebDavFatalError("WebDAV server URL scheme is not supported");
    }
    if (parsed.protocol === "http:" && !options.allowInsecureHttp) {
      throw new WebDavFatalError(
        "Plain HTTP is not allowed for WebDAV sync by current settings",
      );
    }
    this.origin = parsed;
    this.basePath = normalizeBasePath(options.basePath);
    this.username = options.username ?? "";
    this.password = options.password ?? "";
    this.allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.acceptSelfSigned = options.acceptSelfSigned ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.maxRequests = Math.floor(options.maxRequests ?? 0);
    this.windowMs = Math.floor(options.windowMs ?? 0);
    this.onRateLimitWait = options.onRateLimitWait;
    this.signal = options.signal;
  }

  /** Fail fast when the caller already aborted before the request began. */
  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new WebDavAbortError();
    }
  }

  /**
   * PROPFIND a resource. Depth 1 on a collection returns the collection
   * itself (path "") plus its direct children.
   */
  public async propfind(path: string, depth: 0 | 1): Promise<WebDavStat[]> {
    const response = await this.requestChecked("PROPFIND", path, {
      headers: {
        Depth: String(depth),
        "Content-Type": "application/xml;charset=UTF-8",
        Accept: "application/xml,text/xml",
      },
      body: Buffer.from(PROPFIND_BODY, "utf8"),
    });
    if (response.status !== 207) {
      throw new WebDavTransientError(
        `PROPFIND failed with status ${response.status}`,
        response.status,
      );
    }
    return parseMultiStatus(
      response.body.toString("utf8"),
      this.collectionBasePath(),
    );
  }

  /** GET a file resource as raw bytes. */
  public async get(path: string): Promise<Buffer> {
    const response = await this.requestChecked("GET", path, {
      headers: { Accept: "*/*" },
    });
    if (response.status !== 200) {
      throw new WebDavTransientError(
        `GET failed with status ${response.status}`,
        response.status,
      );
    }
    return response.body;
  }

  /**
   * PUT file content, creating or overwriting the resource. Optional
   * conditions turn the write into a compare-and-swap; a failed
   * precondition surfaces as PreconditionFailedError so callers can
   * react instead of blindly overwriting.
   */
  public async put(
    path: string,
    content: Buffer,
    conditions?: WebDavPutConditions,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (conditions?.ifMatch) {
      headers["If-Match"] = conditions.ifMatch;
    }
    if (conditions?.ifNoneMatchStar) {
      headers["If-None-Match"] = "*";
    }
    const response = await this.requestChecked("PUT", path, {
      headers,
      body: content,
    });
    if (response.status === 412) {
      throw new PreconditionFailedError(
        "PUT precondition failed with status 412",
        412,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new WebDavTransientError(
        `PUT failed with status ${response.status}`,
        response.status,
      );
    }
  }

  /** MKCOL one collection. Existing collections are treated as success. */
  public async mkcol(path: string): Promise<void> {
    const response = await this.requestChecked("MKCOL", path, {
      headers: {},
    });
    if (response.status !== 201 && response.status !== 405) {
      throw new WebDavTransientError(
        `MKCOL failed with status ${response.status}`,
        response.status,
      );
    }
  }

  /**
   * Create every collection segment of the base path in order, including
   * missing intermediate segments. Segments that already exist answer
   * 405/409 and count as success; real failures propagate.
   */
  public async ensureBasePath(): Promise<void> {
    const serverPath = this.origin.pathname.replace(/\/+$/, "");
    const segments = this.basePath
      .split("/")
      .filter((segment) => segment.length > 0);
    let current = serverPath;
    for (const segment of segments) {
      current = `${current}/${encodeURIComponent(decodeSegment(segment))}`;
      const response = this.checkStatus(
        await this.sendToUrl(
          "MKCOL",
          new URL(current, this.origin),
          this.buildHeaders({}),
          undefined,
        ),
      );
      if (
        response.status !== 201 &&
        response.status !== 405 &&
        response.status !== 409
      ) {
        throw new WebDavTransientError(
          `MKCOL failed with status ${response.status}`,
          response.status,
        );
      }
    }
  }

  /** DELETE a resource. Missing resources are treated as success. */
  public async del(
    path: string,
    conditions?: WebDavDeleteConditions,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    if (conditions?.ifMatch) {
      headers["If-Match"] = conditions.ifMatch;
    }
    const response = await this.requestChecked("DELETE", path, { headers });
    if (response.status === 412) {
      throw new PreconditionFailedError(
        "DELETE precondition failed with status 412",
        412,
      );
    }
    if (
      response.status !== 200 &&
      response.status !== 202 &&
      response.status !== 204 &&
      response.status !== 404
    ) {
      throw new WebDavTransientError(
        `DELETE failed with status ${response.status}`,
        response.status,
      );
    }
  }

  private buildHeaders(extra: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.username !== "" || this.password !== "") {
      const token = Buffer.from(
        `${this.username}:${this.password}`,
        "utf8",
      ).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  private requestUrl(path: string): URL {
    // Preserve the server URL's own path (e.g. Jianguoyun's /dav/ segment);
    // joining base+rel with an absolute path would silently discard it.
    const serverPath = this.origin.pathname.replace(/\/+$/, "");
    const encodedBase = this.basePath
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(decodeSegment(segment)))
      .join("/");
    const encodedRel = encodeRelPath(path);
    const parts = [
      serverPath.replace(/^\//, ""),
      encodedBase,
      encodedRel,
    ].filter((part) => part.length > 0);
    return new URL("/" + parts.join("/"), this.origin);
  }

  /** Combined collection path: server URL path plus normalized base path. */
  private collectionBasePath(): string {
    const serverPath = this.origin.pathname.replace(/\/+$/, "");
    return serverPath + normalizeBasePath(this.basePath);
  }

  private async requestChecked(
    method: string,
    path: string,
    options: { headers: Record<string, string>; body?: Buffer },
  ): Promise<RawResponse> {
    return this.checkStatus(await this.send(method, path, options));
  }

  private checkStatus(response: RawResponse): RawResponse {
    if (response.status === 429 || response.status === 503) {
      throw new WebDavRateLimitedError(
        `WebDAV server rate limited with status ${response.status}`,
        response.status,
        parseRetryAfterMs(response.headers["retry-after"]),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new WebDavFatalError(
        `WebDAV server rejected the credentials with status ${response.status}`,
        response.status,
      );
    }
    if (response.status >= 500) {
      throw new WebDavTransientError(
        `WebDAV server error with status ${response.status}`,
        response.status,
      );
    }
    return response;
  }

  private async send(
    method: string,
    path: string,
    options: { headers: Record<string, string>; body?: Buffer },
  ): Promise<RawResponse> {
    return this.sendToUrl(
      method,
      this.requestUrl(path),
      this.buildHeaders(options.headers),
      options.body,
    );
  }

  /** 307/308 keep the method for every verb; other redirects only reads. */
  private redirectIsFollowable(method: string, status: number): boolean {
    if (status === 307 || status === 308) {
      return true;
    }
    return method === "GET" || method === "HEAD" || method === "PROPFIND";
  }

  /**
   * Send one request, following up to MAX_REDIRECTS redirects. Redirect
   * targets on another origin never receive the Authorization header;
   * 301/302/303 responses on write methods fail with a configuration
   * hint instead of silently converting the request.
   */
  private async sendToUrl(
    method: string,
    initialUrl: URL,
    initialHeaders: Record<string, string>,
    body: Buffer | undefined,
  ): Promise<RawResponse> {
    let url = initialUrl;
    let headers = initialHeaders;
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.sendOnce(method, url, headers, body);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      const location = response.headers.location;
      if (typeof location !== "string" || location.length === 0) {
        return response;
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new WebDavTransientError(
          `WebDAV request exceeded the redirect limit of ${MAX_REDIRECTS}`,
          response.status,
        );
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, url);
      } catch {
        return response;
      }
      if (!this.redirectIsFollowable(method, response.status)) {
        throw new WebDavFatalError(
          `The server redirected the request to ${nextUrl.toString()}. ` +
            "Enter that final address as the server URL in the sync settings.",
        );
      }
      if (
        nextUrl.origin !== initialUrl.origin &&
        headers.Authorization !== undefined
      ) {
        headers = { ...headers };
        delete headers.Authorization;
      }
      url = nextUrl;
    }
  }

  /**
   * Sliding-window pacing: every outgoing request, redirects included,
   * reserves a slot; when the window is full the request waits until the
   * oldest timestamp exits the window.
   */
  private async paceRequest(): Promise<void> {
    if (this.maxRequests < 1 || this.windowMs < 1) {
      return;
    }
    this.throwIfAborted();
    const startedAt = Date.now();
    let waited = false;
    for (;;) {
      const now = Date.now();
      while (
        this.requestTimestamps.length > 0 &&
        now - this.requestTimestamps[0] >= this.windowMs
      ) {
        this.requestTimestamps.shift();
      }
      if (this.requestTimestamps.length < this.maxRequests) {
        break;
      }
      const sleepMs = Math.max(
        this.windowMs - (now - this.requestTimestamps[0]) + 1,
        1,
      );
      waited = true;
      // Sleep in short slices so an abort lands quickly: the full window can
      // be minutes long and a launch cannot wait for it.
      await this.sleepInterruptibly(sleepMs);
    }
    if (waited) {
      this.onRateLimitWait?.(Date.now() - startedAt);
    }
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Wait out one pacing slice, waking early on abort. The slice length keeps
   * the abort latency bounded without busy-waiting.
   */
  private async sleepInterruptibly(totalMs: number): Promise<void> {
    const sliceMs = 250;
    let remaining = totalMs;
    while (remaining > 0) {
      this.throwIfAborted();
      const slice = Math.min(remaining, sliceMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, slice);
        timer.unref?.();
      });
      remaining -= slice;
    }
    this.throwIfAborted();
  }

  /**
   * One raw HTTP round trip: idle timeout, hard total deadline and a
   * response-size cap all abort the request with a transient error.
   * Every hop reserves a pacing slot first; without pacing the request
   * issues synchronously like a bare node:http call.
   */
  private sendOnce(
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: Buffer | undefined,
  ): Promise<RawResponse> {
    this.throwIfAborted();
    const issueRequest = (): Promise<RawResponse> => {
      const lib = url.protocol === "https:" ? https : http;
      const requestOptions: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: { ...headers },
      };
      if (url.protocol === "https:" && this.acceptSelfSigned) {
        requestOptions.agent = new https.Agent({
          rejectUnauthorized: false,
        });
      }
      return new Promise<RawResponse>((resolve, reject) => {
        let settled = false;
        const settle = (settleFn: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(totalTimer);
          this.signal?.removeEventListener("abort", onAbort);
          settleFn();
        };
        const onAbort = (): void => {
          req.destroy(new WebDavAbortError());
        };
        const totalTimer = setTimeout(() => {
          req.destroy(
            new WebDavTransientError(
              "WebDAV request exceeded the total time limit",
            ),
          );
        }, this.totalTimeoutMs);
        totalTimer.unref();
        const req = lib.request(requestOptions, (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              req.destroy(
                new WebDavTransientError(
                  `WebDAV response exceeded ${MAX_RESPONSE_BYTES} bytes`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            settle(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
          });
          res.on("error", (err: Error) => {
            settle(() => reject(new WebDavTransientError(err.message)));
          });
        });
        req.setTimeout(this.timeoutMs, () => {
          req.destroy(new WebDavTransientError("WebDAV request timed out"));
        });
        if (this.signal) {
          this.signal.addEventListener("abort", onAbort, { once: true });
          // The signal may have fired between the check above and this
          // registration; destroy now so the request cannot hang.
          if (this.signal.aborted) {
            onAbort();
          }
        }
        req.on("error", (err: Error) => {
          settle(() => {
            if (
              err instanceof WebDavAbortError ||
              err instanceof WebDavFatalError ||
              err instanceof WebDavTransientError
            ) {
              reject(err);
              return;
            }
            reject(new WebDavTransientError(err.message));
          });
        });
        if (body) {
          req.write(body);
        }
        req.end();
      });
    };
    if (this.maxRequests < 1 || this.windowMs < 1) {
      return issueRequest();
    }
    return this.paceRequest().then(issueRequest);
  }
}
