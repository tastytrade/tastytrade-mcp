/**
 * End-to-end round trips for the ORDERS, POSITIONS and MARGIN tools — all 27 of them,
 * through the real MCP protocol and the real dispatcher, with the HTTP boundary
 * answered from a route table.
 *
 * Each test asserts three things, because those are the three places this server can
 * silently go wrong: the OUTBOUND request (verb and path, checked against
 * src/api-client.ts and the vendored spec); the snake_case → kebab-case translation
 * seam, where `snakeCaseKeyPaths()` fails the test if any underscore survives onto the
 * wire; and the UNWRAPPED result, since the client peels the API envelope off.
 *
 * The seven destructive tools are driven the honest way: call the matching dry-run,
 * take the `confirmation_token` it issued, then call the live tool with that token and
 * byte-identical args. Token FAILURE modes belong to test/e2e/confirmation.test.ts.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness, RecordedRequest, Route } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import { MCP_ORDER_SOURCE } from "../../src/mcp-server/index.js";

const ACCT = "5WX00001";
const ORDER_ID = "1075264";
const COMPLEX_ID = "56544";

/**
 * The attribution the dispatcher stamps on every order body the API documents
 * a `source` field on. Mirrors MCP_ORDER_SOURCE in src/mcp-server/index.ts;
 * kept as a literal here on purpose, so bumping the server-side constant has
 * to be a deliberate two-sided edit rather than something the tests follow
 * silently.
 */

let h: Harness | undefined;

/**
 * Two env vars change what the destructive tools do, so this suite pins them
 * rather than inheriting whatever the developer's shell happens to hold:
 * MAX_ORDER_NOTIONAL_USD is the sanity-check cap compared against the dry-run's
 * buying-power impact, and TASTYTRADE_READ_ONLY would withhold every write and
 * destructive tool outright.
 */
const PINNED_ENV = {
  MAX_ORDER_NOTIONAL_USD: "50000",
  TASTYTRADE_READ_ONLY: undefined,
} as const;
const priorEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(PINNED_ENV)) {
    priorEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Both of these live in module-level state shared by every harness in this
  // file. The destructive bucket only holds 5 tokens/min and this file places,
  // cancels, edits and replaces more than that, so without the reset the later
  // destructive tests would fail with rate_limit_exceeded instead of running.
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The whole conversation as "METHOD /path" lines — the round trip at a glance. */
function trace(harness: Harness): string[] {
  return harness.requests.map((r) => `${r.method} ${r.url}`);
}

function requestFor(
  harness: Harness,
  method: string,
  url: string,
): RecordedRequest {
  const hit = harness.requests.find(
    (r) => r.method === method && r.url === url,
  );
  if (!hit) {
    throw new Error(
      `No ${method} ${url} was sent. Observed: ${trace(harness).join(" | ") || "<nothing>"}`,
    );
  }
  return hit;
}

/**
 * Dotted paths of every object key that still contains an underscore. The
 * outbound payload must be pure kebab-case, so this returning anything at all
 * is a translation leak — and the path says exactly where.
 */
function snakeCaseKeyPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => snakeCaseKeyPaths(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([k, v]) => [
        ...(k.includes("_") ? [`${path}.${k}`] : []),
        ...snakeCaseKeyPaths(v, `${path}.${k}`),
      ],
    );
  }
  return [];
}

/** Asserts the request carries no snake_case key in either params or body. */
function expectKebabOnly(req: RecordedRequest): void {
  expect(snakeCaseKeyPaths(req.params, "params")).toEqual([]);
  expect(snakeCaseKeyPaths(req.body, "body")).toEqual([]);
}

/**
 * runSanityChecks() calls these two endpoints before every live placement
 * (src/safety/sanity-checks.ts). Routing them explicitly keeps the placement
 * tests' warning assertions honest: any sanity_warning must have come from the
 * dry-run payload, not from an unreachable-endpoint fallback.
 */
const POSITION_LIMIT = {
  "account-number": ACCT,
  "equity-order-size": 100,
  "equity-option-order-size": 100,
  "future-order-size": 100,
  "underlying-opening-order-limit": 100,
};

const CLEAN_TRADING_STATUS = {
  "account-number": ACCT,
  "is-frozen": false,
  "is-closing-only": false,
  "is-in-margin-call": false,
};

/**
 * The account-state read. every route that spends a
 * confirmation token now makes it, not just the two that carry legs, so the
 * three legless submit paths need it routed too.
 */
function accountStateRoute(): Route {
  return {
    matcher: `/accounts/${ACCT}/trading-status`,
    method: "GET",
    reply: { data: CLEAN_TRADING_STATUS },
  };
}

function sanityRoutes(): Route[] {
  return [
    {
      matcher: `/accounts/${ACCT}/position-limit`,
      method: "GET",
      reply: { data: POSITION_LIMIT },
    },
    accountStateRoute(),
  ];
}

// ---------------------------------------------------------------------------
// Order search & read
// ---------------------------------------------------------------------------

describe("order search: tastytrade_search_orders / tastytrade_get_orders", () => {
  const fixture = loadFixture("tastytrade_search_orders") as {
    items: Array<Record<string, unknown>>;
  };

  it("GETs /accounts/{n}/orders and kebab-cases the whole filter set", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const result = (await callOk(h, "tastytrade_search_orders", {
      account_number: ACCT,
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      start_at: "2026-06-01T00:00:00Z",
      end_at: "2026-06-30T23:59:59Z",
      status: ["Live", "Filled"],
      underlying_symbol: "AAPL",
      underlying_instrument_type: "Equity",
      futures_symbol: "/ESU9",
      sort: "Asc",
      page_offset: 1,
      per_page: 25,
    })) as Array<Record<string, unknown>>;

    const req = requestFor(h, "GET", `/accounts/${ACCT}/orders`);
    // account_number is a path segment, so it must NOT also appear as a query
    // param; `status` becomes the repeated `status[]` key documented in
    // open-api-spec/orders.md.
    expect(req.params).toEqual({
      "start-date": "2026-06-01",
      "end-date": "2026-06-30",
      "start-at": "2026-06-01T00:00:00Z",
      "end-at": "2026-06-30T23:59:59Z",
      "status[]": ["Live", "Filled"],
      "underlying-symbol": "AAPL",
      "underlying-instrument-type": "Equity",
      "futures-symbol": "/ESU9",
      sort: "Asc",
      "page-offset": 1,
      "per-page": 25,
    });
    expectKebabOnly(req);
    expect(req.body).toBeUndefined();

    // Unwrapped to .data.data.items — the bare array, not the {items:…}
    // envelope, which `toEqual` against the array already rejects.
    expect(result).toEqual(fixture.items);
    expect(result[0]).toHaveProperty("account-number");
  });

  it("treats tastytrade_get_orders as a byte-identical deprecated alias", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const args = { account_number: ACCT, status: ["Filled"], per_page: 5 };
    const viaSearch = await callOk(h, "tastytrade_search_orders", args);
    const viaAlias = await callOk(h, "tastytrade_get_orders", args);

    expect(trace(h)).toEqual([
      `GET /accounts/${ACCT}/orders`,
      `GET /accounts/${ACCT}/orders`,
    ]);
    expect(h.requests[1].params).toEqual(h.requests[0].params);
    expect(h.requests[1].params).toEqual({
      "status[]": ["Filled"],
      "per-page": 5,
    });
    expect(viaAlias).toEqual(viaSearch);
  });

  it("sends no query params when only the account is given", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "GET",
          reply: { data: { items: [] } },
        },
      ],
    });

    expect(
      await callOk(h, "tastytrade_get_orders", { account_number: ACCT }),
    ).toEqual([]);
    expect(requestFor(h, "GET", `/accounts/${ACCT}/orders`).params).toEqual({});
  });
});

