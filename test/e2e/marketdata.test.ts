import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

/**
 * End-to-end round trips for the market-data, watchlist and quote-alert tools — 25 of
 * them, through the real MCP protocol and the real dispatcher, answered by the shared
 * fake transport.
 *
 * Each test asserts the same three things, because those are the three places a silent
 * bug hides: the outbound METHOD and PATH match what the API documents; the outbound
 * params and body are KEBAB-case, asserted key by key rather than loosely; and the
 * tool returns the payload the client unwrapped out of the envelope, not the envelope.
 *
 * Where the server's behaviour differs from what its own docs would lead you to
 * expect, the test asserts the ACTUAL behaviour and says so in a FINDING comment.
 */

let h: Harness | undefined;

beforeEach(() => {
  // The token buckets in src/safety/rate-limit.ts are module-level singletons,
  // shared by every harness this file builds. Destructive is only 5/min, so
  // without a reset the order tests run in would decide whether a call gets a
  // rate_limit_exceeded envelope instead of the assertion under test.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/**
 * Every key in `value`, recursively, whose name contains an underscore — i.e.
 * every place a snake_case agent-facing name leaked into an outbound request.
 * Returned as dotted paths so a failure names the offending field.
 */
function snakeCaseKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => snakeCaseKeys(v, `${prefix}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return [...(k.includes("_") ? [path] : []), ...snakeCaseKeys(v, path)];
  });
}

/** The 25 tools this suite owns. Used by the registry check below. */
const GROUP_TOOLS = [
  "tastytrade_create_quote_alert",
  "tastytrade_create_watchlist",
  "tastytrade_delete_quote_alert",
  "tastytrade_delete_watchlist",
  "tastytrade_get_active_equities",
  "tastytrade_get_api_quote_token",
  "tastytrade_get_earnings_reports",
  "tastytrade_get_historical_dividends",
  "tastytrade_get_market_holidays",
  "tastytrade_get_market_metrics",
  "tastytrade_get_market_session",
  "tastytrade_get_pairs_watchlist",
  "tastytrade_get_pairs_watchlists",
  "tastytrade_get_public_watchlist",
  "tastytrade_get_public_watchlists",
  "tastytrade_get_quantity_precisions",
  "tastytrade_get_quote",
  "tastytrade_get_quote_alerts",
  "tastytrade_get_quote_snapshot",
  "tastytrade_get_sessions_range",
  "tastytrade_get_span_rows",
  "tastytrade_get_total_fees",
  "tastytrade_get_watchlist",
  "tastytrade_get_watchlists",
  "tastytrade_update_watchlist",
] as const;

describe("registry: this group's tools are actually advertised", () => {
  it("advertises all 25 tools with the annotation hints their bucket implies", async () => {
    h = await createHarness();
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of GROUP_TOOLS) {
      expect(byName.has(name)).toBe(true);
    }

    // The write + destructive members of this group, whose annotations pick the
    // non-read rate-limit bucket. Asserting the hints here means a later edit
    // that silently reclassifies a delete as a read fails this test.
    // The three watchlist mutators joined this list. They
    // issue a full-replacement PUT, so `destructiveHint: false` was denying what
    // api-client.ts asserts in its own comment — "any entry not present in
    // `entries` is removed".
    const destructive = [
      "tastytrade_delete_watchlist",
      "tastytrade_delete_quote_alert",
      "tastytrade_update_watchlist",
      "tastytrade_add_watchlist_symbol",
      "tastytrade_remove_watchlist_symbol",
    ];
    for (const name of destructive) {
      expect(byName.get(name)!.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
    }
    // Update_watchlist moved to the destructive list
    // above. Creating a watchlist stays a write — it replaces nothing.
    const writes = [
      "tastytrade_create_watchlist",
      "tastytrade_create_quote_alert",
    ];
    for (const name of writes) {
      expect(byName.get(name)!.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    }
  });
});

// ============================================================================
// Market data — snapshot quotes
// ============================================================================

describe("market data: tastytrade_get_quote", () => {
  // Kebab-case with string-decimal prices — the shape production actually
  // returns (see the recorded tastytrade_get_quote fixture). The regression
  // block at the bottom of this file asserts against that fixture directly.
  const QUOTE_ITEMS = [
    {
      symbol: "SPY",
      "instrument-type": "Equity",
      bid: "601.12",
      ask: "601.15",
      mark: "601.135",
      "day-high-price": "603.4",
      "is-trading-halted": false,
      "halt-start-time": -1,
      "updated-at": "2026-08-14T18:12:03.221Z",
    },
    {
      symbol: "AAPL",
      "instrument-type": "Equity",
      bid: "231.4",
      ask: "231.42",
      mark: "231.41",
      "is-trading-halted": false,
    },
  ];

  it("GETs /market-data/by-type with the singular hyphenated type param", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-data/by-type",
          method: "GET",
          reply: { data: { items: QUOTE_ITEMS } },
        },
      ],
    });

    const quotes = await callOk(h, "tastytrade_get_quote", {
      symbols: ["SPY", "AAPL"],
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/market-data/by-type");
    // instrument_type defaults to Equity, and the param name is the singular
    // hyphenated form. Plural ("equities") silently returns nothing upstream,
    // which is exactly the class of bug this assertion catches.
    expect(req.params).toEqual({ equity: ["SPY", "AAPL"] });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    // include_instrument defaults false → the flag is omitted entirely.
    expect(Object.keys(req.params)).not.toContain("include-instrument");

    // `.data.data.items`, unwrapped — not the envelope.
    expect(quotes).toEqual(QUOTE_ITEMS);
  });

  it("maps 'Equity Option' to equity-option and forwards include-instrument", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
      ],
    });

    await callOk(h, "tastytrade_get_quote", {
      symbols: ["AAPL  260417C00200000"],
      instrument_type: "Equity Option",
      include_instrument: true,
    });

    const req = h.lastRequest()!;
    expect(req.params).toEqual({
      "equity-option": ["AAPL  260417C00200000"],
      "include-instrument": true,
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
  });

  // There is deliberately no per-instrument-type table here. getQuote derives
  // the param name with `instrumentType.toLowerCase().replace(/ /g, "-")` — one
  // uniform expression with no per-type branch — so a row for Future, another
  // for Cryptocurrency and another for Index all exercise the identical code
  // and kill the identical mutations as the two tests above (drop the
  // lowercasing and the Equity default fails; drop the space→hyphen and the
  // 'Equity Option' case fails). The type table that CAN be individually wrong
  // is QUOTE_SNAPSHOT_PARAM_MAP, a hand-written lookup in the dispatcher; it is
  // enumerated against tastytrade_get_quote_snapshot below, where a single
  // wrong entry is a single failing row.

  it("sends a single request at the 100-symbol endpoint cap", async () => {
    const symbols = Array.from({ length: 100 }, (_, i) => `SYM${i}`);
    h = await createHarness({
      routes: [
        { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
      ],
    });

    await callOk(h, "tastytrade_get_quote", { symbols });

    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()!.params).toEqual({ equity: symbols });
  });

  it("refuses 101 symbols before any HTTP call, as a non-retryable validation error", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_quote", {
      symbols: Array.from({ length: 101 }, (_, i) => `SYM${i}`),
    });

    // The cap IS enforced: no request escapes.
    expect(h.requests).toHaveLength(0);
    expect(err.message).toMatch(/101 symbols exceeds the 100-symbol/);
    // The argument fault is the CALLER's, so it must be reported as
    // `validation`, matching tastytrade_get_quote_snapshot's identical cap.
    // getQuote would throw a bare `new Error(...)`, which adaptError's
    // fallback classified as `upstream_error` — an agent branching on `code`
    // (as errors.ts instructs) would then conclude the broker was broken and
    // retry rather than split its symbol list.
    expect(err.code).toBe("validation");
    expect(err.retryable).toBe(false);
    expect((err as { hint?: string }).hint).toMatch(/Split the symbol list/);
  });

  it("refuses an empty symbol list, also as validation", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_quote", { symbols: [] });

    expect(h.requests).toHaveLength(0);
    expect(err.message).toMatch(/at least one symbol required/);
    expect(err.code).toBe("validation");
    expect(err.retryable).toBe(false);
  });
});

describe("market data: tastytrade_get_quote_snapshot", () => {
  it("buckets a heterogenous list into one kebab-keyed /market-data/by-type call", async () => {
    const items = [
      { symbol: "SPY", mark: 601.13 },
      { symbol: "AAPL  260417C00200000", mark: 4.35 },
      { symbol: "/ESM6", mark: 6021.5 },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/market-data/by-type",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const snapshot = await callOk(h, "tastytrade_get_quote_snapshot", {
      symbols: [
        { symbol: "SPY", instrument_type: "Equity" },
        { symbol: "QQQ", instrument_type: "Equity" },
        { symbol: "AAPL  260417C00200000", instrument_type: "Equity Option" },
        { symbol: "/ESM6", instrument_type: "Future" },
      ],
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/market-data/by-type");
    // One request, one param per instrument type, symbols grouped per bucket.
    expect(h.requests).toHaveLength(1);
    expect(req.params).toEqual({
      equity: ["SPY", "QQQ"],
      "equity-option": ["AAPL  260417C00200000"],
      future: ["/ESM6"],
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(snapshot).toEqual(items);
  });

  /**
   * Every entry of QUOTE_SNAPSHOT_PARAM_MAP, the dispatcher's hand-written
   * instrument_type -> query-param lookup. Unlike getQuote's derived
   * `toLowerCase().replace(/ /g,"-")`, each row here is typed out by hand and
   * can be individually wrong, so each row is its own failure. Two of them —
   * Future Option and Cryptocurrency — could be changed to any string at all
   * with the whole suite still green before this table existed. A type the map
   * does not carry is rejected as `validation`, asserted separately below, so
   * this list is also the exhaustive set of types the tool accepts.
   */
  it.each([
    ["Equity", "equity", "SPY"],
    ["Equity Option", "equity-option", "AAPL  260417C00200000"],
    ["Future", "future", "/ESM6"],
    ["Future Option", "future-option", "./ESM6 EW2N6 250620C6000"],
    ["Cryptocurrency", "cryptocurrency", "BTC/USD"],
    ["Index", "index", "SPX"],
  ])(
    "buckets instrument_type %s under the %s param",
    async (type, param, symbol) => {
      h = await createHarness({
        routes: [
          { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
        ],
      });

      await callOk(h, "tastytrade_get_quote_snapshot", {
        symbols: [{ symbol, instrument_type: type }],
      });

      expect(h.lastRequest()!.params).toEqual({ [param]: [symbol] });
    },
  );

  it("forwards include-instrument as kebab-case when requested", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
      ],
    });

    await callOk(h, "tastytrade_get_quote_snapshot", {
      symbols: [{ symbol: "SPY", instrument_type: "Equity" }],
      include_instrument: true,
    });

    expect(h.lastRequest()!.params).toEqual({
      equity: ["SPY"],
      "include-instrument": true,
    });
  });

  it("allows exactly 100 symbols (the endpoint's combined cap)", async () => {
    const symbols = Array.from({ length: 100 }, (_, i) => ({
      symbol: `SYM${i}`,
      instrument_type: i % 2 === 0 ? "Equity" : "Index",
    }));
    h = await createHarness({
      routes: [
        { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
      ],
    });

    await callOk(h, "tastytrade_get_quote_snapshot", { symbols });

    expect(h.requests).toHaveLength(1);
    const params = h.lastRequest()!.params as Record<string, string[]>;
    expect(params.equity).toHaveLength(50);
    expect(params.index).toHaveLength(50);
  });

  it("rejects 101 symbols with a structured validation error and no HTTP call", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_quote_snapshot", {
      symbols: Array.from({ length: 101 }, (_, i) => ({
        symbol: `SYM${i}`,
        instrument_type: "Equity",
      })),
    });

    // This is the honest, correctly-typed version of the cap. The dispatcher
    // checks it before the client is touched, so nothing goes out and the agent
    // gets an actionable `validation` code with a hint.
    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/101 symbols exceeds the 100-symbol/);
    expect(err.retryable).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  it("rejects an unknown instrument_type before bucketing", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_quote_snapshot", {
      symbols: [{ symbol: "SPY", instrument_type: "Equities" }],
    });

    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/valid instrument_type/);
    expect(h.requests).toHaveLength(0);
  });

  it("rejects an empty symbol list", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_quote_snapshot", {
      symbols: [],
    });

    expect(err.code).toBe("validation");
    expect(h.requests).toHaveLength(0);
  });
});

describe("market data: tastytrade_get_api_quote_token", () => {
  it("GETs /api-quote-tokens and returns the unwrapped streamer credentials", async () => {
    const token = {
      token: "streamer-token-not-a-real-secret",
      "dxlink-url": "wss://tasty-openapi-ws.dxfeed.com/realtime",
      level: "api",
    };
    h = await createHarness({
      routes: [
        { matcher: "/api-quote-tokens", method: "GET", reply: { data: token } },
      ],
    });

    const result = await callOk(h, "tastytrade_get_api_quote_token");

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/api-quote-tokens");
    expect(req.params).toEqual({});
    expect(result).toEqual(token);
  });
});

// ============================================================================
// Market metrics
// ============================================================================

describe("market metrics", () => {
  it("GETs /market-metrics with symbols comma-joined into one param", async () => {
    const items = [
      {
        symbol: "AAPL",
        "implied-volatility-index": "0.2845",
        "implied-volatility-rank": "0.3512",
        "liquidity-rating": 4,
      },
      { symbol: "SPY", "implied-volatility-index": "0.1421" },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/market-metrics",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const metrics = await callOk(h, "tastytrade_get_market_metrics", {
      symbols: ["AAPL", "SPY"],
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/market-metrics");
    // Documented shape is a single comma-joined `symbols` value, NOT a
    // repeated `symbols[]` key.
    expect(req.params).toEqual({ symbols: "AAPL,SPY" });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(metrics).toEqual(items);
  });

  it("leaves '/' in a symbol for axios to encode rather than pre-encoding it", async () => {
    h = await createHarness({
      routes: [{ matcher: "/market-metrics", reply: { data: { items: [] } } }],
    });

    await callOk(h, "tastytrade_get_market_metrics", {
      symbols: ["BRK/B", "AAPL"],
    });

    // The raw param value carries the slash; axios percent-encodes the value as
    // a unit at serialization time, which is what the API expects.
    expect(h.lastRequest()!.params).toEqual({ symbols: "BRK/B,AAPL" });
  });

  it("GETs the historic dividends path for a symbol", async () => {
    const items = [
      { "occurred-date": "2026-02-07", amount: 0.25 },
      { "occurred-date": "2025-11-08", amount: 0.25 },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: /historic-corporate-events\/dividends/,
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const dividends = await callOk(h, "tastytrade_get_historical_dividends", {
      symbol: "AAPL",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "/market-metrics/historic-corporate-events/dividends/AAPL",
    );
    // The endpoint documents no query parameters at all.
    expect(req.params).toEqual({});
    expect(dividends).toEqual(items);
  });

  it("percent-encodes a slash in the dividends path segment", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /historic-corporate-events\/dividends/,
          reply: { data: { items: [] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_historical_dividends", {
      symbol: "BRK/B",
    });

    expect(h.lastRequest()!.url).toBe(
      "/market-metrics/historic-corporate-events/dividends/BRK%2FB",
    );
  });

  it("percent-encodes a slash in the earnings-reports path segment too", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /historic-corporate-events\/earnings-reports/,
          reply: { data: { items: [] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_earnings_reports", { symbol: "BRK/B" });

    // The sibling above pinned the dividends path only, so getEarningsReports
    // could drop its encodeURIComponent with the whole suite still green —
    // even though both take the same free-text equity symbol, and equity
    // symbols may contain a `/` (BRK/A, BRK/B — api-overview.md).
    const url = h.lastRequest()!.url;
    expect(url).toBe(
      "/market-metrics/historic-corporate-events/earnings-reports/BRK%2FB",
    );
    expect(url.split("/")).toHaveLength(5);
  });

  it("GETs the earnings-reports path — but sends NO date range, which the API requires", async () => {
    const items = [
      { "occurred-date": "2026-01-30", eps: 2.41 },
      { "occurred-date": "2025-10-30", eps: 1.64 },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: /historic-corporate-events\/earnings-reports/,
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const earnings = await callOk(h, "tastytrade_get_earnings_reports", {
      symbol: "AAPL",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      "/market-metrics/historic-corporate-events/earnings-reports/AAPL",
    );
    expect(earnings).toEqual(items);

    // FINDING (broken tool): market-metrics.md documents `start-date` as a REQUIRED
    // query parameter here. But the tool's inputSchema exposes only `symbol` and
    // decorateTool sets `additionalProperties: false`, so an agent CANNOT pass a date
    // range — and the client passes no params at all. Against the live API this 422s every
    // time, while the tool's own description tells the agent "`start_date` (YYYY-MM-DD) is
    // mandatory": an argument the schema forbids. This pins the current (empty) param set
    // so the fix is visible when it lands.
    expect(req.params).toEqual({});
  });
});

// ============================================================================
// Instruments — active equities + quantity precisions
// ============================================================================

describe("instruments: tastytrade_get_active_equities", () => {
  it("GETs /instruments/equities/active with kebab-case paging params", async () => {
    const items = [
      { symbol: "AAPL", "instrument-type": "Equity", active: true },
      { symbol: "MSFT", "instrument-type": "Equity", active: true },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/instruments/equities/active",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const equities = await callOk(h, "tastytrade_get_active_equities", {
      page_offset: 2,
      per_page: 500,
      lendability: "Easy To Borrow",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/equities/active");
    expect(req.params).toEqual({
      "page-offset": 2,
      "per-page": 500,
      lendability: "Easy To Borrow",
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(equities).toEqual(items);
  });

  it("omits every paging param when the agent passes none", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/instruments/equities/active",
          reply: { data: { items: [] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_active_equities", {});

    // The dispatcher only copies keys the caller actually set, so no
    // `page-offset=undefined` noise reaches the wire.
    expect(h.lastRequest()!.params).toEqual({});
  });
});

describe("instruments: tastytrade_get_quantity_precisions", () => {
  it("GETs /instruments/quantity-decimal-precisions", async () => {
    const items = [
      {
        "instrument-type": "Cryptocurrency",
        value: 8,
        "minimum-increment-precision": 8,
      },
      {
        "instrument-type": "Equity",
        value: 0,
        "minimum-increment-precision": 0,
      },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/instruments/quantity-decimal-precisions",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const precisions = await callOk(h, "tastytrade_get_quantity_precisions");

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/quantity-decimal-precisions");
    expect(req.params).toEqual({});

    // Unwrapped to the bare array, like every other list tool in this group,
    // and as this tool's own metadata description + outputSchema promise.
    // getQuantityDecimalPrecisions() would return `response.data.data`, so
    // the text payload the agent read was the `{items:[...]}` WRAPPER and
    // `result[0]` per the description came back undefined. (structuredContent
    // lined up either way, because the dispatcher wraps bare arrays as
    // `{items: …}` anyway — which is exactly why this went unnoticed.)
    expect(precisions).toEqual(items);
    expect(precisions).not.toHaveProperty("items");
  });

  it("still satisfies its declared output schema after unwrapping", async () => {
    const items = [
      {
        "instrument-type": "Cryptocurrency",
        value: 8,
        "minimum-increment-precision": 8,
      },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/instruments/quantity-decimal-precisions",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    // tools/list is load-bearing: the SDK caches each tool's outputSchema and
    // validates structuredContent against it, so this is what proves the
    // unwrap did not break a spec-aware client.
    await h.client.listTools();
    const res = (await h.client.callTool({
      name: "tastytrade_get_quantity_precisions",
      arguments: {},
    })) as { isError?: boolean; structuredContent?: unknown };

    expect(res.isError).toBeFalsy();
    // A bare array payload is re-wrapped under `items` by the dispatcher, so
    // the declared `{ items: QuantityDecimalPrecision[] }` schema still holds.
    expect(res.structuredContent).toEqual({ items });
  });
});

// ============================================================================
// Market sessions + holidays
// ============================================================================

describe("market sessions: tastytrade_get_market_session", () => {
  const SESSION = {
    "instrument-collection": "Equity",
    "open-at": "2026-08-14T13:30:00.000Z",
    "close-at": "2026-08-14T20:00:00.000Z",
    state: "Open",
  };

  it.each(["current", "next", "previous"] as const)(
    "routes a single Equity collection with when=%s to the equities endpoint",
    async (when) => {
      h = await createHarness({
        routes: [
          {
            matcher: /^\/market-time\/equities\/sessions\//,
            method: "GET",
            reply: { data: SESSION },
          },
        ],
      });

      const session = await callOk(h, "tastytrade_get_market_session", {
        collections: ["Equity"],
        when,
      });

      const req = h.lastRequest()!;
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`/market-time/equities/sessions/${when}`);
      expect(req.params).toEqual({});
      expect(session).toEqual(SESSION);
    },
  );

  it("defaults `when` to current when the agent omits it", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /^\/market-time\/equities\/sessions\//,
          reply: { data: SESSION },
        },
      ],
    });

    await callOk(h, "tastytrade_get_market_session", {
      collections: ["Equity"],
    });

    expect(h.lastRequest()!.url).toBe("/market-time/equities/sessions/current");
  });

  it.each([
    ["CME", "previous"],
    ["CFE", "next"],
  ] as const)(
    "routes a single %s collection to /market-time/futures/sessions/{when}/{collection}",
    async (collection, when) => {
      h = await createHarness({
        routes: [
          {
            matcher: /^\/market-time\/futures\/sessions\//,
            method: "GET",
            reply: {
              data: { ...SESSION, "instrument-collection": collection },
            },
          },
        ],
      });

      const session = (await callOk(h, "tastytrade_get_market_session", {
        collections: [collection],
        when,
      })) as Record<string, unknown>;

      const req = h.lastRequest()!;
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/market-time/futures/sessions/${when}/${collection}`,
      );
      expect(session["instrument-collection"]).toBe(collection);
    },
  );

  it("routes a multi-collection current query to /market-time/sessions/current with a kebab repeated param", async () => {
    const payload = { Equity: SESSION, CME: { state: "Open" } };
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/sessions/current",
          method: "GET",
          reply: { data: payload },
        },
      ],
    });

    const sessions = await callOk(h, "tastytrade_get_market_session", {
      collections: ["Equity", "CME"],
      when: "current",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/market-time/sessions/current");
    // Serialized by the client as repeated `instrument-collections=` keys; the
    // params object the adapter records is the pre-serialization array.
    expect(req.params).toEqual({
      "instrument-collections": ["Equity", "CME"],
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(sessions).toEqual(payload);
  });

  it("refuses a multi-collection next/previous query, which the API cannot serve", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_market_session", {
      collections: ["Equity", "CME"],
      when: "next",
    });

    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/only support when=current/);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses an empty collections array", async () => {
    h = await createHarness();

    const err = await callError(h, "tastytrade_get_market_session", {
      collections: [],
    });

    expect(err.code).toBe("validation");
    expect(h.requests).toHaveLength(0);
  });
});

