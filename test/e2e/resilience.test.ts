/**
 * Surviving a misbehaving upstream: a broker that stops answering, and a broker that
 * answers with something unreadable.
 *
 * These are the failure modes that do not announce themselves. An HTTP 500 arrives,
 * is classified, and the agent is told. The two modelled here are worse.
 *
 *   1. A REQUEST THAT NEVER COMPLETES. axios ships with NO timeout, so a broker that
 *      accepts the connection and goes quiet hangs the tool call, the MCP request and
 *      the agent indefinitely, with nothing reporting it. On a money path that is
 *      worse than an error: a hung `place_order` leaves the agent unable to tell
 *      whether the order reached the exchange, and the intuitive reading ("it did
 *      not") is the one that doubles a position.
 *
 *   2. A 2xx WHOSE BODY CANNOT BE UNWRAPPED. Every client method reaches into
 *      `response.data.data`. Without a guard above it, the `.data.data.items` methods
 *      turn a null body or a proxy's HTML interstitial into a raw `TypeError`
 *      flattened into an opaque `upstream_error`; the `.data.data` methods are
 *      quieter and worse, reading the same bodies as `undefined` and returning them
 *      as a SUCCESSFUL empty result — an agent told an account had no balances
 *      because a load balancer answered.
 *
 * The through-line: a failure on a WRITE is not the same event as the same failure on
 * a READ. A read can be repeated; an unacknowledged write cannot, and every assertion
 * about `retryable` below holds that line.
 *
 * Everything is offline — the HTTP boundary is a route table and the token endpoint a
 * spy on `axios.post`. axios enforces `timeout` inside its own transport, which an
 * injected adapter replaces, so these tests prove the two halves that are ours: the
 * configured value reaches every outbound request, and the error it produces is
 * classified correctly.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import axios from "axios";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHarness, callOk, callError } from "./harness.js";
import type { Harness, Route, RouteReply } from "./harness.js";
import { TastytradeMCPServer } from "../../src/mcp-server/index.js";
import {
  TastytradeClient,
  isMutatingRequest,
  isUnestablishedWrite,
  adaptRequestFailure,
} from "../../src/api-client.js";
import type { HttpAdapter } from "../../src/api-client.js";
import {
  TastytradeOAuthClient,
  DEFAULT_HTTP_TIMEOUT_MS,
  HTTP_TIMEOUT_ENV_VAR,
  isTimeoutErrorCode,
  resolveHttpTimeoutMs,
} from "../../src/oauth-client.js";
import {
  adaptError,
  isToolErrorException,
  toolError,
} from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import { MAX_REQUEST_PATH_CHARS } from "../../src/safety/bounded-text.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACCT = "5WX00001";
const ORDER_ID = "1075264";
const API_URL = "https://api.cert.tastyworks.com";

const BALANCES = `/accounts/${ACCT}/balances`;
const ACCOUNTS = "/customers/me/accounts";
const ORDER_DRY_RUN = `/accounts/${ACCT}/orders/dry-run`;
const ORDERS = `/accounts/${ACCT}/orders`;
const ORDER = `/accounts/${ACCT}/orders/${ORDER_ID}`;
const ORDER_DRY_RUN_BY_ID = `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`;

/**
 * The code axios raises when its own `timeout` fires. `ETIMEDOUT` (an OS-level
 * connect timeout) is covered by the transport table in test/e2e/errors.test.ts;
 * this file leads with ECONNABORTED because that is the one the shared taxonomy
 * in src/safety/errors.ts does NOT recognise, and so the one that would have
 * been misreported as `upstream_error`.
 */
const AXIOS_TIMEOUT = "ECONNABORTED";

// ---------------------------------------------------------------------------
// Environment and shared state
// ---------------------------------------------------------------------------

/**
 * Pinned rather than inherited: the timeout default is under test, the notional
 * cap gates every placement, and read-only mode would withhold the destructive
 * tools this file needs.
 */
const PINNED_ENV = {
  [HTTP_TIMEOUT_ENV_VAR]: undefined,
  MAX_ORDER_NOTIONAL_USD: "50000",
  TASTYTRADE_READ_ONLY: undefined,
} as const;
const priorEnv: Record<string, string | undefined> = {};

let h: Harness | undefined;