describe("order read: tastytrade_get_order / tastytrade_get_live_orders", () => {
  it("GETs a single order at /accounts/{n}/orders/{id} and unwraps .data.data", async () => {
    const order = (
      loadFixture("tastytrade_get_orders") as {
        items: Array<Record<string, unknown>>;
      }
    ).items[0];

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "GET",
          reply: { data: order },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    const req = requestFor(h, "GET", `/accounts/${ACCT}/orders/${ORDER_ID}`);
    expect(req.params).toEqual({});
    expect(result).toEqual(order);
    // A single order, not a list — the envelope is gone and no `items` remains.
    expect(result).not.toHaveProperty("items");
  });

  it("GETs today's orders at /accounts/{n}/orders/live and returns the items array", async () => {
    const fixture = loadFixture("tastytrade_get_live_orders") as {
      items: Array<Record<string, unknown>>;
    };

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/live`,
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const result = (await callOk(h, "tastytrade_get_live_orders", {
      account_number: ACCT,
    })) as Array<Record<string, unknown>>;

    expect(trace(h)).toEqual([`GET /accounts/${ACCT}/orders/live`]);
    expect(result).toEqual(fixture.items);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("customer-level order tools", () => {
  it("search_customer_orders GETs /customers/{id}/orders with account-numbers[] + status[]", async () => {
    const fixture = loadFixture("tastytrade_search_customer_orders") as {
      items: Array<Record<string, unknown>>;
    };

    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/orders",
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_search_customer_orders", {
      // `customer_id` is not an argument. The
      // customer is pinned to the authenticated one, so the value that would
      // be passed here has nothing to select.
      account_numbers: [ACCT, "5WX00002"],
      status: ["Live"],
      underlying_symbol: "AAPL",
      per_page: 10,
    });

    const req = requestFor(h, "GET", "/customers/me/orders");
    expect(req.params).toEqual({
      "account-numbers[]": [ACCT, "5WX00002"],
      "status[]": ["Live"],
      "underlying-symbol": "AAPL",
      "per-page": 10,
    });
    expectKebabOnly(req);
    expect(result).toEqual(fixture.items);
  });

  // Was "defaults customer_id to 'me'". It is pinned
  // now, not defaulted: a default is a value a caller can replace.
  it("search_customer_orders always addresses the authenticated customer", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/orders",
          method: "GET",
          reply: { data: { items: [] } },
        },
      ],
    });

    await callOk(h, "tastytrade_search_customer_orders", {
      start_date: "2026-06-01",
    });

    expect(trace(h)).toEqual(["GET /customers/me/orders"]);
    expect(h.lastRequest()?.params).toEqual({ "start-date": "2026-06-01" });
  });

  // This test would route `/customers/12345/orders/live`
  // and pass `customer_id: "12345"` — it was the pin on the defect: a
  // caller-chosen customer id became a path segment under the operator's
  // bearer. The customer is now the authenticated one and the argument is gone,
  // so the route is `/customers/me/...` and a value like "12345" is refused
  // nowhere because there is nowhere to put it.
  it("get_customer_live_orders GETs /customers/me/orders/live and forwards only account-numbers[]", async () => {
    const fixture = loadFixture("tastytrade_get_customer_live_orders") as {
      items: Array<Record<string, unknown>>;
    };

    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/orders/live",
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_customer_live_orders", {
      account_numbers: [ACCT],
    });

    const req = requestFor(h, "GET", "/customers/me/orders/live");
    // The tool's schema exposes only account_numbers, and the dispatcher
    // forwards exactly one param — no date/status filters leak in.
    expect(req.params).toEqual({ "account-numbers[]": [ACCT] });
    expectKebabOnly(req);
    expect(result).toEqual(fixture.items);
  });
});

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

describe("positions: tastytrade_get_positions / tastytrade_get_position", () => {
  const POSITIONS = [
    {
      "account-number": ACCT,
      symbol: "AAPL",
      "instrument-type": "Equity",
      "underlying-symbol": "AAPL",
      quantity: 10,
      "quantity-direction": "Long",
      "mark-price": "201.5",
    },
    {
      "account-number": ACCT,
      symbol: "SPY",
      "instrument-type": "Equity",
      "underlying-symbol": "SPY",
      quantity: 1,
      "quantity-direction": "Long",
      "mark-price": "601.2",
    },
  ];

  it("GETs /accounts/{n}/positions with every filter kebab-cased", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/positions`,
          method: "GET",
          reply: { data: { items: POSITIONS } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_positions", {
      account_number: ACCT,
      symbol: "AAPL",
      underlying_symbol: ["AAPL", "SPY"],
      instrument_type: "Equity Option",
      include_closed_positions: false,
      net_positions: true,
      underlying_product_code: "ES",
    });

    const req = requestFor(h, "GET", `/accounts/${ACCT}/positions`);
    expect(req.params).toEqual({
      symbol: "AAPL",
      "underlying-symbol": ["AAPL", "SPY"],
      "instrument-type": "Equity Option",
      "include-closed-positions": false,
      "include-marks": true,
      "net-positions": true,
      "underlying-product-code": "ES",
    });
    expectKebabOnly(req);
    expect(result).toEqual(POSITIONS);
  });

  it("defaults include-marks to true and forwards an explicit false", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/positions`,
          method: "GET",
          reply: { data: { items: POSITIONS } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_positions", { account_number: ACCT });
    expect(h.lastRequest()?.params).toEqual({ "include-marks": true });

    // /accounts/{n}/positions is capped at 1 request/second and this test calls
    // it twice. Reset rather than sleep: the subject is parameter forwarding.
    _resetRateLimitsForTest();

    await callOk(h, "tastytrade_get_positions", {
      account_number: ACCT,
      include_marks: false,
    });
    expect(h.lastRequest()?.params).toEqual({ "include-marks": false });
  });

  it("get_position filters the list endpoint client-side (there is no per-symbol path)", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/positions`,
          method: "GET",
          reply: { data: { items: POSITIONS } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_position", {
      account_number: ACCT,
      symbol: "SPY",
    });

    // Same collection endpoint, narrowed by query params, then matched in
    // process — asserting the path proves no /positions/{symbol} is invented.
    expect(trace(h)).toEqual([`GET /accounts/${ACCT}/positions`]);
    const req = h.lastRequest()!;
    expect(req.params).toEqual({ symbol: "SPY", "include-marks": true });
    expectKebabOnly(req);
    expect(result).toEqual(POSITIONS[1]);
  });

  it("get_position reports not_found when the account does not hold the symbol", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/positions`,
          method: "GET",
          reply: { data: { items: [POSITIONS[0]] } },
        },
      ],
    });

    const err = await callError(h, "tastytrade_get_position", {
      account_number: ACCT,
      symbol: "TSLA",
    });

    expect(err.code).toBe("not_found");
    expect(err.message).toContain("TSLA");
  });
});

// ---------------------------------------------------------------------------
// Margin & limits
// ---------------------------------------------------------------------------

describe("margin & position limits", () => {
  it("get_position_limit GETs /accounts/{n}/position-limit", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/position-limit`,
          method: "GET",
          reply: { data: POSITION_LIMIT },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_position_limit", {
      account_number: ACCT,
    });

    expect(trace(h)).toEqual([`GET /accounts/${ACCT}/position-limit`]);
    expect(h.lastRequest()?.params).toEqual({});
    expect(result).toEqual(POSITION_LIMIT);
  });

  it("get_margin_requirements GETs /accounts/{n}/margin-requirements/{symbol}/effective", async () => {
    const fixture = loadFixture("tastytrade_get_margin_requirements");

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/margin-requirements/AAPL/effective`,
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_margin_requirements", {
      account_number: ACCT,
      symbol: "AAPL",
    });

    expect(trace(h)).toEqual([
      `GET /accounts/${ACCT}/margin-requirements/AAPL/effective`,
    ]);
    expect(result).toEqual(fixture);
    expect(result).toHaveProperty("underlying-symbol", "AAPL");
  });

  it("get_margin_requirements encodes a `/` in the underlying symbol", async () => {
    h = await createHarness({
      routes: [
        { matcher: /\/margin-requirements\//, method: "GET", reply: {} },
      ],
    });

    await callOk(h, "tastytrade_get_margin_requirements", {
      account_number: ACCT,
      symbol: "BRK/B",
    });

    // Equity symbols may contain a `/` (BRK/A, BRK/B — api-overview.md).
    // Unencoded, `BRK/B` splits into two segments and pushes `/effective` one
    // level too deep, so the documented
    // `/accounts/{n}/margin-requirements/{symbol}/effective` route stops
    // matching and the call silently addresses nothing. Same bug the option
    // chains and `get_instrument` already had; this endpoint's encoding was
    // the last one in this group with no test behind it.
    const url = h.lastRequest()!.url;
    expect(url).toBe(`/accounts/${ACCT}/margin-requirements/BRK%2FB/effective`);
    expect(url.split("/")).toHaveLength(6);
  });

  it("get_margin_config GETs the unauthenticated public configuration path", async () => {
    const fixture = loadFixture("tastytrade_get_margin_config");

    h = await createHarness({
      routes: [
        {
          matcher: "/margin-requirements-public-configuration",
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_margin_config", {});

    expect(trace(h)).toEqual(["GET /margin-requirements-public-configuration"]);
    expect(result).toEqual(fixture);
    expect(result).toHaveProperty("risk-free-rate");
  });

  it("dry_run_margin_impact POSTs /margin/accounts/{n}/dry-run and issues no token", async () => {
    const reply = {
      "buying-power-effect": {
        "change-in-margin-requirement": "201.5",
        "change-in-buying-power": "-201.5",
        "change-in-buying-power-effect": "Debit",
        "is-spread": false,
      },
      "margin-requirement": "201.5",
    };

    h = await createHarness({
      routes: [
        {
          matcher: `/margin/accounts/${ACCT}/dry-run`,
          method: "POST",
          reply: { data: reply },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_dry_run_margin_impact", {
      account_number: ACCT,
      underlying_symbol: "AAPL",
      order_type: "Limit",
      time_in_force: "GTD",
      price: "201.50",
      price_effect: "Debit",
      stop_trigger: "200.00",
      gtc_date: "2026-12-31",
      replaces_order_id: "1075261",
      legs: [
        {
          symbol: "AAPL",
          instrument_type: "Equity",
          action: "Buy to Open",
          quantity: "1",
          remaining_quantity: "1",
        },
      ],
    });

    const req = requestFor(h, "POST", `/margin/accounts/${ACCT}/dry-run`);
    // This endpoint is the one order-shaped body that repeats the account
    // number *inside* the payload as well as in the path.
    expect(req.body).toEqual({
      "account-number": ACCT,
      "underlying-symbol": "AAPL",
      "order-type": "Limit",
      "time-in-force": "GTD",
      price: "201.50",
      "price-effect": "Debit",
      "stop-trigger": "200.00",
      "gtc-date": "2026-12-31",
      "replaces-order-id": "1075261",
      legs: [
        {
          symbol: "AAPL",
          "instrument-type": "Equity",
          action: "Buy to Open",
          quantity: "1",
          "remaining-quantity": "1",
        },
      ],
    });
    expectKebabOnly(req);

    // Margin-only pre-flight: unlike dry_run_order it grants no authority to
    // place anything, so no confirmation_token comes back.
    expect(result).toEqual(reply);
    expect(result).not.toHaveProperty("confirmation_token");
  });
});

// ---------------------------------------------------------------------------
// Single orders — dry-run / place / cancel / edit / replace
// ---------------------------------------------------------------------------

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

/** The kebab-case body buildOrderBody() must produce from ORDER_ARGS. */
const ORDER_BODY = {
  "time-in-force": "Day",
  "order-type": "Limit",
  source: MCP_ORDER_SOURCE,
  price: "1.02",
  "price-effect": "Debit",
  legs: [
    {
      "instrument-type": "Equity",
      symbol: "AAPL",
      action: "Buy to Open",
      quantity: 1,
    },
  ],
};

const DRY_RUN_ORDER_REPLY = {
  order: {
    "account-number": ACCT,
    "order-type": "Limit",
    price: "1.02",
    "price-effect": "Debit",
    size: 1,
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
  warnings: [
    {
      code: "tif.next_valid_session",
      message: "Your order will begin working during next valid session.",
    },
  ],
  "buying-power-effect": {
    "change-in-buying-power": "1.021",
    "change-in-buying-power-effect": "Debit",
    "current-buying-power": "1000000.0",
    "new-buying-power": "999998.979",
    "is-spread": false,
    impact: "1.021",
    effect: "Debit",
  },
  "fee-calculation": { "total-fees": "0.001", "total-fees-effect": "Debit" },
};

describe("single order: dry_run_order -> place_order", () => {
  it("dry_run_order POSTs /accounts/{n}/orders/dry-run and issues a token", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_ORDER_REPLY },
        },
      ],
    });

    const result = (await callOk(
      h,
      "tastytrade_dry_run_order",
      ORDER_ARGS,
    )) as {
      confirmation_token: string;
      upstream: { order: unknown };
    };

    const req = requestFor(h, "POST", `/accounts/${ACCT}/orders/dry-run`);
    expect(req.body).toEqual(ORDER_BODY);
    expectKebabOnly(req);

    // The unwrapped dry-run payload, plus the token the place tool will need.
    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect(result.upstream.order).toEqual(DRY_RUN_ORDER_REPLY.order);
    expect(typeof result.confirmation_token).toBe("string");
    expect(result.confirmation_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("omits price / price-effect entirely for a Market order", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_ORDER_REPLY },
        },
      ],
    });

    await callOk(h, "tastytrade_dry_run_order", {
      account_number: ACCT,
      order_type: "Market",
      time_in_force: "Day",
      legs: ORDER_ARGS.legs,
    });

    expect(h.lastRequest()?.body).toEqual({
      "time-in-force": "Day",
      "order-type": "Market",
      source: MCP_ORDER_SOURCE,
      legs: ORDER_BODY.legs,
    });
  });

  it("place_order POSTs /accounts/{n}/orders with the token's exact body", async () => {
    const placed = {
      order: { ...DRY_RUN_ORDER_REPLY.order, id: 1075999, status: "Routed" },
      warnings: [],
      "buying-power-effect": DRY_RUN_ORDER_REPLY["buying-power-effect"],
    };

    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: `/accounts/${ACCT}/orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_ORDER_REPLY },
        },
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { data: placed },
        },
      ],
    });

    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };
    const result = (await callOk(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    })) as {
      upstream: { order: Record<string, unknown> };
      sanity_warnings: string[];
      upstream_notes: string[];
    };

    // The full round trip: pre-flight, the three sanity reads, then the live
    // POST. The instrument read is the tick check fetching the price increment
    // published for the leg's underlying.
    expect(trace(h)).toEqual([
      `POST /accounts/${ACCT}/orders/dry-run`,
      `GET /accounts/${ACCT}/position-limit`,
      `GET /instruments/equities/AAPL`,
      `GET /accounts/${ACCT}/trading-status`,
      `POST /accounts/${ACCT}/orders`,
    ]);

    const live = requestFor(h, "POST", `/accounts/${ACCT}/orders`);
    // Identical to the dry-run body — that tuple is what the argsHash binds.
    expect(live.body).toEqual(ORDER_BODY);
    expect(live.body).toEqual(
      requestFor(h, "POST", `/accounts/${ACCT}/orders/dry-run`).body,
    );
    expectKebabOnly(live);

    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect(result.upstream.order.id).toBe(1075999);
    // Soft dry-run warnings are still surfaced alongside
    // the placed order, but under an upstream name — the broker wrote them, and
    // `sanity_warnings` is now this server's own verdict and nothing else.
    expect(result.upstream_notes).toEqual([
      "Your order will begin working during next valid session.",
    ]);
    expect(result.sanity_warnings).toEqual([]);
  });

  it("place_order logs nothing — the live order body never reaches stderr", async () => {
    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: `/accounts/${ACCT}/orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_ORDER_REPLY },
        },
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { data: { order: DRY_RUN_ORDER_REPLY.order } },
        },
      ],
    });

    const dry = (await callOk(h, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };

    // Spy AFTER construction: the startup banners (live-API warning,
    // read-only notice) are deliberate one-time logs and are not what this
    // test is about. What matters is that dispatching a real order emits
    // nothing.
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    let logged: string[];
    try {
      await callOk(h, "tastytrade_place_order", {
        ...ORDER_ARGS,
        confirmation_token: dry.confirmation_token,
      });
      // Snapshot the calls BEFORE restoring: mockRestore() also resets the
      // recorded calls, so reading spy.mock.calls afterwards would always find
      // an empty list and this assertion could never fail.
      logged = spy.mock.calls.map((c) => c.map(String).join(" "));
    } finally {
      spy.mockRestore();
    }

    // placeOrder() would open with an unconditional
    // `console.error(JSON.stringify(orderData))` — the only console.* call in
    // the whole ~1000-line client — dumping every live order body (symbols,
    // actions, quantities, prices) into whatever aggregates stderr, with no
    // sibling in dryRunOrder / placeComplexOrder / replaceOrder / editOrder.
    expect(logged).toEqual([]);
    expect(logged.join("\n")).not.toContain(ORDER_BODY.legs[0].symbol);
  });

  it("refuses place_order with dry_run_required before any request leaves", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { data: {} },
        },
      ],
    });

    const err = await callError(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: "00000000-0000-0000-0000-000000000000",
    });

    expect(err.code).toBe("dry_run_required");
    // The gate is closed upstream of HTTP: nothing at all was sent.
    expect(trace(h)).toEqual([]);
  });
});

describe("single order: cancel", () => {
  it("cancel_order DELETEs /accounts/{n}/orders/{id} with no token required", async () => {
    const cancelled = {
      ...DRY_RUN_ORDER_REPLY.order,
      id: Number(ORDER_ID),
      status: "Cancelled",
      cancellable: false,
    };

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "DELETE",
          reply: { data: cancelled },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: ORDER_ID,
    });

    // Cancels reduce risk, so this destructive tool takes no confirmation token.
    expect(trace(h)).toEqual([`DELETE /accounts/${ACCT}/orders/${ORDER_ID}`]);
    expect(h.lastRequest()?.body).toBeUndefined();
    expect(result).toEqual(cancelled);
    expect(result).toHaveProperty("status", "Cancelled");
  });
});

describe("single order: dry_run_replace_order -> replace_order", () => {
  const REPLACE_ARGS = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Limit",
    time_in_force: "GTD",
    price: "1.05",
    price_effect: "Debit",
    stop_trigger: "1.00",
    gtc_date: "2026-12-31",
  };

  /** buildReplaceBody(): a full order body MINUS legs (the API retains them). */
  const REPLACE_BODY = {
    "order-type": "Limit",
    "time-in-force": "GTD",
    source: MCP_ORDER_SOURCE,
    price: "1.05",
    "price-effect": "Debit",
    "stop-trigger": "1.00",
    "gtc-date": "2026-12-31",
  };

  const DRY_RUN_REPLACE_REPLY = {
    order: { ...DRY_RUN_ORDER_REPLY.order, price: "1.05" },
    warnings: [],
    "buying-power-effect": DRY_RUN_ORDER_REPLY["buying-power-effect"],
  };

  it("dry-runs at POST /accounts/{n}/orders/{id}/dry-run without legs", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_REPLACE_REPLY },
        },
      ],
    });

    const result = (await callOk(
      h,
      "tastytrade_dry_run_replace_order",
      REPLACE_ARGS,
    )) as { confirmation_token: string; upstream: { order: unknown } };

    const req = requestFor(
      h,
      "POST",
      `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
    );
    expect(req.body).toEqual(REPLACE_BODY);
    expect(req.body).not.toHaveProperty("legs");
    expectKebabOnly(req);
    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect(result.upstream.order).toEqual(DRY_RUN_REPLACE_REPLY.order);
    expect(typeof result.confirmation_token).toBe("string");
  });

  it("replace_order PUTs /accounts/{n}/orders/{id} with the identical body", async () => {
    const replaced = {
      ...DRY_RUN_ORDER_REPLY.order,
      id: 1076000,
      price: "1.05",
    };

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_REPLACE_REPLY },
        },
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "PUT",
          reply: { data: replaced },
        },
        accountStateRoute(),
      ],
    });

    const dry = (await callOk(
      h,
      "tastytrade_dry_run_replace_order",
      REPLACE_ARGS,
    )) as { confirmation_token: string };
    const result = await callOk(h, "tastytrade_replace_order", {
      ...REPLACE_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    // Replace re-checks the STORED dry-run and then reads
    // the account state, because `is-frozen` is a HARD BLOCK that needs no legs
    // — this route would submit to a frozen account that place_order refused.
    // The POSITION-LIMIT read is still absent, and deliberately: it would fetch
    // ceilings this legless body has nothing to compare against.
    expect(trace(h)).toEqual([
      `POST /accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
      `GET /accounts/${ACCT}/trading-status`,
      `PUT /accounts/${ACCT}/orders/${ORDER_ID}`,
    ]);
    const live = requestFor(h, "PUT", `/accounts/${ACCT}/orders/${ORDER_ID}`);
    expect(live.body).toEqual(REPLACE_BODY);
    expectKebabOnly(live);
    // The replacement Order, with the soft warnings the checks produced
    // appended the way place_order appends them.
    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect((result as { upstream: unknown }).upstream).toMatchObject(replaced);
    expect((result as { sanity_warnings: string[] }).sanity_warnings).toEqual(
      [],
    );
  });
});

describe("single order: dry_run_edit_order -> edit_order", () => {
  const EDIT_ARGS = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.10",
    price_effect: "Credit",
  };

  /**
   * buildEditBody(): only the fields the caller set, kebab-cased — plus the
   * server-side `source`, which PATCH /orders/{id} accepts as part of the
   * partial order body.
   */
  const EDIT_BODY = {
    source: MCP_ORDER_SOURCE,
    "order-type": "Limit",
    price: "1.10",
    "price-effect": "Credit",
    "time-in-force": "Day",
  };

  const DRY_RUN_EDIT_REPLY = {
    order: { ...DRY_RUN_ORDER_REPLY.order, price: "1.10" },
    warnings: [],
    "buying-power-effect": DRY_RUN_ORDER_REPLY["buying-power-effect"],
  };

  it("shares the replace dry-run endpoint but binds a different action", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_EDIT_REPLY },
        },
      ],
    });

    const result = (await callOk(
      h,
      "tastytrade_dry_run_edit_order",
      EDIT_ARGS,
    )) as { confirmation_token: string; upstream: { order: unknown } };

    // Same POST path as dry_run_replace_order — the difference is the token's
    // bound action ("edit_order" vs "replace_order"), not the HTTP call.
    const req = requestFor(
      h,
      "POST",
      `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
    );
    expect(req.body).toEqual(EDIT_BODY);
    expectKebabOnly(req);
    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect(result.upstream.order).toEqual(DRY_RUN_EDIT_REPLY.order);
    expect(typeof result.confirmation_token).toBe("string");
  });

  it("edit_order PATCHes /accounts/{n}/orders/{id} with the identical partial body", async () => {
    const edited = { ...DRY_RUN_ORDER_REPLY.order, id: 1076001, price: "1.10" };

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_EDIT_REPLY },
        },
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "PATCH",
          reply: { data: edited },
        },
        accountStateRoute(),
      ],
    });

    const dry = (await callOk(
      h,
      "tastytrade_dry_run_edit_order",
      EDIT_ARGS,
    )) as { confirmation_token: string };
    const result = await callOk(h, "tastytrade_edit_order", {
      ...EDIT_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    // The account-state read, for the reason spelled out
    // on the replace test above.
    expect(trace(h)).toEqual([
      `POST /accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
      `GET /accounts/${ACCT}/trading-status`,
      `PATCH /accounts/${ACCT}/orders/${ORDER_ID}`,
    ]);
    const live = requestFor(h, "PATCH", `/accounts/${ACCT}/orders/${ORDER_ID}`);
    expect(live.body).toEqual(EDIT_BODY);
    expectKebabOnly(live);
    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect((result as { upstream: unknown }).upstream).toMatchObject(edited);
    expect((result as { sanity_warnings: string[] }).sanity_warnings).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Complex orders
// ---------------------------------------------------------------------------

describe("complex order reads", () => {
  const COMPLEX_ORDER = (
    loadFixture("tastytrade_dry_run_complex_order") as {
      "complex-order": Record<string, unknown>;
    }
  )["complex-order"];

  it("get_complex_orders GETs /accounts/{n}/complex-orders with kebab pagination", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders`,
          method: "GET",
          reply: { data: { items: [COMPLEX_ORDER] } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_complex_orders", {
      account_number: ACCT,
      page_offset: 0,
      per_page: 50,
    });

    const req = requestFor(h, "GET", `/accounts/${ACCT}/complex-orders`);
    expect(req.params).toEqual({ "page-offset": 0, "per-page": 50 });
    expectKebabOnly(req);
    expect(result).toEqual([COMPLEX_ORDER]);
  });

  it("get_live_complex_orders GETs /accounts/{n}/complex-orders/live", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/live`,
          method: "GET",
          reply: { data: { items: [COMPLEX_ORDER] } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_live_complex_orders", {
      account_number: ACCT,
    });

    expect(trace(h)).toEqual([`GET /accounts/${ACCT}/complex-orders/live`]);
    expect(h.lastRequest()?.params).toEqual({});
    expect(result).toEqual([COMPLEX_ORDER]);
  });

  it("get_complex_order GETs /accounts/{n}/complex-orders/{id} and unwraps to the object", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
          method: "GET",
          reply: { data: COMPLEX_ORDER },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_complex_order", {
      account_number: ACCT,
      complex_order_id: COMPLEX_ID,
    });

    expect(trace(h)).toEqual([
      `GET /accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
    ]);
    expect(result).toEqual(COMPLEX_ORDER);
    expect(result).toHaveProperty("type", "OCO");
  });
});

