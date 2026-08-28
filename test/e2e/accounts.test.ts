import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

/**
 * End-to-end round trips for the accounts, balances and transactions tools.
 *
 * Every test drives a real MCP `tools/call` through the real dispatcher and asserts
 * three things, because each is a place a silent bug hides: the OUTBOUND request, verb
 * and path, against what the vendored open-api spec documents (open-api-spec/
 * balances-and-positions.md, net-liquidating-value-history.md, transactions.md); the
 * snake_case →
 * kebab-case translation the dispatcher owns, asserted as an exact params object so a
 * dropped, renamed or leaked filter fails; and the UNWRAPPED result, since the API's
 * envelope must never reach the agent.
 *
 * The rate-limit buckets are module-level state shared by every harness in this file,
 * so they are reset per test. Without that, a file that grows past the per-endpoint
 * budget starts failing with `rate_limit_exceeded` for reasons unrelated to the tool
 * under test.
 */

const ACCT = "5WX00001";

/** A trimmed Account object, kebab-case exactly as the API serializes it. */
const ACCOUNT = {
  "account-number": ACCT,
  "account-type-name": "Individual",
  "margin-or-cash": "Margin",
  "is-closed": false,
  "is-futures-approved": true,
};

const BALANCE = {
  "account-number": ACCT,
  currency: "USD",
  "cash-balance": "100000.0",
  "net-liquidating-value": "100123.45",
  "equity-buying-power": "200246.9",
};

const SNAPSHOT = {
  "account-number": ACCT,
  currency: "USD",
  "snapshot-date": "2026-06-05",
  "time-of-day": "EOD",
  "net-liquidating-value": "100123.45",
};

/** One NetLiqOhlc candle, camelCase per the net-liq history spec. */
const CANDLE = {
  open: 10250.5,
  high: 10420.75,
  low: 10180.3,
  close: 10350.0,
  totalClose: 10350.0,
  time: "2026-04-09T00:00:00+00:00",
};

/** Recorded sandbox transactions: `{ items: [...] }`, four real rows. */
const TX_FIXTURE = loadFixture("tastytrade_get_transactions") as {
  items: Array<Record<string, unknown>>;
};

/** Recorded sandbox margin config: `{ "risk-free-rate": "0.0025" }`. */
const MARGIN_CONFIG_FIXTURE = loadFixture("tastytrade_get_margin_config") as {
  "risk-free-rate": string;
};

let h: Harness | undefined;

beforeEach(() => {
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/**
 * Asserts an outbound query-parameter object is wire-shaped: kebab-case keys
 * only, and no filter smuggled through as a placeholder.
 */
function expectKebabParams(params: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(params)) {
    // Agent-facing schemas are snake_case, the REST API is kebab-case. An
    // underscore in an outbound key means the translation seam leaked.
    expect(key).not.toMatch(/_/);
    expect(key).toBe(key.toLowerCase());
    if (value === undefined) continue;
    // An omitted optional filter must be absent, never sent as null or "".
    expect(value).not.toBeNull();
    expect(value).not.toBe("");
  }
}

/** The params that would actually be serialized onto the query string. */
function definedParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined),
  );
}

// ============================================================================
// The nine tools, one row each: verb, path, and envelope unwrapping.
// ============================================================================

interface RoundTrip {
  tool: string;
  args: Record<string, unknown>;
  /** Path the client must hit, baseURL stripped. */
  url: string;
  /** API payload; the harness wraps it as `{ data: ... }`. */
  reply: unknown;
  /** What the tool must return once the envelope is unwrapped. */
  expected: unknown;
}

