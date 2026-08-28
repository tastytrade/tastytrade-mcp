/**
 * Hostile input on the agent-facing surface.
 *
 * Every tool argument is attacker-influenced in practice — shaped by a prompt-injected
 * web page, a hostile instrument name, or a confused model — and two parts of this
 * server walk that input RECURSIVELY: the snake→kebab seam that builds every request
 * body, and the canonicalizer that computes the confirmation-token argsHash. So
 * arguments are treated here as untrusted bytes rather than a well-formed schema
 * instance.
 *
 * Each test asserts one of exactly three acceptable outcomes and never anything else:
 * a structured `ToolError` from the taxonomy; a correctly encoded request on the wire,
 * every hostile character percent-encoded in a path and every value valid JSON in a
 * body; or a protocol-level refusal from the SDK's own schema validation. Never a
 * crash, never a silently mangled order, and never a body carrying a key the agent
 * chose rather than one the translation seam chose.
 *
 * Everything runs offline; only the HTTP boundary is a route table.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { createHarness, callOk, callError, type Harness } from "./harness.js";
import { TastytradeClient } from "../../src/api-client.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import {
  _resetTokensForTest,
  canonicalize,
} from "../../src/safety/confirmation.js";
import {
  MAX_ARGUMENT_DEPTH,
  MAX_ECHOED_ARGUMENT_CHARS,
  snakeToKebabParams,
  buildOrderBody,
  buildComplexOrderBody,
  toWatchlistEntries,
} from "../../src/mcp-server/index.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCT = "5WX00001";

/**
 * A clean dry-run reply plus the account-state reads `runSanityChecks` performs,
 * so a hostile-argument order can be driven all the way to a live POST when a
 * test needs to prove what would actually reach the broker.
 */
const ORDER_ROUTES = [
  {
    matcher: /^\/accounts\/[^/]+\/orders\/dry-run$/,
    reply: {
      data: {
        warnings: [],
        errors: [],
        "buying-power-effect": { "change-in-buying-power": 100 },
      },
    },
  },
  {
    matcher: /^\/accounts\/[^/]+\/complex-orders\/dry-run$/,
    reply: {
      data: {
        warnings: [],
        errors: [],
        "buying-power-effect": { "change-in-buying-power": 100 },
      },
    },
  },
  {
    matcher: /^\/accounts\/[^/]+\/orders$/,
    method: "POST",
    reply: { data: { order: { id: "9001", status: "Received" } } },
  },
  {
    matcher: /^\/accounts\/[^/]+\/position-limit$/,
    reply: {
      data: { "equity-order-size": 100, "equity-option-order-size": 50 },
    },
  },
  {
    matcher: /^\/accounts\/[^/]+\/trading-status$/,
    reply: { data: { "is-frozen": false, "is-closing-only": false } },
  },
  { matcher: "/watchlists", method: "POST", reply: { data: { name: "wl" } } },
];

/** A well-formed order, the baseline every hostile variant deviates from. */
const GOOD_ORDER = {
  account_number: ACCT,
  order_type: "Limit",
  time_in_force: "Day",
  price: "1.00",
  price_effect: "Debit",
  legs: [
    {
      instrument_type: "Equity",
      symbol: "AAPL",
      action: "Buy to Open",
      quantity: 1,
    },
  ],
};

/**
 * Field names a hostile payload tries to smuggle onto `Object.prototype`. Read
 * off a bare `{}` after every pollution test: if any of them is defined, a
 * `__proto__` / `constructor` key reached an assignment target somewhere.
 */
const POLLUTION_PROBES = [
  "polluted",
  "per_page",
  "page_offset",
  "quantity",
  "instrument_type",
  "source",
  "account_number",
];

function expectNoPrototypePollution(): void {
  const bare = {} as Record<string, unknown>;
  for (const key of POLLUTION_PROBES) {
    expect(bare[key]).toBeUndefined();
  }
  // A `__proto__` key that landed on an assignment target would have REPLACED a
  // prototype rather than adding a property, which the probes above cannot see.
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  expect(Object.getPrototypeOf([])).toBe(Array.prototype);
}

/**
 * Builds args by JSON.parse rather than from a literal, on purpose: only
 * `JSON.parse` creates a real OWN `__proto__` property. A literal
 * `{ __proto__: x }` invokes the setter and sets the prototype instead, which is
 * a different (and much less interesting) thing to test. This is also exactly
 * what the stdio transport hands the server in production.
 */
function hostile(json: string): Record<string, unknown> {
  return JSON.parse(json);
}

/** `levels` objects nested one inside the next, deepest holding a scalar. */
function nest(levels: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = { a: value };
  return value;
}

/** A JSON text nested `levels` deep, built as text so no stack is used. */
function deepJsonText(levels: number): string {
  return `${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`;
}

let h: Harness;

beforeEach(async () => {
  _resetRateLimitsForTest();
  _resetTokensForTest();
  h = await createHarness({ routes: ORDER_ROUTES });
});

