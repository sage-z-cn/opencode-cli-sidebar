import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:https", () => ({
  Agent: class {
    constructor(public readonly options: unknown) {}
  },
  request: vi.fn(),
}));

vi.mock("node:http", () => ({
  Agent: class {
    constructor(public readonly options: unknown) {}
  },
  request: vi.fn(),
}));

import * as http from "node:http";
import * as https from "node:https";
import {
  WebDavAbortError,
  WebDavClient,
  WebDavFatalError,
  WebDavRateLimitedError,
  WebDavTransientError,
  hrefToRelativePath,
  parseMultiStatus,
  MAX_RESPONSE_BYTES,
  PreconditionFailedError,
} from "./WebDavClient";

class FakeReq extends EventEmitter {
  public readonly written: Buffer[] = [];
  public timeoutHandler: (() => void) | undefined;

  public setTimeout(_ms: number, handler: () => void): this {
    this.timeoutHandler = handler;
    return this;
  }

  public destroy(error?: Error): void {
    if (error) {
      this.emit("error", error);
    } else {
      this.emit("close");
    }
  }

  public write(chunk: Buffer): void {
    this.written.push(chunk);
  }

  public end(): void {}
}

interface CapturedCall {
  options: Record<string, unknown>;
  callback: (res: unknown) => void;
  req: FakeReq;
}

const httpsCalls: CapturedCall[] = [];
const httpCalls: CapturedCall[] = [];

function installRequestMock(
  target: typeof https.request,
  calls: CapturedCall[],
): void {
  vi.mocked(target).mockImplementation(((
    options: Record<string, unknown>,
    callback: (res: unknown) => void,
  ) => {
    const req = new FakeReq();
    const call = { options, callback, req };
    calls.push(call);
    return req;
  }) as unknown as typeof target);
}

function respond(
  call: CapturedCall,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
  };
  res.statusCode = status;
  res.headers = headers;
  call.callback(res);
  res.emit("data", Buffer.isBuffer(body) ? body : Buffer.from(body));
  res.emit("end");
}

function baseOptions(): ConstructorParameters<typeof WebDavClient>[0] {
  return {
    url: "https://dav.example.com",
    username: "user",
    password: "pass",
    basePath: "/opencode-config/",
  };
}

const MULTI_STATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/opencode-config/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/opencode-config/skills/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/opencode-config/skills/a%20b.md</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/>
      <D:getetag>&quot;etag-1&quot;</D:getetag>
      <D:getcontentlength>11</D:getcontentlength>
      <D:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</D:getlastmodified>
    </D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