const ROUND_TRIPS: RoundTrip[] = [
  {
    tool: "tastytrade_get_accounts",
    args: {},
    url: "/customers/me/accounts",
    reply: { items: [{ account: ACCOUNT, "authority-level": "owner" }] },
    expected: [{ account: ACCOUNT, "authority-level": "owner" }],
  },
  {
    tool: "tastytrade_get_account",
    args: { account_number: ACCT },
    url: `/customers/me/accounts/${ACCT}`,
    reply: ACCOUNT,
    expected: ACCOUNT,
  },
  {
    tool: "tastytrade_get_balances",
    args: { account_number: ACCT },
    url: `/accounts/${ACCT}/balances`,
    // The only tool in this group whose `items` wrapper is NOT stripped: the
    // handler returns `.data.data` verbatim, and its declared outputSchema
    // requires exactly `{ items: [...] }`. See the dedicated describe block.
    reply: { items: [BALANCE] },
    expected: { items: [BALANCE] },
  },
  {
    tool: "tastytrade_get_balance_by_currency",
    args: { account_number: ACCT },
    // Currency rides the PATH, not a query param, and defaults to USD.
    url: `/accounts/${ACCT}/balances/USD`,
    reply: BALANCE,
    expected: BALANCE,
  },
  {
    tool: "tastytrade_get_balance_snapshots",
    args: { account_number: ACCT },
    url: `/accounts/${ACCT}/balance-snapshots`,
    reply: { items: [SNAPSHOT] },
    expected: [SNAPSHOT],
  },
  {
    tool: "tastytrade_get_net_liq_history",
    args: { account_number: ACCT },
    url: `/accounts/${ACCT}/net-liq/history`,
    reply: { items: [CANDLE] },
    expected: [CANDLE],
  },
  {
    tool: "tastytrade_get_risk_free_rate",
    args: {},
    // A convenience wrapper: it reads the public margin-config endpoint.
    url: "/margin-requirements-public-configuration",
    reply: MARGIN_CONFIG_FIXTURE,
    expected: { "risk-free-rate": 0.0025 },
  },
  {
    tool: "tastytrade_get_transactions",
    args: { account_number: ACCT },
    url: `/accounts/${ACCT}/transactions`,
    reply: TX_FIXTURE,
    expected: TX_FIXTURE.items,
  },
  {
    tool: "tastytrade_get_transaction",
    args: { account_number: ACCT, transaction_id: "1735820" },
    url: `/accounts/${ACCT}/transactions/1735820`,
    reply: TX_FIXTURE.items[0],
    expected: TX_FIXTURE.items[0],
  },
];

describe("accounts, balances & transactions: request/response contract", () => {
  it.each(ROUND_TRIPS)(
    "$tool GETs $url and returns the unwrapped payload",
    async ({ tool, args, url, reply, expected }) => {
      h = await createHarness({
        routes: [{ matcher: url, method: "GET", reply: { data: reply } }],
      });

      const result = await callOk(h, tool, args);

      expect(h.requests).toHaveLength(1);
      const req = h.lastRequest()!;
      expect(req.method).toBe("GET");
      expect(req.url).toBe(url);
      expect(req.body).toBeUndefined();
      expectKebabParams(req.params);
      // The `{data:...}` envelope must not survive into the tool result.
      expect(result).toEqual(expected);
      expect(result).not.toHaveProperty("data");
    },
  );

  it.each(ROUND_TRIPS)(
    "$tool returns structured content satisfying its declared output schema",
    async ({ tool, args, url, reply, expected }) => {
      h = await createHarness({
        routes: [{ matcher: url, method: "GET", reply: { data: reply } }],
      });

      // Calling tools/list first is what a spec-aware client does, and it is
      // load-bearing: the SDK caches each tool's outputSchema from the listing
      // and then validates structuredContent against it, rejecting a mismatch
      // with McpError -32602 before the agent ever sees the payload. A test
      // that skips tools/list silently skips that whole check.
      await h.client.listTools();

      const res = (await h.client.callTool({
        name: tool,
        arguments: args,
      })) as {
        isError?: boolean;
        structuredContent?: unknown;
      };

      expect(res.isError).toBeFalsy();
      // Structured content must be an object per the MCP spec, so an array
      // payload is wrapped under `items` and an object payload is mirrored.
      expect(res.structuredContent).toEqual(
        Array.isArray(expected) ? { items: expected } : expected,
      );
    },
  );

  /**
   * Names this group owns, as a prefix test against the live registry. The
   * point is the direction of the comparison: the expected list is derived from
   * `tools/list`, not typed out beside the table, so a NEW account/balance/
   * transaction tool shipping without a round-trip row fails here instead of
   * quietly having no end-to-end test at all. (Comparing the table to a literal
   * copy of itself — which is what this would do — can only fail when someone
   * edits the table and forgets to edit the literal, i.e. never for the reason
   * that matters.) `tastytrade_get_total_fees` is deliberately outside these
   * prefixes: it lives with the market-data suite.
   */
  const GROUP_PREFIXES = [
    "tastytrade_get_account",
    "tastytrade_get_balance",
    "tastytrade_get_net_liq",
    "tastytrade_get_risk_free",
    "tastytrade_get_transaction",
  ];

  it("has a round trip for every accounts-group tool the server advertises", async () => {
    h = await createHarness();
    const { tools } = await h.client.listTools();

    const advertised = tools
      .map((t) => t.name)
      .filter((name) => GROUP_PREFIXES.some((p) => name.startsWith(p)))
      .sort();

    // A non-empty expectation is load-bearing: if the prefixes ever stopped
    // matching anything, an empty-vs-empty comparison would pass forever.
    expect(advertised.length).toBe(ROUND_TRIPS.length);
    expect(ROUND_TRIPS.map((r) => r.tool).sort()).toEqual(advertised);
  });
});

