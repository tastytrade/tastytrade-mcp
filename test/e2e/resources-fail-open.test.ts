import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { createHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import {
  MCP_ERROR_INTERNAL,
  MCP_ERROR_INVALID_PARAMS,
  MCP_ERROR_RESOURCE_NOT_FOUND,
} from "../../src/mcp-server/index.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { MAX_FIELD_FAILURE_CHARS } from "../../src/safety/bounded-text.js";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The fail-open audit of the computed account resources.
 *
 * `tastytrade://accounts/{n}/summary` and `.../pnl-today` fan out to the API and then
 * present the result as a finished page. Swallowing the fetch failure and building
 * that page from an empty fallback produces a SUCCESSFUL resource read asserting
 * `"position-count": 0`, `"open-position-symbols": []` and zero P&L, with nothing in
 * the body saying the read had failed.
 *
 * That is worse than an error, because an error is visible. An agent told "this
 * account holds no positions and made nothing today" can liquidate nothing, double a
 * position it believes it does not hold, or report a flat book to a human — with no way
 * to tell that answer from a true one.
 *
 * Every test asserts the same invariant from a different angle: the body never states a
 * definite zero or an empty collection for data the server could not read. The
 * permitted answers are a taxonomy error (fail closed) or an explicit `null` plus a
 * named entry saying which field is unknown and why. A real zero must still come
 * through as a zero, which the honest-path tests pin.
 */

let h: Harness | undefined;

// The rate limiter is module-global, so every test in this file draws on the
// same buckets. `tastytrade://.../summary` and `.../pnl-today` both spend the
// 1/sec `positions` ceiling (RESOURCE_RATE_KEYS in src/mcp-server/index.ts), so
// without a reset the second test in the file would be refused before it
// reached the behaviour it is asserting.
beforeEach(() => {
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  _resetRateLimitsForTest();
});

const ACCT = "5WX00001";
const SUMMARY = `tastytrade://accounts/${ACCT}/summary`;
const PNL = `tastytrade://accounts/${ACCT}/pnl-today`;
const BALANCES = `/accounts/${ACCT}/balances`;
const POSITIONS = `/accounts/${ACCT}/positions`;
const STATUS = `/accounts/${ACCT}/trading-status`;

/** The shape a computed resource body exposes for a failed sub-fetch. */
interface Unavailable {
  field: string;
  code: string;
  message: string;
  retryable: boolean;
  "upstream-status"?: number;
}

/** The JSON-RPC error the SDK surfaces for a failed `resources/read`. */
interface RpcFailure {
  code?: number;
  message: string;
  data?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    hint?: string;
    upstream?: { status?: number };
  };
}

/** Reads a resource and returns both the raw text and the parsed body. */
async function readBody(
  harness: Harness,
  uri: string,
): Promise<{ text: string; body: Record<string, any> }> {
  const res = await harness.client.readResource({ uri });
  expect(res.contents).toHaveLength(1);
  const text = (res.contents[0] as { text?: string }).text ?? "";
  return { text, body: JSON.parse(text) as Record<string, any> };
}

/**
 * Asserts a read FAILED and returns the JSON-RPC error. Deliberately reports the
 * returned body on the unexpected-success path: a fail-open regression here is
 * exactly a read that succeeded, and seeing the fabricated body is the point.
 */
async function readFailure(harness: Harness, uri: string): Promise<RpcFailure> {
  const outcome = await harness.client.readResource({ uri }).then(
    (ok) => ({ ok }),
    (err: unknown) => ({ err: err as RpcFailure }),
  );
  if (!("err" in outcome)) {
    throw new Error(
      `Expected resources/read ${uri} to fail, but it returned a body: ` +
        JSON.stringify(outcome.ok),
    );
  }
  return outcome.err;
}

/** The `unavailable-fields` entry for one field, asserting it is present. */
function unavailableFor(body: Record<string, any>, field: string): Unavailable {
  const entries = (body["unavailable-fields"] ?? []) as Unavailable[];
  const hit = entries.find((e) => e.field === field);
  expect(hit).toBeDefined();
  return hit!;
}

// ---------------------------------------------------------------------------
// Account summary: aggregate, so a partial answer is allowed — but only a
// declared one.
// ---------------------------------------------------------------------------

