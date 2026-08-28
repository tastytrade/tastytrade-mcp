/**
 * Tests for the `TastytradeClient` HTTP injection seam.
 *
 * These prove the properties the seam exists to guarantee: omitting it leaves the
 * production request path byte-for-byte unchanged; the seam sits BELOW the request
 * interceptor, so an injected adapter observes the fully-decorated outbound request;
 * response unwrapping works for both envelope shapes; and two rules that hold for
 * the whole file rather than one method — no envelope reach may dereference without a
 * null guard, and no path parameter may be interpolated with a bare
 * `encodeURIComponent`. Both are checked against the source itself, because the point
 * of each is that it holds at the sixty-fifth call site as well as the first.
 *
 * Everything runs offline: a stub token provider means no OAuth call, and the fake
 * adapter means no socket is opened. The fake-transport block below is deliberately
 * self-contained — see ./README.md for why it cannot live in a shared module.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import axios, { AxiosError, AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TastytradeClient } from "../../src/api-client.js";
import type { HttpAdapter } from "../../src/api-client.js";
import { isToolErrorException } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCOUNT = "5WV12345";
const API_URL = "https://api.cert.tastyworks.com";

/** The client's own source, for the two file-wide invariants at the bottom. */
const CLIENT_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/api-client.ts",
  ),
  "utf8",
);

// ============================================================================
// Fake transport — copy this block into any new offline client test.
// ============================================================================

/** One captured outbound request, as the transport saw it. */
interface RecordedRequest {
  /** Upper-cased HTTP method, e.g. `"GET"`. */
  method: string;
  /** Path exactly as the client asked for it. */
  url: string;
  /** `baseURL` + `url`, with no query string appended. */
  fullUrl: string;
  /** Query params the client passed, un-serialized. */
  params: Record<string, unknown>;
  /** Header names lower-cased (axios normalizes them), values stringified. */
  headers: Record<string, string>;
  /**
   * The serialized request body parsed back into a value — so assertions read
   * the bytes that would have gone over the wire. `undefined` when there was
   * no body; the raw string when it was not JSON.
   */
  body: unknown;
  /** Escape hatch: the untouched axios config object. */
  config: InternalAxiosRequestConfig;
}

interface FakeHttp {
  /** Pass as `{ adapter: http.adapter }` to the `TastytradeClient` constructor. */
  adapter: HttpAdapter;
  /** Every request the client made, oldest first. */
  requests: RecordedRequest[];
  /** Queue one reply (raw payload, envelope included). FIFO. */
  reply(data: unknown, init?: { status?: number }): void;
  /** Queue a non-2xx reply; rejects the way a real axios adapter does. */
  replyError(status: number, data?: unknown): void;
  /** The most recent request. Throws if none was made. */
  last(): RecordedRequest;
}

function recordRequest(config: InternalAxiosRequestConfig): RecordedRequest {
  // By the time the adapter runs, `config.headers` is a real AxiosHeaders
  // instance with every interceptor-applied header merged in, and `config.data`
  // has already been through axios's `transformRequest`.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.headers.toJSON())) {
    headers[key.toLowerCase()] = String(value);
  }

  let body: unknown = config.data ?? undefined;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* not JSON — keep the raw string */
    }
  }

  const url = config.url ?? "";
  return {
    method: (config.method ?? "get").toUpperCase(),
    url,
    fullUrl: `${(config.baseURL ?? "").replace(/\/+$/, "")}${url}`,
    params: (config.params ?? {}) as Record<string, unknown>,
    headers,
    body,
    config,
  };
}

/**
 * A recording fake transport with a FIFO queue of replies.
 *
 * Reproduces axios's own `settle()` semantics: a queued status outside
 * `validateStatus` rejects with a real `AxiosError` carrying `.response`, so
 * error-path code (`adaptError()` and friends) sees what it would see against
 * the live API.
 */