// ============================================================================
// Accounts
// ============================================================================

describe("tastytrade_get_accounts", () => {
  it("returns an empty ARRAY for an empty items list, not null", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/accounts",
          method: "GET",
          reply: { data: { items: [] } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_accounts");

    // A customer with no accounts must be an empty collection an agent can
    // iterate, not a null it has to special-case. `toEqual([])` is the whole
    // claim: it already rejects null, undefined and `{}`.
    expect(result).toEqual([]);
  });

  it("sends no query parameters at all", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/accounts",
          method: "GET",
          reply: { data: { items: [{ account: ACCOUNT }] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_accounts");

    expect(h.lastRequest()!.params).toEqual({});
  });
});

describe("tastytrade_get_account", () => {
  it("puts the account number on the path and nothing in the query", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/customers/me/accounts/${ACCT}`,
          method: "GET",
          reply: { data: ACCOUNT },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_account", {
      account_number: ACCT,
    });

    const req = h.lastRequest()!;
    expect(req.url).toBe(`/customers/me/accounts/${ACCT}`);
    // account_number is a path segment here — it must not also leak into the
    // query string under either casing.
    expect(req.params).toEqual({});
    expect(result).toEqual(ACCOUNT);
  });

  it("maps an unknown account number to not_found", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /^\/customers\/me\/accounts\//,
          method: "GET",
          reply: { status: 404 },
        },
      ],
    });

    const err = await callError(h, "tastytrade_get_account", {
      account_number: "5WX99999",
    });

    expect(err.code).toBe("not_found");
    expect(err.retryable).toBe(false);
    expect(h.lastRequest()!.url).toBe("/customers/me/accounts/5WX99999");
  });
});

// ============================================================================
// Balances
// ============================================================================

describe("tastytrade_get_balances", () => {
  const BALANCES_URL = `/accounts/${ACCT}/balances`;

  it("GETs /accounts/{n}/balances with the account number only on the path", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES_URL,
          method: "GET",
          reply: { data: { items: [BALANCE] } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(BALANCES_URL);
    expect(req.params).toEqual({});
    // Note the asymmetry with every other collection tool in this group
    // (get_accounts, get_transactions, get_balance_snapshots, get_net_liq_history
    // all hand back the bare array): this handler returns `.data.data`, so the
    // `items` wrapper survives into the tool result. Its declared outputSchema
    // encodes that on purpose — `required: ["items"]`, additionalProperties
    // false.
    expect(result).toEqual({ items: [BALANCE] });
    // Kebab-case field names arrive verbatim: the response is NOT translated
    // back to snake_case, so agents read the API's own vocabulary.
    expect(
      (result as { items: Array<Record<string, unknown>> }).items[0],
    ).toHaveProperty("net-liquidating-value");
  });

  it("passes a single balance object straight through, wrapper or not", async () => {
    h = await createHarness({
      routes: [
        { matcher: BALANCES_URL, method: "GET", reply: { data: BALANCE } },
      ],
    });

    const result = await callOk(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    // The handler does no shape normalization at all — whatever the API puts under
    // `data` is what the agent gets.
    //
    // Worth knowing before changing anything here: this tool declares an outputSchema of
    // `{ items: AccountBalance[] }` with `required: ["items"]` and
    // `additionalProperties: false`, while its sibling get_balance_by_currency declares a
    // BARE AccountBalance for the same resource. So if the live endpoint answers with a
    // bare object, structuredContent violates the declared schema and a spec-aware client
    // rejects the result with -32602 instead of showing balances. Only the pass-through is
    // asserted, because that is what the code does.
    expect(result).toEqual(BALANCE);
    expect(result).not.toHaveProperty("items");
  });
});

describe("tastytrade_get_balance_by_currency", () => {
  it.each([
    {
      label: "defaults to USD when currency is omitted",
      args: {},
      path: "USD",
    },
    {
      label: "uses the requested currency",
      args: { currency: "EUR" },
      path: "EUR",
    },
  ])("$label", async ({ args, path }) => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/balances/${path}`,
          method: "GET",
          reply: { data: { ...BALANCE, currency: path } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_balance_by_currency", {
      account_number: ACCT,
      ...args,
    });

    const req = h.lastRequest()!;
    expect(req.url).toBe(`/accounts/${ACCT}/balances/${path}`);
    // The currency is a path segment; it must never become `?currency=`.
    expect(req.params).toEqual({});
    expect(result).toEqual({ ...BALANCE, currency: path });
  });
});