describe("market sessions: tastytrade_get_market_holidays", () => {
  const CALENDAR = {
    "market-holidays": ["2026-01-01", "2026-07-03"],
    "market-half-days": ["2026-11-27"],
  };

  it("defaults to the equities holiday calendar", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/equities/holidays",
          method: "GET",
          reply: { data: CALENDAR },
        },
      ],
    });

    const holidays = await callOk(h, "tastytrade_get_market_holidays", {});

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/market-time/equities/holidays");
    expect(holidays).toEqual(CALENDAR);
  });

  it.each(["CME", "CFE"] as const)(
    "routes collection %s to /market-time/futures/holidays/{collection}",
    async (collection) => {
      h = await createHarness({
        routes: [
          {
            matcher: /^\/market-time\/futures\/holidays\//,
            method: "GET",
            reply: { data: CALENDAR },
          },
        ],
      });

      const holidays = await callOk(h, "tastytrade_get_market_holidays", {
        collection,
      });

      expect(h.lastRequest()!.url).toBe(
        `/market-time/futures/holidays/${collection}`,
      );
      expect(holidays).toEqual(CALENDAR);
    },
  );
});

/**
 * The two market-TIME tools put a declared enum in PATH-SEGMENT position, and a bare
 * `as` cast "enforcing" it emits no code.
 *
 * `get_market_session` had the check fifteen lines above where it was needed, inside
 * `if (collections.length > 1)`. So the SAME value was refused or forwarded depending
 * only on how many array elements accompanied it: `["INJECTED","CME"]` came back
 * `validation` with an empty wire, while `["INJECTED"]` dialled
 * `GET /market-time/futures/sessions/current/INJECTED` under the operator's bearer and
 * was reported as an ordinary success. Neither the schema, the description nor the
 * refusal messages express that distinction. The single branch's cast even listed
 * `'Zero Hash CLOB'` — the one value its sibling refuses by name.
 *
 * `get_market_holidays` has no multi-collection sibling, so there the enum was simply
 * unenforced.
 *
 * The four-way contrast below is the test: both parameters, both arities. NOT a
 * path-construction fix, and that is asserted — neither value is a dot or empty
 * segment, so `apiPath` passes both through byte-identically.
 */