beforeEach(() => {
  for (const [key, value] of Object.entries(PINNED_ENV)) {
    priorEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Module-level state shared by every harness in the file. The destructive
  // bucket holds 5 tokens/min and this file places, cancels, edits and replaces
  // more than that in aggregate.
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `callError`, widened to the optional ToolError fields this file asserts on. */
async function envelope(
  harness: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolError> {
  return (await callError(harness, name, args)) as unknown as ToolError;
}

/** A recording adapter that answers everything with a minimal valid envelope. */
function observingAdapter(): {
  adapter: HttpAdapter;
  configs: AxiosRequestConfig[];
} {
  const configs: AxiosRequestConfig[] = [];
  const adapter: HttpAdapter = async (config: AxiosRequestConfig) => {
    configs.push(config);
    return {
      // A real entity, not `{data: {}}`. These tests are about the outbound
      // config and nothing else, but one of them drives `placeOrder`, and an
      // empty envelope on a submit is now refused as an unknown outcome — so an
      // empty canned body would make a timeout test fail for a reason that has
      // nothing to do with timeouts.
      data: { data: { id: 1, status: "Received" } },
      status: 200,
      statusText: "200",
      headers: {},
      config,
    } as AxiosResponse;
  };
  return { adapter, configs };
}

/** The timeout axios would apply to one outbound request from a fresh client. */
async function observedTimeout(): Promise<number | undefined> {
  const { adapter, configs } = observingAdapter();
  const client = new TastytradeClient(
    { apiUrl: API_URL },
    { adapter, tokenProvider: () => "test-access-token" },
  );
  await client.getBalances(ACCT);
  return configs[0]?.timeout;
}

const DRY_RUN_REPLY = {
  order: {
    "account-number": ACCT,
    "order-type": "Limit",
    price: "1.02",
    "price-effect": "Debit",
    status: "Received",
    "time-in-force": "Day",
    "underlying-symbol": "AAPL",
    legs: [
      {
        action: "Buy to Open",
        "instrument-type": "Equity",
        quantity: 1,
        symbol: "AAPL",
        fills: [],
      },
    ],
  },
  warnings: [],
  "buying-power-effect": {
    "change-in-buying-power": "1.021",
    "change-in-buying-power-effect": "Debit",
  },
};

const ORDER_ARGS = {
  account_number: ACCT,
  order_type: "Limit",
  time_in_force: "Day",
  price: "1.02",
  price_effect: "Debit",
  legs: [
    {
      symbol: "AAPL",
      instrument_type: "Equity",
      action: "Buy to Open",
      quantity: 1,
    },
  ],
};

const REPLACE_ARGS = {
  account_number: ACCT,
  order_id: ORDER_ID,
  order_type: "Limit",
  time_in_force: "Day",
  price: "1.05",
  price_effect: "Debit",
};

/** runSanityChecks() reads these two before any live placement. */
function sanityRoutes(): Route[] {
  return [
    {
      matcher: `/accounts/${ACCT}/position-limit`,
      method: "GET",
      reply: {
        data: {
          "equity-order-size": 100,
          "equity-option-order-size": 100,
          "future-order-size": 100,
        },
      },
    },
    {
      matcher: `/accounts/${ACCT}/trading-status`,
      method: "GET",
      reply: {
        data: { "is-frozen": false, "is-closing-only": false },
      },
    },
  ];
}

/**
 * Every assertion an unacknowledged state-changing request has to satisfy.
 * Collected in one place because it IS the contract: an agent that reads this
 * envelope must come away unable to justify resubmitting.
 */
function expectAmbiguousWriteEnvelope(err: ToolError): void {
  // Not retryable — the point of the whole exercise. `retryable: true` here
  // would be an instruction to repeat a request that may already have filled.
  expect(err.retryable).toBe(false);
  expect(err.retry_after_ms).toBeUndefined();
  // Names the ambiguity rather than implying failure.
  expect(err.message).toMatch(/outcome is UNKNOWN/i);
  expect(err.message).toMatch(/may already have been accepted/i);
  // Forbids the resubmission explicitly...
  expect(err.message).toMatch(/do NOT resubmit/i);
  // ...and points at the read that resolves it.
  expect(err.message).toContain("tastytrade_get_live_orders");
  expect(err.hint ?? "").toMatch(/reconcile|live orders/i);
  // The consumed confirmation token is called out, so an agent that does decide
  // to place again knows it needs a fresh dry-run rather than a token replay.
  expect(err.hint ?? "").toMatch(/confirmation token/i);
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SIMULATE_TRADE = "/simulate-trade";

const WATCHLISTS = "/watchlists";

/**
 * The margin pre-flight: the only non-GET route a TOOL can reach that declares
 * itself non-mutating (`NON_MUTATING_ROUTE`, api-client.ts), and so the only
 * tool that can drive the "a failed non-mutating POST raises no doubt" branches
 * end to end. the declaration would be a suffix match
 * on the request path.
 */
const MARGIN_DRY_RUN = `/margin/accounts/${ACCT}/dry-run`;
const MARGIN_DRY_RUN_LEGS = [
  {
    symbol: "AAPL",
    instrument_type: "Equity",
    action: "Buy to Open",
    quantity: 1,
  },
];

// ---------------------------------------------------------------------------
// The claim "this endpoint routes no order" is checked against the client
// ---------------------------------------------------------------------------

/**
 * The envelope a reset socket produces for one (verb, path), straight through the
 * real classifier.
 *
 * Built here rather than routed through the harness because the subject is the PATH,
 * and several paths below belong to tools this suite would otherwise have to
 * construct valid arguments for. `adaptRequestFailure` is what the response
 * interceptor calls with exactly this shape, and `adaptError` is what the
 * dispatcher's catch-all does to the result.
 *
 * `url: undefined` is a real case: axios omits `config` on a rejection raised before
 * the request was assembled, and the classifier documents a fail-closed answer.
 */
function inDoubtEnvelope(
  verb: string,
  url: string | undefined,
  // The classifier reads the route tag the CALL SITE
  // attached, not the request path, so a case that wants the non-mutating
  // branch has to declare it the way the client's own pre-flight methods do.
  tastytradeRoute?: { mutating: boolean },
): ToolError {
  const raw = Object.assign(new Error("ECONNRESET"), {
    code: "ECONNRESET",
    isAxiosError: true,
    config: { method: verb, url, tastytradeRoute },
  });
  return adaptError(adaptRequestFailure(raw, DEFAULT_HTTP_TIMEOUT_MS));
}

// ===========================================================================
// 1. The timeout exists, and is configurable
// ===========================================================================

describe("the HTTP timeout", () => {
  it("applies a finite default to every outbound request", async () => {
    // The regression this guards: `grep -n timeout src/api-client.ts` would
    // return nothing, and axios's default is no timeout at all.
    await expect(observedTimeout()).resolves.toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_HTTP_TIMEOUT_MS)).toBe(true);
  });

  it("is overridable per deployment by environment variable", async () => {
    process.env[HTTP_TIMEOUT_ENV_VAR] = "4500";
    await expect(observedTimeout()).resolves.toBe(4500);
  });

  it("carries the same value onto a write, not just a read", async () => {
    const { adapter, configs } = observingAdapter();
    const client = new TastytradeClient(
      { apiUrl: API_URL },
      { adapter, tokenProvider: () => "test-access-token" },
    );

    await client.placeOrder(ACCT, { "order-type": "Market", legs: [] });

    expect(configs[0]?.method?.toUpperCase()).toBe("POST");
    expect(configs[0]?.timeout).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });

  it("also bounds the token grant, which every request waits on", async () => {
    // The request interceptor awaits getAccessToken() before anything goes out,
    // so an unbounded token POST hangs every tool call just as completely as an
    // unbounded API call would.
    const post = jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "t", expires_in: 900 } });

    const oauth = new TastytradeOAuthClient({
      apiUrl: API_URL,
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
    await oauth.getAccessToken();

    const config = post.mock.calls[0]![2] as AxiosRequestConfig;
    expect(config.timeout).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });

  it("hands the api-client's resolved value to the OAuth client it builds", async () => {
    // Resolved once per process rather than once per grant, so a misconfigured
    // value warns once instead of on every token refresh.
    process.env[HTTP_TIMEOUT_ENV_VAR] = "7000";
    const warn = jest.spyOn(console, "error").mockImplementation(() => {});
    const post = jest
      .spyOn(axios, "post")
      .mockResolvedValue({ data: { access_token: "t", expires_in: 900 } });
    const { adapter } = observingAdapter();

    const client = new TastytradeClient(
      {
        apiUrl: API_URL,
        clientId: "id",
        clientSecret: "secret",
        refreshToken: "refresh",
      },
      { adapter },
    );
    await client.getBalances(ACCT);

    expect((post.mock.calls[0]![2] as AxiosRequestConfig).timeout).toBe(7000);
    expect(warn).not.toHaveBeenCalled();
  });

  describe("refuses to be switched off", () => {
    /**
     * `0` is the case that matters: axios reads `timeout: 0` as "wait forever",
     * so an operator who typed it meaning "no limit" would silently restore the
     * unbounded hang. There is deliberately no value that disables the timeout.
     */
    const UNUSABLE = [
      ["zero, which axios reads as no timeout", "0"],
      ["a negative", "-1"],
      ["not a number", "30s"],
      ["empty", ""],
      ["Infinity", "Infinity"],
    ] as const;

    it.each(UNUSABLE)("falls back and warns when given %s", (_label, raw) => {
      const warn = jest.spyOn(console, "error").mockImplementation(() => {});
      process.env[HTTP_TIMEOUT_ENV_VAR] = raw;

      expect(resolveHttpTimeoutMs()).toBe(DEFAULT_HTTP_TIMEOUT_MS);

      // Silence is the failure mode: an operator who believes they configured
      // something must be told they did not.
      // Empty unless console.error was called, so these two also prove the
      // warning was emitted at all — and emitted on stderr, since stdout
      // carries the MCP protocol and is never written to here.
      const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(said).toContain(HTTP_TIMEOUT_ENV_VAR);
      expect(said).toMatch(/has NOT been disabled/);
    });

    it("says nothing when the variable is simply unset", () => {
      const warn = jest.spyOn(console, "error").mockImplementation(() => {});
      delete process.env[HTTP_TIMEOUT_ENV_VAR];

      expect(resolveHttpTimeoutMs()).toBe(DEFAULT_HTTP_TIMEOUT_MS);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// 2. Timeout classification: network, never upstream_error
// ===========================================================================

describe("a timeout is a transport failure, not the broker erroring", () => {
  it("reaches the agent as `network` for the code axios actually emits", async () => {
    // src/safety/errors.ts classifies ECONNREFUSED / ENOTFOUND / ETIMEDOUT but
    // NOT ECONNABORTED, which is what axios's own timeout raises. Unhandled it
    // would fall through to `upstream_error` — telling the agent the broker
    // returned an error when the broker returned nothing at all.
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { networkError: "ECONNABORTED" },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    // `network`, not the `upstream_error` an unrecognised code falls through to.
    expect(err.code).toBe("network");
    // No HTTP response existed, so claiming a status would be a lie.
    expect(err.upstream).toBeUndefined();
  });

  it("recognises both codes a timeout can arrive under", () => {
    // ECONNABORTED is axios's own limit firing; ETIMEDOUT is the OS refusing to
    // wait for a connect, or axios with `clarifyTimeoutError` enabled.
    expect(isTimeoutErrorCode("ECONNABORTED")).toBe(true);
    expect(isTimeoutErrorCode("ETIMEDOUT")).toBe(true);
    // A connection refused outright is NOT a timeout: it is a definite answer,
    // and it must keep its existing classification.
    expect(isTimeoutErrorCode("ECONNREFUSED")).toBe(false);
    expect(isTimeoutErrorCode(undefined)).toBe(false);
  });

  it("leaves any rejection it cannot say more about to the shared taxonomy", () => {
    // The classifier claims exactly two things — a timeout, and a write whose
    // outcome is unestablished — and returns everything else by identity, so a
    // rejection it has no opinion on cannot be silently swallowed into `network`.
    const refused = { code: "ECONNREFUSED", isAxiosError: true };
    expect(adaptRequestFailure(refused, 30_000)).toBe(refused);
    expect(adaptRequestFailure(null, 30_000)).toBeNull();
    // A read that got a real answer, however bad, is the taxonomy's business.
    const gatewayRead = {
      isAxiosError: true,
      config: { method: "get", url: BALANCES },
      response: { status: 503 },
    };
    expect(adaptRequestFailure(gatewayRead, 30_000)).toBe(gatewayRead);
  });

  it("does not re-dress an error a lower layer already classified", () => {
    // The OAuth client's grant failures reach the response interceptor through
    // the request-interceptor chain, already carrying their own taxonomy code.
    // Rewriting an `auth_failed` into "your order may have landed" would be a
    // false statement about a request that was never sent.
    const alreadyClassified = toolError({
      code: "auth_failed",
      message: "the refresh token was rejected",
      retryable: false,
    });
    expect(adaptRequestFailure(alreadyClassified, 30_000)).toBe(
      alreadyClassified,
    );
    expect(adaptError(alreadyClassified).code).toBe("auth_failed");
  });
});

describe("a timeout on a read", () => {
  it("is safely retryable and says so", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Nothing was changed/i);
    // A read timeout must NOT drag the agent into a reconciliation it does not
    // need — that is noise, and noise trains agents to ignore the real thing.
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
    expect(err.message).not.toContain("tastytrade_get_live_orders");
  });

  it("names the request and the configured limit, for the operator", async () => {
    process.env[HTTP_TIMEOUT_ENV_VAR] = "1500";
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(err.message).toContain("1500ms");
    expect(err.message).toContain(BALANCES);
    expect(err.message).toContain("GET");
    // The raw code survives, because that is what gets grepped.
    expect(err.message).toContain(AXIOS_TIMEOUT);
    expect(err.hint ?? "").toContain(HTTP_TIMEOUT_ENV_VAR);
  });

  it("treats a dry-run POST as a read, because it creates nothing", async () => {
    // The dry-run endpoints validate an order and return its projected effect.
    // Nothing exists afterwards, so a timeout on one is as safe to repeat as a
    // GET — and telling the agent to go reconcile would be simply false.
    h = await createHarness({
      routes: [
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_dry_run_order", ORDER_ARGS);

    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });
});

// ---------------------------------------------------------------------------
// The reflected request path is the CALLER'S text, so it is bounded like one
// ---------------------------------------------------------------------------

/**
 * The envelope one (verb, path, axios code) produces, straight through the real
 * classifier and the real envelope gate. Same pairing as `inDoubtEnvelope`
 * above, with the code and the verb parameterised, because the subject here is
 * the PATH operand rather than the doubt classification.
 */
function failureFor(
  url: string,
  code = AXIOS_TIMEOUT,
  method = "get",
): ToolError {
  const raw = Object.assign(new Error(code), {
    code,
    isAxiosError: true,
    config: { method, url },
  });
  return adaptError(adaptRequestFailure(raw, 400));
}

/**
 * A caller-supplied account number far past any legitimate length. Nothing about
 * it is malformed — `pathParam` percent-encodes an argument, it does not bound
 * one — and every message in `adaptRequestFailure` interpolates the URL built
 * from it.
 */
const LONG_ACCOUNT = `5WX${"0".repeat(2000)}TAIL`;

describe("the reflected request path is bounded at its source", () => {
  it("does not echo a 2,007-character account number back into the message", () => {
    // The value here is the CALLER's, not the broker's: `e.config.url` is the
    // URL this client built out of the arguments it was handed. Before the
    // operand was bounded, the same 2,007 characters that
    // `clipParam` (mcp-server/resources.ts) had already cut to 32 a few words
    // earlier in the same sentence arrived here verbatim — 71x that budget.
    const err = failureFor(`/accounts/${LONG_ACCOUNT}/balances`);
    expect(err.message).not.toContain(LONG_ACCOUNT);
    expect(err.message).toMatch(/…\[truncated, \d+ chars\]/);
    expect(err.message.length).toBeLessThan(MAX_REQUEST_PATH_CHARS + 300);
  });

  it("bounds the path on the connection-failed wording too", () => {
    // A reset socket on a WRITE takes the other branch of the same function:
    // "The connection to the tastytrade API failed before any reply arrived".
    // Both branches interpolate the one operand, which is why the bound is on
    // the operand and not on either sentence.
    const err = failureFor(
      `/accounts/${LONG_ACCOUNT}/orders`,
      "ECONNRESET",
      "post",
    );
    expect(err.message).toContain("failed before any reply arrived");
    expect(err.message).not.toContain(LONG_ACCOUNT);
  });

  it("leaves a normal failure message byte-identical", () => {
    // ANTI-OVERREACH. An operator greps for the verb, the axios code and the
    // "this client waits Nms" clause, so a real path must come through
    // untouched and unmarked. This is the assertion that fails if the cap is
    // ever set anywhere near the length of a legitimate request path.
    const err = failureFor(BALANCES);
    expect(err.message).toBe(
      `The tastytrade API did not answer in time (GET ${BALANCES} — ${AXIOS_TIMEOUT}); ` +
        `this client waits 400ms. Nothing was changed, so this read can safely be repeated.`,
    );
  });
});

describe("SOURCE INVARIANT — every reflected path in api-client.ts is bounded", () => {
  const SRC = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/api-client.ts",
    ),
    "utf8",
  );

  /**
   * Every STATEMENT in api-client.ts that reads a request URL off an axios
   * config, derived by scanning the file. The denominator is whatever the tree
   * currently has — asserting a literal count is how a stale number passes a
   * green test while a new site goes unguarded.
   */
  function urlReadingStatements(): string[] {
    const lines = SRC.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/config\?\.url/.test(lines[i]!)) continue;
      if (/^\s*(?:\*|\/\/)/.test(lines[i]!)) continue; // a comment, not code
      let stmt = "";
      for (let j = i; j < lines.length; j++) {
        stmt += lines[j]!;
        if (lines[j]!.trimEnd().endsWith(";")) break;
      }
      out.push(stmt);
    }
    return out;
  }

  it("classifies every config.url read as either path-classification or bounded prose", () => {
    // Two legitimate shapes, and only two. `.split("?")[0]` is the mutation
    // classifier, which compares a path against a suffix table and emits
    // nothing; `boundedText(` is the reflecting shape. A third shape is a new
    // unbounded echo and fails here rather than in a PoC.
    const statements = urlReadingStatements();
    expect(statements.length).toBeGreaterThan(0);
    const unclassified = statements.filter(
      (s) => !s.includes('.split("?")') && !s.includes("boundedText("),
    );
    expect(unclassified).toEqual([]);
  });

  it("finds at least one prose-bound read, so the classifier arm cannot absorb them all", () => {
    const bounded = urlReadingStatements().filter((s) =>
      s.includes("boundedText("),
    );
    expect(bounded.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. A timeout on a write is ambiguous — the money case
// ===========================================================================

describe("a timeout on a write", () => {
  it("refuses to invite a retry of an unacknowledged place_order", async () => {
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        {
          matcher: ORDERS,
          method: "POST",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };
    const err = await envelope(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    expect(err.code).toBe("network");
    expectAmbiguousWriteEnvelope(err);
    // The submission really was attempted — this is not a pre-flight refusal.
    expect(
      h.requests.filter((r) => r.method === "POST" && r.url === ORDERS),
    ).toHaveLength(1);
  });

  it("leaves the confirmation token spent, so a replay cannot resubmit blindly", async () => {
    // The token is consumed before the POST, which is what makes the hint's
    // "you need a fresh dry-run" instruction true rather than advisory: an agent
    // that ignores the envelope and retries with the same token is refused here
    // rather than at the exchange.
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        {
          matcher: ORDERS,
          method: "POST",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };
    const args = { ...ORDER_ARGS, confirmation_token: dry.confirmation_token };
    await envelope(h, "tastytrade_place_order", args);

    const replay = await envelope(h, "tastytrade_place_order", args);
    expect(replay.code).toBe("dry_run_required");
    // Exactly one live submission, not two.
    expect(
      h.requests.filter((r) => r.method === "POST" && r.url === ORDERS),
    ).toHaveLength(1);
  });

  it("applies to a DELETE — a cancel that may or may not have landed", async () => {
    // A cancel is not risk-free to repeat blindly either: "did my cancel land"
    // has to be answered by reading, because a resent cancel on an order that
    // already filled is a different decision entirely.
    h = await createHarness({
      routes: [
        {
          matcher: ORDER,
          method: "DELETE",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    expect(err.code).toBe("network");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/outcome is UNKNOWN/i);
    expect(err.message).toMatch(/duplicate the order or the cancel/i);
  });

  it("applies to a PUT (replace)", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: ORDER_DRY_RUN_BY_ID,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        {
          matcher: ORDER,
          method: "PUT",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const dry = (await callOk(
      h,
      "tastytrade_dry_run_replace_order",
      REPLACE_ARGS,
    )) as { confirmation_token: string };
    const err = await envelope(h, "tastytrade_replace_order", {
      ...REPLACE_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    expect(err.code).toBe("network");
    expectAmbiguousWriteEnvelope(err);
  });

  it("applies to a PATCH (edit)", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: ORDER_DRY_RUN_BY_ID,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        {
          matcher: ORDER,
          method: "PATCH",
          reply: { networkError: AXIOS_TIMEOUT },
        },
      ],
    });

    const dry = (await callOk(h, "tastytrade_dry_run_edit_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
      price: "1.10",
      price_effect: "Credit",
    })) as { confirmation_token: string };
    const err = await envelope(h, "tastytrade_edit_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
      price: "1.10",
      price_effect: "Credit",
      confirmation_token: dry.confirmation_token,
    });

    expect(err.code).toBe("network");
    expectAmbiguousWriteEnvelope(err);
  });
});

// ===========================================================================
// 3b. Every OTHER way a write can end in doubt
//
// A timeout is the most conspicuous member of a family. A socket reset, a broken
// pipe and a gateway status leave the same question unanswered — did the order reach
// the exchange? — and a 504 leaves it MORE open, because it is an intermediary
// confirming the request got at least as far as itself. Every one would come back
// `retryable: true` with no ambiguity warning, which reads as "that call failed
// cleanly, do it again".
// ===========================================================================

describe("a write the transport never resolved", () => {
  /** place_order, with the live POST failing however the route says. */
  async function placeAgainst(reply: Route["reply"]): Promise<ToolError> {
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        { matcher: ORDERS, method: "POST", reply },
      ],
    });
    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };
    return envelope(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    });
  }

  it("treats a reset socket on place_order exactly like a timeout", async () => {
    // ECONNRESET is the textbook "request delivered, response lost": the
    // connection was established, so the POST may well have been read, routed
    // and filled before the peer went away.
    const err = await placeAgainst({ networkError: "ECONNRESET" });

    expect(err.code).toBe("network");
    expectAmbiguousWriteEnvelope(err);
    // The raw code still survives, because that is what gets grepped.
    expect(err.message).toContain("ECONNRESET");
  });

  it("treats a broken pipe the same way", async () => {
    const err = await placeAgainst({ networkError: "EPIPE" });

    expect(err.code).toBe("network");
    expectAmbiguousWriteEnvelope(err);
  });

  it("says the same of a cancel, which is also a write", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: ORDER,
          method: "DELETE",
          reply: { networkError: "ECONNRESET" },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    expect(err.code).toBe("network");
    expectAmbiguousWriteEnvelope(err);
  });

  it("leaves a reset socket on a READ plainly retryable", async () => {
    // The read path must not move: dragging an agent into a reconciliation it
    // does not need is noise, and noise is how a real warning gets ignored.
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { networkError: "ECONNRESET" },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(err.code).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });

  it("leaves a reset socket on a dry-run retryable, because it created nothing", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { networkError: "ECONNRESET" },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_dry_run_order", ORDER_ARGS);

    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });

  it("keeps a write that provably never left the machine plainly classified", async () => {
    // A refused connection and a failed DNS lookup are not ambiguous: no byte of
    // the request reached anything that could act on it. Claiming "the outcome
    // is unknown" here would be crying wolf, and it is the wolf that has to stay
    // credible.
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      await h?.close();
      _resetRateLimitsForTest();
      h = await createHarness({
        routes: [
          { matcher: ORDER, method: "DELETE", reply: { networkError: code } },
        ],
      });
      const err = await envelope(h, "tastytrade_cancel_order", {
        account_number: ACCT,
        order_id: ORDER_ID,
      });
      expect(err.code).toBe("network");
      expect(err.retryable).toBe(true);
      expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
    }
  });
});

describe("a write the broker answered with a server-side status", () => {
  async function cancelAgainst(status: number): Promise<ToolError> {
    h = await createHarness({
      routes: [
        {
          matcher: ORDER,
          method: "DELETE",
          reply: { status, data: { error: { code: "gateway" } } },
        },
      ],
    });
    return envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });
  }

  it("refuses to call a 504 on a cancel retryable", async () => {
    // Strictly worse than the timeout that was already handled: a 504 means an
    // intermediary took the request and never heard back from the origin, so the
    // cancel may be applied at the broker right now.
    const err = await cancelAgainst(504);

    expect(err.code).toBe("upstream_error");
    expectAmbiguousWriteEnvelope(err);
    // The status is still reported — the operator needs to know who answered.
    expect(err.upstream?.status).toBe(504);
  });

  it("says the same of 502, 503 and a bare 500", async () => {
    for (const status of [500, 502, 503]) {
      await h?.close();
      _resetRateLimitsForTest();
      const err = await cancelAgainst(status);
      expect(err.code).toBe("upstream_error");
      expectAmbiguousWriteEnvelope(err);
      expect(err.upstream?.status).toBe(status);
    }
  });

  it("applies to the POST that places an order", async () => {
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        { matcher: ORDERS, method: "POST", reply: { status: 503, data: {} } },
      ],
    });
    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };

    const err = await envelope(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    expectAmbiguousWriteEnvelope(err);
    expect(
      h.requests.filter((r) => r.method === "POST" && r.url === ORDERS),
    ).toHaveLength(1);
  });

  it("leaves a 504 on a READ retryable, with no reconciliation to do", async () => {
    h = await createHarness({
      routes: [{ matcher: BALANCES, method: "GET", reply: { status: 504 } }],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });

  it("leaves a 503 on a dry-run retryable", async () => {
    h = await createHarness({
      routes: [
        { matcher: ORDER_DRY_RUN, method: "POST", reply: { status: 503 } },
      ],
    });

    const err = await envelope(h, "tastytrade_dry_run_order", ORDER_ARGS);

    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });

  it("leaves a definite 4xx refusal of a write exactly as it was", async () => {
    // A 422 is the origin saying it understood the request and declined it.
    // Nothing was created, so the taxonomy's field-level answer is the useful
    // one and the reconciliation advice would be a distraction.
    h = await createHarness({
      routes: [
        {
          matcher: ORDER,
          method: "DELETE",
          reply: { status: 422, data: { error: { message: "too late" } } },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    expect(err.code).toBe("validation");
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });

  it("leaves an upstream 429 on a write retryable, because it was rejected", async () => {
    h = await createHarness({
      routes: [{ matcher: ORDER, method: "DELETE", reply: { status: 429 } }],
    });

    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.retryable).toBe(true);
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
  });
});

describe("classifying a request as state-changing", () => {
  // The predicate the read/write split rests on, exercised directly so the
  // fail-closed cases are pinned rather than inferred.
  // Every case below would hand the classifier a URL,
  // because the classification was a suffix match on `config.url` — and that is
  // the defect: `dry-run` is made of RFC 3986 unreserved characters, so any
  // route with a caller-supplied last segment could be renamed into the
  // exempt set. The predicate now reads a call-site tag, so these cases pass
  // the tag and the URL is carried only to show it is not consulted.
  const asConfig = (o: Record<string, unknown>) =>
    o as Parameters<typeof isMutatingRequest>[0];

  it("treats a GET as safe and anything else as state-changing", () => {
    expect(isMutatingRequest(asConfig({ method: "get", url: BALANCES }))).toBe(
      false,
    );
    expect(isMutatingRequest(asConfig({ method: "post", url: ORDERS }))).toBe(
      true,
    );
    expect(isMutatingRequest(asConfig({ method: "put", url: ORDER }))).toBe(
      true,
    );
    expect(isMutatingRequest(asConfig({ method: "patch", url: ORDER }))).toBe(
      true,
    );
    expect(isMutatingRequest(asConfig({ method: "delete", url: ORDER }))).toBe(
      true,
    );
  });

  it("carves out the endpoints that create nothing, and only those", () => {
    const preflight = { mutating: false };
    expect(
      isMutatingRequest(
        asConfig({
          method: "post",
          url: ORDER_DRY_RUN,
          tastytradeRoute: preflight,
        }),
      ),
    ).toBe(false);
    expect(
      isMutatingRequest(
        asConfig({
          method: "post",
          url: ORDER_DRY_RUN_BY_ID,
          tastytradeRoute: preflight,
        }),
      ),
    ).toBe(false);
    // The margin pre-flight is a dry-run too (POST /margin/accounts/{n}/dry-run).
    expect(
      isMutatingRequest(
        asConfig({
          method: "post",
          url: `/margin/accounts/${ACCT}/dry-run`,
          tastytradeRoute: preflight,
        }),
      ),
    ).toBe(false);

    // And the half that is the whole point: the same paths, UNTAGGED, are
    // state-changing. /simulate-trade is here for the same reason — its
    // exemption was removed with the tool that posted to it, and now no string
    // can earn an exemption at all.
    expect(
      isMutatingRequest(asConfig({ method: "post", url: ORDER_DRY_RUN })),
    ).toBe(true);
    expect(
      isMutatingRequest(asConfig({ method: "post", url: SIMULATE_TRADE })),
    ).toBe(true);
    expect(
      isMutatingRequest(
        asConfig({ method: "delete", url: `/accounts/${ACCT}/orders/dry-run` }),
      ),
    ).toBe(true);
    expect(
      isMutatingRequest(
        asConfig({ method: "post", url: "/accounts/X/dry-run/submit" }),
      ),
    ).toBe(true);
  });

  it("fails closed when the request cannot be identified", () => {
    // A failure we cannot attribute is assumed to have possibly landed. Being
    // wrong in this direction costs a needless read; the other direction costs
    // a duplicated order.
    expect(isMutatingRequest(undefined)).toBe(true);
    expect(isMutatingRequest(asConfig({}))).toBe(true);
    expect(isMutatingRequest(asConfig({ method: "post" }))).toBe(true);
    // A malformed tag is not a licence either — only
    // `mutating === false` exempts, so an untagged or half-tagged write stays
    // on the cautious side.
    expect(
      isMutatingRequest(asConfig({ method: "post", tastytradeRoute: {} })),
    ).toBe(true);
  });

  it("keeps that fail-closed stance through the whole envelope", () => {
    const orphan = adaptRequestFailure({ code: AXIOS_TIMEOUT }, 30_000);
    expect(isToolErrorException(orphan)).toBe(true);
    const err = adaptError(orphan);
    expect(err.code).toBe("network");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/outcome is UNKNOWN/i);
  });
});

describe("deciding whether a write's outcome was established", () => {
  const WRITE = { method: "post", url: ORDERS };
  const READ = { method: "get", url: BALANCES };

  it("says no when a live write ended with no reply at all", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT"]) {
      expect(isUnestablishedWrite({ code, config: WRITE })).toBe(true);
    }
  });

  it("says yes only for the codes that prove nothing was dispatched", () => {
    for (const code of [
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ]) {
      expect(isUnestablishedWrite({ code, config: WRITE })).toBe(false);
    }
  });

  it("treats an unrecognised transport code as unestablished", () => {
    // The direction the whole module argues for: a code nobody enumerated is
    // not evidence of anything, and the cheap mistake is the cautious one.
    expect(isUnestablishedWrite({ code: "ESOMETHINGNEW", config: WRITE })).toBe(
      true,
    );
  });

  it("reads a 4xx as the origin refusing the request, and a 5xx as silence", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 499]) {
      expect(
        isUnestablishedWrite({ config: WRITE, response: { status } }),
      ).toBe(false);
    }
    for (const status of [500, 502, 503, 504]) {
      expect(
        isUnestablishedWrite({ config: WRITE, response: { status } }),
      ).toBe(true);
    }
  });

  it("never says yes about a read, however the read failed", () => {
    expect(isUnestablishedWrite({ code: "ECONNRESET", config: READ })).toBe(
      false,
    );
    expect(
      isUnestablishedWrite({ config: READ, response: { status: 504 } }),
    ).toBe(false);
    // A pre-flight is exempt because its call site
    // declared the route non-mutating, not because its URL ends in `dry-run`.
    expect(
      isUnestablishedWrite({
        code: "ECONNRESET",
        config: {
          method: "post",
          url: ORDER_DRY_RUN,
          tastytradeRoute: { mutating: false },
        },
      }),
    ).toBe(false);
    // The same failure with no declaration is a write in doubt — which is what
    // a caller-renamed segment would be able to talk this predicate out of.
    expect(
      isUnestablishedWrite({
        code: "ECONNRESET",
        config: { method: "post", url: ORDER_DRY_RUN },
      }),
    ).toBe(true);
  });

  it("declines to judge anything that is not a failed request", () => {
    // A bare value rethrown through the interceptor carries no request to
    // attribute, so claiming an order might be live would be invention.
    expect(isUnestablishedWrite(null)).toBe(false);
    expect(isUnestablishedWrite(undefined)).toBe(false);
    expect(isUnestablishedWrite("boom")).toBe(false);
    expect(isUnestablishedWrite(new Error("boom"))).toBe(false);
    expect(isUnestablishedWrite({ config: WRITE })).toBe(false);
  });

  it("still fails closed when a transport failure names no request", () => {
    // Config missing but a transport code present: something was dispatched and
    // we cannot say what it was, which is the fail-closed case isMutatingRequest
    // already decides.
    expect(isUnestablishedWrite({ code: "ECONNRESET" })).toBe(true);
  });
});