describe("tastytrade_get_balance_snapshots", () => {
  const SNAPSHOTS_URL = `/accounts/${ACCT}/balance-snapshots`;

  it("translates the full documented filter set to kebab-case", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: SNAPSHOTS_URL,
          method: "GET",
          reply: { data: { items: [SNAPSHOT] } },
        },
      ],
    });

    const args = {
      account_number: ACCT,
      snapshot_date: "2026-06-05",
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      time_of_day: "EOD",
      currency: "USD",
      page_offset: 1,
      per_page: 25,
    };
    await callOk(h, "tastytrade_get_balance_snapshots", args);

    const req = h.lastRequest()!;
    expect(req.url).toBe(SNAPSHOTS_URL);
    expect(req.params).toEqual({
      "snapshot-date": "2026-06-05",
      "start-date": "2026-06-01",
      "end-date": "2026-06-30",
      "time-of-day": "EOD",
      currency: "USD",
      "page-offset": 1,
      "per-page": 25,
    });
    // Every arg except the path segment reached the query string — nothing was
    // silently dropped on the way through.
    expect(Object.keys(req.params)).toHaveLength(Object.keys(args).length - 1);
    expectKebabParams(req.params);
  });

  it("omits every filter the caller did not set", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: SNAPSHOTS_URL,
          method: "GET",
          reply: { data: { items: [SNAPSHOT] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_balance_snapshots", {
      account_number: ACCT,
      time_of_day: "BOD",
    });

    const req = h.lastRequest()!;
    // Absent means ABSENT — an unset date filter must not appear at all, in
    // any form. `?start-date=` or `?start-date=undefined` would be sent to the
    // API as a literal value and change the result set.
    expect(req.params).toEqual({ "time-of-day": "BOD" });
    for (const key of [
      "snapshot-date",
      "start-date",
      "end-date",
      "currency",
      "page-offset",
      "per-page",
    ]) {
      expect(req.params).not.toHaveProperty(key);
    }
  });

  it("forwards pagination as numbers, including page-offset 0", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: SNAPSHOTS_URL,
          method: "GET",
          reply: { data: { items: [SNAPSHOT] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_balance_snapshots", {
      account_number: ACCT,
      page_offset: 0,
      per_page: 250,
    });

    const req = h.lastRequest()!;
    // 0 is a meaningful offset (the first page) and must survive the
    // `!== undefined` guard rather than being treated as unset.
    expect(req.params).toEqual({ "page-offset": 0, "per-page": 250 });
    expect(typeof req.params["page-offset"]).toBe("number");
    expect(typeof req.params["per-page"]).toBe("number");
  });

  it("returns the snapshot object itself when the API omits `items`", async () => {
    h = await createHarness({
      routes: [
        // The endpoint documents an array, but the client's unwrap chain also
        // tolerates a bare object under `data` — assert what it actually does.
        { matcher: SNAPSHOTS_URL, method: "GET", reply: { data: SNAPSHOT } },
      ],
    });

    const result = await callOk(h, "tastytrade_get_balance_snapshots", {
      account_number: ACCT,
    });

    expect(result).toEqual(SNAPSHOT);
  });

  it("returns an empty array for an empty snapshot list", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: SNAPSHOTS_URL,
          method: "GET",
          reply: { data: { items: [] } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_balance_snapshots", {
      account_number: ACCT,
    });

    expect(result).toEqual([]);
  });
});