function createFakeHttp(): FakeHttp {
  const requests: RecordedRequest[] = [];
  const queue: { status: number; data: unknown }[] = [];

  const adapter: HttpAdapter = (config: InternalAxiosRequestConfig) => {
    const request = recordRequest(config);
    requests.push(request);

    const stub = queue.shift();
    if (!stub) {
      return Promise.reject(
        new Error(
          `createFakeHttp: no queued response for ${request.method} ${request.url} — ` +
            `call reply()/replyError() once per expected request`,
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
      queue.push({
        status,
        data: data ?? { error: { code: "stub", message: "stubbed failure" } },
      });
    },
    last() {
      const request = requests[requests.length - 1];
      if (!request) throw new Error("createFakeHttp: no request was recorded");
      return request;
    },
  };
}

/**
 * A `TastytradeClient` with no OAuth credentials in its config, a recording
 * adapter, and a stub token provider — so nothing can reach the network.
 */
function createTestClient(token = "test-access-token") {
  const http = createFakeHttp();
  const client = new TastytradeClient(
    { apiUrl: API_URL },
    { adapter: http.adapter, tokenProvider: () => token },
  );
  return { client, http };
}

// ============================================================================
// Tests
// ============================================================================

/** Set a `process.env` key and return a restore fn (handles "was absent"). */
function withEnv(key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

/** Every object key in a nested payload, flattened. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      collectKeys(nested, out);
    }
  }
  return out;
}

describe("TastytradeClient constructor seam", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes no adapter key to axios.create when the option is omitted", () => {
    const spy = jest.spyOn(axios, "create");

    new TastytradeClient({ apiUrl: API_URL });

    expect(spy).toHaveBeenCalledTimes(1);
    const passed = spy.mock.calls[0][0]!;
    // Not merely `undefined` — the key must be absent, so axios resolves its
    // own default transport exactly as it did before the seam existed.
    expect(Object.prototype.hasOwnProperty.call(passed, "adapter")).toBe(false);
    expect(passed.baseURL).toBe(API_URL);
  });

  it("disables redirect following, so the first connection is the only one", () => {
    // Not a style preference. NEVER_DISPATCHED_ERROR_CODES in the client makes
    // an absolute claim — a connect-stage failure proves not one byte of the
    // request body reached a socket the broker was reading — and that claim is
    // true only of the FIRST connection. Under axios's default of 21 redirects
    // an order POST could be answered by a second host (placeOrder resolving
    // with THAT host's body as the placed order), or fail at the redirect leg's
    // connect stage and be reported `retryable: true` for an order the origin
    // already had. `maxRedirects: 0` is what makes the set's proof hold.
    const spy = jest.spyOn(axios, "create");

    new TastytradeClient({ apiUrl: API_URL });

    expect(spy.mock.calls[0][0]!.maxRedirects).toBe(0);
  });

  it("keeps redirects disabled when an adapter is injected", () => {
    // The seam spreads its key last, so a future refactor that merged options
    // into the base config could shadow this. It travels on every request
    // config either way.
    const spy = jest.spyOn(axios, "create");
    const adapter: HttpAdapter = () => Promise.reject(new Error("unused"));

    new TastytradeClient({ apiUrl: API_URL }, { adapter });

    expect(spy.mock.calls[0][0]!.maxRedirects).toBe(0);
  });

  it("forwards the injected adapter to axios.create verbatim", () => {
    const spy = jest.spyOn(axios, "create");
    const adapter: HttpAdapter = () => Promise.reject(new Error("unused"));

    new TastytradeClient({ apiUrl: API_URL }, { adapter });

    expect(spy.mock.calls[0][0]!.adapter).toBe(adapter);
  });

  it("accepts an adapter name, the other shape axios allows", () => {
    const spy = jest.spyOn(axios, "create");

    new TastytradeClient({ apiUrl: API_URL }, { adapter: "http" });

    expect(spy.mock.calls[0][0]!.adapter).toBe("http");
  });

  it("leaves the legacy session-token path intact when no tokenProvider is given", async () => {
    const http = createFakeHttp();
    const client = new TastytradeClient(
      { apiUrl: API_URL, sessionToken: "legacy-session-token" },
      { adapter: http.adapter },
    );

    http.reply({ data: { items: [] } });
    await client.getAccounts();

    // Raw token, no "Bearer " prefix — the deprecated behaviour, unchanged.
    expect(http.last().headers.authorization).toBe("legacy-session-token");
  });

  it("sends no Authorization header when there is no credential at all", async () => {
    const http = createFakeHttp();
    const client = new TastytradeClient(
      { apiUrl: API_URL },
      { adapter: http.adapter },
    );

    http.reply({ data: { items: [] } });
    await client.getAccounts();

    expect(http.last().headers.authorization).toBeUndefined();
  });
});

describe("request interceptor runs above the injected adapter", () => {
  it("applies Authorization, Accept-Version and User-Agent to the outbound request", async () => {
    const restoreVersion = withEnv("TASTYTRADE_ACCEPT_VERSION", undefined);
    const restoreAgent = withEnv("TASTYTRADE_USER_AGENT", undefined);
    try {
      const { client, http } = createTestClient("stub-token-123");
      http.reply({ data: { items: [] } });

      await client.getAccounts();
      const request = http.last();

      expect(request.headers.authorization).toBe("Bearer stub-token-123");

      // Today's date, YYYYMMDD, in UTC — not local time.
      const now = new Date();
      const expected =
        `${now.getUTCFullYear()}` +
        String(now.getUTCMonth() + 1).padStart(2, "0") +
        String(now.getUTCDate()).padStart(2, "0");
      expect(request.headers["accept-version"]).toBe(expected);

      // In the <product>/<version> form the API requires — which also settles
      // "non-empty", so there is nothing weaker worth asserting alongside it.
      expect(request.headers["user-agent"]).toMatch(/^\S+\/\S+$/);
    } finally {
      restoreAgent();
      restoreVersion();
    }
  });

  it("honours TASTYTRADE_ACCEPT_VERSION as a pin", async () => {
    const restore = withEnv("TASTYTRADE_ACCEPT_VERSION", "20240101");
    try {
      const { client, http } = createTestClient();
      http.reply({ data: {} });
      await client.getBalances(ACCOUNT);
      expect(http.last().headers["accept-version"]).toBe("20240101");
    } finally {
      restore();
    }
  });

  it("honours TASTYTRADE_USER_AGENT as an override", async () => {
    const restore = withEnv("TASTYTRADE_USER_AGENT", "custom-agent/9.9.9");
    try {
      const { client, http } = createTestClient();
      http.reply({ data: {} });
      await client.getBalances(ACCOUNT);
      expect(http.last().headers["user-agent"]).toBe("custom-agent/9.9.9");
    } finally {
      restore();
    }
  });

  it("recomputes Accept-Version per request, so a long-running server rolls over at midnight", async () => {
    const restore = withEnv("TASTYTRADE_ACCEPT_VERSION", undefined);
    jest.useFakeTimers();
    try {
      const { client, http } = createTestClient();

      jest.setSystemTime(new Date("2026-03-14T23:59:59.000Z"));
      http.reply({ data: {} });
      await client.getBalances(ACCOUNT);
      expect(http.requests[0].headers["accept-version"]).toBe("20260314");

      // Same client instance, same interceptor — only the clock moved.
      jest.setSystemTime(new Date("2026-03-15T00:00:01.000Z"));
      http.reply({ data: {} });
      await client.getBalances(ACCOUNT);
      expect(http.requests[1].headers["accept-version"]).toBe("20260315");
    } finally {
      jest.useRealTimers();
      restore();
    }
  });

  it("calls the token provider once per request and awaits an async one", async () => {
    const tokenProvider = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("token-one")
      .mockResolvedValueOnce("token-two");
    const http = createFakeHttp();
    const client = new TastytradeClient(
      { apiUrl: API_URL },
      { adapter: http.adapter, tokenProvider },
    );

    http.reply({ data: {} });
    http.reply({ data: {} });
    await client.getBalances(ACCOUNT);
    await client.getBalances(ACCOUNT);

    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(http.requests[0].headers.authorization).toBe("Bearer token-one");
    expect(http.requests[1].headers.authorization).toBe("Bearer token-two");
  });

  it("keeps the constructor-level Content-Type and Accept headers", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: {} });
    await client.getBalances(ACCOUNT);

    expect(http.last().headers.accept).toBe("application/json");
    expect(http.last().headers["content-type"]).toBe("application/json");
  });
});

describe("tastytrade envelope unwrapping", () => {
  it("unwraps { data: { ... } } to .data.data", async () => {
    const { client, http } = createTestClient();
    const account = { "account-number": ACCOUNT, nickname: "Individual" };
    http.reply({ data: account, context: `/customers/me/accounts/${ACCOUNT}` });

    await expect(client.getAccount(ACCOUNT)).resolves.toEqual(account);
  });

  it("unwraps { data: { items: [ ... ] } } to .data.data.items", async () => {
    const { client, http } = createTestClient();
    const items = [
      { account: { "account-number": ACCOUNT } },
      { account: { "account-number": "5WV99999" } },
    ];
    http.reply({ data: { items }, context: "/customers/me/accounts" });

    await expect(client.getAccounts()).resolves.toEqual(items);
  });

  it("unwraps an items envelope on a paginated endpoint", async () => {
    const { client, http } = createTestClient();
    const items = [{ "instrument-type": "Equity", symbol: "AAPL" }];
    http.reply({
      data: { items },
      pagination: { "per-page": 250, "page-offset": 0 },
    });

    await expect(client.getPositions(ACCOUNT)).resolves.toEqual(items);
  });

  it("surfaces a non-2xx reply as a rejected AxiosError carrying the response", async () => {
    const { client, http } = createTestClient();
    http.replyError(404, { error: { code: "record_not_found" } });

    await expect(client.getAccount("NOPE")).rejects.toMatchObject({
      response: { status: 404 },
    });
  });
});

describe("outbound URL, method and body", () => {
  it("issues the GET path the client intended", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: {} });
    await client.getBalances(ACCOUNT);

    const request = http.last();
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`/accounts/${ACCOUNT}/balances`);
    expect(request.fullUrl).toBe(`${API_URL}/accounts/${ACCOUNT}/balances`);
    expect(request.body).toBeUndefined();
  });

  it("passes query params through un-serialized, in kebab-case", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: { items: [] } });
    await client.getNetLiquidatingValueHistory(ACCOUNT, {
      "time-back": "1m",
      interval: "1d",
    });

    const request = http.last();
    expect(request.url).toBe(`/accounts/${ACCOUNT}/net-liq/history`);
    expect(request.params).toEqual({ "time-back": "1m", interval: "1d" });
  });

  it("sends the order body verbatim as raw kebab-case JSON", async () => {
    // placeOrder writes the order body to stderr; keep the output clean.
    jest.spyOn(console, "error").mockImplementation(() => {});

    const { client, http } = createTestClient();
    // Exactly what the dispatcher's buildOrderBody produces: already kebab.
    const body = {
      "order-type": "Limit",
      "time-in-force": "Day",
      price: "1.25",
      "price-effect": "Debit",
      legs: [
        {
          "instrument-type": "Equity",
          symbol: "AAPL",
          quantity: 1,
          action: "Buy to Open",
        },
      ],
    };
    http.reply({ data: { order: { id: 1 } } });

    await client.placeOrder(ACCOUNT, body);

    const request = http.last();
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`/accounts/${ACCOUNT}/orders`);
    // The recorded body is the serialized wire payload parsed back, so this
    // asserts on the bytes axios would have written to the socket.
    expect(request.body).toEqual(body);
    const keys = collectKeys(request.body);
    expect(keys).toEqual(
      expect.arrayContaining([
        "order-type",
        "time-in-force",
        "price-effect",
        "instrument-type",
      ]),
    );
    // The snake_case → kebab-case translation belongs to the dispatcher; the
    // client must never emit a snake_case key of its own.
    for (const key of keys) {
      expect(key).not.toMatch(/_/);
    }

    jest.restoreAllMocks();
  });

  it("uses PUT for a replace and PATCH for an edit", async () => {
    const { client, http } = createTestClient();

    // A real entity in the reply, not `{data: {}}`: a submit whose 2xx names no
    // order is refused as an unknown outcome, and this test is about the verb.
    http.reply({ data: { id: 42, status: "Received" } });
    await client.replaceOrder(ACCOUNT, "42", { "order-type": "Market" });
    expect(http.last().method).toBe("PUT");
    expect(http.last().url).toBe(`/accounts/${ACCOUNT}/orders/42`);
    expect(http.last().body).toEqual({ "order-type": "Market" });

    http.reply({ data: { id: 43, status: "Received" } });
    await client.editOrder(ACCOUNT, "42", { price: "2.00" });
    expect(http.last().method).toBe("PATCH");
    expect(http.last().body).toEqual({ price: "2.00" });
  });

  it("uses DELETE for a cancel", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: { id: 42, status: "Cancelled" } });

    await expect(client.cancelOrder(ACCOUNT, "42")).resolves.toEqual({
      id: 42,
      status: "Cancelled",
    });
    expect(http.last().method).toBe("DELETE");
    expect(http.last().url).toBe(`/accounts/${ACCOUNT}/orders/42`);
  });
});

// ============================================================================
// Reaching through the envelope without dereferencing null
// ============================================================================

/**
 * `assertReadableResponse` deliberately lets `{data: null}` and
 * `{data: {items: null}}` through, because an explicit null is a legitimately empty
 * RESULT and the safety layer reads it as one — issueToken() mints no token when the
 * dry-run payload is null.
 *
 * Spelt bare, the six `.items` reaches dereference whatever sits at `.data`, so the
 * admitted `{data: null}` body throws `TypeError: Cannot read properties of null` out
 * of the client — and adaptError(), seeing only an `Error`, can report it no better
 * than `upstream_error` described by a JavaScript diagnostic.
 *
 * Both directions are pinned: the reach must stop throwing, and it must NOT acquire
 * the tolerant `?? response.data` fallbacks in the process, because those turn
 * `{data: null}` into a truthy object and hand the safety layer a dry-run "result"
 * where there was none.
 */
describe("an empty envelope is read, not dereferenced", () => {
  it("reads `{data: null}` on a collection endpoint without throwing", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: null });

    // Before the null guard this rejected with a raw TypeError from inside the
    // client. There is no collection in this body, so there is nothing to
    // return — but that is an answer, not a crash.
    await expect(client.getAccounts()).resolves.toBeUndefined();
  });

  it("still returns an explicitly null `items` as null, not as the envelope", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: { items: null } });

    // The guard against over-correcting: `?? response.data?.data ?? response.data`
    // would answer `{items: null}` here.
    await expect(client.getAccounts()).resolves.toBeNull();
  });

  it("still returns an explicitly null entity as null, not as the envelope", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: null });

    // Same over-correction guard one layer shallower. `dryRunOrder` unwraps at
    // exactly this depth, and a token must never be minted against `{data: null}`.
    await expect(client.getBalances(ACCOUNT)).resolves.toBeNull();
  });

  it("leaves a populated envelope alone at both depths", async () => {
    const { client, http } = createTestClient();
    const items = [{ "account-number": ACCOUNT }];

    http.reply({ data: { items } });
    await expect(client.getAccounts()).resolves.toEqual(items);

    http.reply({ data: { "cash-balance": "100.00" } });
    await expect(client.getBalances(ACCOUNT)).resolves.toEqual({
      "cash-balance": "100.00",
    });
  });
});

