/**
 * End-to-end round trips for the INSTRUMENTS, OPTION CHAINS and SYMBOLS tools.
 *
 * Every test drives a real server over the real MCP protocol and asserts three things
 * per tool: the OUTBOUND verb and path against the documented endpoint; the
 * snake_case → kebab-case translation seam, where nothing with an underscore may reach
 * the wire; and the unwrapped result, since the client strips the API envelope.
 *
 * Symbology gets extra attention because this is where the API is least forgiving: OCC
 * equity-option symbols embed two spaces, futures symbols start with `/`,
 * futures-option symbols contain both, and crypto symbols contain a `/`. Those must
 * survive the round trip byte-for-byte and occupy exactly one path segment.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

// ---------------------------------------------------------------------------
// Symbols under test. Each is a real wire-format symbol, taken from the
// recorded sandbox payloads or from the documented examples.
// ---------------------------------------------------------------------------

/** OCC equity option. Note the TWO spaces after the root — real OCC padding. */
const OCC_SYMBOL = "AAPL  260612C00110000";
/** Outright future. Leading `/` is part of the symbol, not a path separator. */
const FUTURE_SYMBOL = "/ESZ6";
/** Futures option: leading `./`, an embedded space, then two more spaces. */
const FUTURE_OPTION_SYMBOL = "./ESZ6 ESZ6  261218P6300";
/** Cryptocurrency pair — the `/` is part of the symbol. */
const CRYPTO_SYMBOL = "BTC/USD";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collects every key anywhere inside `value` that contains an underscore,
 * returning dotted paths so a failure names the offender. The tastytrade API
 * has no snake_case keys at all, so the expected result is always `[]`.
 */
function snakeCaseKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => snakeCaseKeys(v, `${prefix}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, v]) => {
        const here = prefix ? `${prefix}.${key}` : key;
        return [
          ...(key.includes("_") ? [here] : []),
          ...snakeCaseKeys(v, here),
        ];
      },
    );
  }
  return [];
}

/** The last request, asserted present so callers get a non-optional object. */
function outbound(h: Harness) {
  const req = h.lastRequest();
  if (!req) throw new Error("no request reached the transport");
  return req;
}

/**
 * Path segments of a recorded url, leading empty string dropped. Asserting on
 * these instead of the whole string proves a symbol occupies exactly ONE
 * segment — an unencoded `/` inside a symbol would show up as an extra entry.
 */
function segments(url: string): string[] {
  return url.split("/").slice(1);
}

/** `items` list fixtures are all shaped `{ items: [...] }` once unwrapped. */
function fixtureItems(toolName: string): Record<string, unknown>[] {
  const payload = loadFixture(toolName) as { items: Record<string, unknown>[] };
  return payload.items;
}

let h: Harness | undefined;

/** Boots the harness and remembers it so `afterEach` can always close it. */
async function boot(routes: Route[]): Promise<Harness> {
  h = await createHarness({ routes });
  return h;
}

beforeEach(() => {
  // The token buckets in src/safety/rate-limit.ts are module-level state shared
  // by every harness in this file, and `read` only allows 60/min. This suite
  // makes more calls than that, so reset per test rather than let the suite's
  // wall-clock duration decide whether it passes.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

// ===========================================================================
// Symbol search and equity instruments
// ===========================================================================

describe("symbol search and equity instruments", () => {
  it("tastytrade_search_symbols GETs /symbols/search/{query} and unwraps items", async () => {
    const harness = await boot([
      {
        matcher: "/symbols/search/AAPL",
        method: "GET",
        reply: {
          data: {
            items: [
              { symbol: "AAPL", description: "APPLE INC" },
              { symbol: "AAPL1", description: "APPLE INC (adjusted)" },
            ],
          },
        },
      },
    ]);

    const result = await callOk(harness, "tastytrade_search_symbols", {
      query: "AAPL",
    });

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/symbols/search/AAPL");
    expect(req.params).toEqual({});
    // `.data.data.items` unwrapped down to the bare array.
    expect(result).toEqual([
      { symbol: "AAPL", description: "APPLE INC" },
      { symbol: "AAPL1", description: "APPLE INC (adjusted)" },
    ]);
  });

  it("tastytrade_search_symbols encodes a multi-word query into one path segment", async () => {
    const harness = await boot([
      { matcher: /^\/symbols\/search\//, reply: { data: { items: [] } } },
    ]);

    await callOk(harness, "tastytrade_search_symbols", { query: "APPLE INC" });

    // `searchSymbols` would interpolate the query without
    // encodeURIComponent. A space happened to survive (Node escapes it on the
    // wire) but a query containing `/` was split into an extra path segment.
    expect(outbound(harness).url).toBe("/symbols/search/APPLE%20INC");
  });

  it("tastytrade_search_symbols keeps a slash-bearing query in ONE segment", async () => {
    const harness = await boot([
      { matcher: /^\/symbols\/search\//, reply: { data: { items: [] } } },
    ]);

    await callOk(harness, "tastytrade_search_symbols", { query: "BRK/B" });

    expect(outbound(harness).url).toBe("/symbols/search/BRK%2FB");
    expect(segments(outbound(harness).url)).toEqual([
      "symbols",
      "search",
      "BRK%2FB",
    ]);
  });

  it("tastytrade_get_instrument GETs /instruments/equities/{symbol} and returns the object", async () => {
    const equity = {
      symbol: "AAPL",
      "instrument-type": "Equity",
      "short-description": "AAPL",
      description: "APPLE INC",
      active: true,
      "is-index": false,
      "is-fractional-quantity-eligible": true,
      lendability: "Easy To Borrow",
      "market-time-instrument-collection": "Equity",
    };
    const harness = await boot([
      {
        matcher: "/instruments/equities/AAPL",
        method: "GET",
        reply: { data: equity },
      },
    ]);

    const result = await callOk(harness, "tastytrade_get_instrument", {
      symbol: "AAPL",
    });

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/equities/AAPL");
    // The envelope is gone; the inner object came back whole and kebab-cased.
    expect(result).toEqual(equity);
    expect(snakeCaseKeys(result)).toEqual([]);
  });

  it("tastytrade_get_instrument encodes a `/` in an equity symbol", async () => {
    const harness = await boot([
      { matcher: /^\/instruments\/equities\//, reply: { data: {} } },
    ]);

    await callOk(harness, "tastytrade_get_instrument", { symbol: "BRK/B" });

    // `getInstrument` would interpolate the symbol without encoding it.
    // api-overview.md states equity symbols may contain a `/` (BRK/A, BRK/B),
    // and market-metrics.md explicitly requires `BRK%2FB`. Unencoded, the
    // request became a four-segment path that the documented
    // `GET /instruments/equities/{symbol}` route cannot match — so it silently
    // addressed the wrong resource.
    expect(outbound(harness).url).toBe("/instruments/equities/BRK%2FB");
    // Exactly the three segments the documented route has.
    expect(segments(outbound(harness).url)).toEqual([
      "instruments",
      "equities",
      "BRK%2FB",
    ]);
  });

  it("tastytrade_get_instruments sends repeated symbol filters to the list endpoint", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/equities",
        method: "GET",
        reply: {
          data: { items: [{ symbol: "AAPL" }, { symbol: "MSFT" }] },
        },
      },
    ]);

    const result = await callOk(harness, "tastytrade_get_instruments", {
      symbols: ["AAPL", "MSFT"],
    });

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/equities");
    // The harness records the params object as handed to axios, before the
    // client's paramsSerializer turns it into `symbol[]=AAPL&symbol[]=MSFT`.
    expect(req.params).toEqual({ symbol: ["AAPL", "MSFT"] });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(result).toEqual([{ symbol: "AAPL" }, { symbol: "MSFT" }]);
  });
});

// ===========================================================================
// Equity option definitions
// ===========================================================================

describe("equity option definitions", () => {
  /** A real recorded EquityOption, reused as the single-definition payload. */
  const definition = () => {
    const item = fixtureItems("tastytrade_get_option_chain")[0];
    expect(item.symbol).toBe(OCC_SYMBOL); // guards the constant above
    return item;
  };

  const equityOptionRoute = (payload: unknown): Route[] => [
    {
      matcher: /^\/instruments\/equity-options\//,
      method: "GET",
      reply: { data: payload },
    },
  ];

  it("tastytrade_get_equity_option percent-encodes the OCC symbol and returns it unmangled", async () => {
    const payload = definition();
    const harness = await boot(equityOptionRoute(payload));

    const result = (await callOk(harness, "tastytrade_get_equity_option", {
      symbol: OCC_SYMBOL,
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(
      `/instruments/equity-options/${encodeURIComponent(OCC_SYMBOL)}`,
    );
    // The OCC double space must travel as %20%20, never as a raw space, and
    // the whole symbol must stay inside one path segment.
    expect(req.url).toContain("%20%20");
    expect(req.url).not.toMatch(/ /);
    expect(segments(req.url)).toEqual([
      "instruments",
      "equity-options",
      encodeURIComponent(OCC_SYMBOL),
    ]);
    // ...and it must decode back to exactly what the agent asked for.
    expect(decodeURIComponent(segments(req.url)[2])).toBe(OCC_SYMBOL);
    // No `active` filter was requested, so no query param is sent.
    expect(req.params).toEqual({});
    expect(result.symbol).toBe(OCC_SYMBOL);
    expect(result["strike-price"]).toBe(payload["strike-price"]);
    expect(result["option-type"]).toBe(payload["option-type"]);
  });

  it("tastytrade_get_equity_option forwards the `active` filter as a query param", async () => {
    const harness = await boot(equityOptionRoute(definition()));

    await callOk(harness, "tastytrade_get_equity_option", {
      symbol: OCC_SYMBOL,
      active: true,
    });

    const req = outbound(harness);
    expect(req.params).toEqual({ active: true });
    expect(snakeCaseKeys(req.params)).toEqual([]);
  });

  it("tastytrade_get_equity_definition is an alias that hits the same endpoint", async () => {
    const harness = await boot(equityOptionRoute(definition()));

    const result = (await callOk(harness, "tastytrade_get_equity_definition", {
      symbol: OCC_SYMBOL,
      active: false,
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    // Identical path to tastytrade_get_equity_option — the tool is kept only
    // as a deprecated name for it.
    expect(req.url).toBe(
      `/instruments/equity-options/${encodeURIComponent(OCC_SYMBOL)}`,
    );
    // `active: false` is a real filter value, not "unset", so it must be sent.
    expect(req.params).toEqual({ active: false });
    expect(result.symbol).toBe(OCC_SYMBOL);
  });
});

// ===========================================================================
// Equity option chains: three variants, three genuinely different shapes
// ===========================================================================

describe("equity option chains", () => {
  it("tastytrade_get_option_chain returns the flat per-contract list", async () => {
    const harness = await boot([
      {
        matcher: "/option-chains/AAPL",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_option_chain") },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_option_chain", {
      symbol: "AAPL",
    })) as { items: Record<string, unknown>[] };

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/option-chains/AAPL");
    expect(req.params).toEqual({});
    // Shape: `items` of complete EquityOption objects, one per contract.
    expect(result.items).toHaveLength(4);
    expect(result.items[0].symbol).toBe(OCC_SYMBOL);
    expect(result.items[0]["strike-price"]).toBe("110.0");
    expect(result.items[0]["option-type"]).toBe("C");
    expect(snakeCaseKeys(result)).toEqual([]);
  });

  it("tastytrade_get_option_chain_compact returns symbol lists, not contract objects", async () => {
    const harness = await boot([
      {
        matcher: "/option-chains/AAPL/compact",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_option_chain_compact") },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_option_chain_compact",
      { symbol: "AAPL" },
    )) as {
      items: Array<{
        "underlying-symbol": string;
        "expiration-type": string;
        symbols: string[];
        "streamer-symbols": string[];
      }>;
    };

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/option-chains/AAPL/compact");
    // Shape: one entry per expiration-type, each carrying parallel arrays of
    // OCC symbols and streamer symbols — and no per-contract metadata at all.
    expect(result.items.map((i) => i["expiration-type"])).toEqual([
      "Weekly",
      "Regular",
    ]);
    expect(result.items[0]).not.toHaveProperty("strike-price");
    expect(result.items[0]).not.toHaveProperty("option-type");
    // The OCC symbols inside the payload keep their double-space padding.
    expect(result.items[0].symbols[0]).toBe(OCC_SYMBOL);
    expect(result.items[0]["streamer-symbols"][0]).toBe(".AAPL260612C110");
  });

  it("tastytrade_get_option_chain_nested groups by expiration then strike", async () => {
    const harness = await boot([
      {
        matcher: "/option-chains/AAPL/nested",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_option_chain_nested") },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_option_chain_nested",
      {
        symbol: "AAPL",
      },
    )) as {
      items: Array<{
        "underlying-symbol": string;
        expirations: Array<{
          "expiration-date": string;
          strikes: Array<{
            "strike-price": string;
            call: string;
            put: string;
          }>;
        }>;
      }>;
    };

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/option-chains/AAPL/nested");
    // Shape: a single underlying entry holding `expirations[].strikes[]`, each
    // strike naming its call and put OCC symbols.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]["underlying-symbol"]).toBe("AAPL");
    expect(
      result.items[0].expirations.map((e) => e["expiration-date"]),
    ).toEqual(["2026-06-12", "2026-06-15", "2026-06-17", "2026-06-18"]);
    const strike = result.items[0].expirations[0].strikes[0];
    expect(strike["strike-price"]).toBe("110.0");
    expect(strike.call).toBe(OCC_SYMBOL);
    expect(strike.put).toBe("AAPL  260612P00110000");
  });

  it("every option-chain tool encodes a `/` in the underlying symbol", async () => {
    const harness = await boot([
      { matcher: /^\/option-chains\//, reply: { data: { items: [] } } },
    ]);

    const args = { symbol: "BRK/B" };
    // The option-chain endpoints share a 2 request/second ceiling and this test
    // walks all three in one millisecond. Reset between them: the subject here
    // is URL encoding, and a rate refusal would never reach the transport to be
    // inspected.
    for (const tool of [
      "tastytrade_get_option_chain",
      "tastytrade_get_option_chain_compact",
      "tastytrade_get_option_chain_nested",
    ]) {
      _resetRateLimitsForTest();
      await callOk(harness, tool, args);
    }

    // The symbol goes through encodeURIComponent, so `BRK/B` stays one path
    // segment instead of splitting in two and pushing the variant suffix a
    // level deeper.
    expect(harness.requests.map((r) => r.url)).toEqual([
      "/option-chains/BRK%2FB",
      "/option-chains/BRK%2FB/compact",
      "/option-chains/BRK%2FB/nested",
    ]);
    // The symbol is one segment everywhere, so the variant suffix (when there
    // is one) sits at exactly the documented depth.
    expect(harness.requests.map((r) => segments(r.url).length)).toEqual([
      2, 3, 3,
    ]);
  });

  it("the three chain variants really do return three different shapes", async () => {
    const harness = await boot([
      {
        matcher: "/option-chains/AAPL/compact",
        reply: { data: loadFixture("tastytrade_get_option_chain_compact") },
      },
      {
        matcher: "/option-chains/AAPL/nested",
        reply: { data: loadFixture("tastytrade_get_option_chain_nested") },
      },
      {
        matcher: "/option-chains/AAPL",
        reply: { data: loadFixture("tastytrade_get_option_chain") },
      },
    ]);

    type Chain = { items: Array<Record<string, unknown>> };
    const args = { symbol: "AAPL" };
    // Same 2/second ceiling as above; the subject here is response shape.
    _resetRateLimitsForTest();
    const full = (await callOk(
      harness,
      "tastytrade_get_option_chain",
      args,
    )) as Chain;
    _resetRateLimitsForTest();
    const compact = (await callOk(
      harness,
      "tastytrade_get_option_chain_compact",
      args,
    )) as Chain;
    _resetRateLimitsForTest();
    const nested = (await callOk(
      harness,
      "tastytrade_get_option_chain_nested",
      args,
    )) as Chain;

    // A generic "truthy" assertion would pass on all three; the discriminator
    // is which key carries the contracts.
    expect(Object.keys(full.items[0])).toContain("strike-price");
    expect(Object.keys(compact.items[0])).toContain("symbols");
    expect(Object.keys(nested.items[0])).toContain("expirations");
    expect(Object.keys(compact.items[0])).not.toContain("expirations");
    expect(Object.keys(nested.items[0])).not.toContain("symbols");
    expect(Object.keys(full.items[0])).not.toContain("symbols");
  });
});

// ===========================================================================
// Futures instruments and products
// ===========================================================================

describe("futures instruments and products", () => {
  it("tastytrade_get_futures kebab-cases every one of its seven filters", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/futures",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_futures") },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_futures", {
      symbol: [FUTURE_SYMBOL],
      product_code: ["ES"],
      exchange: "CME",
      security_id: ["ES-DEC26"],
      only_active_futures: true,
      page_offset: 0,
      per_page: 100,
    })) as Array<Record<string, unknown>>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/futures");
    // Exact param map: four snake_case inputs became kebab-case, and the two
    // already-single-word names passed through unchanged.
    expect(req.params).toEqual({
      symbol: [FUTURE_SYMBOL],
      "product-code": ["ES"],
      exchange: "CME",
      "security-id": ["ES-DEC26"],
      "only-active-futures": true,
      "page-offset": 0,
      "per-page": 100,
    });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    // `.data.data.items` unwrapped to the bare array of Future objects.
    expect(Array.isArray(result)).toBe(true);
    expect(result.map((f) => f.symbol)).toEqual([
      "/ESZ6",
      "/ESZ7",
      "/ESU6",
      "/ESM6",
      "/ESH7",
      "/ESM7",
      "/ESU7",
    ]);
    expect(result[0]["product-code"]).toBe("ES");
  });

  it("tastytrade_get_futures omits filters the agent did not supply", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/futures",
        reply: { data: { items: [] } },
      },
    ]);

    await callOk(harness, "tastytrade_get_futures", { exchange: "CME" });

    // Absent inputs must not become explicit params — an empty `symbol` filter
    // is not the same query as no `symbol` filter.
    expect(outbound(harness).params).toEqual({ exchange: "CME" });
  });

  it("tastytrade_get_future encodes the leading slash of the futures symbol", async () => {
    const future = fixtureItems("tastytrade_get_futures")[0];
    const harness = await boot([
      {
        matcher: /^\/instruments\/futures\//,
        method: "GET",
        reply: { data: future },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_future", {
      symbol: FUTURE_SYMBOL,
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    // `/ESZ6` must become `%2FESZ6`: encoded, it is one path segment, so the
    // documented `GET /instruments/futures/{symbol}` route still matches.
    expect(segments(req.url)).toEqual(["instruments", "futures", "%2FESZ6"]);
    expect(decodeURIComponent(segments(req.url)[2])).toBe(FUTURE_SYMBOL);
    expect(result.symbol).toBe(FUTURE_SYMBOL);
    expect(result["streamer-symbol"]).toBe(future["streamer-symbol"]);
  });

  it("tastytrade_get_future_products paginates with kebab-case params", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/future-products",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_future_products") },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_future_products", {
      page_offset: 1,
      per_page: 50,
    })) as Array<Record<string, unknown>>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/future-products");
    expect(req.params).toEqual({ "page-offset": 1, "per-page": 50 });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(result).toHaveLength(83);
    expect(result[0].code).toBe("MES");
    expect(result[0]["root-symbol"]).toBe("/MES");
  });

  it("tastytrade_get_future_product puts exchange and code in the path", async () => {
    const product = loadFixture("tastytrade_get_future_product") as Record<
      string,
      unknown
    >;
    const harness = await boot([
      {
        matcher: "/instruments/future-products/CME/ES",
        method: "GET",
        reply: { data: product },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_future_product", {
      exchange: "CME",
      code: "ES",
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/future-products/CME/ES");
    expect(req.params).toEqual({});
    // Single object, not an `items` list — the envelope's `data` unwrapped once.
    expect(result.code).toBe("ES");
    expect(result.exchange).toBe("CME");
    expect(result["root-symbol"]).toBe("/ES");
    expect(result).not.toHaveProperty("items");
    expect(snakeCaseKeys(result)).toEqual([]);
  });
});

// ===========================================================================
// Futures options and futures-option products
// ===========================================================================

describe("futures options and futures-option products", () => {
  it("tastytrade_get_future_option encodes slashes AND spaces in one segment", async () => {
    const futureOption = fixtureItems(
      "tastytrade_get_futures_option_chain_full",
    )[0];
    expect(futureOption.symbol).toBe(FUTURE_OPTION_SYMBOL); // guards the constant

    const harness = await boot([
      {
        matcher: /^\/instruments\/future-options\//,
        method: "GET",
        reply: { data: futureOption },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_future_option", {
      symbol: FUTURE_OPTION_SYMBOL,
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    // `./ESZ6 ESZ6  261218P6300` is the nastiest symbol in the API: a leading
    // `./`, a single space, then two spaces. All of it must be encoded, so the
    // path still has exactly three segments.
    expect(req.url).toContain("%2F");
    expect(req.url).toContain("%20%20");
    expect(req.url).not.toMatch(/ /);
    expect(segments(req.url)).toEqual([
      "instruments",
      "future-options",
      encodeURIComponent(FUTURE_OPTION_SYMBOL),
    ]);
    expect(decodeURIComponent(segments(req.url)[2])).toBe(FUTURE_OPTION_SYMBOL);
    expect(result.symbol).toBe(FUTURE_OPTION_SYMBOL);
    expect(result["product-code"]).toBe("ES");
    expect(result["root-symbol"]).toBe("/ES");
  });

  it("tastytrade_get_future_option_products lists products with pagination", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/future-option-products",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_future_option_products") },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_future_option_products",
      { page_offset: 0, per_page: 100 },
    )) as Array<Record<string, unknown>>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/future-option-products");
    expect(req.params).toEqual({ "page-offset": 0, "per-page": 100 });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(result).toHaveLength(100);
    expect(result[0]["root-symbol"]).toBe("GE");
    expect(result[0].exchange).toBe("CME");
  });

  it("tastytrade_get_future_option_product uses the one-segment path without exchange", async () => {
    const product = fixtureItems("tastytrade_get_future_option_products")[0];
    const harness = await boot([
      {
        matcher: /^\/instruments\/future-option-products\//,
        method: "GET",
        reply: { data: product },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_future_option_product",
      { root_symbol: "GE" },
    )) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/future-option-products/GE");
    expect(result["root-symbol"]).toBe("GE");
  });

  it("tastytrade_get_future_option_product uses the two-segment path with exchange", async () => {
    const harness = await boot([
      {
        matcher: /^\/instruments\/future-option-products\//,
        method: "GET",
        reply: {
          data: fixtureItems("tastytrade_get_future_option_products")[0],
        },
      },
    ]);

    await callOk(harness, "tastytrade_get_future_option_product", {
      root_symbol: "GE",
      exchange: "CME",
    });

    // Exchange first, then root symbol — the order documented for
    // GET /instruments/future-option-products/{exchange}/{root_symbol}.
    expect(outbound(harness).url).toBe(
      "/instruments/future-option-products/CME/GE",
    );
  });
});

// ===========================================================================
// Futures option chains
// ===========================================================================

describe("futures option chains", () => {
  it("tastytrade_get_futures_option_chain_full GETs the product-code chain", async () => {
    const harness = await boot([
      {
        matcher: "/futures-option-chains/ES",
        method: "GET",
        reply: {
          data: loadFixture("tastytrade_get_futures_option_chain_full"),
        },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_futures_option_chain_full",
      { product_code: "ES" },
    )) as { items: Array<Record<string, unknown>> };

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    // Product code, not a contract symbol — no `/nested` suffix on this one.
    expect(req.url).toBe("/futures-option-chains/ES");
    expect(req.params).toEqual({});
    // Shape: a flat `items` list of complete FutureOption objects.
    expect(result.items).toHaveLength(4);
    expect(result.items.map((i) => i.symbol)).toEqual([
      "./ESZ6 ESZ6  261218P6300",
      "./ESU6 E1AN6 260706P6260",
      "./ESZ6 EW3U6 260918P9100",
      "./ESZ6 EW3U6 260918C9100",
    ]);
    // Embedded spaces survive the JSON round trip inside field values too.
    expect(result.items[0]["exchange-symbol"]).toBe("ESZ6 P6300");
    expect(result.items[0]["option-root-symbol"]).toBe("ES");
    expect(snakeCaseKeys(result)).toEqual([]);
  });

  it("tastytrade_get_futures_option_chains GETs the /nested variant", async () => {
    const harness = await boot([
      {
        matcher: "/futures-option-chains/ES/nested",
        method: "GET",
        reply: { data: loadFixture("tastytrade_get_futures_option_chains") },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_futures_option_chains",
      { product_code: "ES" },
    )) as {
      futures: Array<Record<string, unknown>>;
      "option-chains": Array<{
        "underlying-symbol": string;
        expirations: Array<{
          strikes: Array<{ "strike-price": string; call: string; put: string }>;
        }>;
      }>;
    };

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/futures-option-chains/ES/nested");
    // Shape: NOT an `items` list. Two sibling collections — the underlying
    // futures, and the chains nested by expiration then strike.
    expect(result).not.toHaveProperty("items");
    expect(result.futures).toHaveLength(4);
    expect(result.futures[0].symbol).toBe("/ESM6");
    expect(result.futures[0]["streamer-symbol"]).toBe("/ESM26:XCME");
    expect(result["option-chains"]).toHaveLength(1);
    expect(result["option-chains"][0]["underlying-symbol"]).toBe("/ES");
    const strike = result["option-chains"][0].expirations[0].strikes[0];
    expect(strike["strike-price"]).toBe("6300.0");
    expect(strike.call).toBe("./ESZ6 ESZ6  261218C6300");
    expect(strike.put).toBe(FUTURE_OPTION_SYMBOL);
  });

  it("the two futures-chain variants return different top-level shapes", async () => {
    const harness = await boot([
      {
        matcher: "/futures-option-chains/ES/nested",
        reply: { data: loadFixture("tastytrade_get_futures_option_chains") },
      },
      {
        matcher: "/futures-option-chains/ES",
        reply: {
          data: loadFixture("tastytrade_get_futures_option_chain_full"),
        },
      },
    ]);

    const full = (await callOk(
      harness,
      "tastytrade_get_futures_option_chain_full",
      { product_code: "ES" },
    )) as Record<string, unknown>;
    const nested = (await callOk(
      harness,
      "tastytrade_get_futures_option_chains",
      { product_code: "ES" },
    )) as Record<string, unknown>;

    expect(Object.keys(full)).toEqual(["items"]);
    expect(Object.keys(nested)).toEqual(["futures", "option-chains"]);
  });

  it("both futures-chain tools encode a product code given with a leading slash", async () => {
    const harness = await boot([
      { matcher: /^\/futures-option-chains\//, reply: { data: {} } },
    ]);

    await callOk(harness, "tastytrade_get_futures_option_chain_full", {
      product_code: "/ES",
    });
    expect(outbound(harness).url).toBe("/futures-option-chains/%2FES");

    await callOk(harness, "tastytrade_get_futures_option_chains", {
      product_code: "/ES",
    });
    expect(outbound(harness).url).toBe("/futures-option-chains/%2FES/nested");
  });
});

// ===========================================================================
// Cryptocurrencies
// ===========================================================================

describe("cryptocurrencies", () => {
  const bitcoin = {
    id: 1,
    symbol: CRYPTO_SYMBOL,
    "instrument-type": "Cryptocurrency",
    "short-description": "BTC",
    description: "Bitcoin",
    "is-closing-only": false,
    active: true,
    "tick-size": "0.01",
    "streamer-symbol": "BTC/USD:CXTALP",
  };

  it("tastytrade_get_cryptocurrencies filters the list endpoint by symbol", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/cryptocurrencies",
        method: "GET",
        reply: { data: { items: [bitcoin] } },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_cryptocurrencies", {
      symbol: CRYPTO_SYMBOL,
    })) as Array<Record<string, unknown>>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/cryptocurrencies");
    expect(req.params).toEqual({ symbol: CRYPTO_SYMBOL });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(result).toEqual([bitcoin]);
    expect(snakeCaseKeys(result)).toEqual([]);
  });

  it("tastytrade_get_cryptocurrencies accepts the array form of the filter", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/cryptocurrencies",
        reply: { data: { items: [] } },
      },
    ]);

    await callOk(harness, "tastytrade_get_cryptocurrencies", {
      symbol: ["BTC/USD", "ETH/USD"],
    });

    // Repeated `symbol=` params; the harness records the pre-serialized array.
    expect(outbound(harness).params).toEqual({
      symbol: ["BTC/USD", "ETH/USD"],
    });
  });

  it("tastytrade_get_cryptocurrencies sends no filter when none is given", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/cryptocurrencies",
        reply: { data: { items: [bitcoin] } },
      },
    ]);

    const result = (await callOk(
      harness,
      "tastytrade_get_cryptocurrencies",
    )) as Array<Record<string, unknown>>;

    // The dispatcher always passes the `symbol` key through; it is `undefined`,
    // and the client's serializer drops undefined values from the query string.
    expect(outbound(harness).params.symbol).toBeUndefined();
    expect(result).toEqual([bitcoin]);
  });

  it("tastytrade_get_cryptocurrency keeps BTC/USD in a single path segment", async () => {
    const harness = await boot([
      {
        matcher: /^\/instruments\/cryptocurrencies\//,
        method: "GET",
        reply: { data: bitcoin },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_cryptocurrency", {
      symbol: CRYPTO_SYMBOL,
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    // The `/` inside the pair must be encoded, or `BTC` and `USD` become two
    // separate path segments and the route no longer matches.
    expect(segments(req.url)).toEqual([
      "instruments",
      "cryptocurrencies",
      "BTC%2FUSD",
    ]);
    expect(decodeURIComponent(segments(req.url)[2])).toBe(CRYPTO_SYMBOL);
    expect(result).toEqual(bitcoin);
  });
});

// ===========================================================================
// Warrants
// ===========================================================================

describe("warrants", () => {
  const warrant = {
    symbol: "RGTIW",
    "instrument-type": "Warrant",
    "listed-market": "XNAS",
    description: "Rigetti Computing Inc - Warrant",
    "is-closing-only": false,
    active: true,
  };

  it("tastytrade_get_warrants filters the list endpoint by symbol", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/warrants",
        method: "GET",
        reply: { data: { items: [warrant] } },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_warrants", {
      symbol: ["RGTIW"],
    })) as Array<Record<string, unknown>>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/warrants");
    expect(req.params).toEqual({ symbol: ["RGTIW"] });
    expect(snakeCaseKeys(req.params)).toEqual([]);
    expect(result).toEqual([warrant]);
  });

  it("tastytrade_get_warrant fetches one warrant by symbol", async () => {
    const harness = await boot([
      {
        matcher: "/instruments/warrants/RGTIW",
        method: "GET",
        reply: { data: warrant },
      },
    ]);

    const result = (await callOk(harness, "tastytrade_get_warrant", {
      symbol: "RGTIW",
    })) as Record<string, unknown>;

    const req = outbound(harness);
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/instruments/warrants/RGTIW");
    expect(req.params).toEqual({});
    expect(result).toEqual(warrant);
    expect(result).not.toHaveProperty("items");
  });

  it("tastytrade_get_warrant reports an unknown symbol as not_found", async () => {
    const harness = await boot([
      { matcher: /^\/instruments\/warrants\//, reply: { status: 404 } },
    ]);

    const err = await callError(harness, "tastytrade_get_warrant", {
      symbol: "NOPEW",
    });
    expect(err.code).toBe("not_found");
    expect(err.retryable).toBe(false);
  });
});

// ===========================================================================
// Watchlist symbol add / remove — the two write tools in this group
// ===========================================================================

describe("watchlist symbol add and remove", () => {
  /**
   * Both tools are client-side GET-modify-PUT helpers: the API has no
   * per-entry endpoint. Routes echo the PUT body back so the assertions can
   * check the result as well as the request.
   */
  const watchlistRoutes = (
    entries: Array<Record<string, string>>,
    name = "Tech",
  ): Route[] => {
    // The client percent-encodes the name into a single path segment, so the
    // route matcher has to as well or a name with a space/slash silently falls
    // through to the harness fallback and the body assertions go vacuous.
    const path = `/watchlists/${encodeURIComponent(name)}`;
    return [
      {
        matcher: path,
        method: "GET",
        reply: { data: { name, "watchlist-entries": entries } },
      },
      {
        matcher: path,
        method: "PUT",
        reply: (req) => ({ data: req.body }),
      },
    ];
  };

  it("tastytrade_add_watchlist_symbol reads, appends, then PUTs the whole list", async () => {
    const harness = await boot(
      watchlistRoutes([{ symbol: "AAPL", "instrument-type": "Equity" }]),
    );

    const result = await callOk(harness, "tastytrade_add_watchlist_symbol", {
      watchlist_name: "Tech",
      symbol: "MSFT",
    });

    expect(harness.requests).toHaveLength(2);
    const [get, put] = harness.requests;
    expect(get.method).toBe("GET");
    expect(get.url).toBe("/watchlists/Tech");
    expect(put.method).toBe("PUT");
    expect(put.url).toBe("/watchlists/Tech");
    // `watchlist_name` / `instrument_type` are snake_case on the tool schema;
    // the body must carry `name` and `instrument-type` and nothing snake_cased.
    expect(put.body).toEqual({
      name: "Tech",
      "watchlist-entries": [
        { symbol: "AAPL", "instrument-type": "Equity" },
        { symbol: "MSFT", "instrument-type": "Equity" },
      ],
    });
    expect(snakeCaseKeys(put.body)).toEqual([]);
    expect(result).toEqual(put.body);
  });

  it("tastytrade_add_watchlist_symbol is a no-op for a symbol already present", async () => {
    const harness = await boot(
      watchlistRoutes([{ symbol: "AAPL", "instrument-type": "Equity" }]),
    );

    await callOk(harness, "tastytrade_add_watchlist_symbol", {
      watchlist_name: "Tech",
      symbol: "AAPL",
    });

    // Idempotent: still a PUT, but the entry list is unchanged.
    expect(harness.requests[1].body).toEqual({
      name: "Tech",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    });
  });

  it("tastytrade_add_watchlist_symbol carries an OCC symbol and instrument type intact", async () => {
    const harness = await boot(watchlistRoutes([]));

    await callOk(harness, "tastytrade_add_watchlist_symbol", {
      watchlist_name: "Tech",
      symbol: OCC_SYMBOL,
      instrument_type: "Equity Option",
    });

    const body = harness.requests[1].body as {
      "watchlist-entries": Array<Record<string, string>>;
    };
    // The OCC double space is inside a JSON string here, so it must NOT be
    // encoded — only path segments get percent-encoding.
    expect(body["watchlist-entries"]).toEqual([
      { symbol: OCC_SYMBOL, "instrument-type": "Equity Option" },
    ]);
  });

  it("tastytrade_remove_watchlist_symbol filters the entry out and PUTs the rest", async () => {
    const harness = await boot(
      watchlistRoutes([
        { symbol: "AAPL", "instrument-type": "Equity" },
        { symbol: "MSFT", "instrument-type": "Equity" },
      ]),
    );

    const result = await callOk(harness, "tastytrade_remove_watchlist_symbol", {
      watchlist_name: "Tech",
      symbol: "MSFT",
    });

    expect(harness.requests.map((r) => r.method)).toEqual(["GET", "PUT"]);
    expect(harness.requests[1].url).toBe("/watchlists/Tech");
    expect(harness.requests[1].body).toEqual({
      name: "Tech",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    });
    expect(snakeCaseKeys(harness.requests[1].body)).toEqual([]);
    expect(result).toEqual(harness.requests[1].body);
  });

  it("tastytrade_remove_watchlist_symbol only removes an exact symbol+type match", async () => {
    const harness = await boot(
      watchlistRoutes([
        { symbol: "AAPL", "instrument-type": "Equity" },
        { symbol: "AAPL", "instrument-type": "Equity Option" },
      ]),
    );

    await callOk(harness, "tastytrade_remove_watchlist_symbol", {
      watchlist_name: "Tech",
      symbol: "AAPL",
      instrument_type: "Equity Option",
    });

    // The Equity entry for the same symbol must survive.
    expect(harness.requests[1].body).toEqual({
      name: "Tech",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    });
  });

  it("tastytrade_remove_watchlist_symbol is a no-op for a symbol that is absent", async () => {
    const harness = await boot(
      watchlistRoutes([{ symbol: "AAPL", "instrument-type": "Equity" }]),
    );

    await callOk(harness, "tastytrade_remove_watchlist_symbol", {
      watchlist_name: "Tech",
      symbol: "TSLA",
    });

    expect(harness.requests[1].body).toEqual({
      name: "Tech",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    });
  });

  it("both legs of the round trip encode the watchlist name identically", async () => {
    const harness = await boot(watchlistRoutes([], "My Tech List"));

    await callOk(harness, "tastytrade_add_watchlist_symbol", {
      watchlist_name: "My Tech List",
      symbol: "AAPL",
    });

    // `getWatchlist` and the PUT in `addSymbolToWatchlist` /
    // `removeSymbolFromWatchlist` would interpolate the name without
    // encodeURIComponent. Spaces survived because Node escapes them on the
    // wire, but a name containing `/`, `?` or `#` corrupted the request — and
    // the GET and the PUT must address the same resource or the read-modify-
    // write lands somewhere else.
    expect(harness.requests.map((r) => r.url)).toEqual([
      "/watchlists/My%20Tech%20List",
      "/watchlists/My%20Tech%20List",
    ]);
  });

  it("a slash-bearing watchlist name stays ONE segment on both legs", async () => {
    const harness = await boot(watchlistRoutes([], "Vol / Vega"));

    await callOk(harness, "tastytrade_add_watchlist_symbol", {
      watchlist_name: "Vol / Vega",
      symbol: "AAPL",
    });

    expect(harness.requests.map((r) => r.url)).toEqual([
      "/watchlists/Vol%20%2F%20Vega",
      "/watchlists/Vol%20%2F%20Vega",
    ]);
    for (const req of harness.requests) {
      expect(segments(req.url)).toEqual(["watchlists", "Vol%20%2F%20Vega"]);
    }
  });
});