// ============================================================================
// Net liquidating value history
// ============================================================================

describe("tastytrade_get_net_liq_history", () => {
  const NET_LIQ_URL = `/accounts/${ACCT}/net-liq/history`;

  it("translates the absolute window (start_time/end_time/interval)", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: NET_LIQ_URL,
          method: "GET",
          reply: { data: { items: [CANDLE] } },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_net_liq_history", {
      account_number: ACCT,
      start_time: "2026-01-01T00:00:00+00:00",
      end_time: "2026-04-09T00:00:00+00:00",
      interval: "1d",
    });

    const req = h.lastRequest()!;
    expect(req.url).toBe(NET_LIQ_URL);
    expect(definedParams(req.params)).toEqual({
      "start-time": "2026-01-01T00:00:00+00:00",
      "end-time": "2026-04-09T00:00:00+00:00",
      interval: "1d",
    });
    expectKebabParams(req.params);
    expect(result).toEqual([CANDLE]);
  });

  it("translates the relative window (time_back) and sends no value for the absolute one", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: NET_LIQ_URL,
          method: "GET",
          reply: { data: { items: [CANDLE] } },
        },
      ],
    });

    await callOk(h, "tastytrade_get_net_liq_history", {
      account_number: ACCT,
      time_back: "1y",
      interval: "1d",
    });

    const req = h.lastRequest()!;
    expect(definedParams(req.params)).toEqual({
      "time-back": "1y",
      interval: "1d",
    });
    // NOTE — behaviour worth knowing: unlike the other filtered tools, this
    // handler builds its params object unconditionally, so the two unset keys
    // are PRESENT with an `undefined` value rather than absent. Axios's default
    // serializer skips undefined, so nothing reaches the wire and the request
    // is correct; but the guarantee that matters is asserted here explicitly —
    // the unset keys are never null and never an empty string, either of which
    // the API would read as a real filter value.
    expect(req.params["start-time"]).toBeUndefined();
    expect(req.params["end-time"]).toBeUndefined();
    expectKebabParams(req.params);
  });

  it("returns an empty array when the account has no history", async () => {
    h = await createHarness({
      routes: [
        { matcher: NET_LIQ_URL, method: "GET", reply: { data: { items: [] } } },
      ],
    });

    const result = await callOk(h, "tastytrade_get_net_liq_history", {
      account_number: ACCT,
    });

    expect(result).toEqual([]);
  });
});

// ============================================================================
// Risk-free rate
// ============================================================================