afterEach(async () => {
  await h.close();
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

/**
 * Re-point `h` at a credential that HOLDS the hostile account number under test.
 *
 * The dispatcher now refuses any call naming an account
 * the credential does not hold, and it does so BEFORE the path is built — so
 * without this, a test whose subject is what `apiPath` does to a CRLF or a NUL
 * inside an account number would measure the account-scope refusal instead, and
 * pass while proving nothing about encoding. Declaring the hostile value as held
 * keeps each of these tests pointed at the control it was written for.
 */
async function withHeldAccount(account: string): Promise<void> {
  await h.close();
  h = await createHarness({
    routes: ORDER_ROUTES,
    heldAccounts: [ACCT, account],
  });
}

/**
 * Calls a tool without asserting success or failure, and reports a protocol-level
 * rejection separately from an in-band `ToolError` — the two are different
 * outcomes and several tests turn on which one happened.
 */
async function attempt(
  name: string,
  args: unknown,
): Promise<{
  protocolRejected: boolean;
  isError: boolean;
  payload: any;
  text: string;
}> {
  try {
    const res = (await h.client.callTool({
      name,
      arguments: args as Record<string, unknown>,
    })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = res.content?.[0]?.text ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return {
      protocolRejected: false,
      isError: res.isError === true,
      payload,
      text,
    };
  } catch (e) {
    return {
      protocolRejected: true,
      isError: true,
      payload: null,
      text: (e as Error).message,
    };
  }
}

/**
 * The query string a positions read would actually put on the wire.
 *
 * The shared harness records `config.params` as an OBJECT, because a custom
 * axios adapter sits BELOW the point where axios turns params into a query
 * string — so an assertion on `request.params` says nothing at all about the
 * bytes that leave. This drives a real `TastytradeClient` over a one-shot
 * adapter and then invokes the very serializer `getPositions` handed axios
 * (axios normalizes a `paramsSerializer` function into `{ serialize }` before
 * any adapter sees the config), which is the function the real http adapter
 * calls to build the URL.
 */
async function serializedPositionsQuery(
  accountNumber: string,
  symbol: string,
): Promise<string> {
  let captured: AxiosRequestConfig | undefined;
  const client = new TastytradeClient(
    { apiUrl: "https://api.cert.tastyworks.com" },
    {
      adapter: async (config: AxiosRequestConfig) => {
        captured = config;
        return {
          data: { data: { items: [] } },
          status: 200,
          statusText: "200",
          headers: {},
          config,
        } as AxiosResponse;
      },
      tokenProvider: () => "test-access-token",
    },
  );
  await client.getPosition(accountNumber, symbol);
  const serializer = captured!.paramsSerializer as unknown as {
    serialize: (params: unknown) => string;
  };
  expect(typeof serializer?.serialize).toBe("function");
  return serializer.serialize(captured!.params);
}

/** Dry-run an order and return the confirmation token it minted, if any. */
async function dryRun(args: Record<string, unknown>): Promise<string | null> {
  const res = (await callOk(h, "tastytrade_dry_run_order", args)) as {
    confirmation_token: string | null;
  };
  return res.confirmation_token;
}

// ===========================================================================
// 1. Prototype pollution through the translation seam
// ===========================================================================

describe("prototype pollution through the translation seam", () => {
  /**
   * The structural reason this whole class of attack fails: every builder writes
   * a FIXED SET of output keys it chose itself, and reads the input only by
   * explicit name. There is no `for (key of input)` copy loop anywhere in the
   * seam, so no key the agent picked can become a key on the wire — whether it
   * is `__proto__`, `constructor`, `prototype`, or anything else.
   *
   * That is asserted directly here, on the builders, because it is the invariant
   * that has to hold rather than an accident of one payload's shape.
   */
  it("gives every builder hostile keys and gets back only whitelisted output keys", () => {
    const order = buildOrderBody(
      hostile(`{
        "order_type": "Limit", "time_in_force": "Day",
        "__proto__": { "polluted": "yes" },
        "constructor": { "prototype": { "polluted": "yes" } },
        "prototype": { "polluted": "yes" },
        "legs": [{
          "instrument_type": "Equity", "symbol": "AAPL",
          "action": "Buy to Open", "quantity": 1,
          "__proto__": { "polluted": "yes" },
          "constructor": "ctor", "prototype": "proto"
        }]
      }`),
    );
    expect(Object.keys(order)).toEqual([
      "time-in-force",
      "order-type",
      "source",
      "legs",
    ]);
    expect(Object.keys(order.legs![0]!)).toEqual([
      "instrument-type",
      "symbol",
      "action",
      "quantity",
    ]);
    // `hasOwn`, not `in`: every plain object inherits a `constructor`, so `in`
    // would be true even for a pristine body and prove nothing.
    expect(Object.hasOwn(order, "constructor")).toBe(false);
    expect(Object.hasOwn(order.legs![0]!, "constructor")).toBe(false);
    expect(Object.hasOwn(order, "__proto__")).toBe(false);

    const params = snakeToKebabParams(
      hostile(
        `{"__proto__":{"page_offset":99},"constructor":{"c":1},"prototype":{},"per_page":5}`,
      ),
    );
    expect(params).toEqual({ "per-page": 5 });

    const entries = toWatchlistEntries(
      hostile(
        `[{"symbol":"AAPL","__proto__":{"instrument_type":"Evil"},"constructor":"c"},"MSFT"]`,
      ),
    );
    // The injected instrument_type is not readable as an inherited property, so
    // the entry carries `undefined` and the client applies its Equity default.
    expect(entries).toEqual([
      { symbol: "AAPL", "instrument-type": undefined },
      { symbol: "MSFT" },
    ]);

    const complex = buildComplexOrderBody(
      hostile(`{
        "type": "OCO",
        "__proto__": { "source": "evil" },
        "constructor": { "c": 1 },
        "orders": [{
          "order_type": "Limit", "time_in_force": "Day", "constructor": "c",
          "legs": [{
            "symbol": "A", "instrument_type": "Equity",
            "action": "Buy to Open", "quantity": 1, "prototype": "p"
          }]
        }]
      }`),
    );
    expect(Object.keys(complex)).toEqual(["type", "source", "orders"]);
    // `source` is a real optional field on this body, and it is now written
    // unconditionally by the builder from a server-side constant — so the
    // injected prototype value cannot supply it or displace it.
    expect(complex.source).toBe("tastytrade-mcp/1.0");
    expect(Object.keys((complex.orders as any[])[0])).toEqual([
      "order-type",
      "time-in-force",
      "legs",
    ]);

    expectNoPrototypePollution();
  });

  it("carries no hostile key onto the wire for a dry-run order, and pollutes nothing", async () => {
    const res = await attempt(
      "tastytrade_dry_run_order",
      hostile(`{
        "account_number": "${ACCT}",
        "order_type": "Limit", "time_in_force": "Day",
        "price": "1.00", "price_effect": "Debit",
        "__proto__": { "polluted": "yes" },
        "prototype": { "polluted": "yes" },
        "legs": [{
          "instrument_type": "Equity", "symbol": "AAPL",
          "action": "Buy to Open", "quantity": 1,
          "__proto__": { "polluted": "yes" }, "prototype": "p"
        }]
      }`),
    );
    expect(res.isError).toBe(false);

    const body = h.lastRequest()!.body as Record<string, unknown>;
    expect(body).toEqual({
      "time-in-force": "Day",
      "order-type": "Limit",
      source: "tastytrade-mcp/1.0",
      price: "1.00",
      "price-effect": "Debit",
      legs: [
        {
          "instrument-type": "Equity",
          symbol: "AAPL",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    });
    expectNoPrototypePollution();
  });

  it("does not let a __proto__ payload SUPPLY a leg field it omitted", async () => {
    // The sharp version of the attack: rather than adding a key, hide the real
    // value on the prototype so a reader that walks the prototype chain sees a
    // quantity the agent's own visible arguments never mention.
    const res = await attempt(
      "tastytrade_dry_run_order",
      hostile(`{
        "account_number": "${ACCT}",
        "order_type": "Limit", "time_in_force": "Day",
        "legs": [{
          "instrument_type": "Equity", "symbol": "AAPL",
          "action": "Buy to Open",
          "__proto__": { "quantity": 9999 }
        }]
      }`),
    );
    expect(res.isError).toBe(false);

    const legs = (h.lastRequest()!.body as any).legs;
    // Absent, not 9999: an own `__proto__` property is inert on a plain object.
    expect(legs[0]).toEqual({
      "instrument-type": "Equity",
      symbol: "AAPL",
      action: "Buy to Open",
      quantity: undefined,
    });
    expect(Object.hasOwn(legs[0], "quantity")).toBe(false);
    expectNoPrototypePollution();
  });

  it("does not let a top-level __proto__ inject a query parameter", async () => {
    const res = await attempt(
      "tastytrade_search_orders",
      hostile(
        `{"account_number":"${ACCT}","__proto__":{"per_page":2000,"page_offset":7},"underlying_symbol":"AAPL"}`,
      ),
    );
    expect(res.isError).toBe(false);
    expect(h.lastRequest()!.params).toEqual({ "underlying-symbol": "AAPL" });
    expectNoPrototypePollution();
  });

  it("does not let a __proto__ payload forge a watchlist entry's instrument type", async () => {
    const res = await attempt(
      "tastytrade_create_watchlist",
      hostile(
        `{"name":"wl","symbols":[{"symbol":"AAPL","__proto__":{"instrument_type":"Evil"}}]}`,
      ),
    );
    expect(res.isError).toBe(false);
    expect(h.lastRequest()!.body).toEqual({
      name: "wl",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    });
    expectNoPrototypePollution();
  });

  /**
   * A `constructor` key is a special case worth pinning, because it never
   * reaches this server's code at all: the MCP SDK validates `params.arguments`
   * with a zod record schema whose plain-object test reads `value.constructor`,
   * so an own `constructor` key makes the whole `tools/call` fail validation.
   *
   * The consequence to be aware of is the error SHAPE, not a security gap: the
   * caller gets a JSON-RPC error rather than a `validation` envelope, because
   * the request never becomes a tool call. No bucket is charged and no request
   * is made, so it is refused strictly more cheaply than a dispatched call.
   */
  it("is refused by the SDK's own schema validation when `constructor` is a top-level key", async () => {
    const res = await attempt(
      "tastytrade_dry_run_order",
      hostile(
        `{"account_number":"${ACCT}","order_type":"Limit","time_in_force":"Day","constructor":{"x":1},"legs":[]}`,
      ),
    );
    expect(res.protocolRejected).toBe(true);
    expect(h.requests).toHaveLength(0);
    // Still callable afterwards: the rejection is per-request, not fatal.
    expect((await attempt("tastytrade_get_accounts", {})).isError).toBe(false);
    expectNoPrototypePollution();
  });

  it("drops a `constructor` or `prototype` key nested inside a leg, which the SDK does let through", async () => {
    const res = await attempt(
      "tastytrade_dry_run_order",
      hostile(`{
        "account_number": "${ACCT}",
        "order_type": "Limit", "time_in_force": "Day",
        "legs": [{
          "instrument_type": "Equity", "symbol": "AAPL",
          "action": "Buy to Open", "quantity": 1,
          "constructor": { "x": 1 }, "prototype": { "y": 2 }
        }]
      }`),
    );
    expect(res.protocolRejected).toBe(false);
    expect(res.isError).toBe(false);
    // This is the case that matters: the key DID reach the dispatcher, and the
    // whitelist builder still refused to copy it.
    expect((h.lastRequest()!.body as any).legs[0]).toEqual({
      "instrument-type": "Equity",
      symbol: "AAPL",
      action: "Buy to Open",
      quantity: 1,
    });
    expectNoPrototypePollution();
  });
});

// ===========================================================================
// 2. The recursive canonicalizer and a deep or wide object
// ===========================================================================

describe("deeply and widely nested arguments", () => {
  /**
   * Why the dispatcher guards depth at all. `canonicalize()` — the function that
   * produces the confirmation-token argsHash — key-sorts its input through a
   * `JSON.stringify` replacer, which recurses over native stack frames and is
   * NOT depth-limited. This pins the hazard directly, so the guard downstream of
   * it has a stated reason to exist.
   */
  it("is a real hazard: canonicalize() itself overflows the stack on a deep object", () => {
    expect(() => canonicalize(nest(100_000))).toThrow(RangeError);
    // And the transport side has no such limit, so the input is deliverable:
    // JSON.parse handles a million levels without complaint.
    expect(() => JSON.parse(deepJsonText(100_000))).not.toThrow();
  });

  it("refuses a 100,000-deep argument with `validation` and never makes a request", async () => {
    const err = await callError(h, "tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [
        {
          instrument_type: "Equity",
          symbol: JSON.parse(deepJsonText(100_000)),
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    });
    expect(err.code).toBe("validation");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain(String(MAX_ARGUMENT_DEPTH));
    // Not `upstream_error`: the caller's input is the problem, and saying so
    // stops an agent retrying against a broker it was told had failed.
    expect(h.requests).toHaveLength(0);
  });

  it("accepts nesting one level under the limit and refuses it one level over", async () => {
    // A scalar path parameter, not a leg: the guard walks the whole argument
    // object, so nesting is refused wherever it sits.
    //
    // The args object is depth 0, so `nest(n)` hung off a property reaches
    // depth n. MAX_ARGUMENT_DEPTH is the first depth refused.
    const under = await attempt("tastytrade_get_account", {
      account_number: nest(MAX_ARGUMENT_DEPTH - 1),
    });
    expect(under.isError).toBe(false);
    expect(h.requests).toHaveLength(1);

    const over = await attempt("tastytrade_get_account", {
      account_number: nest(MAX_ARGUMENT_DEPTH),
    });
    expect(over.isError).toBe(true);
    expect((over.payload as ToolError).code).toBe("validation");
    expect(h.requests).toHaveLength(1);
  });

  it("still accepts the deepest shape any tool legitimately declares", async () => {
    // args → orders[] → order → legs[] → leg → scalar is the deepest schema in
    // the surface. The guard must not be near it.
    const res = await attempt("tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OCO",
      orders: [
        {
          order_type: "Limit",
          time_in_force: "Day",
          price: "1.00",
          price_effect: "Debit",
          legs: [
            {
              symbol: "AAPL",
              instrument_type: "Equity",
              action: "Sell to Close",
              quantity: 1,
            },
          ],
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(res.payload.confirmation_token).toEqual(expect.any(String));
  });

  it("keeps deep input away from the confirmation canonicalizer entirely", async () => {
    // place_order canonicalizes {account_number, body} to check the argsHash. A
    // deep argument is refused by the pre-flight, so consumeToken — and the
    // unguarded recursion inside it — is never reached.
    const err = await callError(h, "tastytrade_place_order", {
      ...GOOD_ORDER,
      confirmation_token: "irrelevant",
      legs: [
        {
          instrument_type: "Equity",
          symbol: JSON.parse(deepJsonText(20_000)),
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    });
    // `validation`, not `upstream_error`: the caller's input is the problem,
    // and saying so stops an agent retrying against a broker it was told had
    // failed.
    expect(err.code).toBe("validation");
    expect(h.requests).toHaveLength(0);
  });

  it("handles a very WIDE argument without crashing, and the guard is depth-only", async () => {
    // 200,000 sibling keys is one level deep, so the depth guard has nothing to
    // say about it. It must be handled, not refused — width is bounded by the
    // transport and costs a linear walk, not a stack frame.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i;

    const res = await attempt("tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [
        {
          instrument_type: "Equity",
          symbol: wide,
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect(h.requests).toHaveLength(1);
    expectNoPrototypePollution();
  });

  it("survives a wide argument on a path parameter, encoding it rather than expanding it", async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) wide[`k${i}`] = i;

    const res = await attempt("tastytrade_get_account", {
      account_number: wide,
    });
    expect(res.isError).toBe(false);
    // Stringified shallowly, so 50,000 keys cost 26 characters of URL.
    expect(h.lastRequest()!.url).toBe(
      "/customers/me/accounts/%5Bobject%20Object%5D",
    );
  });
});

// ===========================================================================
// 3. Size and content abuse
// ===========================================================================

describe("oversized arguments", () => {
  it("percent-encodes a multi-megabyte path parameter in full, without truncating or crashing", async () => {
    // Half the payload is `/`, which is what makes this an encoding test at
    // all: three million 'A's — what this would send — are a string
    // `encodeURIComponent` returns untouched, so the old version demonstrated
    // the absence of truncation and nothing whatever about encoding.
    const big = "A/".repeat(1_500_000);
    expect(big).toHaveLength(3_000_000);
    await withHeldAccount(big);

    const res = await attempt("tastytrade_get_account", {
      account_number: big,
    });
    expect(res.isError).toBe(false);
    const prefix = "/customers/me/accounts/";
    const url = h.lastRequest()!.url;
    expect(url.startsWith(prefix)).toBe(true);

    // Faithful in both directions. Nothing was truncated — a silently dropped
    // tail would query a DIFFERENT account than the one asked for, and
    // rejecting an over-long URL is the upstream's job (414), not this
    // server's.
    expect(decodeURIComponent(url.slice(prefix.length))).toBe(big);
    // And every one of the 1.5 million slashes was encoded, so a payload that
    // is half separator is still ONE path segment rather than 1.5M of them.
    expect(url.split("/")).toHaveLength(5);
    // 1.5M 'A' at one character each, 1.5M '/' at three (`%2F`) each.
    expect(url.length).toBe(prefix.length + 1_500_000 + 1_500_000 * 3);
  });

  it("keeps the error envelope a fixed size when a multi-megabyte value is quoted back", async () => {
    // The symbol is echoed by the leg-action refusal. Unclipped, a 2 MB symbol
    // produced a 2 MB error envelope: work proportional to the input, and 2 MB
    // of attacker-authored text copied into the agent's transcript.
    const bigSymbol = "S".repeat(2_000_000);
    const err = await callError(h, "tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [
        {
          instrument_type: "Equity",
          symbol: bigSymbol,
          // Equity requires an open/close action, so this refuses and quotes
          // the symbol.
          action: "Buy",
          quantity: 1,
        },
      ],
    });
    expect(err.code).toBe("validation");
    expect(err.message.length).toBeLessThan(1_000);
    expect(err.message).toContain("S".repeat(MAX_ECHOED_ARGUMENT_CHARS));
    expect(err.message).not.toContain(
      "S".repeat(MAX_ECHOED_ARGUMENT_CHARS + 1),
    );
    // The real length is still reported, so an operator can see what happened.
    expect(err.message).toContain("2000000 chars");
    expect(h.requests).toHaveLength(0);
  });

  it("forwards 10,000 legs faithfully rather than truncating the order", async () => {
    const legs = Array.from({ length: 10_000 }, (_, i) => ({
      instrument_type: "Equity",
      symbol: `SYM${i}`,
      action: "Buy to Open",
      quantity: 1,
    }));
    const res = await attempt("tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs,
    });
    expect(res.isError).toBe(false);

    const body = h.lastRequest()!.body as any;
    // Silently dropping legs would be the dangerous outcome: an agent that
    // dry-ran a 10,000-leg order and got a clean verdict on a 4-leg one.
    expect(body.legs).toHaveLength(10_000);
    expect(body.legs[9_999]).toEqual({
      "instrument-type": "Equity",
      symbol: "SYM9999",
      action: "Buy to Open",
      quantity: 1,
    });
  });

  it("clips a multi-megabyte tool NAME, so an unknown-name call cannot be made expensive", async () => {
    const bigName = "Z".repeat(3_000_000);
    const err = await callError(h, bigName, {});
    expect(err.code).toBe("not_found");
    expect(err.message.length).toBeLessThan(500);
    expect(err.message).toContain("3000000 chars");
    expect(h.requests).toHaveLength(0);
  });
});

describe("hostile characters in a value that becomes part of a URL", () => {
  it("percent-encodes a NUL byte instead of passing a raw one to the transport", async () => {
    await withHeldAccount("5WX\u000012");
    await attempt("tastytrade_get_account", { account_number: "5WX\u000012" });
    const url = h.lastRequest()!.url;
    expect(url).toBe("/customers/me/accounts/5WX%0012");
    expect(url).not.toContain("\u0000");
  });

  it("percent-encodes CRLF, so a path parameter cannot smuggle a header or a second request", async () => {
    // The classic request-splitting payload. A raw CR/LF reaching the HTTP
    // layer inside a path is the one hostile character class that does not
    // merely corrupt the request — it appends to it. `encodeURIComponent`
    // turns both into %0D / %0A, so the whole payload stays one path segment.
    const splitting = "5WX\r\nX-Injected: 1\r\n\r\nGET /orders HTTP/1.1";
    await withHeldAccount(splitting);
    await attempt("tastytrade_get_account", { account_number: splitting });
    const url = h.lastRequest()!.url;

    expect(url).not.toContain("\r");
    expect(url).not.toContain("\n");
    // Still ONE path segment: the spaces and the `/` of the smuggled request
    // line are encoded too, so nothing after the account number can be read as
    // a header, a body or a second request line.
    expect(url).toBe(
      "/customers/me/accounts/5WX%0D%0AX-Injected%3A%201%0D%0A%0D%0AGET%20%2Forders%20HTTP%2F1.1",
    );
    expect(url.split("/")).toHaveLength(5);
  });

  it("percent-encodes RTL-override and zero-width characters in a watchlist name", async () => {
    // U+202E flips the display order of everything after it, and U+200B is
    // invisible — together they make "watch<RLO>list<ZWSP>" render as a
    // different name than the one that goes on the wire.
    const deceptive = "watch\u202Elist\u200B";
    await attempt("tastytrade_get_watchlist", { name: deceptive });
    const url = h.lastRequest()!.url;
    expect(url).toBe("/watchlists/watch%E2%80%AElist%E2%80%8B");
    expect(url).not.toContain("\u202E");
    expect(url).not.toContain("\u200B");
  });

  it("carries deceptive characters verbatim in a JSON body, without silently normalizing them", async () => {
    const deceptive = "watch\u202Elist\u200B";
    await attempt("tastytrade_create_watchlist", {
      name: deceptive,
      symbols: ["AAPL"],
    });
    // A body is JSON, not a URL, so encoding is JSON's job. What matters is that
    // the name is not silently rewritten into a different name.
    expect((h.lastRequest()!.body as any).name).toBe(deceptive);
  });

  it("neutralises a symbol that is entirely path traversal", async () => {
    await attempt("tastytrade_get_option_chain", { symbol: "../../" });
    const url = h.lastRequest()!.url;
    expect(url).toBe("/option-chains/..%2F..%2F");
    // The whole point: the slashes are encoded, so the request cannot climb out
    // of /option-chains/ into another endpoint.
    expect(url.startsWith("/option-chains/")).toBe(true);
    expect(url).not.toContain("../");
  });

  it("neutralises traversal in a symbol that reaches a query parameter", async () => {
    const traversal = "../../etc/passwd";
    await withHeldAccount(`../../${ACCT}`);
    await attempt("tastytrade_get_position", {
      account_number: `../../${ACCT}`,
      symbol: traversal,
    });
    const req = h.lastRequest()!;
    expect(req.url).toBe(`/accounts/..%2F..%2F${ACCT}/positions`);
    // The traversal arrived as a discrete query parameter rather than as part
    // of the path — but this is the params OBJECT the harness recorded, one
    // layer above the wire, so on its own it says nothing about serialization.
    expect(req.params.symbol).toBe(traversal);

    // So run the client's own paramsSerializer, the function axios would call
    // to build the URL, and assert the bytes: every slash and every dot-segment
    // percent-encoded inside one `symbol=` value, unable to reach the path.
    const query = await serializedPositionsQuery(`../../${ACCT}`, traversal);
    expect(query).toBe("symbol=..%2F..%2Fetc%2Fpasswd&include-marks=true");
    expect(query).not.toContain("/");
  });
});

describe("type confusion between the declared schema and what arrives", () => {
  it("stringifies an array supplied where a scalar path parameter is declared, without injecting a path segment", async () => {
    await attempt("tastytrade_get_account", {
      account_number: [ACCT, "OTHER"],
    });
    const url = h.lastRequest()!.url;
    // `String([a, b])` is "a,OTHER" — the comma is encoded and no extra `/`
    // appears, so a two-element array cannot become a two-segment path.
    expect(url).toBe(`/customers/me/accounts/${ACCT}%2COTHER`);
    expect(url.split("/")).toHaveLength(5);
  });

  it("forwards a number where a string is declared, and a string where a number is declared", async () => {
    await attempt("tastytrade_get_account", { account_number: 12345 });
    expect(h.lastRequest()!.url).toBe("/customers/me/accounts/12345");

    await attempt("tastytrade_search_orders", {
      account_number: ACCT,
      per_page: "50",
      page_offset: "0",
    });
    // Passed through with the type the agent sent. Query parameters are text on
    // the wire regardless, so this is a correctly encoded request, not a
    // coercion the server invented.
    expect(h.lastRequest()!.params).toEqual({
      "per-page": "50",
      "page-offset": "0",
    });
  });

  it("still builds a refusal for a value that has no primitive conversion at all", async () => {
    // `{"toString": 1}` shadows toString with a non-callable, and Object.prototype
    // .valueOf returns the object, so `String(value)` THROWS TypeError. That is
    // deliverable straight over JSON, and the code that reports the problem must
    // not be the code that fails on it.
    const err = await callError(h, "tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [
        {
          ...GOOD_ORDER.legs[0],
          quantity: JSON.parse(`{"toString":1,"valueOf":2}`),
        },
      ],
    });
    expect(err.code).toBe("validation");
    expect(err.message).toContain("[unrenderable value]");
    expect(h.requests).toHaveLength(0);
  });

  it("answers with a taxonomy error, not a crash, when such a value reaches a path parameter", async () => {
    // `encodeURIComponent` in the API client throws on the same value. It is
    // caught by the dispatcher's adapter, so the outcome is a structured error
    // and no request — the acceptable outcome — though the code lands on
    // `upstream_error` rather than naming the argument. Recorded so a future
    // change to that classification is a deliberate one.
    const err = await callError(h, "tastytrade_get_account", {
      account_number: JSON.parse(`{"toString":1,"valueOf":2}`),
    });
    expect(["validation", "upstream_error"]).toContain(err.code);
    expect(err.retryable).toBe(false);
    expect(h.requests).toHaveLength(0);
    // The connection survives it.
    expect((await attempt("tastytrade_get_accounts", {})).isError).toBe(false);
  });

  it("refuses an object or array supplied as a leg quantity", async () => {
    for (const quantity of [{ q: 1 }, [1], true, null] as unknown[]) {
      const err = await callError(h, "tastytrade_dry_run_order", {
        ...GOOD_ORDER,
        legs: [{ ...GOOD_ORDER.legs[0], quantity }],
      });
      expect(err.code).toBe("validation");
      expect(err.message).toContain("positive");
    }
    // None of the four reached the broker.
    expect(h.requests).toHaveLength(0);
  });

  it("never emits an invalid JSON token for NaN or Infinity", async () => {
    // JSON cannot express either, so these are only reachable from an in-process
    // client — but the wire body must stay parseable regardless.
    const err = await callError(h, "tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [{ ...GOOD_ORDER.legs[0], quantity: Number.NaN }],
    });
    expect(err.code).toBe("validation");

    const err2 = await callError(h, "tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [{ ...GOOD_ORDER.legs[0], quantity: Number.POSITIVE_INFINITY }],
    });
    expect(err2.code).toBe("validation");
    expect(h.requests).toHaveLength(0);

    // A non-finite value in a field with no numeric contract still serializes to
    // JSON `null` rather than the literal `NaN`, which would make the body
    // unparseable for the broker.
    await attempt("tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      price: Number.POSITIVE_INFINITY,
    });
    expect((h.lastRequest()!.body as any).price).toBeNull();
  });

  it("refuses the string forms of NaN and Infinity, which ARE deliverable over JSON", async () => {
    for (const quantity of ["NaN", "Infinity", "-Infinity", "", "abc"]) {
      const err = await callError(h, "tastytrade_dry_run_order", {
        ...GOOD_ORDER,
        legs: [{ ...GOOD_ORDER.legs[0], quantity }],
      });
      expect(err.code).toBe("validation");
    }
    expect(h.requests).toHaveLength(0);
  });
});

describe("leg quantity", () => {
  it("refuses a negative or zero quantity — direction comes from `action`, not the sign", async () => {
    for (const quantity of [-5, -0.5, 0]) {
      const err = await callError(h, "tastytrade_dry_run_order", {
        ...GOOD_ORDER,
        legs: [{ ...GOOD_ORDER.legs[0], quantity }],
      });
      expect(err.code).toBe("validation");
      expect(err.message).toContain("Leg 0");
    }
    expect(h.requests).toHaveLength(0);
  });

  it("accepts a fractional quantity, because cryptocurrency orders use them", async () => {
    const res = await attempt("tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [
        {
          instrument_type: "Cryptocurrency",
          symbol: "BTC/USD",
          action: "Buy to Open",
          quantity: 0.25,
        },
      ],
    });
    expect(res.isError).toBe(false);
    expect((h.lastRequest()!.body as any).legs[0].quantity).toBe(0.25);
  });

  it("accepts a numeric string, because the API does and agents send them", async () => {
    const res = await attempt("tastytrade_dry_run_order", {
      ...GOOD_ORDER,
      legs: [{ ...GOOD_ORDER.legs[0], quantity: " 3 " }],
    });
    expect(res.isError).toBe(false);
    // Forwarded verbatim rather than coerced: the value the agent sent is the
    // value the confirmation hash binds and the broker receives.
    expect((h.lastRequest()!.body as any).legs[0].quantity).toBe(" 3 ");
  });

  it("names the offending component when a complex order carries a bad quantity", async () => {
    const err = await callError(h, "tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OTOCO",
      trigger_order: {
        order_type: "Limit",
        time_in_force: "Day",
        legs: [{ ...GOOD_ORDER.legs[0], quantity: 1 }],
      },
      orders: [
        {
          order_type: "Limit",
          time_in_force: "Day",
          legs: [{ ...GOOD_ORDER.legs[0], quantity: 1 }],
        },
        {
          order_type: "Limit",
          time_in_force: "Day",
          legs: [{ ...GOOD_ORDER.legs[0], quantity: "not-a-number" }],
        },
      ],
    });
    expect(err.code).toBe("validation");
    expect(err.message).toContain("orders[1]");
    expect(h.requests).toHaveLength(0);
  });

  it("catches a bad quantity in a complex order's trigger order", async () => {
    const err = await callError(h, "tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OTO",
      trigger_order: {
        order_type: "Limit",
        time_in_force: "Day",
        legs: [{ ...GOOD_ORDER.legs[0], quantity: 0 }],
      },
    });
    expect(err.code).toBe("validation");
    expect(err.message).toContain("trigger_order");
    expect(h.requests).toHaveLength(0);
  });

  it("refuses at the boundary rather than relying on the position-limit check, which cannot compare an unparseable quantity", async () => {
    // The layer this protects: runSanityChecks compares
    // `Number(leg.quantity ?? 0) > limit`, and for an unparseable quantity that
    // is `NaN > limit` — false — so the local limit check would wave the order
    // through having compared nothing. Refusing at the door means the submit
    // path never sees a quantity that cannot be checked.
    const token = await dryRun(GOOD_ORDER);
    expect(token).toEqual(expect.any(String));

    const err = await callError(h, "tastytrade_place_order", {
      ...GOOD_ORDER,
      legs: [{ ...GOOD_ORDER.legs[0], quantity: { evil: 1 } }],
      confirmation_token: token!,
    });
    expect(err.code).toBe("validation");
    // Refused before the token was even consulted, so nothing was placed.
    expect(
      h.requests.filter(
        (r) => r.method === "POST" && r.url.endsWith("/orders"),
      ),
    ).toHaveLength(0);
  });

  it("still enforces the position limit for a parseable but absurd quantity", async () => {
    // The complement of the test above: a quantity that DOES parse is passed
    // through to the sanity layer, which is where the account's order-size limit
    // stops it. equity-order-size is 100 in these routes.
    const args = {
      ...GOOD_ORDER,
      legs: [{ ...GOOD_ORDER.legs[0], quantity: "1e9" }],
    };
    const token = await dryRun(args);
    expect(token).toEqual(expect.any(String));

    const err = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: token!,
    });
    expect(err.code).toBe("sanity_check_failed");
    expect(err.message).toContain("exceeds account order limit 100");
  });
});