// ============================================================================
// Every dry-run that can mint a confirmation token unwraps strictly
// ============================================================================

/**
 * The four client methods whose payload can become a confirmation token, and the
 * five tools that reach them.
 *
 * `isCleanDryRun` mints a token for any readable object with no `errors` member, and
 * `null` is the one value that fails its readability test. That is the whole reason a
 * broker reply of `{data: null}` cannot authorise a live write — and it holds only
 * while the unwrap is strict. Tolerantly, `response.data?.data ?? response.data`
 * hands back the truthy object `{data: null}`, which is readable and carries no
 * `errors`, so the token is minted against a dry-run that said nothing.
 *
 * Written down for one method and left tolerant on the other three, all four tools
 * mint tokens from `{data: null}` and all four tokens are accepted. So the list is
 * asserted here rather than trusted to a comment: each method's behaviour below, and
 * the classification of every `dryRun*` method in the invariant block at the bottom.
 */
const TOKEN_MINTING_DRY_RUNS = [
  "dryRunOrder",
  "dryRunReplaceOrEdit",
  "dryRunComplexOrder",
  "dryRunEditComplexOrder",
] as const;

/**
 * `dryRun*` methods that mint nothing, so the tolerant read is theirs to keep.
 *
 * Listed because the invariant below requires every `dryRun*` method in the
 * file to appear in exactly one of the two lists: a new one cannot be added
 * without someone deciding which it is.
 */
