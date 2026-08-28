/**
 * Every credential-bearing HTTP surface is bounded at TRANSFER TIME, in bytes and in
 * wall clock.
 *
 * Choosing `timeout` and `maxRedirects: 0` while omitting the size pair leaves both
 * instances on axios's `maxContentLength: -1`, its sentinel for unlimited. The ordering
 * is what makes that a security defect rather than untuned config: the Node adapter
 * buffers every chunk, concatenates, decodes and JSON-parses ALL OF IT before any
 * response interceptor runs. So both guards this codebase already had run too late by
 * construction — `assertReadableResponse` inspects the PARSED body, and the
 * 200-character text slice slices a body already resident in memory. There is no point
 * at which the server can say "too big".
 *
 * Measured against a real origin: `FATAL ERROR: Reached heap limit`, `SIGABRT`, exit
 * code `null`, and no JS `catch` anywhere. Not an exception — an abort() inside V8,
 * which takes the whole in-memory safety layer with it: every outstanding confirmation
 * token, its bound args, its stored dry-run, and every rate bucket.
 *
 * `maxContentLength` is the only layer that can close it, being checked against streamed
 * bytes as they arrive. The wall clock is not decoration: `req.setTimeout` is a socket
 * INACTIVITY timeout, so a byte cap alone leaves a drip-feed unbounded in TIME and a
 * wall clock alone leaves a fast 400 MB body unbounded in SPACE.
 *
 * Offline: a real `node:http` loopback listener, no credentials, no network.
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { TastytradeClient } from "../../src/api-client.js";
import * as oauth from "../../src/oauth-client.js";
import { DEFAULT_HTTP_TIMEOUT_MS } from "../../src/oauth-client.js";
import { adaptError } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import type { HttpAdapter } from "../../src/api-client.js";
import type { InternalAxiosRequestConfig } from "axios";

const ACCOUNT = "5WX00001";
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SRC = (file: string) =>
  readFileSync(path.join(REPO_ROOT, "src", file), "utf8");

/**
 * The two resolvers, read off the module namespace rather than imported by
 * name, so this file compiles against the revision that does not export them
 * and the failure is a measured one instead of a type error.
 */
const ns = oauth as unknown as Record<string, unknown>;
const resolveMaxResponseBytes = ns["resolveMaxResponseBytes"] as
  | (() => number)
  | undefined;
const resolveHttpWallClockMs = ns["resolveHttpWallClockMs"] as
  | (() => number)
  | undefined;
const httpTransportLimits = ns["httpTransportLimits"] as
  | (() => { maxContentLength: number; maxBodyLength: number })
  | undefined;
const DEFAULT_MAX_RESPONSE_BYTES = ns["DEFAULT_MAX_RESPONSE_BYTES"] as
  | number
  | undefined;
const MAX_RESPONSE_BYTES_ENV_VAR =
  (ns["MAX_RESPONSE_BYTES_ENV_VAR"] as string | undefined) ??
  "TASTYTRADE_MAX_RESPONSE_BYTES";
const HTTP_WALL_CLOCK_ENV_VAR =
  (ns["HTTP_WALL_CLOCK_ENV_VAR"] as string | undefined) ??
  "TASTYTRADE_HTTP_WALL_CLOCK_MS";

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const restores: Array<() => void> = [];
const servers: http.Server[] = [];

function withEnv(key: string, value: string | undefined): void {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  restores.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

afterEach(async () => {
  while (restores.length > 0) restores.pop()!();
  jest.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => {
      // A request this suite deliberately leaves hanging would otherwise keep
      // `close()` waiting on its socket forever.
      s.closeAllConnections();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    }),
  );
});

/** A loopback origin, and the base URL to point a client at. */
async function origin(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** An origin that answers every request with `bytes` of chunked JSON. */
function floods(bytes: number) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    });
    res.write('{"data":{"items":["');
    const chunk = "A".repeat(64 * 1024);
    let written = 0;
    while (written < bytes) {
      res.write(chunk);
      written += chunk.length;
    }
    res.end('"]}}');
  };
}

/** An origin that sends one byte at a time, forever, and never finishes. */
function drips(): (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void {
  return (_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    });
    res.write("{");
    const timer = setInterval(() => res.write(" "), 20);
    timer.unref();
    res.on("close", () => clearInterval(timer));
  };
}

function realClient(apiUrl: string): TastytradeClient {
  return new TastytradeClient(
    { apiUrl },
    { tokenProvider: () => "test-access-token" },
  );
}

