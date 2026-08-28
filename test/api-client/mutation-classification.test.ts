/**
 * The mutating-request classifier reads the ROUTE the call site chose, never the URL
 * string the caller helped build.
 *
 * `isMutatingRequest` decides two things an agent acts on: whether `retryable` may be
 * true for a failed write, and whether a 2xx whose body cannot be read is described as
 * "No state was changed." or as an unknown outcome. Deriving that from
 * `config.url.endsWith("/dry-run")` makes the answer a function of caller text —
 * `dry-run` is entirely RFC 3986 unreserved characters, so it survives
 * `encodeURIComponent` byte-identical, and any route whose last segment is
 * caller-supplied can be RENAMED into the non-mutating set:
 * `cancel_order{order_id: "dry-run"}` dialled `DELETE /accounts/A/orders/dry-run` and a
 * 503 on it came back `retryable: true` with the unknown-outcome envelope gone.
 *
 * The classification reads a tag the call site attaches, so the only authority is this
 * module's own source. Untagged stays MUTATING, which keeps the asymmetry the module is
 * built on: forgetting a tag over-warns about a dry-run, never under-warns about a
 * cancel.
 *
 * Everything here is offline — a stub token provider and a fake adapter.
 */

import { describe, it, expect } from "@jest/globals";
import { AxiosError, AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TastytradeClient,
  isMutatingRequest,
  isUnestablishedWrite,
} from "../../src/api-client.js";
import type { HttpAdapter } from "../../src/api-client.js";
import { adaptError } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCOUNT = "5WX00001";
const API_URL = "https://api.cert.tastyworks.com";
const UNKNOWN = /outcome is UNKNOWN/i;

const CLIENT_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/api-client.ts",
  ),
  "utf8",
);

/**
 * A request config for the classifier, built without an excess-property check.
 *
 * The whole point of these cases is to hand the classifier shapes a caller can
 * produce — including the `url` it must now ignore — so the literal is widened
 * deliberately rather than typed against whatever the signature happens to
 * accept today.
 */
const cfg = (o: Record<string, unknown>) =>
  o as Parameters<typeof isMutatingRequest>[0];

// ============================================================================
// Fake transport — see ./README.md for why it is copied.
// ============================================================================

interface RecordedRequest {
  method: string;
  url: string;
  config: InternalAxiosRequestConfig;
}

interface FakeHttp {
  adapter: HttpAdapter;
  requests: RecordedRequest[];
  reply(data: unknown, init?: { status?: number }): void;
  replyError(status: number, data?: unknown): void;
  last(): RecordedRequest;
}

function createFakeHttp(): FakeHttp {
  const requests: RecordedRequest[] = [];
  const queue: { status: number; data: unknown; raw?: boolean }[] = [];

  const adapter: HttpAdapter = (config: InternalAxiosRequestConfig) => {
    const request: RecordedRequest = {
      method: (config.method ?? "get").toUpperCase(),
      url: config.url ?? "",
      config,
    };
    requests.push(request);

    const stub = queue.shift();
    if (!stub) {
      return Promise.reject(
        new Error(
          `createFakeHttp: no queued response for ${request.method} ${request.url}`,
        ),
      );
    }

    const response: AxiosResponse = {
      data: stub.data,
      status: stub.status,
      statusText: String(stub.status),
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      request,
    };

    const validateStatus = config.validateStatus;
    if (!validateStatus || validateStatus(response.status)) {
      return Promise.resolve(response);
    }
    return Promise.reject(
      new AxiosError(
        `Request failed with status code ${response.status}`,
        response.status >= 400 && response.status < 500
          ? AxiosError.ERR_BAD_REQUEST
          : AxiosError.ERR_BAD_RESPONSE,
        config,
        request,
        response,
      ),
    );
  };

  return {
    adapter,
    requests,
    reply(data, init) {
      queue.push({ status: init?.status ?? 200, data });
    },
    replyError(status, data) {
      queue.push({ status, data: data ?? { error: { code: "stub" } } });
    },
    last() {
      const request = requests[requests.length - 1];
      if (!request) throw new Error("createFakeHttp: no request was recorded");
      return request;
    },
  };
}