const NON_MINTING_DRY_RUNS = ["dryRunMarginImpact"] as const;

describe("a dry-run that can mint a token reads `{data: null}` as null", () => {
  /** Call one token-minting method with placeholder arguments. */
  function callDryRun(
    client: TastytradeClient,
    method: (typeof TOKEN_MINTING_DRY_RUNS)[number],
  ): Promise<unknown> {
    switch (method) {
      case "dryRunOrder":
        return client.dryRunOrder(ACCOUNT, { legs: [] });
      case "dryRunReplaceOrEdit":
        return client.dryRunReplaceOrEdit(ACCOUNT, "1075264", { price: "1.0" });
      case "dryRunComplexOrder":
        return client.dryRunComplexOrder(ACCOUNT, { type: "OTOCO" });
      case "dryRunEditComplexOrder":
        return client.dryRunEditComplexOrder(ACCOUNT, "3", {
          "ratio-price-threshold": 1.5,
        });
    }
  }

  for (const method of TOKEN_MINTING_DRY_RUNS) {
    it(`${method} returns null, not the truthy envelope`, async () => {
      const { client, http } = createTestClient();
      http.reply({ data: null });

      // `{data: null}` is the shape assertReadableResponse deliberately admits
      // and the shape a token must never be minted from. Tolerantly it comes
      // back as `{data: null}` — an object, which is all isCleanDryRun asks for.
      await expect(callDryRun(client, method)).resolves.toBeNull();
    });

    it(`${method} still returns a populated entity untouched`, async () => {
      // The over-correction guard: strictness must not empty a real dry-run.
      const { client, http } = createTestClient();
      const payload = {
        "buying-power-effect": { "change-in-buying-power": "102.0" },
      };
      http.reply({ data: payload });

      await expect(callDryRun(client, method)).resolves.toEqual(payload);
    });
  }
});

// ============================================================================
// A bad argument is the caller's fault, and must be reported as one
// ============================================================================