/**
 * The confirmation gate itself is not re-tested here. Its two properties that
 * bear on hostile input — the argsHash binds the exact bytes, so a value cannot
 * be swapped between dry-run and submit, and a dry-run the broker refused mints
 * no token at all — are owned by test/e2e/confirmation.test.ts, which sweeps an
 * eleven-row tamper table (including "quantity 1 -> 100 (dry-run small, submit
 * large)") and a fourteen-row bogus-token table. What this file adds is the
 * other direction: that the hardening above has not made a legitimate order
 * unplaceable.
 */
describe("the confirmation binding under hostile input", () => {
  it("places the order unchanged when the hostile-looking arguments are in fact valid", async () => {
    // The control case. Hardening that refuses everything is not hardening.
    const args = {
      ...GOOD_ORDER,
      legs: [
        {
          instrument_type: "Equity",
          // A legitimate symbol that merely looks odd: dots, slashes and digits
          // all occur in real tastytrade symbology.
          symbol: "./ESZ4 EW4U4 240920P5300",
          action: "Buy to Open",
          quantity: 2,
        },
      ],
    };
    const token = await dryRun(args);
    const placed = (await callOk(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: token!,
    })) as any;
    // The broker's payload is under `upstream`.
    expect(placed.upstream.order.id).toBe("9001");
    const post = h.requests.filter(
      (r) => r.method === "POST" && r.url.endsWith("/orders"),
    );
    expect(post).toHaveLength(1);
    expect((post[0]!.body as any).legs[0].symbol).toBe(
      "./ESZ4 EW4U4 240920P5300",
    );
  });
});