describe("complex order: dry_run_complex_order -> place_complex_order", () => {
  const DRY_RUN_COMPLEX_REPLY = loadFixture(
    "tastytrade_dry_run_complex_order",
  ) as Record<string, unknown> & {
    warnings: Array<{ message: string }>;
  };

  const COMPONENT = {
    order_type: "Limit",
    time_in_force: "GTC",
    price: "99999.0",
    price_effect: "Credit",
    legs: [
      {
        symbol: "AAPL",
        instrument_type: "Equity",
        action: "Sell to Close",
        quantity: 1,
      },
    ],
  };

  const COMPONENT_BODY = {
    "order-type": "Limit",
    "time-in-force": "GTC",
    price: "99999.0",
    "price-effect": "Credit",
    legs: [
      {
        "instrument-type": "Equity",
        symbol: "AAPL",
        action: "Sell to Close",
        quantity: 1,
      },
    ],
  };

  /**
   * `source` is deliberately still passed in here even though it is not an
   * input-schema property: it keeps every complex-order round trip in this
   * block doubling as proof that a caller-supplied value never reaches the
   * wire. The dedicated assertions live in the attribution block at the end
   * of the file.
   */
  const OCO_ARGS = {
    account_number: ACCT,
    type: "OCO",
    source: "spoofed-by-the-caller",
    orders: [COMPONENT, { ...COMPONENT, price: "1.0" }],
  };

  const OCO_BODY = {
    type: "OCO",
    source: MCP_ORDER_SOURCE,
    orders: [COMPONENT_BODY, { ...COMPONENT_BODY, price: "1.0" }],
  };

  it("dry-runs at POST /accounts/{n}/complex-orders/dry-run and issues a token", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_COMPLEX_REPLY },
        },
      ],
    });

    const result = (await callOk(
      h,
      "tastytrade_dry_run_complex_order",
      OCO_ARGS,
    )) as { confirmation_token: string };

    const req = requestFor(
      h,
      "POST",
      `/accounts/${ACCT}/complex-orders/dry-run`,
    );
    expect(req.body).toEqual(OCO_BODY);
    expectKebabOnly(req);
    expect(typeof result.confirmation_token).toBe("string");
    // The recorded fixture carries a (scrubbed, long-dead) confirmation_token
    // field; the freshly issued one must replace it, not be shadowed by it.
    expect(result.confirmation_token).not.toBe(
      DRY_RUN_COMPLEX_REPLY.confirmation_token,
    );
  });

  it("translates an OTOCO trigger_order to a kebab-case trigger-order", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_COMPLEX_REPLY },
        },
      ],
    });

    await callOk(h, "tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OTOCO",
      trigger_order: {
        order_type: "Limit",
        time_in_force: "Day",
        price: "200.00",
        price_effect: "Debit",
        legs: [
          {
            symbol: "AAPL",
            instrument_type: "Equity",
            action: "Buy to Open",
            quantity: 1,
          },
        ],
      },
      orders: [COMPONENT],
    });

    const req = h.lastRequest()!;
    expect(req.body).toEqual({
      type: "OTOCO",
      source: MCP_ORDER_SOURCE,
      "trigger-order": {
        "order-type": "Limit",
        "time-in-force": "Day",
        price: "200.00",
        "price-effect": "Debit",
        legs: [
          {
            "instrument-type": "Equity",
            symbol: "AAPL",
            action: "Buy to Open",
            quantity: 1,
          },
        ],
      },
      orders: [COMPONENT_BODY],
    });
    expectKebabOnly(req);
  });

  it("translates the PAIRS ratio fields, including the notional flag", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_COMPLEX_REPLY },
        },
      ],
    });

    await callOk(h, "tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "PAIRS",
      orders: [COMPONENT],
      ratio_price_comparator: "gte",
      ratio_price_threshold: 1.25,
      ratio_price_is_threshold_based_on_notional: true,
    });

    const req = h.lastRequest()!;
    expect(req.body).toEqual({
      type: "PAIRS",
      source: MCP_ORDER_SOURCE,
      orders: [COMPONENT_BODY],
      "ratio-price-comparator": "gte",
      "ratio-price-threshold": 1.25,
      "ratio-price-is-threshold-based-on-notional": true,
    });
    expectKebabOnly(req);
  });

  it("place_complex_order POSTs /accounts/{n}/complex-orders with the token's body", async () => {
    const placed = {
      "complex-order": {
        ...(DRY_RUN_COMPLEX_REPLY["complex-order"] as Record<string, unknown>),
        id: 56545,
      },
      warnings: [],
    };

    h = await createHarness({
      routes: [
        ...sanityRoutes(),
        {
          matcher: `/accounts/${ACCT}/complex-orders/dry-run`,
          method: "POST",
          reply: { data: DRY_RUN_COMPLEX_REPLY },
        },
        {
          matcher: `/accounts/${ACCT}/complex-orders`,
          method: "POST",
          reply: { data: placed },
        },
      ],
    });

    const dry = (await callOk(
      h,
      "tastytrade_dry_run_complex_order",
      OCO_ARGS,
    )) as { confirmation_token: string };
    const result = (await callOk(h, "tastytrade_place_complex_order", {
      ...OCO_ARGS,
      confirmation_token: dry.confirmation_token,
    })) as {
      upstream: { "complex-order": Record<string, unknown> };
      sanity_warnings: string[];
      upstream_notes: string[];
    };

    expect(trace(h)).toEqual([
      `POST /accounts/${ACCT}/complex-orders/dry-run`,
      `GET /accounts/${ACCT}/position-limit`,
      `GET /accounts/${ACCT}/trading-status`,
      `POST /accounts/${ACCT}/complex-orders`,
    ]);

    const live = requestFor(h, "POST", `/accounts/${ACCT}/complex-orders`);
    expect(live.body).toEqual(OCO_BODY);
    expect(live.body).toEqual(
      requestFor(h, "POST", `/accounts/${ACCT}/complex-orders/dry-run`).body,
    );
    expectKebabOnly(live);

    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect(result.upstream["complex-order"].id).toBe(56545);
    // Every dry-run warning from the recorded payload
    // still reaches the caller — sanity checks flatten legs across
    // trigger-order + orders[] and pass — but in the upstream channel, because
    // the broker wrote them.
    expect(result.upstream_notes).toEqual(
      DRY_RUN_COMPLEX_REPLY.warnings.map((w) => w.message),
    );
    expect(result.sanity_warnings).toEqual([]);
  });
});