/** Assert a rejection is a ToolError, and hand it back for closer inspection. */
async function rejectedToolError(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (!isToolErrorException(e)) {
      throw new Error(
        `expected a ToolErrorException, got ${String((e as Error)?.message ?? e)}`,
        { cause: e },
      );
    }
    return e.toolError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/**
 * A value with no primitive conversion is not exotic — `{"toString": 1,
 * "valueOf": 2}` survives `JSON.parse` intact, a JSON Schema `type: "string"` is
 * advisory, and the dispatcher hands `args.account_number` to the client exactly
 * as it arrived. `encodeURIComponent` throws a TypeError on it.
 *
 * Left raw, that TypeError reached the agent as `upstream_error` — the broker is
 * broken — quoting a JavaScript internal message. Nothing had been sent; the
 * broker had said nothing; the argument was wrong and no retry could help. Each
 * of those four claims is pinned separately below, because each one of them
 * misdirects an agent on its own.
 */
describe("a path parameter that cannot be rendered", () => {
  /** Parsed, not written as a literal, to show it is reachable from agent JSON. */
  const NO_PRIMITIVE = JSON.parse('{"toString": 1, "valueOf": 2}');

  it("is refused as a caller fault, not blamed on the broker", async () => {
    const { client } = createTestClient();
    const err = await rejectedToolError(client.getAccount(NO_PRIMITIVE));

    expect(err.code).toBe("validation");
    expect(err.retryable).toBe(false);
  });

  it("names the parameter and never quotes the interpreter", async () => {
    const { client } = createTestClient();
    const err = await rejectedToolError(client.getAccount(NO_PRIMITIVE));

    expect(err.message).toContain("account_number");
    // The exact text V8 produces for this fault, which would BE the message.
    expect(err.message).not.toContain("Cannot convert object to primitive");
    expect(err.message).not.toMatch(/TypeError/);
  });

  it("sends nothing, so the message may promise nothing was changed", async () => {
    const { client, http } = createTestClient();
    await rejectedToolError(client.getAccount(NO_PRIMITIVE));

    expect(http.requests).toHaveLength(0);
  });

  it("distinguishes an unpaired surrogate, the other way encoding fails", async () => {
    const { client, http } = createTestClient();
    // A lone high surrogate has no UTF-8 encoding, so encodeURIComponent raises
    // URIError rather than TypeError. Same class of caller fault, different
    // remedy, so the message says which one it was.
    const err = await rejectedToolError(client.getWatchlist("\uD800"));

    expect(err.code).toBe("validation");
    expect(err.message).toContain("watchlist_name");
    expect(err.message).toContain("surrogate");
    expect(http.requests).toHaveLength(0);
  });

  it("still percent-encodes every value that CAN be rendered", async () => {
    const { client, http } = createTestClient();

    // The three shapes the path-building invariant exists for: a slash inside an
    // equity symbol, a leading slash on a futures symbol, and the padding spaces
    // in an OCC option symbol.
    http.reply({ data: {} });
    await client.getInstrument("BRK/A");
    expect(http.last().url).toBe("/instruments/equities/BRK%2FA");

    http.reply({ data: {} });
    await client.getWatchlist("../../customers/me");
    expect(http.last().url).toBe("/watchlists/..%2F..%2Fcustomers%2Fme");

    http.reply({ data: {} });
    await client.getInstrument("AAPL  260417C00200000");
    expect(http.last().url).toBe(
      "/instruments/equities/AAPL%20%20260417C00200000",
    );
  });

  it("leaves a value that renders to nonsense for the API to judge", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: {} });

    // Requiredness and shape belong to the tool schema; a value that renders is
    // sent and gets a real answer. Pinned so the refusal above stays narrow.
    await client.getAccount(undefined as unknown as string);
    expect(http.last().url).toBe("/customers/me/accounts/undefined");
  });
});

// ============================================================================
// One decision, one default
// ============================================================================

/**
 * `addSymbolToWatchlist` and `removeSymbolFromWatchlist` would declare
 * `instrumentType = "Equity"`, while the dispatcher passes
 * `args.instrument_type ?? "Equity"` on every call — so the client-side default
 * could never be reached, and two defaults for one decision is how they come to
 * disagree. The default now lives only at the agent-facing boundary, next to the
 * `default: "Equity"` the tool schema already advertises.
 *
 * `Function.prototype.length` counts the parameters before the first defaulted
 * one, so it is the direct observation of "this parameter has no default" —
 * reinstating the default drops it back to 2.
 */
describe("the watchlist-entry instrument type has exactly one default", () => {
  it("declares no default for instrumentType on either method", () => {
    expect(TastytradeClient.prototype.addSymbolToWatchlist).toHaveLength(3);
    expect(TastytradeClient.prototype.removeSymbolFromWatchlist).toHaveLength(
      3,
    );
  });

  it("writes back the instrument type it was given, never an assumed Equity", async () => {
    const { client, http } = createTestClient();
    http.reply({ data: { name: "crypto", "watchlist-entries": [] } });
    http.reply({ data: { name: "crypto" } });

    await client.addSymbolToWatchlist("crypto", "BTC/USD", "Cryptocurrency");

    expect(http.last().method).toBe("PUT");
    expect(http.last().body).toEqual({
      name: "crypto",
      "watchlist-entries": [
        { symbol: "BTC/USD", "instrument-type": "Cryptocurrency" },
      ],
    });
  });

  it("matches on the instrument type it was given when removing", async () => {
    const { client, http } = createTestClient();
    const entries = [
      { symbol: "BTC/USD", "instrument-type": "Cryptocurrency" },
      { symbol: "BTC/USD", "instrument-type": "Equity" },
    ];
    http.reply({ data: { name: "crypto", "watchlist-entries": entries } });
    http.reply({ data: { name: "crypto" } });

    await client.removeSymbolFromWatchlist("crypto", "BTC/USD", "Equity");

    // Only the Equity row goes; an assumed default would have taken the wrong one.
    expect(http.last().body).toEqual({
      name: "crypto",
      "watchlist-entries": [
        { symbol: "BTC/USD", "instrument-type": "Cryptocurrency" },
      ],
    });
  });
});

// ============================================================================
// Two rules that have to hold for all ninety-odd methods, not just the tested ones
// ============================================================================

/** Source lines with the comment markers and blank lines removed. */
function codeLines(source: string): { n: number; text: string }[] {
  return source
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*");
    });
}

/**
 * Map every `async dryRun*(...)` method in the client to the `envelope*` helper
 * it returns.
 *
 * Read off the source rather than the runtime, because the point is to catch a
 * method nobody wrote a test for. A method with no recognised return lands in
 * the map as `"unknown"`, which fails the classification assertion loudly
 * instead of passing vacuously.
 */