// ===========================================================================
// 3b. A redirected write, through the real transport
// ===========================================================================

/**
 * The one failure in this file that an injected adapter cannot model.
 *
 * `isUnestablishedWrite` lets exactly one class of write failure be reported as safe
 * to repeat: NEVER_DISPATCHED_ERROR_CODES, on the grounds that a connect-stage
 * failure proves not one byte reached a socket the broker was reading. That is
 * absolute, and true only of the FIRST connection. Following redirects puts a second
 * connection on the money path and both directions go silent — the redirect target
 * answers and `placeOrder` resolves with THAT host's body, an order id that is not
 * the broker's; or it is unreachable and the ECONNREFUSED comes from the redirect
 * leg, indistinguishable from a broker never reached, so the agent is told
 * `retryable: true` for an order the origin already has.
 *
 * Redirect following happens inside axios's transport, the one thing a fake adapter
 * replaces, so these use the real transport against loopback servers. Nothing leaves
 * the machine: the targets are literal `127.0.0.1` addresses, so no DNS and no
 * egress.
 */
describe("a write the origin answered with a redirect", () => {
  /** One loopback origin, plus what it saw. */
  interface Origin {
    port: number;
    requests: { method: string; url: string; body: string }[];
    close: () => Promise<void>;
  }

  const origins: Origin[] = [];

  /** Start a loopback HTTP server that answers every request via `respond`. */
  async function startOrigin(
    respond: (res: http.ServerResponse) => void,
  ): Promise<Origin> {
    const requests: Origin["requests"] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
        });
        respond(res);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const origin: Origin = {
      port: (server.address() as AddressInfo).port,
      requests,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
    origins.push(origin);
    return origin;
  }

  afterEach(async () => {
    for (const origin of origins.splice(0)) await origin.close();
  });

  /** A real-transport client pointed at a loopback origin. */
  function clientFor(port: number): TastytradeClient {
    return new TastytradeClient(
      { apiUrl: `http://127.0.0.1:${port}` },
      { tokenProvider: () => "test-access-token" },
    );
  }

  /** Place an order and return the ToolError it rejected with. */
  async function placeAndCatch(
    client: TastytradeClient,
  ): Promise<ToolError | { resolvedWith: unknown }> {
    try {
      return { resolvedWith: await client.placeOrder(ACCT, { legs: [] }) };
    } catch (e) {
      if (!isToolErrorException(e)) {
        throw new Error(
          `expected a ToolError, got ${String((e as Error)?.message ?? e)}`,
          { cause: e },
        );
      }
      return e.toolError;
    }
  }

  it("never lets a second host answer the order POST", async () => {
    const second = await startOrigin((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id: "FROM-SECOND-HOST" } }));
    });
    const origin = await startOrigin((res) => {
      res.writeHead(302, {
        location: `http://127.0.0.1:${second.port}/orders`,
      });
      res.end();
    });

    const result = await placeAndCatch(clientFor(origin.port));

    // The order POST really did reach the origin — this is not a pre-flight
    // refusal, it is the ambiguity that follows a dispatched write.
    expect(origin.requests).toHaveLength(1);
    expect(origin.requests[0].method).toBe("POST");
    // And the second host was never asked anything. Following the redirect it
    // answers, and its `{id: "FROM-SECOND-HOST"}` is returned as the placed order.
    expect(second.requests).toEqual([]);

    const err = result as ToolError;
    expect(err.code).toBe("upstream_error");
    expect(err.upstream?.status).toBe(302);
    expectAmbiguousWriteEnvelope(err);
  });

  it("does not blame an unreachable redirect target for a write the origin has", async () => {
    // Port 1 on loopback: nothing listens there, and the kernel refuses
    // immediately. Following the redirect produced ECONNREFUSED — a code
    // NEVER_DISPATCHED_ERROR_CODES reads as proof nothing was sent, for a
    // request the origin had already parsed and answered.
    const origin = await startOrigin((res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/orders" });
      res.end();
    });

    const err = (await placeAndCatch(clientFor(origin.port))) as ToolError;

    expect(origin.requests).toHaveLength(1);
    // The failure is attributed to the 302 the origin actually sent, not to a
    // connect error on a leg that must never be attempted.
    expect(err.code).toBe("upstream_error");
    expect(err.upstream?.status).toBe(302);
    expect(err.message).not.toContain("ECONNREFUSED");
    expectAmbiguousWriteEnvelope(err);
  });

  it("leaves a redirected read to the shared taxonomy, untouched", async () => {
    // The other direction of the fix. A read cannot be in doubt, so a 3xx on
    // one must NOT acquire the unknown-outcome envelope — this module hands it
    // back exactly as axios raised it and src/safety/errors.ts classifies it
    // like any other non-2xx. Pinned so nothing on the read path moved.
    const origin = await startOrigin((res) => {
      res.writeHead(301, { location: "http://127.0.0.1:1/balances" });
      res.end();
    });

    let raised: unknown;
    try {
      await clientFor(origin.port).getBalances(ACCT);
      throw new Error("expected the redirected read to reject");
    } catch (e) {
      raised = e;
    }

    // Not re-dressed as a ToolError by this client...
    expect(isToolErrorException(raised)).toBe(false);
    expect(
      (raised as { response?: { status?: number } }).response?.status,
    ).toBe(301);
    // ...because neither predicate claims it: a read is never in doubt.
    expect(isUnestablishedWrite(raised)).toBe(false);
    expect(adaptRequestFailure(raised, DEFAULT_HTTP_TIMEOUT_MS)).toBe(raised);
    // And the taxonomy above it says nothing about an unknown outcome.
    expect(adaptError(raised).message).not.toMatch(/outcome is UNKNOWN/i);
  });
});

