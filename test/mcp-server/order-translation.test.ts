import { describe, it, expect } from "@jest/globals";
import {
  validateLegActions,
  validateComplexOrderLegActions,
  buildOrderBody,
  buildComplexOrderBody,
  snakeToKebabParams,
} from "../../src/mcp-server/index.js";

/**
 * Mirrors MCP_ORDER_SOURCE in src/mcp-server/index.ts, which is now
 * `tastytrade-mcp/${PACKAGE_VERSION}`. Held as a literal here on purpose, so
 * changing the stamp stays a deliberate two-sided edit: this value is reported
 * to tastytrade and read back off their order flow, and a version bump that
 * silently changed it on both sides at once is exactly what this literal is for.
 */
const MCP_ORDER_SOURCE = "tastytrade-mcp/1.0.0";

describe("validateLegActions — instrument/action pairing", () => {
  it("returns null for non-array input", () => {
    expect(validateLegActions(undefined)).toBeNull();
    expect(validateLegActions(null)).toBeNull();
  });

  it("accepts outright Future legs with Buy/Sell", () => {
    expect(
      validateLegActions([
        { instrument_type: "Future", action: "Buy", symbol: "/ESZ4" },
      ]),
    ).toBeNull();
    expect(
      validateLegActions([
        { instrument_type: "Future", action: "Sell", symbol: "/ESZ4" },
      ]),
    ).toBeNull();
  });

  it("rejects a Future leg using open/close actions", () => {
    const err = validateLegActions([
      { instrument_type: "Future", action: "Buy to Open", symbol: "/ESZ4" },
    ]);
    expect(err).not.toBeNull();
    expect(err?.legIndex).toBe(0);
    expect(err?.message).toMatch(/Buy.*Sell/);
  });

  it("accepts open/close instrument types with open/close actions", () => {
    for (const t of [
      "Equity",
      "Equity Option",
      "Future Option",
      "Cryptocurrency",
    ]) {
      expect(
        validateLegActions([
          { instrument_type: t, action: "Buy to Open", symbol: "X" },
        ]),
      ).toBeNull();
    }
  });

  it("rejects a Future Option using Buy/Sell — must use open/close (the key pairing rule)", () => {
    const err = validateLegActions([
      {
        instrument_type: "Future Option",
        action: "Buy",
        symbol: "./ESZ4 EW4U4",
      },
    ]);
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/Open|Close/);
  });

  it("rejects an Equity leg using Buy/Sell", () => {
    expect(
      validateLegActions([
        { instrument_type: "Equity", action: "Buy", symbol: "AAPL" },
      ]),
    ).not.toBeNull();
  });

  it("falls through (null) for unknown instrument types", () => {
    expect(
      validateLegActions([
        { instrument_type: "Bond", action: "Whatever", symbol: "X" },
      ]),
    ).toBeNull();
  });

  it("reports the index of the first offending leg", () => {
    const err = validateLegActions([
      { instrument_type: "Equity", action: "Buy to Open", symbol: "AAPL" },
      { instrument_type: "Future", action: "Buy to Open", symbol: "/ESZ4" },
    ]);
    expect(err?.legIndex).toBe(1);
  });
});

describe("validateComplexOrderLegActions", () => {
  it("tags errors from the trigger_order with its location", () => {
    const err = validateComplexOrderLegActions({
      trigger_order: {
        legs: [{ instrument_type: "Future", action: "Buy to Open" }],
      },
    });
    expect(err?.location).toBe("trigger_order");
  });

  it("tags errors from a component order with its index", () => {
    const err = validateComplexOrderLegActions({
      orders: [
        { legs: [{ instrument_type: "Equity", action: "Buy to Open" }] },
        { legs: [{ instrument_type: "Equity", action: "Buy" }] },
      ],
    });
    expect(err?.location).toBe("orders[1]");
  });

  it("returns null when all legs are valid", () => {
    expect(
      validateComplexOrderLegActions({
        orders: [
          { legs: [{ instrument_type: "Equity", action: "Sell to Close" }] },
        ],
      }),
    ).toBeNull();
  });
});