/** The envelope an agent would receive for a rejected client call. */
async function envelopeOf(call: Promise<unknown>): Promise<ToolError> {
  try {
    await call;
  } catch (error) {
    return adaptError(error);
  }
  throw new Error("expected the call to reject");
}

/** The outbound config an injected adapter observes, defaults merged in. */
async function observedConfig(): Promise<InternalAxiosRequestConfig> {
  let seen: InternalAxiosRequestConfig | undefined;
  const adapter: HttpAdapter = (config) => {
    seen = config;
    return Promise.resolve({
      data: { data: {} },
      status: 200,
      statusText: "200",
      headers: {},
      config,
    } as never);
  };
  const client = new TastytradeClient(
    { apiUrl: "https://api.cert.tastyworks.com" },
    { adapter, tokenProvider: () => "t" },
  );
  await client.getBalances(ACCOUNT);
  if (!seen) throw new Error("no request observed");
  return seen;
}

// ===========================================================================
// 1. The resolvers
// ===========================================================================

describe("resolveMaxResponseBytes", () => {
  it("exists, beside the timeout resolver both HTTP callers already share", () => {
    expect(typeof resolveMaxResponseBytes).toBe("function");
    expect(typeof DEFAULT_MAX_RESPONSE_BYTES).toBe("number");
  });

  it("returns the documented default when unset", () => {
    if (!resolveMaxResponseBytes) throw new Error("not exported");
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, undefined);
    expect(resolveMaxResponseBytes()).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it("accepts a plain positive integer", () => {
    if (!resolveMaxResponseBytes) throw new Error("not exported");
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, "1048576");
    expect(resolveMaxResponseBytes()).toBe(1_048_576);
  });

  it.each(["0", "-1", "Infinity", "abc", "", "-5", "1e400"])(
    "falls back WITH a warning for %p, so the bound cannot be switched off",
    (raw) => {
      if (!resolveMaxResponseBytes) throw new Error("not exported");
      const warn = jest.spyOn(console, "error").mockImplementation(() => {});
      withEnv(MAX_RESPONSE_BYTES_ENV_VAR, raw);
      expect(resolveMaxResponseBytes()).toBe(DEFAULT_MAX_RESPONSE_BYTES);
      expect(warn).toHaveBeenCalled();
      // `-1` is axios's own sentinel for unlimited, so it has to be refused
      // explicitly rather than passed through.
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /has NOT been disabled|falling back/i,
      );
    },
  );
});

describe("resolveHttpWallClockMs", () => {
  it("exists", () => {
    expect(typeof resolveHttpWallClockMs).toBe("function");
  });

  it("defaults to a multiple of the socket timeout", () => {
    if (!resolveHttpWallClockMs) throw new Error("not exported");
    withEnv(HTTP_WALL_CLOCK_ENV_VAR, undefined);
    const value = resolveHttpWallClockMs();
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(DEFAULT_HTTP_TIMEOUT_MS);
  });

  it("refuses a value that is not strictly greater than the socket timeout", () => {
    if (!resolveHttpWallClockMs) throw new Error("not exported");
    const warn = jest.spyOn(console, "error").mockImplementation(() => {});
    withEnv(HTTP_WALL_CLOCK_ENV_VAR, String(DEFAULT_HTTP_TIMEOUT_MS));
    // A wall clock at or under the per-socket timeout would fire first and
    // convert every slow-but-legitimate request into a cancellation.
    expect(resolveHttpWallClockMs()).toBeGreaterThan(DEFAULT_HTTP_TIMEOUT_MS);
    expect(warn).toHaveBeenCalled();
  });

  it("accepts a larger value", () => {
    if (!resolveHttpWallClockMs) throw new Error("not exported");
    withEnv(HTTP_WALL_CLOCK_ENV_VAR, String(DEFAULT_HTTP_TIMEOUT_MS * 10));
    expect(resolveHttpWallClockMs()).toBe(DEFAULT_HTTP_TIMEOUT_MS * 10);
  });
});

// ===========================================================================
// 2. The bound is on the instance, and on every request
// ===========================================================================

describe("the constructed client carries both bounds", () => {
  it("sets a finite positive byte cap on every outbound request", async () => {
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, undefined);
    const config = await observedConfig();
    // Today both are -1, axios's sentinel for unlimited.
    expect(Number.isFinite(config.maxContentLength)).toBe(true);
    expect(config.maxContentLength).toBeGreaterThan(0);
    expect(Number.isFinite(config.maxBodyLength)).toBe(true);
    expect(config.maxBodyLength).toBeGreaterThan(0);
    expect(config.maxContentLength).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it("honours the environment override", async () => {
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, "4096");
    const config = await observedConfig();
    expect(config.maxContentLength).toBe(4096);
  });

  it("attaches a wall-clock abort signal PER REQUEST", async () => {
    const first = await observedConfig();
    const second = await observedConfig();
    expect(first.signal).toBeDefined();
    expect(second.signal).toBeDefined();
    // A signal is single-use: one on the instance would abort every request
    // after the first 90 seconds of process life.
    expect(first.signal).not.toBe(second.signal);
    expect(first.signal?.aborted).toBe(false);
  });
});