// ===========================================================================
// 4. Malformed and hostile 2xx bodies
// ===========================================================================

describe("a 2xx whose body cannot be unwrapped", () => {
  /**
   * Each row is a body the client's `response.data.data` chain cannot read.
   *
   * Two distinct failures, and the second is nastier. On the `.data.data.items`
   * methods every row throws a raw `TypeError` which `adaptError` flattens into an
   * `upstream_error` carrying a JavaScript diagnostic for a message. On the
   * `.data.data` methods only a null or absent body throws: a 204, a proxy's HTML page,
   * an array or a bare number all read as `undefined` and return as a SUCCESSFUL "no
   * data" result — the server telling an agent "your account has no balances" because a
   * load balancer answered.
   *
   * Both land on one taxonomy code that describes the reply.
   */
  const UNREADABLE: ReadonlyArray<
    readonly [label: string, status: number, body: unknown]
  > = [
    ["a null body", 200, null],
    ["no body at all", 200, undefined],
    ["a 204 No Content", 204, ""],
    [
      "a text body (a proxy or WAF answering)",
      200,
      "<html>503 from squid</html>",
    ],
    ["a top-level JSON array", 200, [{ "account-number": ACCT }]],
    ["a bare JSON number", 200, 0],
    ["a JSON object with no `data` member", 200, { errors: [] }],
  ];

  it.each(UNREADABLE)(
    "surfaces %s as a taxonomy code, not a TypeError",
    async (_label, status, body) => {
      h = await createHarness({
        routes: [
          {
            matcher: BALANCES,
            method: "GET",
            reply: { status, data: body, raw: true },
          },
        ],
      });

      // `envelope` fails the test unless the result came back with `isError`
      // set, which is the assertion that catches the quieter of the two old
      // behaviours: a `.data.data` method returning an unreadable body as a
      // successful `null` — an agent told an account has no balances because a
      // proxy answered. Every row below covers it, the HTML one included.
      const err = await envelope(h, "tastytrade_get_balances", {
        account_number: ACCT,
      });

      expect(err.code).toBe("upstream_error");
      // The message describes the reply, not our stack.
      expect(err.message).not.toMatch(/Cannot read propert/i);
      expect(err.message).not.toMatch(/undefined is not an object/i);
      expect(err.message).toMatch(/could not be read/i);
      // The status the broker actually sent is preserved for diagnosis.
      expect(err.upstream?.status).toBe(status);
      // A read: nothing changed, so retrying is reasonable.
      expect(err.retryable).toBe(true);
      expect(err.message).toMatch(/No state was changed/i);
    },
  );

  it("does the same for the `.data.data.items` chain", async () => {
    // Two different unwrap depths exist in the client; the guard sits above both
    // rather than at the ~90 call sites.
    h = await createHarness({
      routes: [
        { matcher: ACCOUNTS, method: "GET", reply: { data: null, raw: true } },
      ],
    });

    const err = await envelope(h, "tastytrade_get_accounts");
    expect(err.code).toBe("upstream_error");
    expect(err.message).not.toMatch(/Cannot read propert/i);
  });

  it("quotes a short excerpt of a text body, because the intermediary is the diagnosis", async () => {
    // "Which box answered instead of tastytrade" is the whole question when a
    // proxy or WAF intercepts, so a peek at the page is kept — truncated, so a
    // full HTML document cannot flood the agent's context.
    const page = `<html><head><title>Blocked</title></head><body>${"x".repeat(5000)}</body></html>`;
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { status: 200, data: page, raw: true },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(String(err.upstream?.body)).toContain("Blocked");
    expect(String(err.upstream?.body).length).toBeLessThanOrEqual(200);
  });

  it("says the outcome is unknown when the unreadable reply was a write", async () => {
    // The honest reading: the broker may well have accepted the order and merely
    // failed to describe it. This is the same ambiguity as a timeout, arriving
    // by a different route, and it gets the same answer.
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { data: DRY_RUN_REPLY },
        },
        {
          matcher: ORDERS,
          method: "POST",
          reply: { status: 204, data: "", raw: true },
        },
      ],
    });

    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };
    const err = await envelope(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    expect(err.code).toBe("upstream_error");
    expect(err.upstream?.status).toBe(204);
    expectAmbiguousWriteEnvelope(err);
  });
});