describe("tastytrade_get_risk_free_rate", () => {
  const CONFIG_URL = "/margin-requirements-public-configuration";

  it("reads the public margin config once and coerces the rate to a number", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: CONFIG_URL,
          method: "GET",
          reply: { data: MARGIN_CONFIG_FIXTURE },
        },
      ],
    });

    const result = (await callOk(h, "tastytrade_get_risk_free_rate")) as Record<
      string,
      unknown
    >;

    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()!.url).toBe(CONFIG_URL);
    expect(h.lastRequest()!.params).toEqual({});
    // The recorded payload carries the rate as the STRING "0.0025"; the whole
    // point of this wrapper over get_margin_config is handing back a number.
    expect(MARGIN_CONFIG_FIXTURE["risk-free-rate"]).toBe("0.0025");
    expect(result).toEqual({ "risk-free-rate": 0.0025 });
    expect(typeof result["risk-free-rate"]).toBe("number");
  });

  it.each([
    {
      label: "a numeric rate",
      payload: { "risk-free-rate": 0.03 },
      rate: 0.03,
    },
    { label: "an absent rate", payload: {}, rate: null },
    {
      label: "an unparseable rate",
      payload: { "risk-free-rate": "not-a-number" },
      rate: null,
    },
  ])("returns $label as $rate", async ({ payload, rate }) => {
    h = await createHarness({
      routes: [
        { matcher: CONFIG_URL, method: "GET", reply: { data: payload } },
      ],
    });

    const result = await callOk(h, "tastytrade_get_risk_free_rate");

    // Null is the deliberate "no usable rate" signal — never NaN, which would
    // serialize to JSON as null anyway but poison any arithmetic before that.
    expect(result).toEqual({ "risk-free-rate": rate });
  });
});

// ============================================================================
// Transactions
// ============================================================================