function dryRunUnwrappers(source: string): Record<string, string> {
  const lines = codeLines(source);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const declared = /^\s*async (dryRun\w+)\s*\(/.exec(lines[i].text);
    if (!declared) continue;
    let unwrapper = "unknown";
    for (let j = i + 1; j < lines.length; j++) {
      const reach = /return (envelope\w+)\(response\)/.exec(lines[j].text);
      if (reach) {
        unwrapper = reach[1];
        break;
      }
      // A class method's closing brace is exactly two spaces in. Stopping there
      // keeps a method that returns nothing recognisable from borrowing its
      // neighbour's answer — it stays `"unknown"` and fails the assertion.
      if (lines[j].text === "  }") break;
    }
    out[declared[1]] = unwrapper;
  }
  return out;
}

describe("file-wide invariants in src/api-client.ts", () => {
  it("guards every inline envelope reach against a null layer", () => {
    // The unguarded spelling is not a style choice — see the block comment above
    // the envelope* helpers. A method that reaches inline must use `?.`, and in
    // practice only the four helpers should reach at all.
    const reaches = codeLines(CLIENT_SOURCE).filter(({ text }) =>
      /\breturn response\.data/.test(text),
    );

    // Non-vacuous: the helpers themselves are in here, so an empty match would
    // mean the reach was renamed and this test had stopped checking anything.
    expect(reaches.length).toBeGreaterThanOrEqual(4);

    const unguarded = reaches
      .filter(({ text }) => !text.includes("?."))
      .map(({ n, text }) => `${n}: ${text.trim()}`);
    expect(unguarded).toEqual([]);
  });

  it("unwraps every token-minting dry-run with the strict dialect", () => {
    // The companion to the behavioural tests above, and the part that survives
    // a NEW dry-run method being added. The defect this pins was not one method
    // written wrong: it was a safety rule written down at one call site and not
    // applied to its four siblings. A source-level check is what makes the rule
    // apply to the site nobody has written yet.
    const unwrappers = dryRunUnwrappers(CLIENT_SOURCE);

    // Every `dryRun*` method in the file has to be classified — a new one
    // cannot slip in as tolerant-by-default, because it will not be in either
    // list and this assertion names it.
    expect(Object.keys(unwrappers).sort()).toEqual(
      [...TOKEN_MINTING_DRY_RUNS, ...NON_MINTING_DRY_RUNS].sort(),
    );

    const tolerant = TOKEN_MINTING_DRY_RUNS.filter(
      (method) => unwrappers[method] !== "envelopeData",
    );
    expect(tolerant).toEqual([]);
  });

  it("refuses a null entity on every method that SUBMITS an order", () => {
    // The companion invariant to the dry-run one above, for the same reason: the defect
    // was never one method written wrong. Three submit methods unwrapped a `{data: null}`
    // write to `null` and a fourth to the truthy `{data: null}` — the same body read two
    // ways, and all four reporting a write nobody can act on as a success. A source-level
    // check is what makes the rule apply to the submit method nobody has written yet.
    //
    // The cancels are deliberately absent: an empty acknowledgement on a DELETE is not an
    // ambiguity, and refusing it would report a successful cancel as a failure.
    const SUBMITS = [
      "placeOrder",
      "replaceOrder",
      "editOrder",
      "placeComplexOrder",
      "editComplexOrder",
    ];
    const lines = codeLines(CLIENT_SOURCE);
    const unwrapper: Record<string, string> = {};
    for (let i = 0; i < lines.length; i++) {
      const declared = /^\s*async (\w+)\s*\(/.exec(lines[i].text);
      if (!declared || !SUBMITS.includes(declared[1])) continue;
      unwrapper[declared[1]] = "unknown";
      for (let j = i + 1; j < lines.length; j++) {
        const reach = /return (\w+)\(response/.exec(lines[j].text);
        if (reach) {
          unwrapper[declared[1]] = reach[1];
          break;
        }
        if (lines[j].text === "  }") break;
      }
    }

    // Non-vacuous: every name has to have been found in the file at all.
    expect(Object.keys(unwrapper).sort()).toEqual([...SUBMITS].sort());
    const tolerant = SUBMITS.filter((m) => unwrapper[m] !== "writtenEntity");
    expect(tolerant).toEqual([]);
  });

  it("lets only the path constructor call encodeURIComponent", () => {
    // The one caller is `encodeSegment`, the rendering
    // half of `apiPath`. Everywhere else, a value that cannot be rendered has to
    // become a `validation` ToolError naming the parameter — not a TypeError
    // that adaptError can only file under "the broker is broken".
    const callers = codeLines(CLIENT_SOURCE)
      .filter(({ text }) => text.includes("encodeURIComponent("))
      .map(({ text }) => text.trim());

    expect(callers).toEqual(["return encodeURIComponent(value as string);"]);
  });

  it("interpolates NOTHING into a request path — every one is built by apiPath", () => {
    // Updated for , and tightened rather than translated. The old rule
    // was "every interpolation goes through pathParam", which permitted the
    // template-literal shape and so permitted the defect: a helper that returns
    // a segment for a caller to splice is exactly what let `..` become
    // structure. There is now no interpolated path template at all — a path
    // carrying caller data is an array of parts handed to `apiPath`, which
    // verifies the target it built.
    const pathTemplates = CLIENT_SOURCE.match(/`\/[^`]*`/g) ?? [];
    const interpolating = pathTemplates.filter((template) =>
      template.includes("${"),
    );
    // Exactly one survives, and it is the constructor's own join — the line that
    // turns the verified part list into the path. Pinned rather than excluded by
    // a rule, so a second interpolation cannot arrive wearing its clothes.
    expect(interpolating).toEqual(['`/${rendered.join("/")}`']);
    const joinAt = CLIENT_SOURCE.indexOf('`/${rendered.join("/")}`');
    expect(joinAt).toBeGreaterThan(CLIENT_SOURCE.indexOf("function apiPath"));

    // Non-vacuous, and DERIVED rather than counted: the caller segments moved
    // from templates into `seg(...)` entries, so that is what has to be found.
    const segments = CLIENT_SOURCE.match(/\bseg\(\s*"/g) ?? [];
    expect(segments.length).toBeGreaterThanOrEqual(50);
    // And a part list is never itself a template, which would put the spliceable
    // shape back one level down.
    expect(CLIENT_SOURCE.match(/apiPath\(\s*`/g) ?? []).toEqual([]);
  });
});