describe("account summary never fabricates a flat book", () => {
  /**
   * The headline defect. Three transport-level shapes, all of which the old
   * `.catch(() => [])` collapsed into "you have no positions":
   *   - a 500 (the endpoint is broken)
   *   - a refused connection (the network is gone)
   *   - a 200 whose payload omits `items` (nothing threw at all)
   */
  const POSITION_FAILURES: Array<{
    label: string;
    reply: Record<string, unknown>;
    code: string;
    status?: number;
  }> = [
    {
      label: "a 500",
      reply: { status: 500 },
      code: "upstream_error",
      status: 500,
    },
    { label: "a 404", reply: { status: 404 }, code: "not_found", status: 404 },
    {
      label: "a refused connection",
      reply: { networkError: "ECONNREFUSED" },
      code: "network",
    },
    {
      label: "a 200 carrying no item list",
      reply: { data: {} },
      code: "upstream_error",
    },
  ];

  it.each(POSITION_FAILURES)(
    "reports position-count as unknown when the positions fetch answers with $label",
    async ({ reply, code, status }) => {
      h = await createHarness({
        routes: [
          {
            matcher: BALANCES,
            reply: { data: { "net-liquidating-value": "12345.67" } },
          },
          { matcher: POSITIONS, reply: reply as never },
          { matcher: STATUS, reply: { data: { "is-frozen": false } } },
        ],
      });

      const { text, body } = await readBody(h, SUMMARY);

      // The whole point: not 0, not [].
      expect(body["position-count"]).toBeNull();
      expect(body["open-position-symbols"]).toBeNull();
      expect(body["position-count"]).not.toBe(0);
      expect(body["open-position-symbols"]).not.toEqual([]);
      expect(text).not.toContain('"position-count": 0');
      expect(text).not.toContain('"position-count":0');

      // And the failure is declared, with the same taxonomy a tool call yields.
      expect(body["partial-read"]).toBe(true);
      const failure = unavailableFor(body, "positions");
      expect(failure.code).toBe(code);
      expect(failure["upstream-status"]).toBe(status);
      expect(typeof failure.message).toBe("string");
      expect(failure.message.length).toBeGreaterThan(0);
      expect(body.warning).toMatch(/UNKNOWN/);
      expect(body.warning).toMatch(/position-count/);

      // The two fetches that worked are still there — a partial page beats no
      // page, as long as the hole is labelled.
      expect(body.balances).toEqual({ "net-liquidating-value": "12345.67" });
      expect(body["trading-status"]).toEqual({ "is-frozen": false });
    },
  );

  it("reports a failed balances fetch as null rather than an object that reads like a balance sheet", async () => {
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { status: 401 } },
        {
          matcher: POSITIONS,
          reply: { data: { items: [{ symbol: "AAPL" }] } },
        },
        { matcher: STATUS, reply: { data: { "is-frozen": false } } },
      ],
    });

    const { body } = await readBody(h, SUMMARY);

    expect(body.balances).toBeNull();
    expect(body["partial-read"]).toBe(true);
    const failure = unavailableFor(body, "balances");
    // 401 classifies as auth_failed, not as a generic upstream fault, so an
    // agent can tell "my credentials expired" from "the broker is down".
    expect(failure.code).toBe("auth_failed");
    expect(failure.retryable).toBe(false);
    expect(failure["upstream-status"]).toBe(401);
    // The reads that worked survive.
    expect(body["position-count"]).toBe(1);
    expect(body["open-position-symbols"]).toEqual(["AAPL"]);
  });

  it("reports a failed trading-status fetch as null, so 'not frozen' is never assumed", async () => {
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { data: {} } },
        { matcher: POSITIONS, reply: { data: { items: [] } } },
        { matcher: STATUS, reply: { status: 404 } },
      ],
    });

    const { body } = await readBody(h, SUMMARY);

    // A missing trading status must not read as a permissive one: `is-frozen`
    // absent from an object-shaped field is how an agent concludes it may trade.
    expect(body["trading-status"]).toBeNull();
    expect(unavailableFor(body, "trading-status").code).toBe("not_found");
    // A genuinely empty position list is still a real, readable zero.
    expect(body["position-count"]).toBe(0);
    expect(body["open-position-symbols"]).toEqual([]);
    expect(body["partial-read"]).toBe(true);
  });

  it("fails closed when every fetch fails, instead of returning a page of nulls", async () => {
    h = await createHarness({ fallback: { status: 503 } });

    const err = await readFailure(h, SUMMARY);

    expect(err.data?.code).toBe("upstream_error");
    expect(err.data?.retryable).toBe(true);
    expect(err.code).toBe(MCP_ERROR_INTERNAL);
    expect(err.message).toMatch(new RegExp(ACCT));
    // The hint has to tell the agent what NOT to conclude, because "empty" is
    // the reading that costs money.
    expect(err.data?.hint).toMatch(/UNKNOWN/);
    expect(err.data?.hint).toMatch(/not as empty, flat or unfunded/);
    // All three were really attempted; this is not one failure short-circuiting.
    expect(h.requests).toHaveLength(3);
  });

  it("carries the failing taxonomy code when every fetch 404s", async () => {
    h = await createHarness({ fallback: { status: 404 } });
    const err = await readFailure(h, SUMMARY);
    expect(err.data?.code).toBe("not_found");
    expect(err.data?.retryable).toBe(false);
    expect(err.code).toBe(MCP_ERROR_RESOURCE_NOT_FOUND);
  });

  it("marks a fully successful read complete, and leaves real zeros alone", async () => {
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { data: { "cash-balance": "0.0" } } },
        { matcher: POSITIONS, reply: { data: { items: [] } } },
        { matcher: STATUS, reply: { data: { "is-frozen": false } } },
      ],
    });

    const { body } = await readBody(h, SUMMARY);

    // An account that really is flat reports 0 and [] — the fix must not turn
    // every zero into an "unknown", or the resource becomes useless.
    expect(body["position-count"]).toBe(0);
    expect(body["open-position-symbols"]).toEqual([]);
    expect(body["partial-read"]).toBe(false);
    expect(body["unavailable-fields"]).toEqual([]);
    expect("warning" in body).toBe(false);
  });

  it("routes the upstream message through credential redaction before it reaches the body", async () => {
    // The old `.catch((e) => ({ error: String(e?.message ?? e) }))` put the raw
    // thrown message straight into a resource body, bypassing sanitizeToolError
    // — the gate every ToolError passes. A resource body is the same egress path
    // as a tool result (it lands in the agent's transcript), and an axios message
    // can carry the request URL, so a TASTYTRADE_API_URL with userinfo in it
    // would have leaked the secret verbatim.
    const secret = "s3cret-client-secret-value";
    const bearer = "Bearer abcdefghijklmnop0123456789";
    const prev = process.env.TASTYTRADE_CLIENT_SECRET;
    process.env.TASTYTRADE_CLIENT_SECRET = secret;
    try {
      h = await createHarness({
        routes: [
          {
            matcher: BALANCES,
            reply: {
              networkError: `connect ECONNREFUSED https://api:${secret}@api.cert.tastyworks.com`,
            },
          },
          { matcher: POSITIONS, reply: { networkError: bearer } },
          { matcher: STATUS, reply: { data: { "is-frozen": false } } },
        ],
      });

      const { text, body } = await readBody(h, SUMMARY);

      expect(text).not.toContain(secret);
      expect(text).not.toContain("abcdefghijklmnop0123456789");
      expect(text).toContain("[redacted]");
      // Redaction must not cost the taxonomy: both failures are still named.
      expect(unavailableFor(body, "balances").message).toContain("[redacted]");
      expect(unavailableFor(body, "positions").message).toContain("[redacted]");
      expect(body["position-count"]).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.TASTYTRADE_CLIENT_SECRET;
      else process.env.TASTYTRADE_CLIENT_SECRET = prev;
    }
  });

  it("omits upstream-status entirely for a transport failure that has none", async () => {
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { networkError: "ETIMEDOUT" } },
        { matcher: POSITIONS, reply: { data: { items: [] } } },
        { matcher: STATUS, reply: { data: {} } },
      ],
    });

    const { body } = await readBody(h, SUMMARY);
    const failure = unavailableFor(body, "balances");
    expect(failure.code).toBe("network");
    expect(failure.retryable).toBe(true);
    // A synthesised `0` status would read as a real HTTP status.
    expect("upstream-status" in failure).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pnl-today: single-source, so there is no partial answer — it fails closed.