const ANY_MARKET_TIME = /^\/market-time\//;

describe("market-time enums hold on every branch", () => {
  /** Every collection/when pair below must be refused with an empty wire. */
  const REFUSED: Array<[string, Record<string, unknown>]> = [
    [
      "single, off-enum collection",
      { collections: ["INJECTED"], when: "current" },
    ],
    [
      "multi, off-enum collection",
      { collections: ["INJECTED", "CME"], when: "current" },
    ],
    ["single, off-enum when", { collections: ["Equity"], when: "arbitrary" }],
    [
      "multi, off-enum when",
      { collections: ["Equity", "CME"], when: "arbitrary" },
    ],
    [
      "single, Zero Hash CLOB",
      { collections: ["Zero Hash CLOB"], when: "current" },
    ],
    [
      "multi, Zero Hash CLOB",
      { collections: ["Zero Hash CLOB", "CME"], when: "current" },
    ],
    ["a prototype member as a collection", { collections: ["__proto__"] }],
    ["a non-string collection element", { collections: [{}] }],
    ["collections that is not an array", { collections: "Equity" }],
  ];

  it.each(REFUSED)(
    "refuses get_market_session (%s) without issuing a request",
    async (_label, args) => {
      h = await createHarness({
        routes: [{ matcher: ANY_MARKET_TIME, reply: { data: {} } }],
      });

      const err = await callError(h, "tastytrade_get_market_session", args);

      expect(err.code).toBe("validation");
      expect(h.requests).toHaveLength(0);
    },
  );

  it("names 'Zero Hash CLOB' in the refusal on the single branch too", async () => {
    h = await createHarness();
    const single = await callError(h, "tastytrade_get_market_session", {
      collections: ["Zero Hash CLOB"],
      when: "current",
    });
    const multi = await callError(h, "tastytrade_get_market_session", {
      collections: ["Zero Hash CLOB", "CME"],
      when: "current",
    });
    expect(single.message).toMatch(/Zero Hash CLOB/);
    expect(multi.message).toMatch(/Zero Hash CLOB/);
  });

  it("still dispatches the legitimate single-collection call", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/equities/sessions/current",
          method: "GET",
          reply: { data: { state: "Open" } },
        },
      ],
    });

    const out = await callOk(h, "tastytrade_get_market_session", {
      collections: ["Equity"],
      when: "current",
    });

    expect(h.lastRequest()!.url).toBe("/market-time/equities/sessions/current");
    expect(out).toEqual({ state: "Open" });
  });

  it("still dispatches the legitimate multi-collection call", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/sessions/current",
          method: "GET",
          reply: { data: { CME: { state: "Open" } } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_market_session", {
      collections: ["CME", "Equity"],
      when: "current",
    });

    expect(h.lastRequest()!.url).toBe("/market-time/sessions/current");
    expect(h.lastRequest()!.params).toEqual({
      "instrument-collections": ["CME", "Equity"],
    });
  });

  it("still dispatches a legitimate futures session for each when", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /^\/market-time\/futures\/sessions\//,
          method: "GET",
          reply: { data: { state: "Closed" } },
        },
      ],
    });

    for (const when of ["current", "next", "previous"]) {
      await callOk(h, "tastytrade_get_market_session", {
        collections: ["CFE"],
        when,
      });
      expect(h.lastRequest()!.url).toBe(
        `/market-time/futures/sessions/${when}/CFE`,
      );
    }
  });

  // -------- the second entry point --------

  it.each(["INJECTED", "Zero Hash CLOB", "__proto__", ""])(
    "refuses get_market_holidays for collection %p without issuing a request",
    async (collection) => {
      h = await createHarness({
        routes: [{ matcher: ANY_MARKET_TIME, reply: { data: {} } }],
      });

      const err = await callError(h, "tastytrade_get_market_holidays", {
        collection,
      });

      expect(err.code).toBe("validation");
      expect(h.requests).toHaveLength(0);
    },
  );

  it("still serves the holiday calendar for every declared collection", async () => {
    h = await createHarness({
      routes: [{ matcher: ANY_MARKET_TIME, reply: { data: { x: 1 } } }],
    });

    await callOk(h, "tastytrade_get_market_holidays", {});
    expect(h.lastRequest()!.url).toBe("/market-time/equities/holidays");

    for (const collection of ["CME", "CFE"]) {
      await callOk(h, "tastytrade_get_market_holidays", { collection });
      expect(h.lastRequest()!.url).toBe(
        `/market-time/futures/holidays/${collection}`,
      );
    }
  });

  // -------- the invariant, derived from the wire --------

  it("refuses every value the shipped schema does not declare, on both tools", async () => {
    // Derived at test time from tools/list rather than written out here: the
    // enum is the tool's published contract, and a test that restates it can
    // agree with a stale copy of it.
    h = await createHarness({
      routes: [{ matcher: ANY_MARKET_TIME, reply: { data: {} } }],
    });
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const sessionSchema = byName.get("tastytrade_get_market_session")!
      .inputSchema as any;
    const declaredCollections: string[] =
      sessionSchema.properties.collections.items.enum;
    const declaredWhens: string[] = sessionSchema.properties.when.enum;
    const holidaySchema = byName.get("tastytrade_get_market_holidays")!
      .inputSchema as any;
    const declaredHolidayCollections: string[] =
      holidaySchema.properties.collection.enum;

    // Non-vacuity: an empty declared set would make every sweep below trivial.
    expect(declaredCollections.length).toBeGreaterThan(0);
    expect(declaredWhens.length).toBeGreaterThan(0);
    expect(declaredHolidayCollections).toEqual(declaredCollections);

    const OFF_ENUM = ["INJECTED", "Zero Hash CLOB", "equity", "CME "];
    for (const bogus of OFF_ENUM) {
      expect(declaredCollections).not.toContain(bogus);
      const before = h.requests.length;
      const err = await callError(h, "tastytrade_get_market_session", {
        collections: [bogus],
      });
      expect(err.code).toBe("validation");
      expect(h.requests).toHaveLength(before);
    }
    for (const bogus of ["ARBITRARY", "Current", "current "]) {
      expect(declaredWhens).not.toContain(bogus);
      const before = h.requests.length;
      const err = await callError(h, "tastytrade_get_market_session", {
        collections: ["Equity"],
        when: bogus,
      });
      expect(err.code).toBe("validation");
      expect(h.requests).toHaveLength(before);
    }
    // Every DECLARED value still dispatches, so the sweep above is not
    // satisfied by a tool that refuses everything.
    for (const good of declaredCollections) {
      for (const when of declaredWhens) {
        const before = h.requests.length;
        await callOk(h, "tastytrade_get_market_session", {
          collections: [good],
          when,
        });
        expect(h.requests.length).toBe(before + 1);
      }
    }
  });
});