describe("the targets a confirmation token binds", () => {
  /**
   * The gate compares two already-normalised (method, path) pairs, and this is
   * the only place they are rendered. What the assertions below are really
   * about is that `encodeURIComponent` is not the last word on what path a
   * string names: `.` and `..` are RFC 3986 unreserved characters and pass
   * through byte-identical, and WHATWG dot-segment removal runs over the
   * DECODED form — so the answer has to come from the transport's own parser
   * rather than from reading the string.
   */
  function clientOn(apiUrl: string): TastytradeClient {
    return new TastytradeClient(
      { apiUrl },
      { tokenProvider: () => "test-access-token" },
    );
  }

  const client = clientOn("https://api.cert.tastyworks.com");

  it("renders a pre-flight that pairs with its submit for an ordinary id", () => {
    const targets = client.authorisationTargets("replace_order", {
      accountNumber: "5WX00001",
      orderId: "1075264",
    });
    expect(targets.submit).toEqual({
      method: "PUT",
      path: "/accounts/5WX00001/orders/1075264",
    });
    expect(targets.dryRun).toEqual({
      method: "POST",
      path: "/accounts/5WX00001/orders/1075264/dry-run",
    });
  });

  it("refuses a dot segment before it can name any endpoint at all", () => {
    // This case would assert what the two legs RESOLVED
    // to — `PUT /accounts/5WX00001/orders/` and
    // `POST /accounts/5WX00001/orders/dry-run`, two different endpoints from one
    // set of arguments, which is what the confirmation gate's target binding
    // exists to catch. Path construction now refuses the value outright, one
    // layer earlier, so the pair is never rendered. Both controls are real and
    // neither replaces the other: this one stops the value becoming structure,
    // the gate stops any future value whose two legs resolve apart.
    const refusal = ((): ToolError => {
      try {
        client.authorisationTargets("replace_order", {
          accountNumber: "5WX00001",
          orderId: ".",
        });
      } catch (e) {
        if (isToolErrorException(e)) return e.toolError;
        throw e;
      }
      throw new Error("expected a refusal");
    })();
    expect(refusal.code).toBe("validation");
    expect(refusal.retryable).toBe(false);
  });

  it("resolves against a base URL that carries a path prefix", () => {
    // axios composes base + path itself (buildFullPath / combineURLs), so a
    // gateway address with a prefix has to be modelled, not assumed away.
    const targets = clientOn(
      "https://gateway.internal/tastytrade/",
    ).authorisationTargets("place_order", { accountNumber: "5WX00001" });
    expect(targets.submit.path).toBe("/tastytrade/accounts/5WX00001/orders");
    expect(targets.dryRun.path).toBe(
      "/tastytrade/accounts/5WX00001/orders/dry-run",
    );
  });

  it("keeps a symbol-shaped identifier's own characters percent-encoded", () => {
    const targets = client.authorisationTargets("edit_complex_order", {
      accountNumber: "5WX00001",
      complexOrderId: "a/b",
    });
    expect(targets.submit.path).toBe("/accounts/5WX00001/complex-orders/a%2Fb");
  });

  it("refuses rather than guessing when the base URL cannot be resolved", () => {
    const refusal = ((): ToolError => {
      try {
        clientOn("not-a-url").authorisationTargets("place_order", {
          accountNumber: "5WX00001",
        });
      } catch (e) {
        if (isToolErrorException(e)) return e.toolError;
        throw e;
      }
      throw new Error("expected a refusal");
    })();
    expect(refusal.code).toBe("validation");
    expect(refusal.retryable).toBe(false);
  });
});

// ============================================================================
// PATH CONSTRUCTION — a caller value must never become path STRUCTURE.
//
// `encodeURIComponent(value)` and nothing else does not judge a value that renders
// successfully — and a value that renders successfully can still be a path OPERATOR.
// `.` and `..` are RFC 3986 unreserved characters, so they pass through
// byte-identical, and axios then composes `baseURL + url` and asks the WHATWG parser
// for a request target, which applies remove_dot_segments.
//
// Measured on the wire against a real loopback origin: ten reaching classes each
// dialled an endpoint the arguments did not name, every one reported as an ordinary
// success. The most valuable was `get_account{account_number:".."}`, which named
// `/customers/me/accounts/..` and dialled `GET /customers/me/` — the Customer record,
// with tax identifiers, birth date and address, which no tool exposes.
//
// The refusals below are asserted through the offline seam. The COLLAPSE itself is
// only observable against a real HTTP origin, since an injected adapter sits above
// URL normalisation, which is why the classes are named by what they became.
// ============================================================================

/** A recording transport that answers everything with an empty envelope. */
function createRecorder() {
  const urls: string[] = [];
  const adapter: HttpAdapter = (config: InternalAxiosRequestConfig) => {
    urls.push(`${(config.method ?? "get").toUpperCase()} ${config.url ?? ""}`);
    return Promise.resolve({
      data: { data: { items: [] } },
      status: 200,
      statusText: "200",
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
    } as AxiosResponse);
  };
  const client = new TastytradeClient(
    { apiUrl: API_URL },
    { adapter, tokenProvider: () => "test-access-token" },
  );
  return { client, urls };
}