// ===========================================================================
// 3. Enforcement, against a real origin
// ===========================================================================

describe("an oversized response is refused instead of aborting the process", () => {
  it("rejects a read with a structured network error, and the process survives", async () => {
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, "65536");
    const url = await origin(floods(2 * 1024 * 1024));
    const err = await envelopeOf(realClient(url).getBalances(ACCOUNT));

    expect(err.code).toBe("network");
    // A read can safely be repeated, and the message has to name the cap and
    // the knob — a local limit must not be reported as the broker's fault.
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/65536|response size|too large/i);
    expect(`${err.message} ${err.hint ?? ""}`).toContain(
      MAX_RESPONSE_BYTES_ENV_VAR,
    );
  }, 30_000);

  it("keeps the unknown-outcome envelope on a WRITE that overflowed", async () => {
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, "65536");
    const url = await origin(floods(2 * 1024 * 1024));
    const err = await envelopeOf(realClient(url).deleteWatchlist("wl"));

    // The overflow happened while reading the RESPONSE, so the DELETE may well
    // have been applied. ERR_BAD_RESPONSE must not join
    // NEVER_DISPATCHED_ERROR_CODES.
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/outcome is UNKNOWN/i);
  }, 30_000);

  it("rejects an upstream that drips a byte at a time forever", async () => {
    // The hole the constructor's own comment named and declined to guess at: a
    // socket inactivity timeout never fires on this origin.
    withEnv(MAX_RESPONSE_BYTES_ENV_VAR, undefined);
    withEnv(HTTP_WALL_CLOCK_ENV_VAR, "1500");
    withEnv("TASTYTRADE_HTTP_TIMEOUT_MS", "1000");
    const url = await origin(drips());

    // Raced rather than awaited: without a wall clock this request never
    // settles at all, and a test that HANGS proves the same thing far less
    // usefully than one that says "still running after five seconds".
    const outcome = await Promise.race([
      envelopeOf(realClient(url).getBalances(ACCOUNT)).then(
        (e) => ({ kind: "rejected" as const, err: e }),
        (e) => ({ kind: "resolved-or-threw" as const, err: e as ToolError }),
      ),
      new Promise<{ kind: "still-running" }>((resolve) => {
        const t = setTimeout(() => resolve({ kind: "still-running" }), 5_000);
        t.unref();
      }),
    ]);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.err.code).toBe("network");
    }
  }, 30_000);
});

// ===========================================================================
// 4. The rule holds for every surface, not just the ones fixed today
// ===========================================================================