describe("market sessions: tastytrade_get_sessions_range", () => {
  it("GETs /market-time/sessions translating every date arg to kebab-case", async () => {
    const items = [
      {
        "start-at": "2026-08-14T13:30:00.000Z",
        "instrument-collection": "CME",
      },
      {
        "start-at": "2026-08-17T13:30:00.000Z",
        "instrument-collection": "CME",
      },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/sessions",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const sessions = await callOk(h, "tastytrade_get_sessions_range", {
      to_date: "2026-09-30",
      from_date: "2026-08-14",
      instrument_collection: "CME",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/market-time/sessions");
    expect(req.params).toEqual({
      "to-date": "2026-09-30",
      "from-date": "2026-08-14",
      "instrument-collection": "CME",
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(sessions).toEqual(items);
  });

  it("sends only to-date when the optional args are omitted", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/market-time/sessions", reply: { data: { items: [] } } },
      ],
    });

    await callOk(h, "tastytrade_get_sessions_range", {
      to_date: "2026-09-30",
    });

    expect(h.lastRequest()!.params).toEqual({ "to-date": "2026-09-30" });
  });
});

// ============================================================================
// SPAN rows + total fees
// ============================================================================

describe("risk: tastytrade_get_span_rows", () => {
  it("GETs /span/rows with kebab paging params", async () => {
    const items = [
      { "exchange-symbol": "ES", "risk-array": [1, 2, 3] },
      { "exchange-symbol": "NQ", "risk-array": [4, 5, 6] },
    ];
    h = await createHarness({
      routes: [
        { matcher: "/span/rows", method: "GET", reply: { data: { items } } },
      ],
    });

    const rows = await callOk(h, "tastytrade_get_span_rows", {
      date: "2026-08-14",
      exchange: "CME",
      page_offset: 1,
      per_page: 2000,
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/span/rows");
    expect(req.params).toEqual({
      date: "2026-08-14",
      exchange: "CME",
      "page-offset": 1,
      "per-page": 2000,
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(rows).toEqual(items);
  });

  it("sends only the two required params when paging is omitted", async () => {
    h = await createHarness({
      routes: [{ matcher: "/span/rows", reply: { data: { items: [] } } }],
    });

    await callOk(h, "tastytrade_get_span_rows", {
      date: "2026-08-14",
      exchange: "CFE",
    });

    expect(h.lastRequest()!.params).toEqual({
      date: "2026-08-14",
      exchange: "CFE",
    });
  });
});

describe("transactions: tastytrade_get_total_fees", () => {
  it("GETs /accounts/{n}/transactions/total-fees with the single-day date param", async () => {
    const fees = { "total-fees": "12.34", "total-fees-effect": "Debit" };
    h = await createHarness({
      routes: [
        {
          matcher: /\/transactions\/total-fees$/,
          method: "GET",
          reply: { data: fees },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_total_fees", {
      account_number: "5WX00001",
      date: "2026-08-14",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/accounts/5WX00001/transactions/total-fees");
    // `date` needs no translation, but account_number must NOT appear as a
    // query param — it belongs in the path.
    expect(req.params).toEqual({ date: "2026-08-14" });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(result).toEqual(fees);
  });

  it("leaves date unset when the agent omits it (endpoint defaults to today)", async () => {
    h = await createHarness({
      routes: [{ matcher: /\/transactions\/total-fees$/, reply: { data: {} } }],
    });

    await callOk(h, "tastytrade_get_total_fees", {
      account_number: "5WX00001",
    });

    // The client always builds `{ date }`, so the key exists with an undefined
    // value; axios drops undefined values at serialization time.
    expect(h.lastRequest()!.params.date).toBeUndefined();
  });
});

// ============================================================================
// User watchlists — read
// ============================================================================

describe("watchlists: reads", () => {
  it("GETs /watchlists and returns the unwrapped items array", async () => {
    const items = [
      { name: "Tech", "watchlist-entries": [{ symbol: "AAPL" }] },
      { name: "Energy", "watchlist-entries": [{ symbol: "XOM" }] },
    ];
    h = await createHarness({
      routes: [
        { matcher: "/watchlists", method: "GET", reply: { data: { items } } },
      ],
    });

    const watchlists = await callOk(h, "tastytrade_get_watchlists");

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/watchlists");
    expect(watchlists).toEqual(items);
  });

  it("GETs /watchlists/{name} and returns the unwrapped watchlist", async () => {
    const watchlist = {
      name: "Tech",
      "group-name": "Thematic",
      "order-index": 9999,
      "watchlist-entries": [
        { symbol: "AAPL", "instrument-type": "Equity" },
        { symbol: "MSFT", "instrument-type": "Equity" },
      ],
    };
    h = await createHarness({
      routes: [
        {
          matcher: "/watchlists/Tech",
          method: "GET",
          reply: { data: watchlist },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_watchlist", {
      name: "Tech",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/watchlists/Tech");
    expect(result).toEqual(watchlist);
  });

  it("surfaces an unknown watchlist name as not_found", async () => {
    h = await createHarness({
      routes: [{ matcher: /^\/watchlists\//, reply: { status: 404 } }],
    });

    const err = await callError(h, "tastytrade_get_watchlist", {
      name: "Nope",
    });

    expect(err.code).toBe("not_found");
  });

  it("URL-encodes a slash-bearing watchlist name into ONE path segment", async () => {
    h = await createHarness({
      routes: [{ matcher: /^\/watchlists\//, reply: { data: {} } }],
    });

    await callOk(h, "tastytrade_get_watchlist", { name: "Vol / Vega" });

    // getWatchlist/updateWatchlist/deleteWatchlist and the add/remove helpers
    // would interpolate the name raw — `/watchlists/${watchlistName}` —
    // while getPublicWatchlist, getPairsWatchlist and deleteQuoteAlert all
    // called encodeURIComponent. A user watchlist named
    // "Vol / Vega" therefore addressed a different, deeper path than the
    // resource it names, and the read (or worse, the PUT/DELETE) silently
    // missed. The name is free text from the agent, so leaving it raw also
    // made the path traversable.
    expect(h.lastRequest()!.url).toBe("/watchlists/Vol%20%2F%20Vega");
    // Exactly two segments: `watchlists` and the whole name.
    expect(h.lastRequest()!.url.split("/").slice(1)).toHaveLength(2);
  });

  it("cannot be walked out of /watchlists by a traversal name", async () => {
    h = await createHarness({
      routes: [{ matcher: /.*/, reply: { data: {} } }],
    });

    await callOk(h, "tastytrade_get_watchlist", {
      name: "../../customers/me",
    });

    // Raw interpolation let axios's `new URL()` resolution collapse the dot
    // segments, so this request would leave for GET /customers/me. Encoded,
    // the dots stay inside the single name segment.
    const url = h.lastRequest()!.url;
    expect(url).toBe("/watchlists/..%2F..%2Fcustomers%2Fme");
    expect(new URL("https://api.cert.tastyworks.com" + url).pathname).toBe(
      "/watchlists/..%2F..%2Fcustomers%2Fme",
    );
  });
});

// ============================================================================
// User watchlists — writes (POST / PUT / DELETE)
// ============================================================================

describe("watchlists: tastytrade_create_watchlist", () => {
  it("POSTs /watchlists with a kebab-case body, defaulting a bare string entry to Equity", async () => {
    const created = {
      name: "Scratch",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    };
    h = await createHarness({
      routes: [
        { matcher: "/watchlists", method: "POST", reply: { data: created } },
      ],
    });

    const result = await callOk(h, "tastytrade_create_watchlist", {
      name: "Scratch",
      symbols: [
        "AAPL",
        { symbol: "MSFT" },
        { symbol: "AAPL  260417C00200000", instrument_type: "Equity Option" },
        { symbol: "/ESM6", instrument_type: "Future" },
      ],
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/watchlists");
    // Both defaulting paths (bare string, object with no instrument_type)
    // resolve to "Equity"; an explicit instrument_type is preserved verbatim
    // and re-keyed to `instrument-type`.
    expect(req.body).toEqual({
      name: "Scratch",
      "watchlist-entries": [
        { symbol: "AAPL", "instrument-type": "Equity" },
        { symbol: "MSFT", "instrument-type": "Equity" },
        {
          symbol: "AAPL  260417C00200000",
          "instrument-type": "Equity Option",
        },
        { symbol: "/ESM6", "instrument-type": "Future" },
      ],
    });
    expect(snakeCaseKeys(req.body)).toEqual([]);
    expect(result).toEqual(created);
  });

  it("sends an empty entry list when symbols is empty", async () => {
    h = await createHarness({
      routes: [{ matcher: "/watchlists", method: "POST", reply: { data: {} } }],
    });

    await callOk(h, "tastytrade_create_watchlist", {
      name: "Empty",
      symbols: [],
    });

    expect(h.lastRequest()!.body).toEqual({
      name: "Empty",
      "watchlist-entries": [],
    });
  });
});

describe("watchlists: tastytrade_update_watchlist", () => {
  it("PUTs /watchlists/{name} with the full replacement body", async () => {
    const updated = {
      name: "Tech",
      "watchlist-entries": [{ symbol: "NVDA", "instrument-type": "Equity" }],
    };
    h = await createHarness({
      routes: [
        {
          matcher: "/watchlists/Tech",
          method: "PUT",
          reply: { data: updated },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_update_watchlist", {
      name: "Tech",
      symbols: ["NVDA", { symbol: "/ESM6", instrument_type: "Future" }],
    });

    const req = h.lastRequest()!;
    // PUT, not PATCH — the API treats this as a full replacement.
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("/watchlists/Tech");
    // The entity carries its own name in the body as well as the path.
    expect(req.body).toEqual({
      name: "Tech",
      "watchlist-entries": [
        { symbol: "NVDA", "instrument-type": "Equity" },
        { symbol: "/ESM6", "instrument-type": "Future" },
      ],
    });
    expect(snakeCaseKeys(req.body)).toEqual([]);
    expect(result).toEqual(updated);
    // Exactly one request: update does not read-then-write.
    expect(h.requests).toHaveLength(1);
  });
});

describe("watchlists: tastytrade_delete_watchlist", () => {
  it("DELETEs /watchlists/{name}", async () => {
    const deleted = { name: "Scratch", "watchlist-entries": [] };
    h = await createHarness({
      routes: [
        {
          matcher: "/watchlists/Scratch",
          method: "DELETE",
          reply: { data: deleted },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_delete_watchlist", {
      name: "Scratch",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("/watchlists/Scratch");
    expect(req.body).toBeUndefined();

    // deleteWatchlist would be the only method in this group returning
    // `response.data` instead of `response.data.data`, so the agent received
    // the raw `{data:{…}}` transport envelope where every sibling tool hands
    // back the inner object — `result.name` was undefined and the caller had
    // to know to reach through `.data`. open-api-spec/watchlists.md says
    // DELETE returns the deleted Watchlist, so that is what comes back now.
    expect(result).toEqual(deleted);
    expect(result).not.toHaveProperty("data");
  });
});

// tastytrade_add_watchlist_symbol / tastytrade_remove_watchlist_symbol are the
// two watchlist tools this suite does NOT own — they belong to the instruments
// group (see the GROUP_TOOLS list above, which omits them) and their GET-modify-
// PUT round trip is covered in test/e2e/instruments.test.ts, which additionally
// pins the exact symbol+instrument-type match on removal and the URL encoding
// of the watchlist name on both legs. A second, weaker copy would sit here.

// ============================================================================
// Public + pairs watchlists
// ============================================================================

describe("watchlists: public and pairs", () => {
  it("GETs /public-watchlists with no params by default", async () => {
    const items = [
      { name: "Tasty Top 25", "watchlist-entries": [{ symbol: "SPY" }] },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/public-watchlists",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_public_watchlists", {});

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/public-watchlists");
    expect(req.params).toEqual({});
    expect(result).toEqual(items);
  });

  it("translates counts_only to the kebab counts-only param", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/public-watchlists", reply: { data: { items: [] } } },
      ],
    });

    await callOk(h, "tastytrade_get_public_watchlists", { counts_only: true });

    const req = h.lastRequest()!;
    expect(req.params).toEqual({ "counts-only": true });
    expect(snakeCaseKeys(req.params)).toEqual([]);
  });

  it("GETs a single public watchlist by name, URL-encoding the segment", async () => {
    const watchlist = {
      name: "High Options Volume",
      "watchlist-entries": [{ symbol: "SPY", "instrument-type": "Equity" }],
    };
    h = await createHarness({
      routes: [
        {
          matcher: /^\/public-watchlists\//,
          method: "GET",
          reply: { data: watchlist },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_public_watchlist", {
      name: "High Options Volume",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    // Unlike the user-watchlist path, this one is encodeURIComponent'd.
    expect(req.url).toBe("/public-watchlists/High%20Options%20Volume");
    expect(result).toEqual(watchlist);
  });

  it("GETs /pairs-watchlists and returns the unwrapped items array", async () => {
    const items = [
      {
        name: "Pairs",
        "pairs-equations": [{ "left-symbol": "GLD", "right-symbol": "SLV" }],
      },
    ];
    h = await createHarness({
      routes: [
        {
          matcher: "/pairs-watchlists",
          method: "GET",
          reply: { data: { items } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_pairs_watchlists");

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/pairs-watchlists");
    expect(result).toEqual(items);
  });

  it("GETs a single pairs watchlist by name, URL-encoding the segment", async () => {
    const watchlist = { name: "Metals Pairs", "pairs-equations": [] };
    h = await createHarness({
      routes: [
        {
          matcher: /^\/pairs-watchlists\//,
          method: "GET",
          reply: { data: watchlist },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_pairs_watchlist", {
      name: "Metals Pairs",
    });

    expect(h.lastRequest()!.url).toBe("/pairs-watchlists/Metals%20Pairs");
    expect(result).toEqual(watchlist);
  });
});

// ============================================================================
// Quote alerts
// ============================================================================

describe("quote alerts", () => {
  it("GETs /quote-alerts and returns the unwrapped items array", async () => {
    const items = [
      {
        "alert-external-id": "9f1c",
        symbol: "AAPL",
        field: "Last",
        operator: ">",
        threshold: "200.0",
        active: true,
      },
    ];
    h = await createHarness({
      routes: [
        { matcher: "/quote-alerts", method: "GET", reply: { data: { items } } },
      ],
    });

    const alerts = await callOk(h, "tastytrade_get_quote_alerts");

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/quote-alerts");
    expect(req.params).toEqual({});
    expect(alerts).toEqual(items);
  });

  it("POSTs /quote-alerts with only the four required fields when nothing optional is set", async () => {
    const created = { "alert-external-id": "9f1c", symbol: "AAPL" };
    h = await createHarness({
      routes: [
        { matcher: "/quote-alerts", method: "POST", reply: { data: created } },
      ],
    });

    const result = await callOk(h, "tastytrade_create_quote_alert", {
      symbol: "AAPL",
      field: "Last",
      operator: ">",
      threshold: "200.00",
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/quote-alerts");
    expect(req.body).toEqual({
      symbol: "AAPL",
      field: "Last",
      operator: ">",
      threshold: "200.00",
    });
    // No `instrument-type: null` noise — unset optionals are omitted, not
    // forwarded as undefined.
    expect(result).toEqual(created);
  });

  it("POSTs every optional field re-keyed to kebab-case", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/quote-alerts", method: "POST", reply: { data: {} } },
      ],
    });

    await callOk(h, "tastytrade_create_quote_alert", {
      symbol: "AAPL  260417C00200000",
      field: "IV",
      operator: "<",
      threshold: "0.25",
      instrument_type: "Equity Option",
      dx_symbol: ".AAPL260417C200",
      threshold_numeric: "0.25",
      expires_at: "2026-05-01T00:00:00.000+00:00",
    });

    const req = h.lastRequest()!;
    expect(req.body).toEqual({
      symbol: "AAPL  260417C00200000",
      field: "IV",
      operator: "<",
      threshold: "0.25",
      "instrument-type": "Equity Option",
      "dx-symbol": ".AAPL260417C200",
      "threshold-numeric": "0.25",
      "expires-at": "2026-05-01T00:00:00.000+00:00",
    });
    expect(snakeCaseKeys(req.body)).toEqual([]);
  });

  it("DELETEs /quote-alerts/{alert_external_id}", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /^\/quote-alerts\//,
          method: "DELETE",
          // The documented response is 204 No Content, and `raw` is what makes
          // it one: without it the harness wraps the body as `{data:{}}`, so
          // the old version of this test never exercised an empty body at all.
          reply: { status: 204, data: "", raw: true },
        },
      ],
    });

    // Arms the SDK's output validator — see the same round trip in
    // test/e2e/resilience.test.ts for why a 204 test without it asserts
    // nothing.
    expect((await h.client.listTools()).tools.length).toBeGreaterThan(0);

    const res = (await h.client.callTool({
      name: "tastytrade_delete_quote_alert",
      arguments: { alert_external_id: "9f1c-42" },
    })) as { isError?: boolean; structuredContent?: unknown };

    const req = h.lastRequest()!;
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("/quote-alerts/9f1c-42");
    expect(req.body).toBeUndefined();
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({});
  });

  it("URL-encodes the alert id path segment", async () => {
    h = await createHarness({
      routes: [{ matcher: /^\/quote-alerts\//, reply: { status: 204 } }],
    });

    await callOk(h, "tastytrade_delete_quote_alert", {
      alert_external_id: "a/b c",
    });

    expect(h.lastRequest()!.url).toBe("/quote-alerts/a%2Fb%20c");
  });
});

describe("regression: committed production fixtures (BUGFIX-BRIEF-market-data-schemas)", () => {
  // These assert on FIELD VALUES from the real recorded responses, not just
  // shape. output-schemas.test.ts proves the same fixtures validate through the
  // MCP client's outputSchema validator (the path that would throw); this
  // proves the values survive the unwrap intact and pins the three shapes the
  // brief called out: string-decimal prices, an index missing bid/ask/mid/
  // volume, and the -1 halt sentinel. A test that only asserts "returns an
  // array" passes on [] and would not catch a recurrence.

  const quoteRoute = () => ({
    routes: [
      {
        matcher: "/market-data/by-type",
        method: "GET" as const,
        reply: { data: loadFixture("tastytrade_get_quote") },
      },
    ],
  });

  it("get_quote: returns kebab-case string-decimal prices from the recorded response", async () => {
    h = await createHarness(quoteRoute());
    const quotes = (await callOk(h, "tastytrade_get_quote", {
      symbols: ["META", "AAPL", "VIX", "SPX"],
    })) as Array<Record<string, unknown>>;

    expect(quotes.map((q) => q.symbol)).toEqual(["META", "AAPL", "VIX", "SPX"]);
    const aapl = quotes.find((q) => q.symbol === "AAPL")!;
    expect(aapl["instrument-type"]).toBe("Equity");
    // Prices arrive as STRING-decimals, not JSON numbers — the type bug the
    // OpenAPI-derived schema missed on top of the casing bug.
    expect(typeof aapl.bid).toBe("string");
    expect(aapl.bid).toBe("312.01");
    expect(Number(aapl.bid)).toBeCloseTo(312.01);
    // Names are kebab-case; the camelCase fields the old schema promised, and
    // the `close` / `last-trade-time` fields it invented, do not exist.
    expect(aapl).not.toHaveProperty("dayHighPrice");
    expect(aapl).not.toHaveProperty("close");
    expect(aapl).not.toHaveProperty("last-trade-time");
  });

  it("get_quote: an index (VIX) parses with bid/ask/mid/volume entirely absent", async () => {
    h = await createHarness(quoteRoute());
    const quotes = (await callOk(h, "tastytrade_get_quote", {
      symbols: ["VIX"],
      instrument_type: "Index",
    })) as Array<Record<string, unknown>>;

    const vix = quotes.find((q) => q.symbol === "VIX")!;
    expect(vix["instrument-type"]).toBe("Index");
    for (const absent of ["bid", "ask", "mid", "volume"]) {
      expect(vix).not.toHaveProperty(absent);
    }
    // It still carries the fields it does quote.
    expect(vix).toHaveProperty("bid-size");
    expect(vix).toHaveProperty("mark");
  });

  it("get_quote: halt-start-time stays the sentinel -1 (not a 1969 date) when not halted", async () => {
    h = await createHarness(quoteRoute());
    const quotes = (await callOk(h, "tastytrade_get_quote", {
      symbols: ["META", "AAPL", "VIX", "SPX"],
    })) as Array<Record<string, unknown>>;

    for (const q of quotes) {
      expect(q["is-trading-halted"]).toBe(false);
      // -1 is preserved as the integer sentinel; nothing coerces it to a date.
      expect(q["halt-start-time"]).toBe(-1);
      expect(q["halt-end-time"]).toBe(-1);
    }
  });

  it("get_quote: an empty items array still returns [] (the case that masked the bug)", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
      ],
    });
    const quotes = await callOk(h, "tastytrade_get_quote", {
      symbols: ["ZZZZNOTAREALTICKER"],
    });
    expect(quotes).toEqual([]);
  });

  it("get_market_metrics: IV fields come back in their documented (mixed) units", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-metrics",
          method: "GET",
          reply: { data: loadFixture("tastytrade_get_market_metrics") },
        },
      ],
    });
    const metrics = (await callOk(h, "tastytrade_get_market_metrics", {
      symbols: ["AAPL"],
    })) as Array<Record<string, unknown>>;

    const aapl = metrics[0];
    expect(aapl.symbol).toBe("AAPL");
    // implied-volatility-index is a 0-1 decimal (0.2618 = 26.18% IV).
    expect(Number(aapl["implied-volatility-index"])).toBeCloseTo(0.2618, 3);
    expect(Number(aapl["implied-volatility-index"])).toBeLessThan(1);
    // implied-volatility-30-day is a PERCENTAGE (~26.53), NOT a 0-1 decimal —
    // the 100x silent-correctness trap. It reads ~100x the index value.
    expect(Number(aapl["implied-volatility-30-day"])).toBeCloseTo(26.53, 2);
    expect(Number(aapl["implied-volatility-30-day"])).toBeGreaterThan(1);
    // Renamed fields present under their real names; the old names the schema
    // used never appear on the wire.
    expect(aapl).toHaveProperty("implied-volatility-index-rank");
    expect(aapl).toHaveProperty("liquidity-value");
    expect(aapl).not.toHaveProperty("implied-volatility-rank");
    expect(aapl).not.toHaveProperty("liquidity");
    // expiration-date is a plain YYYY-MM-DD date, not a datetime (the throw).
    const oe = aapl["option-expiration-implied-volatilities"] as Array<
      Record<string, unknown>
    >;
    expect(oe[0]["expiration-date"]).toBe("2026-08-24");
    expect(oe[0]["expiration-date"]).not.toMatch(/T/);
  });
});