/** The ToolError a rejected call carried. */
async function refusalOf(fn: () => Promise<unknown>): Promise<ToolError> {
  try {
    await fn();
  } catch (e) {
    if (isToolErrorException(e)) return e.toolError;
    throw e;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

/**
 * Every reaching class the scan executed against a real HTTP origin, named by
 * what the request became on the wire once the URL layer had removed the dot
 * segments. The value in each is a path OPERATOR, not data.
 */
const REACHING: ReadonlyArray<
  readonly [string, (c: TastytradeClient) => Promise<unknown>]
> = [
  ["A. DELETE /quote-alerts/ (the collection)", (c) => c.deleteQuoteAlert(".")],
  ["B. DELETE / (the API root)", (c) => c.deleteWatchlist("..")],
  ["B'. DELETE /watchlists/ (every watchlist)", (c) => c.deleteWatchlist(".")],
  [
    "C. DELETE / from two controlled segments",
    (c) => c.cancelOrder("..", ".."),
  ],
  [
    "C'. DELETE /accounts/5WX00001/orders/ (every order)",
    (c) => c.cancelOrder("5WX00001", "."),
  ],
  [
    "D. PUT / with a caller-authored body",
    (c) => c.updateWatchlist("..", [{ symbol: "AAPL" }]),
  ],
  ["E. GET /customers/me/ (the Customer record)", (c) => c.getAccount("..")],
  [
    "H. POST /margin/dry-run without its account",
    (c) => c.dryRunMarginImpact("..", {}),
  ],
  [
    "G. the percent-encoded entrance, once decoded",
    (c) => c.getWatchlist(".."),
  ],
  [
    "an empty segment, which is structure and not data",
    (c) => c.getAccount(""),
  ],
];

describe("a caller value that would become path structure is refused", () => {
  it.each(REACHING)("refuses %s", async (_label, call) => {
    const { client, urls } = createRecorder();
    const refusal = await refusalOf(() => call(client));
    expect(refusal.code).toBe("validation");
    expect(refusal.retryable).toBe(false);
    // The load-bearing half: nothing reached the transport at all.
    expect(urls).toEqual([]);
  });
});

/**
 * The acceptance set. A fix that refuses these is a charset ban rather than a
 * structural check — every one is real tastytrade symbology or a lookalike that
 * carries no path operator once encoded.
 */
const ACCEPTED: ReadonlyArray<
  readonly [string, (c: TastytradeClient) => Promise<unknown>, string]
> = [
  [
    "an ordinary account number",
    (c) => c.getAccount("5WX00001"),
    "/customers/me/accounts/5WX00001",
  ],
  [
    "a futures symbol, which STARTS with a slash",
    (c) => c.getFuture("/ESZ4"),
    "/instruments/futures/%2FESZ4",
  ],
  [
    "a futures symbol with a leading dot-slash",
    (c) => c.getFuture("./ESZ4EX4"),
    "/instruments/futures/.%2FESZ4EX4",
  ],
  [
    "an equity symbol containing a slash",
    (c) => c.getInstrument("BRK/B"),
    "/instruments/equities/BRK%2FB",
  ],
  [
    "an OCC option symbol with padding spaces",
    (c) => c.getEquityOption("AAPL  260320C00200000"),
    "/instruments/equity-options/AAPL%20%20260320C00200000",
  ],
  [
    "a percent-encoded lookalike",
    (c) => c.getWatchlist("%2e%2e"),
    "/watchlists/%252e%252e",
  ],
  [
    "dots either side of an encoded slash",
    (c) => c.getWatchlist("..%2f.."),
    "/watchlists/..%252f..",
  ],
  [
    "four dots and two slashes",
    (c) => c.getWatchlist("....//"),
    "/watchlists/....%2F%2F",
  ],
  [
    "two dots and a semicolon",
    (c) => c.getWatchlist("..;"),
    "/watchlists/..%3B",
  ],
];

describe("a legitimate value still reaches its own endpoint", () => {
  it.each(ACCEPTED)("dispatches %s", async (_label, call, expected) => {
    const { client, urls } = createRecorder();
    await call(client);
    expect(urls).toHaveLength(1);
    expect(urls[0].split(" ")[1]).toBe(expected);
    // The assertion that would have caught the original defect: ask the
    // transport's own parser what the built string NAMES, not what it reads as.
    const dialled = new URL(`${API_URL}${urls[0].split(" ")[1]}`).pathname;
    expect(dialled).toBe(expected);
  });
});

describe("SOURCE INVARIANT: nothing in the client can build a spliceable segment", () => {
  it("has no `pathParam` identifier left anywhere in the module", () => {
    expect(CLIENT_SOURCE.match(/\bpathParam\b/g) ?? []).toEqual([]);
  });

  it("passes no interpolating template literal as a request path", () => {
    // Derived, not counted: every first argument of a client verb call that is
    // a template literal containing `${` is a path built by concatenation.
    const offenders =
      CLIENT_SOURCE.match(
        /this\.client\.(?:get|post|put|patch|delete)\(\s*`[^`]*\$\{/g,
      ) ?? [];
    expect(offenders).toEqual([]);
  });

  it("calls `encodeURIComponent` in exactly one place, inside the constructor", () => {
    // The CALL, not the word: this file's own doc comments name it four times
    // while explaining why encoding alone is not enough, and a check that
    // counted mentions would be a check on prose.
    const calls = [...CLIENT_SOURCE.matchAll(/encodeURIComponent\(/g)];
    expect(calls).toHaveLength(1);
    const start = CLIENT_SOURCE.indexOf("function encodeSegment");
    const end = CLIENT_SOURCE.indexOf("function decodeSegmentSafely");
    expect(start).toBeGreaterThan(-1);
    expect(calls[0].index).toBeGreaterThan(start);
    expect(calls[0].index).toBeLessThan(end);
  });

  it("routes every caller-supplied segment through `seg(`", () => {
    // The denominator is DERIVED at test time. A literal count is how a stale
    // number passes a green test after the surface changes size.
    const segs = CLIENT_SOURCE.match(/\bseg\(\s*"/g) ?? [];
    expect(segs.length).toBeGreaterThan(50);
    // And every apiPath call is a real array of parts, not a re-interpolation.
    const bad = CLIENT_SOURCE.match(/apiPath\(\s*`/g) ?? [];
    expect(bad).toEqual([]);
  });
});