function createTestClient() {
  const http = createFakeHttp();
  const client = new TastytradeClient(
    { apiUrl: API_URL },
    { adapter: http.adapter, tokenProvider: () => "test-access-token" },
  );
  return { client, http };
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

/** The route tag as the two consumers observe it on a config. */
const tagOf = (config: unknown): unknown =>
  (config as Record<string, unknown> | undefined)?.["tastytradeRoute"];

const LEG = {
  symbol: "AAPL",
  "instrument-type": "Equity",
  action: "Buy to Open",
  quantity: 1,
};

// ============================================================================
// 1. The predicate itself
// ============================================================================

describe("isMutatingRequest", () => {
  it("treats a GET as safe and every other verb as state-changing", () => {
    expect(isMutatingRequest(cfg({ method: "get", url: "/x" }))).toBe(false);
    expect(isMutatingRequest(cfg({ method: "post", url: "/x" }))).toBe(true);
    expect(isMutatingRequest(cfg({ method: "put", url: "/x" }))).toBe(true);
    expect(isMutatingRequest(cfg({ method: "patch", url: "/x" }))).toBe(true);
    expect(isMutatingRequest(cfg({ method: "delete", url: "/x" }))).toBe(true);
  });

  it("ignores a caller-chosen final segment that names a pre-flight route", () => {
    // The finding: every one of these was answered "not mutating" because the
    // URL ended in a string the caller wrote.
    expect(
      isMutatingRequest(
        cfg({ method: "DELETE", url: `/accounts/${ACCOUNT}/orders/dry-run` }),
      ),
    ).toBe(true);
    expect(
      isMutatingRequest(cfg({ method: "DELETE", url: "/watchlists/dry-run" })),
    ).toBe(true);
    expect(
      isMutatingRequest(
        cfg({ method: "PUT", url: "/watchlists/simulate-trade" }),
      ),
    ).toBe(true);
    expect(
      isMutatingRequest(
        cfg({ method: "PATCH", url: `/accounts/${ACCOUNT}/orders/dry-run` }),
      ),
    ).toBe(true);
    // Even the genuine pre-flight PATH is mutating when it arrives untagged:
    // the string is not the authority any more, the tag is.
    expect(
      isMutatingRequest(
        cfg({ method: "POST", url: `/accounts/${ACCOUNT}/orders/dry-run` }),
      ),
    ).toBe(true);
  });

  it("reads the tag the call site attached, and nothing else", () => {
    expect(
      isMutatingRequest(
        cfg({
          method: "POST",
          url: `/accounts/${ACCOUNT}/orders/dry-run`,
          tastytradeRoute: { mutating: false },
        }),
      ),
    ).toBe(false);
    // A tag that says mutating, on a URL that says otherwise.
    expect(
      isMutatingRequest(
        cfg({
          method: "POST",
          url: `/accounts/${ACCOUNT}/orders/dry-run`,
          tastytradeRoute: { mutating: true },
        }),
      ),
    ).toBe(true);
    // No URL at all is no obstacle — the tag carries the whole answer.
    expect(
      isMutatingRequest(
        cfg({ method: "POST", tastytradeRoute: { mutating: false } }),
      ),
    ).toBe(false);
  });

  it("fails closed when the request cannot be identified", () => {
    expect(isMutatingRequest(undefined)).toBe(true);
    expect(isMutatingRequest(cfg({}))).toBe(true);
    expect(isMutatingRequest(cfg({ method: "post" }))).toBe(true);
    // A malformed tag is not a licence: only `mutating === false` exempts.
    expect(
      isMutatingRequest(cfg({ method: "post", tastytradeRoute: {} })),
    ).toBe(true);
  });
});

// ============================================================================
// 2. The two consumers, through the real client
// ============================================================================

describe("what the agent is told about a renamed segment", () => {
  it("keeps the unknown-outcome envelope on a 503 DELETE named dry-run", async () => {
    const { client, http } = createTestClient();
    http.replyError(503);
    const err = await envelopeOf(client.cancelOrder(ACCOUNT, "dry-run"));

    expect(http.last().url).toBe(`/accounts/${ACCOUNT}/orders/dry-run`);
    expect(err.message).toMatch(UNKNOWN);
    expect(err.retryable).toBe(false);
    expect(`${err.message} ${err.hint ?? ""}`).toMatch(
      /tastytrade_get_live_orders/,
    );
  });

  it("does not tell the agent a renamed DELETE changed nothing", async () => {
    const { client, http } = createTestClient();
    // A 200 an intermediary answered with: unreadable body, mutating verb.
    http.reply("<html>proxy interstitial</html>");
    const err = await envelopeOf(client.deleteWatchlist("dry-run"));

    expect(err.message).not.toMatch(/No state was changed/);
    expect(err.message).toMatch(UNKNOWN);
    expect(err.retryable).toBe(false);
  });

  it("does not tell the agent a renamed PUT changed nothing", async () => {
    const { client, http } = createTestClient();
    http.reply("<html>proxy interstitial</html>");
    // The sharpest of the three: a PUT that rewrites the whole list from a
    // caller-authored body, reported as having changed nothing.
    const err = await envelopeOf(
      client.updateWatchlist("dry-run", [{ symbol: "AAPL" }]),
    );

    expect(err.message).not.toMatch(/No state was changed/);
    expect(err.retryable).toBe(false);

    // `/simulate-trade` was the second suffix and is already gone (5185b9e
    // removed it when the tool that posted there was removed), so this row is a
    // regression lock rather than a live vector — kept because the suffix list
    // is what is being deleted, and a re-added entry would show up here.
    expect(
      isMutatingRequest(
        cfg({ method: "PUT", url: "/watchlists/simulate-trade" }),
      ),
    ).toBe(true);
  });

  it("still exempts the real pre-flight routes, which carry the tag", async () => {
    const { client, http } = createTestClient();
    http.replyError(503);
    const err = await envelopeOf(
      client.dryRunMarginImpact(ACCOUNT, { legs: [LEG] }),
    );
    expect(err.message).not.toMatch(UNKNOWN);
    expect(err.retryable).toBe(true);
  });

  it("still exempts a pre-flight whose 200 body cannot be read", async () => {
    const { client, http } = createTestClient();
    http.reply("<html>proxy interstitial</html>");
    const err = await envelopeOf(client.dryRunOrder(ACCOUNT, { legs: [LEG] }));
    expect(err.message).toMatch(/No state was changed/);
    expect(err.retryable).toBe(true);
  });
});

// ============================================================================
// 3. The tag reaches both consumers
// ============================================================================

describe("the route tag survives to where it is read", () => {
  it("is on response.config for a pre-flight that succeeds", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: { "buying-power-effect": {} } });
    await client.dryRunOrder(ACCOUNT, { legs: [LEG] });
    expect(tagOf(http.last().config)).toEqual({ mutating: false });
  });

  it("is on error.config for a pre-flight that fails", async () => {
    const { client, http } = createTestClient();
    http.replyError(503);
    let seen: unknown;
    try {
      await client.dryRunOrder(ACCOUNT, { legs: [LEG] });
    } catch (error) {
      seen = (error as { config?: unknown }).config;
    }
    expect(tagOf(seen)).toEqual({ mutating: false });
    // The judgement the tag exists to feed, pinned directly.
    expect(
      isUnestablishedWrite({
        code: "ECONNRESET",
        config: seen as { method?: string },
      }),
    ).toBe(false);
  });

  it("is absent from a submit, which is why untagged must mean mutating", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: { order: { id: 1 } } });
    await client.placeOrder(ACCOUNT, { legs: [LEG] });
    expect(tagOf(http.last().config)).toBeUndefined();
  });
});