describe("tastytrade_get_transactions", () => {
  const TX_URL = `/accounts/${ACCT}/transactions`;

  it("unwraps the recorded sandbox payload to the bare items array", async () => {
    h = await createHarness({
      routes: [{ matcher: TX_URL, method: "GET", reply: { data: TX_FIXTURE } }],
    });

    const result = (await callOk(h, "tastytrade_get_transactions", {
      account_number: ACCT,
    })) as Array<Record<string, unknown>>;

    const req = h.lastRequest()!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe(TX_URL);
    expect(req.params).toEqual({});
    expect(result).toHaveLength(TX_FIXTURE.items.length);
    expect(result[0]["transaction-type"]).toBe("Trade");
    expect(result[0]["underlying-symbol"]).toBe("SMCI");
  });

  it("translates the full documented filter set, arrays included", async () => {
    h = await createHarness({
      routes: [{ matcher: TX_URL, method: "GET", reply: { data: TX_FIXTURE } }],
    });

    const args = {
      account_number: ACCT,
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      start_at: "2026-06-01T00:00:00Z",
      end_at: "2026-06-30T23:59:59Z",
      symbol: "SMCI  260605C00045000",
      underlying_symbol: "SMCI",
      futures_symbol: "/ESZ9",
      instrument_type: "Equity Option",
      type: "Trade",
      types: ["Trade", "Receive Deliver"],
      sub_type: ["Buy to Open", "Sell to Close"],
      action: "Buy to Open",
      sort: "Asc",
      currency: "USD",
      page_offset: 2,
      per_page: 100,
    };
    await callOk(h, "tastytrade_get_transactions", args);

    const req = h.lastRequest()!;
    // `types[]` / `sub-type[]` keep their bracket suffix: the spec documents
    // the repeated form `types[]=Trade&types[]=Receive Deliver`, and the client
    // serializes an array value as repeated keys.
    expect(req.params).toEqual({
      "start-date": "2026-06-01",
      "end-date": "2026-06-30",
      "start-at": "2026-06-01T00:00:00Z",
      "end-at": "2026-06-30T23:59:59Z",
      symbol: "SMCI  260605C00045000",
      "underlying-symbol": "SMCI",
      "futures-symbol": "/ESZ9",
      "instrument-type": "Equity Option",
      type: "Trade",
      "types[]": ["Trade", "Receive Deliver"],
      "sub-type[]": ["Buy to Open", "Sell to Close"],
      action: "Buy to Open",
      sort: "Asc",
      currency: "USD",
      "page-offset": 2,
      "per-page": 100,
    });
    // One query param per supplied filter — none dropped, none invented.
    expect(Object.keys(req.params)).toHaveLength(Object.keys(args).length - 1);
    expectKebabParams(req.params);
    expect(Array.isArray(req.params["types[]"])).toBe(true);
  });

  it("omits every filter the caller did not set", async () => {
    h = await createHarness({
      routes: [{ matcher: TX_URL, method: "GET", reply: { data: TX_FIXTURE } }],
    });

    await callOk(h, "tastytrade_get_transactions", {
      account_number: ACCT,
      start_date: "2026-06-01",
    });

    const req = h.lastRequest()!;
    expect(req.params).toEqual({ "start-date": "2026-06-01" });
    for (const key of [
      "end-date",
      "start-at",
      "end-at",
      "symbol",
      "underlying-symbol",
      "futures-symbol",
      "instrument-type",
      "type",
      "types[]",
      "sub-type[]",
      "action",
      "sort",
      "currency",
      "page-offset",
      "per-page",
    ]) {
      expect(req.params).not.toHaveProperty(key);
    }
  });

  it("forwards pagination alone, as numbers", async () => {
    h = await createHarness({
      routes: [{ matcher: TX_URL, method: "GET", reply: { data: TX_FIXTURE } }],
    });

    await callOk(h, "tastytrade_get_transactions", {
      account_number: ACCT,
      page_offset: 0,
      per_page: 2000,
    });

    const req = h.lastRequest()!;
    expect(req.params).toEqual({ "page-offset": 0, "per-page": 2000 });
    expect(typeof req.params["page-offset"]).toBe("number");
    expect(typeof req.params["per-page"]).toBe("number");
  });

  it.each([
    { label: "an empty items array", payload: { items: [] } },
    { label: "a payload with no items key at all", payload: {} },
  ])("returns [] for $label", async ({ payload }) => {
    h = await createHarness({
      routes: [{ matcher: TX_URL, method: "GET", reply: { data: payload } }],
    });

    const result = await callOk(h, "tastytrade_get_transactions", {
      account_number: ACCT,
    });

    // An account with no matching activity is an empty list an agent can
    // iterate — never null, never undefined, both of which `toEqual([])`
    // already rejects.
    expect(result).toEqual([]);
  });
});

describe("tastytrade_get_transaction", () => {
  it("puts account number and transaction id on the path", async () => {
    const tx = TX_FIXTURE.items[0];
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/transactions/${tx.id}`,
          method: "GET",
          reply: { data: tx },
        },
      ],
    });

    const result = await callOk(h, "tastytrade_get_transaction", {
      account_number: ACCT,
      transaction_id: String(tx.id),
    });

    const req = h.lastRequest()!;
    expect(req.url).toBe(`/accounts/${ACCT}/transactions/${tx.id}`);
    // Both identifiers are path segments — neither may appear in the query.
    expect(req.params).toEqual({});
    expect(result).toEqual(tx);
    expect((result as Record<string, unknown>)["account-number"]).toBe(
      tx["account-number"],
    );
  });

  it("maps an unknown transaction id to not_found", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /\/transactions\/\d+$/,
          method: "GET",
          reply: { status: 404 },
        },
      ],
    });

    const err = await callError(h, "tastytrade_get_transaction", {
      account_number: ACCT,
      transaction_id: "999999999",
    });

    expect(err.code).toBe("not_found");
    expect(h.lastRequest()!.url).toBe(
      `/accounts/${ACCT}/transactions/999999999`,
    );
  });
});