// ---------------------------------------------------------------------------

describe("pnl-today fails closed rather than reporting a zeroed day", () => {
  // Date.now() is the only nondeterminism in the computed view. Only Date is
  // faked — the SDK arms a real setTimeout per request and the in-memory
  // transport must stay live.
  const FROZEN = "2026-03-04T14:30:00.000Z";
  const REAL_TIMERS = [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "nextTick",
    "queueMicrotask",
    "performance",
    "hrtime",
  ] as const;

  function freezeClock(): void {
    jest.useFakeTimers({ doNotFake: [...REAL_TIMERS] });
    jest.setSystemTime(new Date(FROZEN));
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  const FETCH_FAILURES: Array<{
    label: string;
    reply: Record<string, unknown>;
    code: string;
    rpc: number;
    retryable: boolean;
  }> = [
    {
      label: "a 500",
      reply: { status: 500 },
      code: "upstream_error",
      rpc: MCP_ERROR_INTERNAL,
      retryable: true,
    },
    {
      label: "a 401",
      reply: { status: 401 },
      code: "auth_failed",
      rpc: MCP_ERROR_INTERNAL,
      retryable: false,
    },
    {
      label: "a 404",
      reply: { status: 404 },
      code: "not_found",
      rpc: MCP_ERROR_RESOURCE_NOT_FOUND,
      retryable: false,
    },
    {
      label: "a refused connection",
      reply: { networkError: "ECONNREFUSED" },
      code: "network",
      rpc: MCP_ERROR_INTERNAL,
      retryable: true,
    },
    {
      label: "a 200 carrying no item list",
      reply: { data: {} },
      code: "upstream_error",
      rpc: MCP_ERROR_INTERNAL,
      retryable: true,
    },
  ];

  it.each(FETCH_FAILURES)(
    "refuses the read when the positions fetch answers with $label",
    async ({ reply, code, rpc, retryable }) => {
      freezeClock();
      h = await createHarness({
        routes: [{ matcher: POSITIONS, reply: reply as never }],
      });

      const err = await readFailure(h, PNL);

      expect(err.data?.code).toBe(code);
      expect(err.data?.retryable).toBe(retryable);
      expect(err.code).toBe(rpc);
      expect(err.message).toMatch(new RegExp(ACCT));
      expect(err.message).toMatch(/no P&L could be computed/);
      expect(err.data?.hint).toMatch(/UNKNOWN/);
      expect(err.data?.hint).toMatch(/not as zero/);
    },
  );

  it("still reports a genuine zero day for an account with no positions", async () => {
    freezeClock();
    h = await createHarness({
      routes: [{ matcher: POSITIONS, reply: { data: { items: [] } } }],
    });

    const { body } = await readBody(h, PNL);

    // A successfully-read empty book is a real zero and must stay a zero.
    expect(body["realized-day-pnl"]).toBe(0);
    expect(body["estimated-unrealized-day-pnl"]).toBe(0);
    expect(body["estimated-total-day-pnl"]).toBe(0);
    expect(body.positions).toEqual([]);
    expect(body["partial-read"]).toBe(false);
    expect(body["positions-excluded-from-estimate"]).toEqual([]);
    expect("warning" in body).toBe(false);
    expect(body["computed-at"]).toBe(FROZEN);
  });
});

describe("pnl-today never prices a position the API did not price", () => {
  const FROZEN = "2026-03-04T14:30:00.000Z";
  const REAL_TIMERS = [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "nextTick",
    "queueMicrotask",
    "performance",
    "hrtime",
  ] as const;

  function freezeClock(): void {
    jest.useFakeTimers({ doNotFake: [...REAL_TIMERS] });
    jest.setSystemTime(new Date(FROZEN));
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Boots the harness with one positions payload. */
  async function withPositions(items: unknown[]): Promise<Record<string, any>> {
    freezeClock();
    h = await createHarness({
      routes: [{ matcher: POSITIONS, reply: { data: { items } } }],
    });
    const { body } = await readBody(h, PNL);
    return body;
  }

  it("excludes a position with no close-price instead of pricing it against zero", async () => {
    // `close-price` is optional in the API — routine for a position opened
    // today, and absent from the vendored spec's own example payload. Defaulting
    // it to 0 turned the ENTIRE position value into a fabricated day gain:
    // (185.25 - 0) * 10 * 1 = +1852.50 out of nothing.
    const body = await withPositions([
      {
        symbol: "AAPL",
        "instrument-type": "Equity",
        quantity: "10",
        multiplier: 1,
        "quantity-direction": "Long",
        "mark-price": "185.25",
        "realized-day-gain": "0.0",
        "realized-day-gain-effect": "None",
      },
    ]);

    expect(body.positions[0]["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body.positions[0]["estimated-total-day-pnl"]).toBeNull();
    expect(body.positions[0]["close-price"]).toBeNull();
    expect(body["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body["estimated-unrealized-day-pnl"]).not.toBe(1852.5);
    // Realized WAS readable, so it keeps its real value rather than vanishing.
    expect(body["realized-day-pnl"]).toBe(0);
    // Total is unknown because half of it is.
    expect(body["estimated-total-day-pnl"]).toBeNull();

    expect(body["partial-read"]).toBe(true);
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { symbol: "AAPL", "unreadable-fields": ["close-price"] },
    ]);
    expect(body.warning).toMatch(/INCOMPLETE ESTIMATE/);
    expect(body.note).toMatch(/unknown, not zero/i);
  });

  it("keeps the priceable positions and excludes only the unpriceable one", async () => {
    const body = await withPositions([
      {
        symbol: "AAPL",
        quantity: "10",
        multiplier: 1,
        "quantity-direction": "Long",
        "close-price": "100.00",
        "mark-price": "105.00",
        "realized-day-gain": "25.00",
        "realized-day-gain-effect": "Credit",
      },
      {
        symbol: "MSFT",
        quantity: "5",
        multiplier: 1,
        "quantity-direction": "Long",
        "mark-price": "n/a",
        "close-price": "300.00",
        "realized-day-gain": "0.0",
        "realized-day-gain-effect": "None",
      },
    ]);

    // AAPL: (105 - 100) * 10 = +50 unrealized, +25 realized.
    expect(body["estimated-unrealized-day-pnl"]).toBe(50);
    expect(body["realized-day-pnl"]).toBe(25);
    expect(body["estimated-total-day-pnl"]).toBe(75);
    // A partial aggregate is allowed, but it says so, and it says which row is
    // missing — the total is a lower bound, not the day's P&L.
    expect(body["partial-read"]).toBe(true);
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { symbol: "MSFT", "unreadable-fields": ["mark-price"] },
    ]);
    expect(body.warning).toMatch(/lower bound/);
    expect(body.positions[1]["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body.positions[1]["mark-price"]).toBeNull();
  });

  it("reports null totals when no position could be priced at all", async () => {
    // The failure mode `sumOrNull` exists for: a running total of 0 over rows
    // that ALL failed to price is indistinguishable from a flat, quiet day.
    const body = await withPositions([
      {
        symbol: "AAPL",
        quantity: "10",
        "mark-price": "",
        "close-price": "100.00",
        "realized-day-gain": "oops",
      },
      // A null row: hostile or truncated payloads do occur, and a null must
      // neither throw its way out of a resource read nor inherit the
      // absent-field defaults a real position legitimately gets.
      null,
      {
        symbol: "SPY",
        quantity: true,
        multiplier: "not-a-number",
        "mark-price": Number.POSITIVE_INFINITY,
        "close-price": "1.00",
        "realized-day-gain": "unparseable",
      },
    ]);

    expect(body["realized-day-pnl"]).toBeNull();
    expect(body["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body["estimated-total-day-pnl"]).toBeNull();
    expect(body["estimated-total-day-pnl"]).not.toBe(0);
    expect(body["partial-read"]).toBe(true);
    expect(body["positions-excluded-from-estimate"]).toHaveLength(3);

    const excluded = body["positions-excluded-from-estimate"] as Array<{
      symbol: string | null;
      "unreadable-fields": string[];
    }>;
    expect(excluded[0]).toEqual({
      symbol: "AAPL",
      "unreadable-fields": ["mark-price", "realized-day-gain"],
    });
    // The null row cannot name itself, but it is counted, declared, and every
    // field of it is unknown — including the realized gain, which a real
    // position omitting the field would have contributed as a legitimate 0.
    expect(excluded[1]).toEqual({
      symbol: null,
      "unreadable-fields": [
        "quantity",
        "multiplier",
        "mark-price",
        "close-price",
        "realized-day-gain",
      ],
    });
    expect(body.positions[1]["quantity-direction"]).toBeNull();
    // A boolean quantity, an unparseable multiplier and a non-finite mark are
    // each unreadable rather than coerced (Number(true) is 1, Number("") is 0).
    expect(excluded[2]).toEqual({
      symbol: "SPY",
      "unreadable-fields": [
        "quantity",
        "multiplier",
        "mark-price",
        "realized-day-gain",
      ],
    });
  });

  it("treats an explicit JSON null the way it treats an absent key", async () => {
    // A null carries no more information than an absent key: equities really are
    // 1x, and no realized gain today really is 0. Both stay defaults rather than
    // becoming exclusions — the distinction from the unparseable
    // "not-a-number" / "unparseable" cases above is deliberate, because a value
    // that is present and wrong is evidence of a payload problem while a null is
    // not.
    const body = await withPositions([
      {
        symbol: "AAPL",
        quantity: "10",
        multiplier: null,
        "quantity-direction": "Long",
        "close-price": "100.00",
        "mark-price": "100.50",
        "realized-day-gain": null,
      },
    ]);

    expect(body["estimated-unrealized-day-pnl"]).toBe(5);
    expect(body["realized-day-pnl"]).toBe(0);
    expect(body["partial-read"]).toBe(false);
  });

  it("refuses to substitute the total `mark` for the per-unit `mark-price`", async () => {
    // Per the API spec `mark` is the position's TOTAL value
    // (mark-price × quantity × multiplier), so the old `?? p?.mark` fallback fed
    // a total into an estimator that multiplies by quantity × multiplier again:
    // (1852.50 - 185.00) * 10 = +16,675 on a position worth 1,852.50.
    const body = await withPositions([
      {
        symbol: "AAPL",
        quantity: "10",
        multiplier: 1,
        "quantity-direction": "Long",
        mark: "1852.50",
        "close-price": "185.00",
        "realized-day-gain": "0.0",
        "realized-day-gain-effect": "None",
      },
    ]);

    expect(body["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body["estimated-unrealized-day-pnl"]).not.toBe(16675);
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { symbol: "AAPL", "unreadable-fields": ["mark-price"] },
    ]);
  });

  it("keeps the documented defaults that are not guesses: absent multiplier is 1, absent realized is nil", async () => {
    // Not every absent field is unknown. The API omits `multiplier` for
    // equities, where it is 1 by definition, and omits `realized-day-gain` when
    // there was no realized activity — and unlike a price, a wrong 0 there
    // cannot be amplified by a quantity. Both stay defaults so the resource does
    // not degrade into all-nulls on ordinary payloads.
    const body = await withPositions([
      {
        symbol: "AAPL",
        quantity: "10",
        "quantity-direction": "Long",
        "close-price": "100.00",
        "mark-price": "101.00",
      },
    ]);

    expect(body["estimated-unrealized-day-pnl"]).toBe(10);
    expect(body["realized-day-pnl"]).toBe(0);
    expect(body["estimated-total-day-pnl"]).toBe(10);
    expect(body["partial-read"]).toBe(false);
    expect(body["positions-excluded-from-estimate"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The one client-side rejection in the registry.
// ---------------------------------------------------------------------------

describe("nlv-history range rejection carries the right taxonomy", () => {
  it("classifies an unsupported range as validation, not as an upstream fault", async () => {
    h = await createHarness();

    const err = await readFailure(
      h,
      `tastytrade://accounts/${ACCT}/nlv-history/7y`,
    );

    // Thrown as a bare Error this classified as `upstream_error` on -32603,
    // telling an agent the broker had failed when the URI it built was simply
    // wrong. The remedy is a different request, which is what `validation` and
    // InvalidParams mean.
    expect(err.data?.code).toBe("validation");
    expect(err.code).toBe(MCP_ERROR_INVALID_PARAMS);
    expect(err.data?.retryable).toBe(false);
    expect(err.message).toMatch(/Unsupported NLV range "7y"/);
    expect(err.message).toMatch(/1d, 1w, 1m, 3m, 6m, 1y, all/);
    // The guard runs ahead of the client call, so nothing was dispatched.
    expect(h.requests).toHaveLength(0);
  });

  it("clips a hostile range before echoing it back", async () => {
    h = await createHarness();
    const err = await readFailure(
      h,
      `tastytrade://accounts/${ACCT}/nlv-history/${"z".repeat(500)}`,
    );
    expect(err.data?.code).toBe("validation");
    // Caller-controlled text is echoed bounded, not verbatim.
    expect(err.message).not.toContain("z".repeat(64));
    expect(err.message).toContain("z".repeat(32));
  });
});

// ---------------------------------------------------------------------------
// The per-field diagnostic is bounded too, and by the same reasoning
// ---------------------------------------------------------------------------

/**
 * A 180,000-character upstream message. `networkError` sets both the thrown
 * error's `message` and its `code`, so an unrecognised code classifies as
 * `upstream_error` — which is exactly the point of the structural assertions
 * below: the attacker authors the prose, never the verdict.
 */
const FLOOD = `upstream said: ${"A".repeat(180_000)}`;

describe("describeFailure bounds the per-field diagnostic it copies", () => {
  it("bounds a 180,000-character upstream message in the 200-OK body", async () => {
    // The sharper of the two surfaces, and the reason the bound is at the
    // producer rather than at the two template literals that consume it: this
    // is a SUCCESS envelope whose own `warning` names `unavailable-fields` as
    // the thing to read, so an agent has no reason to discount it.
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { networkError: FLOOD } },
        { matcher: POSITIONS, reply: { data: { items: [] } } },
        { matcher: STATUS, reply: { data: { "is-frozen": false } } },
      ],
    });
    const { body } = await readBody(h, SUMMARY);
    const entry = unavailableFor(body, "balances");
    expect(entry.message.length).toBeLessThanOrEqual(MAX_FIELD_FAILURE_CHARS);
    expect(entry.message).toMatch(/…\[truncated, \d+ chars\]/);
    // The structural fields the attacker must not reach are untouched: an
    // unrecognised transport code is still `upstream_error`, still not
    // retryable, and the body still declares the read partial.
    expect(entry.code).toBe("upstream_error");
    expect(entry.retryable).toBe(false);
    expect(body["partial-read"]).toBe(true);
  });

  it("bounds the same message on the all-three-failed ToolError path", async () => {
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { networkError: FLOOD } },
        { matcher: POSITIONS, reply: { networkError: FLOOD } },
        { matcher: STATUS, reply: { networkError: FLOOD } },
      ],
    });
    const err = await readFailure(h, SUMMARY);
    expect((err.data?.message ?? "").length).toBeLessThanOrEqual(
      MAX_FIELD_FAILURE_CHARS + 200,
    );
    // The server's own half of the sentence survives — the composite is not
    // capped, its operands are.
    expect(err.data?.message).toContain(
      "Could not read any part of the summary",
    );
  });

  it("leaves a short diagnostic uncut and unmarked", async () => {
    // ANTI-OVERREACH. The diagnostic is the whole value of this field; a bound
    // that marks a routine ETIMEDOUT as truncated has cost more than it saved.
    h = await createHarness({
      routes: [
        { matcher: BALANCES, reply: { networkError: "ETIMEDOUT" } },
        { matcher: POSITIONS, reply: { data: { items: [] } } },
        { matcher: STATUS, reply: { data: { "is-frozen": false } } },
      ],
    });
    const { body } = await readBody(h, SUMMARY);
    const entry = unavailableFor(body, "balances");
    expect(entry.message).not.toMatch(/truncated/);
    expect(entry.message).toContain("ETIMEDOUT");
  });
});

describe("SOURCE INVARIANT — every UnavailableField producer bounds its message", () => {
  const SRC = readFileSync(
    nodePath.join(
      nodePath.dirname(fileURLToPath(import.meta.url)),
      "../../src/mcp-server/resources.ts",
    ),
    "utf8",
  );

  /**
   * Every function in resources.ts declared to RETURN an `UnavailableField`,
   * with its body. Derived by scanning for the return-type annotation, so a
   * producer added next year lands in the denominator automatically — the whole
   * argument for bounding at the producer is that there is exactly one today,
   * and this is what keeps that true.
   */
  function producers(): Array<{ name: string; body: string }> {
    const lines = SRC.split("\n");
    const out: Array<{ name: string; body: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^function (\w+)\([^)]*\): UnavailableField \{$/.exec(
        lines[i]!,
      );
      if (!m) continue;
      let body = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === "}") break;
        body += `${lines[j]!}\n`;
      }
      out.push({ name: m[1]!, body });
    }
    return out;
  }

  it("has at least one producer, and every one of them bounds `message`", () => {
    const found = producers();
    expect(found.length).toBeGreaterThan(0);
    const unbounded = found
      .filter((p) => /(^|\n)\s*message:/.test(p.body))
      .filter((p) => !/message:\s*boundedText\(/.test(p.body))
      .map((p) => p.name);
    expect(unbounded).toEqual([]);
  });
});