describe("bodies that are empty but well-formed still pass through", () => {
  // The guard has to stay narrow. A legitimately empty result is CONTENT, and
  // the safety layer depends on telling "the dry-run returned nothing" apart
  // from "the dry-run failed" — conflating the two would either mint a token
  // against nothing or refuse orders the broker was happy with.
  it("hands `{data: null}` to the handler untouched", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { data: { data: null }, raw: true },
        },
      ],
    });

    await expect(
      callOk(h, "tastytrade_get_balances", { account_number: ACCT }),
    ).resolves.toBeNull();
  });

  it("hands an `items` that is not an array to the handler untouched", async () => {
    // Degrades cleanly on its own — the value is simply returned, no dereference
    // happens, and inventing a rejection here would break the null-items case
    // that resources reads rely on. Pinned so nobody "fixes" it into an error.
    h = await createHarness({
      routes: [
        {
          matcher: ACCOUNTS,
          method: "GET",
          reply: { data: { data: { items: "not-a-list" } }, raw: true },
        },
      ],
    });

    await expect(callOk(h, "tastytrade_get_accounts")).resolves.toBe(
      "not-a-list",
    );
  });

  it("hands `{data: {items: null}}` to the handler untouched", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: ACCOUNTS,
          method: "GET",
          reply: { data: { data: { items: null } }, raw: true },
        },
      ],
    });

    await expect(callOk(h, "tastytrade_get_accounts")).resolves.toBeNull();
  });

  it("accepts a 204 on a DELETE, which is a documented tastytrade answer", async () => {
    // `DELETE /quote-alerts/{id}` genuinely answers 204 No Content
    // (open-api-spec/quote-alerts.md). A guard that refused every empty body
    // would break that tool against the live API while every offline test stayed
    // green — the exact shape of over-tightening worth pinning against. A 204 is
    // also an ACKNOWLEDGED success, so there is no unknown outcome to report.
    h = await createHarness({
      routes: [
        {
          matcher: "/quote-alerts/12345",
          method: "DELETE",
          reply: { status: 204, data: "", raw: true },
        },
      ],
    });

    // listTools() first, and it is load-bearing rather than tidiness. The SDK
    // compiles its per-tool output validator in cacheToolMetadata(), which runs
    // ONLY from Client.listTools(); without the round trip getToolOutputValidator
    // returns undefined and the whole check is skipped. This test was written to
    // pin the carve-out and could not see that the tool was broken one layer up
    // — the api-client accepted the 204 correctly and the CLIENT then threw
    // -32600 because no structuredContent came back. Arming it is what makes
    // `isError` mean anything here.
    expect((await h.client.listTools()).tools.length).toBeGreaterThan(0);

    const res = (await h.client.callTool({
      name: "tastytrade_delete_quote_alert",
      arguments: { alert_external_id: "12345" },
    })) as { isError?: boolean; structuredContent?: unknown };
    expect(res.isError).toBeFalsy();
    // The empty acknowledgement, said in the dialect the outputSchema declares.
    expect(res.structuredContent).toEqual({});
    expect(h.lastRequest()?.method).toBe("DELETE");
  });

  it("still refuses a DELETE answered with a text body", async () => {
    // The carve-out is for an EMPTY body only. A proxy page arriving on a
    // destructive request is not an acknowledgement of anything.
    h = await createHarness({
      routes: [
        {
          matcher: "/quote-alerts/12345",
          method: "DELETE",
          reply: {
            status: 200,
            data: "<html>gateway timeout</html>",
            raw: true,
          },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_delete_quote_alert", {
      alert_external_id: "12345",
    });
    expect(err.code).toBe("upstream_error");
    expect(err.message).toMatch(/outcome is UNKNOWN/i);
  });

  it("accepts an empty envelope, which is what most tools legitimately get", async () => {
    h = await createHarness({
      routes: [{ matcher: BALANCES, method: "GET", reply: { data: {} } }],
    });

    await expect(
      callOk(h, "tastytrade_get_balances", { account_number: ACCT }),
    ).resolves.toEqual({});
  });
});