describe("buildOrderBody — snake_case → kebab-case", () => {
  it("maps order fields and legs to the API shape", () => {
    const body = buildOrderBody({
      time_in_force: "Day",
      order_type: "Limit",
      price: "1.50",
      price_effect: "Debit",
      legs: [
        {
          instrument_type: "Equity",
          symbol: "AAPL",
          action: "Buy to Open",
          quantity: 10,
        },
      ],
    });
    expect(body).toMatchObject({
      "time-in-force": "Day",
      "order-type": "Limit",
      price: "1.50",
      "price-effect": "Debit",
    });
    expect(body.legs?.[0]).toEqual({
      "instrument-type": "Equity",
      symbol: "AAPL",
      action: "Buy to Open",
      quantity: 10,
    });
  });

  it("omits price/price-effect when no price is set (e.g. Market orders)", () => {
    const body = buildOrderBody({
      time_in_force: "Day",
      order_type: "Market",
      legs: [],
    });
    expect(body.price).toBeUndefined();
    expect(body["price-effect"]).toBeUndefined();
  });

  it("defaults legs to an empty array when omitted", () => {
    const body = buildOrderBody({ time_in_force: "Day", order_type: "Market" });
    expect(body.legs).toEqual([]);
  });

  it("stamps the MCP order source, which the caller cannot override", () => {
    // Server-side attribution: `source` is a documented optional field on the
    // order request body (open-api-spec/orders.md). It is set here rather than
    // taken from the caller so the tag cannot be forged or suppressed — and it
    // is set inside the shared builder so the dry-run and live paths produce
    // the same body, which is what the confirmation argsHash binds.
    const base = { time_in_force: "Day", order_type: "Market", legs: [] };
    expect(buildOrderBody(base).source).toBe(MCP_ORDER_SOURCE);
    expect(buildOrderBody({ ...base, source: "forged" }).source).toBe(
      MCP_ORDER_SOURCE,
    );
  });
});

describe("buildComplexOrderBody", () => {
  it("kebab-cases the trigger-order and component orders", () => {
    const body = buildComplexOrderBody({
      type: "OTOCO",
      trigger_order: {
        order_type: "Limit",
        time_in_force: "Day",
        legs: [
          {
            instrument_type: "Equity",
            symbol: "AAPL",
            action: "Buy to Open",
            quantity: 1,
          },
        ],
      },
      orders: [
        {
          order_type: "Limit",
          time_in_force: "GTC",
          legs: [
            {
              instrument_type: "Equity",
              symbol: "AAPL",
              action: "Sell to Close",
              quantity: 1,
            },
          ],
        },
      ],
    });
    expect(body.type).toBe("OTOCO");
    expect(body["trigger-order"]).toMatchObject({
      "order-type": "Limit",
      "time-in-force": "Day",
    });
    expect(Array.isArray(body.orders)).toBe(true);
  });

  it("stamps the MCP order source, which the caller cannot override", () => {
    // `source` is documented on the complex-order request body too, and it
    // would be a pass-through input property. It is now server-controlled:
    // whatever the caller sends is discarded.
    expect(buildComplexOrderBody({ type: "OCO", orders: [] }).source).toBe(
      MCP_ORDER_SOURCE,
    );
    expect(
      buildComplexOrderBody({ type: "OCO", orders: [], source: "forged" })
        .source,
    ).toBe(MCP_ORDER_SOURCE);
  });

  it("does not stamp the source onto the nested component orders", () => {
    // Attribution rides on the complex order itself; the children carry its
    // complex-order-id, so the strategy's `source` already covers them and
    // repeating it per component would only widen the outbound body.
    const body = buildComplexOrderBody({
      type: "OTO",
      trigger_order: { order_type: "Market", time_in_force: "Day", legs: [] },
      orders: [{ order_type: "Market", time_in_force: "Day", legs: [] }],
    });
    const trigger = body["trigger-order"] as Record<string, unknown>;
    const child = (body.orders as Array<Record<string, unknown>>)[0]!;
    expect(Object.hasOwn(trigger, "source")).toBe(false);
    expect(Object.hasOwn(child, "source")).toBe(false);
  });
});

describe("snakeToKebabParams", () => {
  it("maps known snake_case keys to kebab query params and array params", () => {
    const out = snakeToKebabParams({
      start_date: "2026-01-01",
      end_date: "2026-02-01",
      underlying_symbol: "AAPL",
      per_page: 50,
      page_offset: 0,
      status: ["Live", "Filled"],
      sort: "Desc",
      // `account_numbers` is deliberately NOT in this
      // mapper any more, so it is passed here to prove the mapper DROPS it. It
      // would be translated for every caller, which made
      // `account-numbers[]=…` an accepted filter on tastytrade_search_orders —
      // a tool whose schema declares a single `account_number` and no plural.
      // The two customer tools that do declare it add it themselves, in
      // `customerOrderParams`.
      account_numbers: ["5WX34382"],
    });
    expect(out["start-date"]).toBe("2026-01-01");
    expect(out["end-date"]).toBe("2026-02-01");
    expect(out["underlying-symbol"]).toBe("AAPL");
    expect(out["per-page"]).toBe(50);
    expect(out["page-offset"]).toBe(0);
    expect(out["status[]"]).toEqual(["Live", "Filled"]);
    expect(out.sort).toBe("Desc");
    // Was `toEqual(["5WX34382"])`.
    expect(out["account-numbers[]"]).toBeUndefined();
  });

  it("omits keys that are undefined", () => {
    const out = snakeToKebabParams({ start_date: "2026-01-01" });
    expect(out).toEqual({ "start-date": "2026-01-01" });
  });
});