/**
 * The smallest dry-run reply that is still a dry-run.
 *
 * `{warnings: []}` would do here, and it does not any more: `isCleanDryRun`
 * now requires the payload to describe an order — an `order`, a
 * `complex-order`, or a `buying-power-effect` — before it will mint a
 * confirmation token, because "the broker did not complain" is not the same
 * claim as "the broker priced this". These tests are about the request body and
 * the token handshake, not about the dry-run shape, so they get a payload the
 * broker could actually have sent.
 */
const MINIMAL_CLEAN_DRY_RUN = {
  warnings: [],
  "buying-power-effect": {
    "change-in-buying-power": "1.0",
    "change-in-buying-power-effect": "Debit",
  },
};

/**
 * Describes an order, but projects no spendable figure.
 *
 * The two gates in front of a submit ask different questions and this payload
 * separates them: `describedAnOrder` is satisfied — there is a `complex-order`, so the
 * broker demonstrably looked — while the notional cap has no `change-in-buying-power`
 * to measure against and must say so rather than pass the order silently.
 *
 * UNVERIFIED, and worth settling before anyone trusts this route: nothing here records
 * what `POST /accounts/{n}/complex-orders/{id}/dry-run` actually answers with. The one
 * complex dry-run we have a capture of is the CREATE, not the edit. This asserts the
 * edit answers with a `complex-order` — the shape the create returns and the vendored
 * spec implies — but that is an assumption, and `describedAnOrder` makes it
 * load-bearing: if the real endpoint answers with none of `order`, `complex-order` or
 * `buying-power-effect`, no token is ever minted and `edit_complex_order` is
 * unreachable as shipped. Record one real sandbox response and point this at it.
 */