// ===========================================================================
// 5. The token endpoint stalling, through a real tool call
// ===========================================================================

describe("the token endpoint stalling", () => {
  /**
   * A server with real OAuth credentials and NO injected token provider, so the
   * OAuth client is genuinely in the request path. This is the one place the
   * shared harness cannot reach: it stubs the token provider by design.
   */
  async function bootWithRealOAuth(): Promise<{
    client: Client;
    apiRequests: string[];
    close(): Promise<void>;
  }> {
    const apiRequests: string[] = [];
    const adapter: HttpAdapter = async (config: AxiosRequestConfig) => {
      apiRequests.push(
        `${(config.method ?? "get").toUpperCase()} ${config.url}`,
      );
      return {
        data: { data: { items: [] } },
        status: 200,
        statusText: "200",
        headers: {},
        config,
      } as AxiosResponse;
    };
    const server = new TastytradeMCPServer(
      {
        apiUrl: API_URL,
        clientId: "id",
        clientSecret: "secret",
        refreshToken: "refresh",
      },
      { adapter },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resilience", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return { client, apiRequests, close: () => client.close() };
  }

  it("becomes a retryable `network` envelope that states nothing was sent", async () => {
    jest.spyOn(axios, "post").mockImplementation((async () => {
      const err = new Error("timeout of 30000ms exceeded") as Error & {
        code: string;
        isAxiosError: boolean;
      };
      err.code = AXIOS_TIMEOUT;
      err.isAxiosError = true;
      throw err;
    }) as never);

    const server = await bootWithRealOAuth();
    try {
      const res = (await server.client.callTool({
        name: "tastytrade_get_accounts",
        arguments: {},
      })) as { isError?: boolean; content?: Array<{ text?: string }> };

      expect(res.isError).toBe(true);
      const err = JSON.parse(res.content?.[0]?.text ?? "{}") as ToolError;
      // Not `upstream_error`: the token endpoint did not answer, it stalled.
      expect(err.code).toBe("network");
      // A credential exchange moves nothing, so this one IS safe to repeat.
      expect(err.retryable).toBe(true);
      expect(err.message).toMatch(/token endpoint did not respond/i);
      // The load-bearing claim: no order, no request, no state.
      expect(err.message).toMatch(/no request reached the trading API/i);
      expect(err.message).toMatch(/nothing on the account was changed/i);
      // And the credential never appears in what the agent is handed.
      expect(JSON.stringify(err)).not.toContain("secret");
      expect(JSON.stringify(err)).not.toContain("refresh");

      // Proof of the claim: the API adapter was never reached.
      expect(server.apiRequests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("keeps a token-endpoint timeout out of the auth_failed bucket", async () => {
    // A stall is not a credential problem. Reporting it as `auth_failed` would
    // send the operator to check secrets that are perfectly fine.
    jest.spyOn(axios, "post").mockImplementation((async () => {
      const err = new Error("timeout") as Error & { code: string };
      err.code = "ETIMEDOUT";
      throw err;
    }) as never);

    const oauth = new TastytradeOAuthClient({
      apiUrl: API_URL,
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });

    const mapped = await oauth
      .getAccessToken()
      .then(() => undefined)
      .catch((e: unknown) => adaptError(e));

    // `network`, not `auth_failed`: nothing about the credentials is in doubt.
    expect(mapped?.code).toBe("network");
    expect(mapped?.upstream).toBeUndefined();
    expect(mapped?.hint ?? "").toContain(HTTP_TIMEOUT_ENV_VAR);
  });
});

// ---------------------------------------------------------------------------
// The third way a call can fail without the broker being involved
// ---------------------------------------------------------------------------

/**
 * A stall and an unreadable reply are both faults of the far end. This one is not:
 * the argument itself cannot be written into a URL, so no request is built, nothing
 * leaves the process, and the broker is never asked.
 *
 * It still reaches the agent as `upstream_error`, because `encodeURIComponent` throws
 * a plain `TypeError` on a value with no primitive conversion and `adaptError()` has
 * nothing better to do with a plain Error. So the agent is told the broker failed, in
 * a JavaScript internal message, about a call that never happened — and every remedy
 * that reading suggests is wasted, while the one that works is ruled out.
 *
 * `{"toString": 1, "valueOf": 2}` is the whole exploit: `JSON.parse` keeps it, a JSON
 * Schema `type: "string"` is advisory, and the dispatcher passes
 * `args.account_number` to the client as it arrived.
 */
describe("an argument that cannot be rendered is the caller's fault", () => {
  /** Parsed, not written as a literal — this is a value an agent can send. */
  const UNRENDERABLE = JSON.parse('{"toString": 1, "valueOf": 2}');

  it("comes back as `validation`, not as a broken broker", async () => {
    h = await createHarness();

    const err = await envelope(h, "tastytrade_get_account", {
      account_number: UNRENDERABLE,
    });

    expect(err.code).toBe("validation");
    // Not retryable, and for the honest reason: the identical call cannot ever
    // succeed. (`upstream_error` said not-retryable too, but paired with "the
    // broker is broken" it reads as "wait and try later".)
    expect(err.retryable).toBe(false);
  });

  it("names the argument instead of quoting the interpreter", async () => {
    h = await createHarness();

    const err = await envelope(h, "tastytrade_get_account", {
      account_number: UNRENDERABLE,
    });

    expect(err.message).toContain("account_number");
    expect(err.message).not.toContain("Cannot convert object to primitive");
    expect(err.hint ?? "").toMatch(/argument/i);
  });

  it("never reaches the transport, so the account is provably untouched", async () => {
    h = await createHarness();

    await envelope(h, "tastytrade_get_account", {
      account_number: UNRENDERABLE,
    });

    // The claim the envelope makes out loud, checked against the wire.
    expect(h.requests).toEqual([]);
  });

  it("refuses a destructive call the same way, before anything is sent", async () => {
    // Worth its own case: on a cancel, "the broker may or may not have acted"
    // is the expensive ambiguity, and there is none here — the request was
    // never built. A DELETE that was never issued must not inherit the
    // unknown-outcome envelope.
    h = await createHarness();

    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: UNRENDERABLE,
    });

    expect(err.code).toBe("validation");
    expect(err.message).toContain("order_id");
    expect(err.message).not.toMatch(/UNKNOWN/);
    expect(h.requests).toEqual([]);
  });

  it("leaves a perfectly renderable account number working", async () => {
    // Localises the refusal to the unrenderable value rather than to the tool.
    h = await createHarness({
      routes: [
        {
          matcher: `/customers/me/accounts/${ACCT}`,
          method: "GET",
          reply: { data: { "account-number": ACCT } },
        },
      ],
    });

    await expect(
      callOk(h, "tastytrade_get_account", { account_number: ACCT }),
    ).resolves.toMatchObject({ "account-number": ACCT });
    expect(h.requests.map((r) => r.url)).toEqual([
      `/customers/me/accounts/${ACCT}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// A state-changing 2xx that carries no entity
// ---------------------------------------------------------------------------
//
// `assertReadableResponse` already refuses a 2xx with no `data` member, so what
// reaches the write methods is an envelope that is PRESENT. Several such envelopes
// still name no order — `{data: null}`, `{data: {}}`, and the non-object
// `{data: []}` / `{data: "OK"}` — a status line saying "done" over a body that says
// nothing about what was done.
//
// A tolerant unwrap makes `{data: null}` come back as a truthy object, the dispatcher
// spreads it, and the agent gets `{"data": null, "sanity_warnings": []}` with no
// error flag. `{data: {}}` survives a guard that asks only whether the entity is
// null: `place_complex_order` answers `isError: false` with `{"sanity_warnings": []}`
// and NOTHING else, and because that tool requires only `sanity_warnings` in its
// outputSchema, a client with its validator armed ACCEPTS it — a live multi-leg
// strategy reported as placed, with nothing in the response to cancel it by.
//
// Either way the agent is told the write succeeded and handed nothing to act on, and
// the natural recovery of calling the tool again is the resubmission that duplicates
// a position, because the token was consumed before the request went out.

describe("a submit whose 2xx carries no order", () => {
  const ORDER_ID = "1075264";
  const COMPLEX_ID = "56544";

  /**
   * The bodies a submit must refuse, and why they are ONE case rather than two.
   *
   * A guard that asks only `entity != null` waves `{data: {}}` through — an envelope
   * that is PRESENT but says nothing. Driven end to end that produces the exact harm
   * this block exists to stop: `place_complex_order` answering `isError: false` with
   * `{"sanity_warnings": []}` and no order id, accepted even by a validating client,
   * with the confirmation token already burnt. The non-object shapes are worse still,
   * because the dispatcher SPREADS the entity, so `{data: []}` and `{data: "OK"}`
   * become `{}` and `{"0":"O", …}`.
   *
   * So the rule is not "not null" but "carries something to act on".
   */
  const NO_ENTITY_BODIES: ReadonlyArray<readonly [string, RouteReply]> = [
    ["a null entity", { data: { data: null }, raw: true }],
    ["an empty entity", { data: { data: {} }, raw: true }],
    ["an array entity", { data: { data: [] }, raw: true }],
    ["a string entity", { data: { data: "OK" }, raw: true }],
    ["a numeric entity", { data: { data: 0 }, raw: true }],
  ];

  const DRY_RUN = {
    order: { id: 1, status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };
  /**
   * What a complex dry-run really answers with.
   *
   * This route would reply `{warnings: [], "buying-power-effect": {}}`, which
   * no endpoint produces: an EMPTY buying-power-effect and no `complex-order`
   * is a payload that proves nothing was priced. `describedAnOrder` refuses to
   * mint a token for it, correctly — that is the whole point of the guard — so
   * the double had to become realistic rather than the guard lenient. Shaped
   * after the recorded capture in
   * test/e2e/_payloads/tastytrade_dry_run_complex_order.json.
   */
  const COMPLEX_DRY_RUN = {
    "complex-order": {
      "account-number": ACCT,
      type: "OCO",
      orders: [{ id: 1, status: "Received" }],
    },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };

  const LEG = {
    symbol: "AAPL",
    instrument_type: "Equity",
    action: "Buy to Open",
    quantity: 1,
  };
  const PLACE_ARGS = {
    account_number: ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "10.00",
    price_effect: "Debit",
    legs: [LEG],
  };
  const COMPLEX_ARGS = {
    account_number: ACCT,
    type: "OCO",
    orders: [
      {
        order_type: "Limit",
        time_in_force: "Day",
        price: "10.00",
        price_effect: "Debit",
        legs: [LEG],
      },
    ],
  };
  const REPLACE_ARGS = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.05",
    price_effect: "Debit",
  };
  const EDIT_COMPLEX_ARGS = {
    account_number: ACCT,
    complex_order_id: COMPLEX_ID,
    ratio_price_threshold: 0.98,
  };

  function routes(noEntity: RouteReply): Route[] {
    return [
      {
        matcher: /\/accounts\/[^/]+\/position-limit$/,
        method: "GET",
        reply: { data: {} },
      },
      {
        matcher: /\/accounts\/[^/]+\/trading-status$/,
        method: "GET",
        reply: { data: {} },
      },
      {
        matcher: `/accounts/${ACCT}/orders/dry-run`,
        method: "POST",
        reply: { data: DRY_RUN },
      },
      {
        matcher: `/accounts/${ACCT}/orders`,
        method: "POST",
        reply: noEntity,
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
        method: "POST",
        reply: { data: DRY_RUN },
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
        method: "PUT",
        reply: noEntity,
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
        method: "PATCH",
        reply: noEntity,
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/dry-run`,
        method: "POST",
        reply: { data: COMPLEX_DRY_RUN },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders`,
        method: "POST",
        reply: noEntity,
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
        method: "POST",
        reply: { data: COMPLEX_DRY_RUN },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
        method: "PATCH",
        reply: noEntity,
      },
    ];
  }

  const SUBMITS: ReadonlyArray<
    readonly [string, string, string, Record<string, unknown>]
  > = [
    [
      "place_order",
      "tastytrade_dry_run_order",
      "tastytrade_place_order",
      PLACE_ARGS,
    ],
    [
      "place_complex_order",
      "tastytrade_dry_run_complex_order",
      "tastytrade_place_complex_order",
      COMPLEX_ARGS,
    ],
    [
      "replace_order",
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      REPLACE_ARGS,
    ],
    [
      "edit_order",
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      REPLACE_ARGS,
    ],
    [
      "edit_complex_order",
      "tastytrade_dry_run_edit_complex_order",
      "tastytrade_edit_complex_order",
      EDIT_COMPLEX_ARGS,
    ],
  ];

  const CASES = NO_ENTITY_BODIES.flatMap(([shape, body]) =>
    SUBMITS.map(
      ([label, dryRunTool, liveTool, args]) =>
        [`${label} + ${shape}`, body, dryRunTool, liveTool, args] as const,
    ),
  );

  it.each(CASES)(
    "%s reports it as an unknown outcome, not as a success",
    async (_label, body, dryRunTool, liveTool, args) => {
      h = await createHarness({ routes: routes(body) });
      const dry = (await callOk(h, dryRunTool, args)) as {
        confirmation_token: string | null;
      };
      expect(typeof dry.confirmation_token).toBe("string");

      const err = (await callError(h, liveTool, {
        ...args,
        confirmation_token: dry.confirmation_token,
      })) as unknown as ToolError;

      expect(err.code).toBe("upstream_error");
      // The three things the envelope has to carry on an unacknowledged write.
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/outcome is UNKNOWN/i);
      expect(err.message).toMatch(/Do NOT resubmit/i);
      expect(err.hint).toMatch(/live orders/i);
    },
  );

  /**
   * The same refusal, judged by a client whose output validator is COMPILED.
   *
   * `place_complex_order` has to carry this test, because it is the one no client-side
   * schema catches: its outputSchema requires only `sanity_warnings`, so a success
   * envelope with nothing else validates cleanly. Its single-order twin is caught
   * incidentally by `required: ["order", "sanity_warnings"]` — but as a bare `-32602`
   * with no `code` and no reconcile hint, and a non-validating client sees a plain
   * false success anyway.
   *
   * So the assertion is two-sided: the tool must fail SERVER-side with the structured
   * envelope, and the client must never have had to reject it. The `listTools()` round
   * trip compiles the validator inside the SDK, which is why the arming is asserted
   * too.
   */
  it("refuses server-side, not by tripping an armed client's output validator", async () => {
    h = await createHarness({
      routes: routes({ data: { data: {} }, raw: true }),
    });
    const listed = await h.client.listTools();
    expect(
      listed.tools.find((t) => t.name === "tastytrade_place_complex_order")
        ?.outputSchema,
    ).toBeDefined();

    const dry = (await callOk(
      h,
      "tastytrade_dry_run_complex_order",
      COMPLEX_ARGS,
    )) as { confirmation_token: string };

    const res = (await h.client.callTool({
      name: "tastytrade_place_complex_order",
      arguments: {
        ...COMPLEX_ARGS,
        confirmation_token: dry.confirmation_token,
      },
    })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ text?: string }>;
    };

    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content?.[0]?.text ?? "{}") as ToolError;
    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/outcome is UNKNOWN/i);
    // The tell that this is the SERVER refusing and not the client's validator:
    // a rejected structuredContent surfaces as a thrown -32602, never as a
    // structured envelope, so reaching this line at all is half the assertion.
    expect(res.structuredContent).toBeUndefined();
  });

  it("still returns the entity when the broker sends one", async () => {
    // The complement, and the line the guard must not cross: `{data: {...}}` is
    // a normal answer and must be unaffected.
    h = await createHarness({
      routes: [
        ...routes({ data: { data: null }, raw: true }).filter(
          (r) => r.matcher !== `/accounts/${ACCT}/orders`,
        ),
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { data: { order: { id: 9001, status: "Received" } } },
        },
      ],
    });
    const dry = (await callOk(h, "tastytrade_dry_run_order", PLACE_ARGS)) as {
      confirmation_token: string;
    };
    const out = (await callOk(h, "tastytrade_place_order", {
      ...PLACE_ARGS,
      confirmation_token: dry.confirmation_token,
    })) as { upstream: { order: { id: number } } };

    // The broker's payload is under `upstream`.
    expect(out.upstream.order.id).toBe(9001);
  });

  it("does not spread the refusal to the READ methods that need the tolerant dialect", async () => {
    // The twin check in the other direction, and the one round two got wrong by
    // making `getAccounts` strict "like its siblings": a read answering
    // `{data: null}` is a legitimate "no data", the safety layer depends on
    // telling that apart from a failure, and nine tests said so. Only the five
    // methods that SUBMIT refuse a null entity.
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "GET",
          reply: { data: { data: null }, raw: true },
        },
      ],
    });

    await expect(
      callOk(h, "tastytrade_get_order", {
        account_number: ACCT,
        order_id: ORDER_ID,
      }),
    ).resolves.toBeNull();
  });

  it("does not refuse a CANCEL that answers with no entity", async () => {
    // Also deliberate. An empty acknowledgement on a DELETE is ambiguous about
    // nothing — RFC 9110 §9.3.5 provides for saying exactly that — so a cancel
    // returns the empty acknowledgement rather than an unknown outcome. Making
    // the cancels refuse here would report a SUCCESSFUL risk-reducing call as a
    // failure the agent must go and reconcile.
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "DELETE",
          reply: { status: 204, data: "", raw: true },
        },
      ],
    });

    const res = (await h.client.callTool({
      name: "tastytrade_cancel_order",
      arguments: { account_number: ACCT, order_id: ORDER_ID },
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Who the unknown-outcome envelope is FOR
// ---------------------------------------------------------------------------

describe("the in-doubt envelope fires only where the doubt is real", () => {
  /**
   * The envelope is a claim about the world — "an order may already be live at
   * the exchange" — and its whole value is that the claim is true when it is
   * made. NEVER_DISPATCHED_ERROR_CODES already argues the point for a refused
   * connection: "an unknown-outcome envelope that fires on a plainly
   * unreachable host teaches an agent to discount the one that fires on a real
   * ambiguity." A POST that creates nothing is the same false positive by a
   * different route, and a POST that creates something other than an order is
   * a true warning wearing the wrong advice.
   */
  const RESET = "ECONNRESET";

  it("says nothing about orders when the margin dry-run's socket breaks", async () => {
    // POST /margin/accounts/{n}/dry-run prices a hypothetical position. It
    // routes nothing, and it is the one non-GET tool still served in read-only
    // mode — so the outcome of a failed one is not in doubt at all.
    h = await createHarness({
      routes: [
        {
          matcher: MARGIN_DRY_RUN,
          method: "POST",
          reply: { networkError: RESET },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_dry_run_margin_impact", {
      account_number: ACCT,
      legs: MARGIN_DRY_RUN_LEGS,
    });

    expect(err.code).toBe("network");
    expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
    expect(`${err.message} ${err.hint ?? ""}`).not.toMatch(/live orders/i);
    // Nothing was changed, so the identical call is safe to make again.
    expect(err.retryable).toBe(true);
  });

  it("keeps the doubt, and drops the orders, for a watchlist write", async () => {
    // A watchlist POST really can land unacknowledged, so the warning stays.
    // What must go is the advice: there is no order to reconcile, no fill to
    // look for, and no confirmation token that was spent.
    h = await createHarness({
      routes: [
        { matcher: WATCHLISTS, method: "POST", reply: { networkError: RESET } },
      ],
    });

    const err = await envelope(h, "tastytrade_create_watchlist", {
      name: "Movers",
      symbols: ["AAPL"],
    });

    expect(err.code).toBe("network");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/outcome is UNKNOWN/i);
    const advice = `${err.message} ${err.hint ?? ""}`;
    expect(advice).not.toMatch(/live orders/i);
    expect(advice).not.toMatch(/duplicate the order/i);
    expect(advice).not.toMatch(/confirmation token/i);
  });

  it("still names orders when the failed write really was one", async () => {
    // The contrast that makes the two above worth having.
    h = await createHarness({
      routes: [
        { matcher: ORDER, method: "DELETE", reply: { networkError: RESET } },
      ],
    });

    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    expect(err.message).toMatch(/outcome is UNKNOWN/i);
    expect(err.message).toMatch(/duplicate the order or the cancel/i);
    expect(`${err.message} ${err.hint ?? ""}`).toMatch(/live orders/i);
  });

  it("reports an unreadable margin dry-run reply as a read, not a write", async () => {
    // The second consumer of the same predicate: a 2xx whose body cannot be
    // unwrapped. It would inherit the identical order-flavoured warning.
    h = await createHarness({
      routes: [
        {
          matcher: MARGIN_DRY_RUN,
          method: "POST",
          reply: { status: 200, data: "<html>gateway</html>", raw: true },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_dry_run_margin_impact", {
      account_number: ACCT,
      legs: MARGIN_DRY_RUN_LEGS,
    });

    expect(err.code).toBe("upstream_error");
    expect(err.message).toMatch(/No state was changed/i);
    expect(err.retryable).toBe(true);
  });
});

describe("the two unknown-outcome wordings are assigned from the real endpoint set", () => {
  /**
   * `WRITE_OUTCOME_UNKNOWN_OTHER` ends with a flat assertion about the world: "This
   * endpoint routes no order, so no position can have moved." Whether that is true
   * depends entirely on which paths fall outside `/\/(complex-)?orders(\/|$)/`, and
   * nothing ties that regex to the set of paths this client can request. It is true
   * today; it stays true only if adding a non-GET endpoint forces someone to say which
   * side of the line it is on.
   *
   * So the paths are read out of src/api-client.ts rather than listed by hand. A new
   * `this.client.post(...)` with a path nobody has classified fails this block.
   *
   * Telling an agent "no position can have moved" after a failed order POST is the one
   * sentence that would stop it reconciling; the mirror image — sending it to
   * `get_live_orders` after a failed watchlist PUT — teaches it to stop believing the
   * envelope at all.
   */

  /** Every non-GET path shape the client can request, deduplicated. */
  const MUTATING_PATHS: readonly string[] = (() => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src", "api-client.ts"),
      "utf8",
    );

    // There are no interpolated path templates in the client: a path carrying caller
    // data is an array of parts handed to `apiPath`, which verifies the target it built.
    // So the shapes are read out of the part lists — a quoted literal contributes its own
    // segments, and a `seg(...)` entry contributes exactly one caller segment, rendered
    // as `X` because the SHAPE is the whole question.
    //
    // This derivation is what keeps the order/no-order split tied to the set of paths
    // the client can actually request, and the floor assertion below is what catches it
    // going quiet.

    /** `apiPath([...])`, `["…", seg("x", …)]` → `/literal/X`. */
    const shapeOf = (partList: string): string => {
      const segments: string[] = [];
      // One pass over the part list, taking quoted literals and seg() entries in
      // source order. A spread of a shared part list (`...ordersParts(a)`) is
      // resolved by the caller below before this runs.
      // The `seg(` branch comes FIRST and consumes its own quoted parameter
      // name, so a caller segment contributes exactly one `X` rather than an `X`
      // and a spurious literal named after the parameter.
      const PART = /\bseg\(\s*"[^"]*"|"([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = PART.exec(partList)) !== null) {
        if (m[1] !== undefined) {
          for (const piece of m[1].split("/")) {
            if (piece !== "") segments.push(piece);
          }
        } else {
          segments.push("X");
        }
      }
      return `/${segments.join("/")}`;
    };

    /** The shared part lists, so a spread of one can be expanded first. */
    const partLists = new Map<string, string>();
    for (const m of source.matchAll(
      /const (\w+Parts) = \([^)]*\): PathPart\[\] => (\[[^\]]*\]);/g,
    )) {
      partLists.set(m[1], m[2]);
    }
    /** Module-level `const NAME = "literal";` declarations, e.g. DRY_RUN. */
    const literals = new Map<string, string>();
    for (const m of source.matchAll(
      /^const ([A-Z][A-Z0-9_]*) = "([^"]*)";/gm,
    )) {
      literals.set(m[1], m[2]);
    }
    const expand = (partList: string): string => {
      let out = partList;
      for (let pass = 0; pass < partLists.size + 1; pass++) {
        const next = out.replace(
          /\.\.\.(\w+Parts)\(a\),?/g,
          (whole, name: string) => {
            const inner = partLists.get(name);
            return inner === undefined ? whole : `${inner.slice(1, -1)},`;
          },
        );
        if (next === out) break;
        out = next;
      }
      // A part named by a constant is still a literal segment; resolving it is
      // what keeps `dry-run` in the shape instead of silently dropping it and
      // deduplicating a pre-flight route into its own submit route.
      for (const [name, value] of literals) {
        out = out.replace(new RegExp(`\\b${name}\\b`, "g"), `"${value}"`);
      }
      return out;
    };

    const found: string[] = [];

    // (a) the non-GET verb calls, whose first argument is either a static string
    //     or an `apiPath([...])` part list.
    const CALL =
      /this\.client\.(?:post|put|patch|delete)\(\s*("[^"]*"|apiPath\((\[[^\]]*\])\))/gs;
    for (const m of source.matchAll(CALL)) {
      if (m[2] !== undefined) found.push(shapeOf(expand(m[2])));
      else found.push(m[1].slice(1, -1));
    }

    // (b) the gated ORDER routes, which declare their paths in GATED_ROUTES so
    //     the confirmation gate can be handed the same rendering the request
    //     uses. Their verb calls above resolve through the table, not a literal.
    const table = source.slice(source.indexOf("export const GATED_ROUTES"));
    for (const m of table.matchAll(
      /path: apiPath\((\[[^\]]*\]|\w+Parts\(a\))\)/gs,
    )) {
      const expr = m[1];
      found.push(
        shapeOf(expand(expr.startsWith("[") ? expr : `[...${expr},]`)),
      );
    }

    return [...new Set(found)].sort();
  })();

  /**
   * The paths that route no order, each with the reason it does not.
   *
   * Anything absent from this map has to match the order regex, and the test
   * below states that as an equality rather than a subset — so a new endpoint
   * cannot be quietly absorbed by either side.
   */
  const ROUTES_NO_ORDER: Readonly<Record<string, string>> = {
    "/quote-alerts": "creates a price alert; nothing is routed",
    "/quote-alerts/X": "deletes that alert",
    "/watchlists": "creates a named symbol list",
    "/watchlists/X": "replaces or deletes that list",
  };

  /**
   * The non-GET paths that create nothing at all, so no unknown-outcome
   * envelope fires for them in the first place — their call sites declare
   * `NON_MUTATING_ROUTE`, which the classifier reads one question earlier than
   * the order/other split. (this would be a suffix
   * match on the request path, which a caller-chosen segment could forge.)
   *
   * Kept in this block rather than assumed, because the two rules compose and
   * the composition is where a mistake hides: a path can be exempt from the
   * doubt, subject to it with the order advice, or subject to it without —
   * three outcomes from two predicates, and only the first two had a test.
   */
  const CREATES_NOTHING: Readonly<Record<string, string>> = {
    "/margin/accounts/X/dry-run": "prices margin for a hypothetical position",
  };

  it("reads a plausible number of non-GET endpoints out of the client", () => {
    // A broken extraction returns [] and every assertion below passes
    // vacuously. Sixteen distinct templates today; the floor is loose enough to
    // survive an endpoint being removed and tight enough to catch a regex that
    // stopped matching.
    expect(MUTATING_PATHS.length).toBeGreaterThanOrEqual(12);
  });

  it("classifies every one of them, and the order wording is the default", () => {
    const notOrders = MUTATING_PATHS.filter(
      (p) => !/\/(complex-)?orders(\/|$)/.test(p),
    );
    expect(notOrders).toEqual(
      [...Object.keys(ROUTES_NO_ORDER), ...Object.keys(CREATES_NOTHING)].sort(),
    );
  });

  it.each(Object.keys(ROUTES_NO_ORDER))(
    "%s gets the no-order advice, and it is true of it",
    (endpoint) => {
      const err = inDoubtEnvelope("POST", endpoint);
      // The doubt itself survives — the request may well have landed.
      expect(err.message).toMatch(/outcome is UNKNOWN/i);
      expect(err.retryable).toBe(false);
      // What must not survive is the order advice.
      const advice = `${err.message} ${err.hint ?? ""}`;
      expect(advice).not.toMatch(/live orders/i);
      expect(advice).not.toMatch(/confirmation token/i);
    },
  );

  it.each([
    "/accounts/X/orders",
    "/accounts/X/orders/X",
    "/accounts/X/complex-orders/X",
  ])("%s keeps the order advice", (endpoint) => {
    const err = inDoubtEnvelope("POST", endpoint);
    const advice = `${err.message} ${err.hint ?? ""}`;
    expect(advice).toMatch(/live orders/i);
    expect(advice).toMatch(/positions/i);
    // The sentence that must never appear on a path that DOES route an order.
    expect(advice).not.toMatch(/routes no order/i);
  });

  it.each(Object.keys(CREATES_NOTHING))(
    "%s raises no doubt to advise about",
    (endpoint) => {
      // The exemption comes from the tag the client's own
      // pre-flight method attaches, not from the path. `mutatingWhenUntagged`
      // below asserts the other half — the same path with no tag is in doubt.
      const err = inDoubtEnvelope("POST", endpoint, { mutating: false });
      // Nothing was created, so there is nothing to reconcile and the identical
      // call is safe. Firing the envelope here is the false positive
      // NEVER_DISPATCHED_ERROR_CODES argues against in api-client.ts.
      expect(err.message).not.toMatch(/outcome is UNKNOWN/i);
      expect(err.retryable).toBe(true);
    },
  );

  it.each(Object.keys(CREATES_NOTHING))(
    "%s is in doubt when nothing declared it a pre-flight",
    (endpoint) => {
      // This is the assertion the suffix match could not
      // make: the exemption is a property of the ROUTE THE CALL SITE CHOSE, so
      // the identical path reached with no declaration gets the doubt. That is
      // what stops `order_id: "dry-run"` buying a cancel an exemption.
      const err = inDoubtEnvelope("POST", endpoint);
      expect(err.message).toMatch(/outcome is UNKNOWN/i);
      expect(err.retryable).toBe(false);
    },
  );

  it("falls into the order wording when the path cannot be read at all", () => {
    // The documented default, and the only branch of the classifier no real
    // endpoint exercises — which is why mutating it to `return false` would
    // pass the whole suite. Over-warning about an order costs one wasted read;
    // under-warning about one costs a duplicated position, and an unattributable
    // failure is exactly when that asymmetry has to decide.
    const err = inDoubtEnvelope("POST", undefined);
    const advice = `${err.message} ${err.hint ?? ""}`;
    expect(advice).toMatch(/live orders/i);
    expect(advice).not.toMatch(/routes no order/i);
  });
});