// ===========================================================================
// 4. An unknown tool name
// ===========================================================================

describe("an unrecognised tool name", () => {
  /**
   * Recorded because it is the kind of thing a reviewer asks about: an unknown name is
   * refused WITHOUT charging any bucket, deliberately.
   *
   * The buckets meter calls that cost the BROKER. An unknown name is a registry miss
   * that never reaches HTTP, and since the name is clipped into a fixed-size envelope
   * the work is constant however large a name is sent. Each attempt still costs the
   * caller a full round-trip.
   *
   * The only bucket it could be billed to is the 50/sec GLOBAL cap — the per-endpoint
   * key comes from the tool name and the order cap from the annotation, and an unknown
   * name has neither. That is the worst of the three places to charge it, because
   * global is the bucket every other call draws on: fifty stale or hallucinated names in
   * a second would empty the aggregate, and the next legitimate read, write or cancel
   * would fail with a misleading `rate_limit_exceeded` for work that never left the
   * process.
   */
  it("is refused with not_found, charges nothing, and reaches no HTTP at all", async () => {
    for (let i = 0; i < 200; i++) {
      const err = await callError(h, `tastytrade_not_a_tool_${i}`, {
        account_number: ACCT,
      });
      expect(err.code).toBe("not_found");
      expect(err.retryable).toBe(false);
    }
    expect(h.requests).toHaveLength(0);

    // 200 attempts is four times the 50/sec global capacity, and every kind of
    // budget is still intact: a read with a per-endpoint ceiling of its own
    // (`accounts`, 1/sec), a write bounded by the global cap alone, and a
    // destructive call drawing on the internal order cap.
    expect((await attempt("tastytrade_get_accounts", {})).isError).toBe(false);
    expect(
      (
        await attempt("tastytrade_update_watchlist", {
          name: "wl",
          symbols: ["AAPL"],
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await attempt("tastytrade_cancel_order", {
          account_number: ACCT,
          order_id: "1",
        })
      ).isError,
    ).toBe(false);
  });
});