describe("no credential-bearing axios surface is unbounded", () => {
  /**
   * The whole `axios.…( … )` call expression starting at `at`.
   *
   * Brace/paren matched rather than windowed by character count, because a
   * fixed window is how a scan starts passing for the wrong reason: too narrow
   * and it misses a spread placed after a long comment, too wide and it borrows
   * the next surface's. Strings, template literals and both comment forms are
   * skipped so prose parentheses cannot close the expression early.
   */
  function callExpression(source: string, at: number): string {
    let i = source.indexOf("(", at);
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        i++;
        for (; i < source.length; i++) {
          if (source[i] === "\\") i++;
          else if (source[i] === quote) break;
        }
        continue;
      }
      if (c === "/" && source[i + 1] === "/") {
        i = source.indexOf("\n", i);
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        i = source.indexOf("*/", i) + 1;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return source.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced axios call at ${at}`);
  }

  /** Every axios entry point in src/, with the file it is in. */
  const surfaces = (() => {
    const found: Array<{ file: string; at: number; text: string }> = [];
    for (const file of ["api-client.ts", "oauth-client.ts", "doctor.ts"]) {
      const source = SRC(file);
      for (const m of source.matchAll(
        /axios\.(create|request|get|post|put|patch|delete)\(/g,
      )) {
        found.push({
          file,
          at: m.index,
          text: callExpression(source, m.index),
        });
      }
    }
    return found;
  })();

  it("finds the surfaces at all", () => {
    // Derived, not asserted as a literal: a fourth surface has to satisfy the
    // rule below rather than move a number.
    expect(surfaces.length).toBeGreaterThanOrEqual(3);
    expect(new Set(surfaces.map((s) => s.file)).size).toBe(3);
  });

  it.each(surfaces.map((s, i) => [`${s.file}#${i}`, s] as const))(
    "%s spreads the shared transport limits",
    (_label, surface) => {
      expect(surface.text).toContain("httpTransportLimits()");
      // Non-vacuity: the matcher really did capture this call and not an empty
      // slice or the whole file.
      expect(surface.text.startsWith("axios.")).toBe(true);
      expect(surface.text.length).toBeLessThan(6_000);
    },
  );

  it("gives every file with an axios surface a wall-clock signal", () => {
    for (const file of new Set(surfaces.map((s) => s.file))) {
      expect(SRC(file)).toMatch(/httpWallClockSignal\(/);
    }
  });

  it("resolves both values once per process, beside the timeout", () => {
    // The reason the resolvers live in oauth-client.ts is written in
    // `resolveHttpTimeoutMs`'s own doc comment: api-client.ts already imports
    // this module, and the reverse direction would be a circular import.
    const source = SRC("oauth-client.ts");
    expect(source).toContain("export function resolveMaxResponseBytes(");
    expect(source).toContain("export function resolveHttpWallClockMs(");
    expect(source).toContain("export function httpTransportLimits(");
    expect(typeof httpTransportLimits).toBe("function");
  });
});

// ===========================================================================
// 5. The failure is named as OURS, on both surfaces
// ===========================================================================

describe("a local bound is reported as a local bound", () => {
  /** axios's rejection when it refuses to finish reading a reply. */
  const oversized = () =>
    Object.assign(new Error("maxContentLength size of 4096 exceeded"), {
      isAxiosError: true,
      code: "ERR_BAD_RESPONSE",
    });

  /** axios's rejection when a request's `signal` fires. */
  const aborted = () =>
    Object.assign(new Error("canceled"), {
      isAxiosError: true,
      code: "ERR_CANCELED",
    });

  const transportBoundRefusal = ns["transportBoundRefusal"] as
    | ((error: unknown) => "size" | "wall-clock" | undefined)
    | undefined;

  it("tells the two bounds apart from the broker's own 5xx", () => {
    if (!transportBoundRefusal) throw new Error("not exported");
    expect(transportBoundRefusal(oversized())).toBe("size");
    expect(transportBoundRefusal(aborted())).toBe("wall-clock");
    // ERR_BAD_RESPONSE is ALSO axios's code for a 5xx, and a 5xx is the
    // broker's failure. The presence of a reply is what separates them.
    expect(
      transportBoundRefusal(
        Object.assign(new Error("Request failed with status code 503"), {
          code: "ERR_BAD_RESPONSE",
          response: { status: 503 },
        }),
      ),
    ).toBeUndefined();
    expect(
      transportBoundRefusal(
        Object.assign(new Error("something else"), {
          code: "ERR_BAD_RESPONSE",
        }),
      ),
    ).toBeUndefined();
    expect(transportBoundRefusal(undefined)).toBeUndefined();
    expect(transportBoundRefusal("ECONNRESET")).toBeUndefined();
    expect(transportBoundRefusal({})).toBeUndefined();
  });

  /** Drive the token grant through the one seam that reaches `axios.post`. */
  async function grantEnvelope(thrown: unknown): Promise<ToolError> {
    jest
      .spyOn(axios, "post")
      .mockImplementation(() => Promise.reject(thrown) as never);
    const client = new oauth.TastytradeOAuthClient({
      apiUrl: "https://api.cert.tastyworks.com",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    });
    return envelopeOf(client.getAccessToken());
  }

  it("names the size bound on the credential-bearing grant", async () => {
    const err = await grantEnvelope(oversized());
    expect(err.code).toBe("network");
    // A grant moves nothing, so it is safe to repeat.
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/response-size limit/i);
    expect(err.hint).toContain(MAX_RESPONSE_BYTES_ENV_VAR);
    // And it must not read as the endpoint's fault.
    expect(err.hint).toMatch(/LOCAL bound/);
    // No credential in the envelope, ever.
    expect(JSON.stringify(err)).not.toContain("test-refresh-token");
    expect(JSON.stringify(err)).not.toContain("test-client-secret");
  });

  it("names the wall clock on the credential-bearing grant", async () => {
    const err = await grantEnvelope(aborted());
    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/wall-clock limit/i);
    expect(err.hint).toContain(HTTP_WALL_CLOCK_ENV_VAR);
  });
});