describe("WebDavClient", () => {
  beforeEach(() => {
    httpsCalls.length = 0;
    httpCalls.length = 0;
    installRequestMock(https.request, httpsCalls);
    installRequestMock(http.request, httpCalls);
  });

  it("parses namespace-agnostic PROPFIND multistatus payloads", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.propfind("", 1);
    respond(httpsCalls[0], 207, MULTI_STATUS, {
      "content-type": "application/xml",
    });
    const stats = await pending;

    expect(stats).toHaveLength(3);
    const base = stats.find((stat) => stat.path === "");
    const dir = stats.find((stat) => stat.path === "skills");
    const file = stats.find((stat) => stat.path === "skills/a b.md");
    expect(base?.isDir).toBe(true);
    expect(dir?.isDir).toBe(true);
    expect(file).toMatchObject({
      etag: '"etag-1"',
      size: 11,
      isDir: false,
    });
    expect(file?.lastModified).toBe(Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"));
  });

  it("sends a Basic authorization header and per-segment encoded paths", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("skills/a b.md");
    const call = httpsCalls[0];
    expect(call.options.method).toBe("GET");
    expect(call.options.path).toBe("/opencode-config/skills/a%20b.md");
    const expected = Buffer.from("user:pass", "utf8").toString("base64");
    expect((call.options.headers as Record<string, string>).Authorization).toBe(
      `Basic ${expected}`,
    );
    respond(call, 200, "hello world");
    const body = await pending;
    expect(body.toString("utf8")).toBe("hello world");
  });

  it("preserves the server URL path prefix in requests and href parsing", async () => {
    const client = new WebDavClient({
      ...baseOptions(),
      url: "https://dav.jianguoyun.com/dav/",
    });
    const pending = client.get("skills/a b.md");
    const call = httpsCalls[0];
    expect(call.options.path).toBe("/dav/opencode-config/skills/a%20b.md");
    respond(call, 200, "body");
    await pending;
    expect(
      hrefToRelativePath("/dav/opencode-config/a.md", "/dav/opencode-config/"),
    ).toBe("a.md");
  });

  it("sends a PROPFIND body and Depth header", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.propfind("skills", 1);
    const call = httpsCalls[0];
    expect((call.options.headers as Record<string, string>).Depth).toBe("1");
    expect(Buffer.concat(call.req.written).toString("utf8")).toContain(
      "propfind",
    );
    respond(call, 207, "");
    await pending;
  });

  it("classifies timeouts as transient errors", async () => {
    const client = new WebDavClient({ ...baseOptions(), timeoutMs: 50 });
    const pending = client.propfind("", 1);
    const rejection = expect(pending).rejects.toThrow(WebDavTransientError);
    httpsCalls[0].req.timeoutHandler?.();
    await rejection;
  });

  it("classifies socket errors as transient errors", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.propfind("", 1);
    const rejection = expect(pending).rejects.toThrow(WebDavTransientError);
    httpsCalls[0].req.emit("error", new Error("connection reset"));
    await rejection;
  });

  it("maps 401 to a fatal error", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.propfind("", 1);
    const rejection = expect(pending).rejects.toThrow(WebDavFatalError);
    respond(httpsCalls[0], 401, "");
    await rejection;
  });

  it("maps 5xx to a transient error", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.propfind("", 1);
    const rejection = expect(pending).rejects.toThrow(WebDavTransientError);
    respond(httpsCalls[0], 502, "");
    await rejection;
    expect(
      await pending.catch((error: WebDavTransientError) => error.status),
    ).toBe(502);
  });

  it("maps 429 to a rate-limit error with a Retry-After hint", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("a.md");
    const rejection = expect(pending).rejects.toThrow(WebDavRateLimitedError);
    respond(httpsCalls[0], 429, "", { "retry-after": "7" });
    await rejection;
    const error = await pending.catch(
      (caught: WebDavRateLimitedError) => caught,
    );
    // A rate limit is a cooldown, not a transient failure.
    expect(error).not.toBeInstanceOf(WebDavTransientError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
  });

  it("parses HTTP-date Retry-After values on 503", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.propfind("", 1);
    const rejection = expect(pending).rejects.toThrow(WebDavRateLimitedError);
    respond(httpsCalls[0], 503, "", {
      "retry-after": new Date(Date.now() + 3000).toUTCString(),
    });
    await rejection;
    const error = await pending.catch(
      (caught: WebDavRateLimitedError) => caught,
    );
    expect(error.status).toBe(503);
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(error.retryAfterMs).toBeLessThanOrEqual(4000);
  });

  it("leaves retryAfterMs unset without a usable Retry-After header", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("a.md");
    const rejection = expect(pending).rejects.toThrow(WebDavRateLimitedError);
    respond(httpsCalls[0], 503, "");
    await rejection;
    const error = await pending.catch(
      (caught: WebDavRateLimitedError) => caught,
    );
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("paces a request burst to maxRequests per window", async () => {
    const waits: number[] = [];
    const client = new WebDavClient({
      ...baseOptions(),
      maxRequests: 2,
      windowMs: 120,
      onRateLimitWait: (ms) => waits.push(ms),
    });
    const startedAt = Date.now();
    const pendings = ["a", "b", "c", "d", "e"].map((name) =>
      client.get(`${name}.md`),
    );
    await Promise.all(
      pendings.map(async (pending, index) => {
        await vi.waitFor(() => {
          if (httpsCalls.length <= index) {
            throw new Error("request not issued yet");
          }
        });
        respond(httpsCalls[index], 200, "x");
        await pending;
      }),
    );
    // Two requests fit immediately; the rest wait for window slots.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(waits).toHaveLength(3);
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(100);
  });

  it("aborts a pacing wait immediately", async () => {
    // The launch path cannot sit out a window-long pacing sleep, so an
    // abort must interrupt the wait rather than let it finish.
    const controller = new AbortController();
    const client = new WebDavClient({
      ...baseOptions(),
      maxRequests: 1,
      windowMs: 60_000,
      signal: controller.signal,
    });
    const first = client.get("a.md");
    await vi.waitFor(() => {
      if (httpsCalls.length < 1) {
        throw new Error("request not issued yet");
      }
    });
    respond(httpsCalls[0], 200, "x");
    await first;

    const pending = client.get("b.md");
    const rejection = expect(pending).rejects.toThrow(WebDavAbortError);
    controller.abort();
    await rejection;
    // The aborted request never reached the network.
    expect(httpsCalls).toHaveLength(1);
  });

  it("fails fast when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new WebDavClient({
      ...baseOptions(),
      signal: controller.signal,
    });
    await expect(client.get("a.md")).rejects.toThrow(WebDavAbortError);
    expect(httpsCalls).toHaveLength(0);
  });

  it("aborts an in-flight request", async () => {
    const controller = new AbortController();
    const client = new WebDavClient({
      ...baseOptions(),
      signal: controller.signal,
    });
    const pending = client.get("a.md");
    const rejection = expect(pending).rejects.toThrow(WebDavAbortError);
    controller.abort();
    await rejection;
  });

  it("issues bursts without delay when pacing is off", async () => {
    const unset = new WebDavClient(baseOptions());
    const unsetPendings = ["a", "b", "c"].map((name) =>
      unset.get(`${name}.md`),
    );
    const disabled = new WebDavClient({
      ...baseOptions(),
      maxRequests: 0,
      windowMs: 60_000,
    });
    const disabledPendings = ["d", "e"].map((name) =>
      disabled.get(`${name}.md`),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(httpsCalls).toHaveLength(5);
    httpsCalls.forEach((call) => respond(call, 200, "x"));
    await Promise.all([...unsetPendings, ...disabledPendings]);
  });

  it("uses a rejectUnauthorized:false agent only for self-signed opt-in", async () => {
    const plain = new WebDavClient(baseOptions());
    const plainPending = plain.propfind("", 1);
    respond(httpsCalls[0], 207, "");
    await plainPending;
    expect(httpsCalls[0].options.agent).toBeUndefined();

    const trusting = new WebDavClient({ ...baseOptions(), acceptSelfSigned: true });
    const trustingPending = trusting.propfind("", 1);
    respond(httpsCalls[1], 207, "");
    await trustingPending;
    const agent = httpsCalls[1].options.agent as unknown as {
      options: { rejectUnauthorized: boolean };
    };
    expect(agent.options.rejectUnauthorized).toBe(false);
  });

  it("rejects plain HTTP unless explicitly allowed", () => {
    expect(() => new WebDavClient({ ...baseOptions(), url: "http://dav.example.com" })).toThrow(
      WebDavFatalError,
    );
    const allowed = new WebDavClient({
      ...baseOptions(),
      url: "http://dav.example.com",
      allowInsecureHttp: true,
    });
    const pending = allowed.propfind("", 1);
    respond(httpCalls[0], 207, "");
    return pending.then(() => {
      expect(httpCalls).toHaveLength(1);
      expect(httpsCalls).toHaveLength(0);
    });
  });

  it("rejects missing and invalid URLs as fatal", () => {
    expect(() => new WebDavClient({ ...baseOptions(), url: "" })).toThrow(
      WebDavFatalError,
    );
    expect(() => new WebDavClient({ ...baseOptions(), url: "not a url" })).toThrow(
      WebDavFatalError,
    );
  });

  it("treats MKCOL 405 and DELETE 404 as success", async () => {
    const client = new WebDavClient(baseOptions());

    const mkcolPending = client.mkcol("skills");
    respond(httpsCalls[0], 405, "");
    await mkcolPending;

    const delPending = client.del("skills/gone.md");
    respond(httpsCalls[1], 404, "");
    await delPending;
  });

  it("converts absolute and encoded hrefs to base-relative paths", () => {
    expect(hrefToRelativePath("/opencode-config/a/b.md", "/opencode-config/")).toBe(
      "a/b.md",
    );
    expect(
      hrefToRelativePath(
        "https://dav.example.com/opencode-config/dir%20name/",
        "/opencode-config/",
      ),
    ).toBe("dir name");
    expect(hrefToRelativePath("/elsewhere/x.md", "/opencode-config/")).toBeNull();
  });

  it("rejects hrefs that traverse outside the base path after decoding", () => {
    expect(
      hrefToRelativePath("/opencode-config/../secret.txt", "/opencode-config/"),
    ).toBeNull();
    expect(
      hrefToRelativePath("/opencode-config/%2e%2e/secret.txt", "/opencode-config/"),
    ).toBeNull();
    expect(hrefToRelativePath("/opencode-config/./a.md", "/opencode-config/")).toBeNull();
    expect(
      hrefToRelativePath("/opencode-config/a%2F..%2Fb.md", "/opencode-config/"),
    ).toBeNull();
    expect(
      hrefToRelativePath("/opencode-config/skills/a%20b.md", "/opencode-config/"),
    ).toBe("skills/a b.md");
  });

  it("matches base paths with spaces and non-ASCII segments", () => {
    const base = "/dav/配置 目录/";
    const encodedBase = "/dav/%E9%85%8D%E7%BD%AE%20%E7%9B%AE%E5%BD%95";
    expect(
      hrefToRelativePath(`${encodedBase}/skills/a%20b.md`, base),
    ).toBe("skills/a b.md");
    // Some servers echo hrefs unencoded.
    expect(
      hrefToRelativePath("/dav/配置 目录/skills/a b.md", base),
    ).toBe("skills/a b.md");
    expect(hrefToRelativePath(encodedBase, base)).toBe("");
    expect(hrefToRelativePath(`${encodedBase}/`, base)).toBe("");
    expect(hrefToRelativePath("/dav/other/x.md", base)).toBeNull();
  });

  it("sends conditional PUT headers and reports 412 distinctly", async () => {
    const client = new WebDavClient(baseOptions());

    const pendingMatch = client.put("a.md", Buffer.from("x", "utf8"), {
      ifMatch: '"v1"',
    });
    const matchCall = httpsCalls[0];
    expect((matchCall.options.headers as Record<string, string>)["If-Match"]).toBe(
      '"v1"',
    );
    respond(matchCall, 204, "");
    await pendingMatch;

    const pendingCreate = client.put("b.md", Buffer.from("y", "utf8"), {
      ifNoneMatchStar: true,
    });
    expect(
      (httpsCalls[1].options.headers as Record<string, string>)["If-None-Match"],
    ).toBe("*");
    respond(httpsCalls[1], 201, "");
    await pendingCreate;

    const pendingStale = client.put("a.md", Buffer.from("z", "utf8"), {
      ifMatch: '"v0"',
    });
    const rejection = expect(pendingStale).rejects.toThrow(
      PreconditionFailedError,
    );
    respond(httpsCalls[2], 412, "");
    await rejection;
    const error = await pendingStale.catch(
      (caught: WebDavTransientError) => caught,
    );
    expect(error).toBeInstanceOf(WebDavTransientError);
    expect(error.status).toBe(412);
  });

  it("sends conditional DELETE headers and reports 412 distinctly", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.del("skills/a.md", { ifMatch: '"v9"' });
    const call = httpsCalls[0];
    expect(call.options.method).toBe("DELETE");
    expect((call.options.headers as Record<string, string>)["If-Match"]).toBe(
      '"v9"',
    );
    respond(call, 412, "");
    const error = await pending.catch(
      (caught: WebDavTransientError) => caught,
    );
    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect(error.status).toBe(412);
  });

  it("aborts the request when the total deadline expires", async () => {
    const client = new WebDavClient({ ...baseOptions(), totalTimeoutMs: 30 });
    const pending = client.propfind("", 1);
    const rejection = expect(pending).rejects.toThrow(WebDavTransientError);
    // No response ever arrives; only the total deadline can end this.
    await rejection;
    const error = await pending.catch(
      (caught: WebDavTransientError) => caught,
    );
    expect(error.message).toContain("total");
  });

  it("rejects response bodies above the size cap", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("big.bin");
    const rejection = expect(pending).rejects.toThrow(WebDavTransientError);
    respond(httpsCalls[0], 200, Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    await rejection;
    const error = await pending.catch(
      (caught: WebDavTransientError) => caught,
    );
    expect(error.message).toContain("exceeded");
  });

  it("follows GET redirects and drops the Authorization header cross-origin", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("a.md");
    const first = httpsCalls[0];
    expect(
      (first.options.headers as Record<string, string>).Authorization,
    ).toBeTruthy();
    respond(first, 302, "", {
      location: "https://other.example.com/opencode-config/a.md",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = httpsCalls[1];
    expect(second.options.hostname).toBe("other.example.com");
    expect(
      (second.options.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    respond(second, 200, "body");
    expect((await pending).toString("utf8")).toBe("body");
  });

  it("keeps the Authorization header on same-origin redirects", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("a.md");
    respond(httpsCalls[0], 307, "", { location: "/moved/a.md" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      (httpsCalls[1].options.headers as Record<string, string>).Authorization,
    ).toBeTruthy();
    respond(httpsCalls[1], 200, "x");
    await pending;
  });

  it("fails write-method 301 redirects with a configuration hint", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.put("a.md", Buffer.from("x", "utf8"));
    const rejection = expect(pending).rejects.toThrow(WebDavFatalError);
    respond(httpsCalls[0], 301, "", {
      location: "https://final.example.com/dav/a.md",
    });
    await rejection;
    const message = await pending.catch(
      (caught: WebDavFatalError) => caught.message,
    );
    expect(message).toContain("final.example.com");
    expect(message).toContain("server URL");
  });

  it("follows 308 redirects for PUT with method and body preserved", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.put("a.md", Buffer.from("payload", "utf8"));
    respond(httpsCalls[0], 308, "", {
      location: "https://dav.example.com/final/a.md",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = httpsCalls[1];
    expect(second.options.method).toBe("PUT");
    expect(Buffer.concat(second.req.written).toString("utf8")).toBe("payload");
    respond(second, 204, "");
    await pending;
  });

  it("stops after three redirects", async () => {
    const client = new WebDavClient(baseOptions());
    const pending = client.get("a.md");
    const rejection = expect(pending).rejects.toThrow(WebDavTransientError);
    for (let hop = 0; hop <= 3; hop += 1) {
      respond(httpsCalls[hop], 302, "", { location: `/hop${hop + 1}` });
      await new Promise((resolve) => setImmediate(resolve));
    }
    await rejection;
  });

  it("creates every base path segment in order", async () => {
    const client = new WebDavClient({
      ...baseOptions(),
      basePath: "/deep/nested/dir/",
    });
    const pending = client.ensureBasePath();
    respond(httpsCalls[0], 201, "");
    await new Promise((resolve) => setImmediate(resolve));
    respond(httpsCalls[1], 405, "");
    await new Promise((resolve) => setImmediate(resolve));
    respond(httpsCalls[2], 409, "");
    await pending;
    expect(httpsCalls.map((call) => call.options.path)).toEqual([
      "/deep",
      "/deep/nested",
      "/deep/nested/dir",
    ]);
    expect(
      httpsCalls.every((call) => call.options.method === "MKCOL"),
    ).toBe(true);
  });

  it("parses multistatus XML without any namespace prefix", () => {
    const stats = parseMultiStatus(
      `<multistatus xmlns="DAV:"><response><href>/opencode-config/opencode.json</href>` +
        `<propstat><prop><getetag>W/"9"</getetag><getcontentlength>2</getcontentlength>` +
        `<resourcetype/></prop></propstat></propstat></response></multistatus>`,
      "/opencode-config/",
    );
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      path: "opencode.json",
      etag: 'W/"9"',
      size: 2,
      isDir: false,
    });
  });
});