// ============================================================================
// 4. Every pre-flight route carries the tag, and only those — DERIVED
// ============================================================================

describe("the tagged routes are exactly the pre-flight routes", () => {
  /**
   * `async` method name -> body, cut at the method's closing brace.
   *
   * The count is DERIVED on both sides rather than written down: a literal
   * "there are five" can be satisfied by tagging a route that should have
   * stayed mutating, which is the defect itself.
   */
  const methodBodies = ((): Map<string, string> => {
    const out = new Map<string, string>();
    for (const chunk of CLIENT_SOURCE.split(/\n {2}async /).slice(1)) {
      const name = chunk.slice(0, chunk.indexOf("("));
      out.set(name, chunk.split("\n  }")[0]);
    }
    return out;
  })();

  /** Methods that dial a `…/dry-run` endpoint: a gated pre-flight, or margin. */
  const dialsPreflight = [...methodBodies]
    .filter(
      ([, body]) =>
        /GATED_ROUTES\.\w+\.dryRun\(/.test(body) || /"\/dry-run"/.test(body),
    )
    .map(([name]) => name)
    .sort();

  /** Methods that declare their route creates nothing. */
  const tagged = [...methodBodies]
    .filter(([, body]) => /NON_MUTATING_ROUTE/.test(body))
    .map(([name]) => name)
    .sort();

  it("reads a plausible number of methods out of the client", () => {
    // A broken split returns nothing and every assertion below passes
    // vacuously.
    expect(methodBodies.size).toBeGreaterThan(50);
    expect(dialsPreflight.length).toBeGreaterThan(0);
  });

  it("tags every pre-flight route and no other route", () => {
    expect(tagged).toEqual(dialsPreflight);
  });

  it("declares nothing non-mutating outside a dry-run method", () => {
    // The second, independent reading of the same rule: a tag on `cancelOrder`
    // would satisfy a count and fail this.
    expect(tagged.filter((name) => !/^dryRun/.test(name))).toEqual([]);
  });

  it("derives the answer from the route tag, not the request path", () => {
    const body = CLIENT_SOURCE.slice(
      CLIENT_SOURCE.indexOf("export function isMutatingRequest("),
    ).split("\n}")[0];
    expect(body).not.toMatch(/\burl\b/);
    expect(body).not.toMatch(/endsWith/);
    expect(body).not.toMatch(/split/);
    expect(CLIENT_SOURCE).not.toContain("NON_MUTATING_PATH_SUFFIXES");
  });
});