const PRICELESS_CLEAN_DRY_RUN = {
  warnings: [],
  "complex-order": { id: 1, type: "PAIRS", orders: [] },
};

describe("complex order: cancel and PAIRS-threshold edit", () => {
  it("cancel_complex_order DELETEs /accounts/{n}/complex-orders/{id}", async () => {
    const cancelled = { id: Number(COMPLEX_ID), type: "OCO", orders: [] };

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
          method: "DELETE",
          reply: { data: cancelled },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_cancel_complex_order", {
      account_number: ACCT,
      complex_order_id: COMPLEX_ID,
    });

    // Safe-destructive: no confirmation token, no request body.
    expect(trace(h)).toEqual([
      `DELETE /accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
    ]);
    expect(h.lastRequest()?.body).toBeUndefined();
    expect(result).toEqual(cancelled);
  });

  const EDIT_COMPLEX_ARGS = {
    account_number: ACCT,
    complex_order_id: COMPLEX_ID,
    ratio_price_comparator: "lte",
    ratio_price_threshold: 0.98,
  };

  const EDIT_COMPLEX_BODY = {
    "ratio-price-comparator": "lte",
    "ratio-price-threshold": 0.98,
  };

  it("dry_run_edit_complex_order POSTs /complex-orders/{id}/dry-run with only the ratio fields", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
          method: "POST",
          reply: { data: MINIMAL_CLEAN_DRY_RUN },
        },
      ],
    });

    const result = (await callOk(
      h,
      "tastytrade_dry_run_edit_complex_order",
      EDIT_COMPLEX_ARGS,
    )) as { confirmation_token: string };

    const req = requestFor(
      h,
      "POST",
      `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
    );
    expect(req.body).toEqual(EDIT_COMPLEX_BODY);
    expectKebabOnly(req);
    expect(typeof result.confirmation_token).toBe("string");
  });

  it("edit_complex_order PATCHes /complex-orders/{id} with the identical body", async () => {
    const edited = {
      id: Number(COMPLEX_ID),
      type: "PAIRS",
      "ratio-price-comparator": "lte",
      "ratio-price-threshold": "0.98",
    };

    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
          method: "POST",
          reply: { data: PRICELESS_CLEAN_DRY_RUN },
        },
        {
          matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
          method: "PATCH",
          reply: { data: edited },
        },
        accountStateRoute(),
      ],
    });

    const dry = (await callOk(
      h,
      "tastytrade_dry_run_edit_complex_order",
      EDIT_COMPLEX_ARGS,
    )) as { confirmation_token: string };
    const result = await callOk(h, "tastytrade_edit_complex_order", {
      ...EDIT_COMPLEX_ARGS,
      confirmation_token: dry.confirmation_token,
    });

    // The account-state read, for the reason spelled out
    // on the replace test above.
    expect(trace(h)).toEqual([
      `POST /accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
      `GET /accounts/${ACCT}/trading-status`,
      `PATCH /accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
    ]);
    const live = requestFor(
      h,
      "PATCH",
      `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
    );
    expect(live.body).toEqual(EDIT_COMPLEX_BODY);
    expectKebabOnly(live);
    // The broker's payload is boxed under `upstream`, so
    // it can occupy none of the names this server owns.
    expect((result as { upstream: unknown }).upstream).toMatchObject(edited);
    // This dry-run reply carries no buying-power figure, so the notional cap
    // compared nothing — and the checks say so rather than letting the caller
    // read an empty warning list as "the ceiling was applied and cleared".
    // Modelled that way on purpose: orders.md documents the PAIRS edit dry-run
    // with no response body at all, and it is the one endpoint the live
    // verification sweep deliberately skips (a ratio threshold could trigger a
    // fill), so nothing here or upstream establishes that it projects one.
    expect((result as { sanity_warnings: string[] }).sanity_warnings).toEqual([
      "Dry-run reported no usable change-in-buying-power, so the " +
        "MAX_ORDER_NOTIONAL_USD cap could not be applied to this order.",
    ]);
  });

  it("rejects an empty PAIRS edit as validation, before the token is consumed", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_edit_complex_order", {
      account_number: ACCT,
      complex_order_id: COMPLEX_ID,
      confirmation_token: "00000000-0000-0000-0000-000000000000",
    });

    // buildComplexEditBody() throws before consumeToken(), so the missing-token
    // path is never reached and nothing is sent upstream.
    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/ratio_price_comparator|ratio_price_threshold/);
    expect(trace(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Order-source attribution: only the parts the endpoint bodies do NOT pin
// ---------------------------------------------------------------------------

/**
 * Every order body carries `source: MCP_ORDER_SOURCE` so tastytrade can attribute
 * flow that originated through MCP — except the complex-order edit, whose request body
 * orders.md enumerates as exactly the two ratio-price fields, so it stays unstamped
 * rather than risk a rejected edit for the sake of a tag.
 *
 * None of that is re-asserted here: the expected bodies above pin it endpoint by
 * endpoint, on the dry-run leg AND the live leg, so a builder that stops stamping (or
 * starts) fails two tests per endpoint.
 *
 * Two properties are genuinely NOT implied by those bodies, and are what this block is
 * for.
 *
 *   1. The stamp cannot be SPOOFED. `source` is not an input-schema property, but the
 *      dispatcher does not schema-validate arguments, so a determined caller can still
 *      send one. It has to be dropped on BOTH legs: riding along on only one makes the
 *      argsHash diverge, and the live call fails with a spurious binding mismatch
 *      instead of a clean override. Each row drives the real dry-run → live round
 *      trip, and `callOk` throwing on an error envelope is what makes the surviving
 *      trip proof the binding held.
 *   2. No tool ADVERTISES `source` as an input, on any endpoint.
 */
describe("order-source attribution", () => {
  /** What a hostile caller puts in `source`. Must never reach the wire. */
  const SPOOF = "definitely-not-mcp";

  /** A minimal component order for the complex-order row. */
  const SPOOF_COMPONENT = {
    order_type: "Limit",
    time_in_force: "GTC",
    price: "1.0",
    price_effect: "Credit",
    legs: [
      {
        symbol: "AAPL",
        instrument_type: "Equity",
        action: "Sell to Close",
        quantity: 1,
      },
    ],
  };

  interface SpoofCase {
    /** Names the row in the test title. */
    flow: string;
    dryRunTool: string;
    liveTool: string;
    /** Args MINUS the spoofed `source`, which the runner adds to both calls. */
    args: Record<string, unknown>;
    dryRun: { method: string; url: string };
    live: { method: string; url: string };
  }

  const SPOOF_CASES: SpoofCase[] = [
    {
      flow: "place_order",
      dryRunTool: "tastytrade_dry_run_order",
      liveTool: "tastytrade_place_order",
      args: ORDER_ARGS,
      dryRun: { method: "POST", url: `/accounts/${ACCT}/orders/dry-run` },
      live: { method: "POST", url: `/accounts/${ACCT}/orders` },
    },
    {
      flow: "replace_order",
      dryRunTool: "tastytrade_dry_run_replace_order",
      liveTool: "tastytrade_replace_order",
      args: {
        account_number: ACCT,
        order_id: ORDER_ID,
        order_type: "Limit",
        time_in_force: "Day",
        price: "1.05",
        price_effect: "Debit",
      },
      dryRun: {
        method: "POST",
        url: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
      },
      live: { method: "PUT", url: `/accounts/${ACCT}/orders/${ORDER_ID}` },
    },
    {
      flow: "edit_order",
      dryRunTool: "tastytrade_dry_run_edit_order",
      liveTool: "tastytrade_edit_order",
      args: {
        account_number: ACCT,
        order_id: ORDER_ID,
        order_type: "Limit",
        time_in_force: "Day",
        price: "1.10",
        price_effect: "Credit",
      },
      dryRun: {
        method: "POST",
        url: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
      },
      live: { method: "PATCH", url: `/accounts/${ACCT}/orders/${ORDER_ID}` },
    },
    {
      flow: "place_complex_order",
      dryRunTool: "tastytrade_dry_run_complex_order",
      liveTool: "tastytrade_place_complex_order",
      args: {
        account_number: ACCT,
        type: "OCO",
        orders: [SPOOF_COMPONENT, { ...SPOOF_COMPONENT, price: "2.0" }],
      },
      dryRun: {
        method: "POST",
        url: `/accounts/${ACCT}/complex-orders/dry-run`,
      },
      live: { method: "POST", url: `/accounts/${ACCT}/complex-orders` },
    },
  ];

  it.each(SPOOF_CASES)(
    "$flow overrides a caller-supplied source on both legs",
    async ({ dryRunTool, liveTool, args, dryRun, live }) => {
      h = await createHarness({
        routes: [
          ...sanityRoutes(),
          {
            matcher: dryRun.url,
            method: dryRun.method,
            reply: { data: MINIMAL_CLEAN_DRY_RUN },
          },
          {
            matcher: live.url,
            method: live.method,
            // A real entity, not `{data: {}}`: a submit whose 2xx carries no
            // order is refused as an unknown outcome (api-client's
            // `writtenEntity`), and this row is about `source` on the OUTBOUND
            // body, so an empty reply would fail it for an unrelated reason.
            reply: { data: { id: 7001, status: "Received" } },
          },
        ],
      });

      const spoofed = { ...args, source: SPOOF };
      const dry = (await callOk(h, dryRunTool, spoofed)) as {
        confirmation_token: string;
      };
      // If the override landed on only one leg the argsHash would not match and
      // this call would come back as a `confirmation_mismatch` envelope, which
      // callOk turns into a thrown error — so reaching the assertions at all is
      // already half the proof.
      await callOk(h, liveTool, {
        ...spoofed,
        confirmation_token: dry.confirmation_token,
      });

      for (const req of [
        requestFor(h, dryRun.method, dryRun.url),
        requestFor(h, live.method, live.url),
      ]) {
        expect((req.body as Record<string, unknown>).source).toBe(
          MCP_ORDER_SOURCE,
        );
        expect(JSON.stringify(req.body)).not.toContain(SPOOF);
      }
    },
  );

  it("advertises no `source` input property on any tool", async () => {
    // The contract change that comes with making this server-controlled:
    // tastytrade_dry_run_complex_order and tastytrade_place_complex_order used
    // to expose `source` as a free-text argument. Nothing may reintroduce it,
    // on those two or anywhere else — an input property is a promise the
    // dispatcher would then be quietly breaking.
    h = await createHarness();
    const { tools } = await h.client.listTools();

    const offenders = tools
      .filter((t) =>
        Object.hasOwn(
          (t.inputSchema as { properties?: Record<string, unknown> })
            .properties ?? {},
          "source",
        ),
      )
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });
});
