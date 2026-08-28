/**
 * End-to-end rate limiting: the CallTool pre-flight's token buckets, exercised
 * through real `tools/call` requests.
 *
 * The limiter is charged for tool calls in exactly one place, so every assertion here
 * drives the real protocol handler and reads the real `ToolError` envelope. Nothing
 * touches the limiter's internals except `_resetRateLimitsForTest()`.
 *
 * Four structural facts shape these tests. The policy is tastytrade's, not ours — a
 * 50/sec global cap plus per-second ceilings on named endpoints — so every wait
 * asserted below is small, several deliberately sub-second. The pre-flight asks two
 * sources two questions: WHICH endpoint a call reaches comes from the tool NAME,
 * WHETHER it moves an order from the ANNOTATION, and several tests exist only to keep
 * those from being conflated again. The buckets are MODULE-LEVEL state shared by every
 * server instance in the process, which is why each test starts from an explicit
 * reset. And the limiter reads the wall clock through a projection that never runs
 * backwards and never sets a timer, so refill is driven by moving the fake system
 * clock — `setSystemTime` rather than `advanceTimersByTime`, so the MCP SDK's
 * per-request timeout timers do not fire.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, callOk, type Harness, type Route } from "./harness.js";
import {
  chargeRateLimit,
  rateKeyForTool,
  _resetRateLimitsForTest,
  GLOBAL_PER_SECOND,
  PER_SECOND_LIMITS,
  TOOL_RATE_KEYS,
  UNCHARGED_RATE_KEYS,
  SAFETY_LAYER_RATE_KEYS,
  type RateKey,
} from "../../src/safety/rate-limit.js";
import { TOOL_ANNOTATIONS } from "../../src/mcp-server/index.js";
import { accessClassFor } from "../../src/mcp-server/annotations.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCOUNT = "5WX00001";

/**
 * One representative tool per shape the pre-flight can produce, chosen so neither the
 * verb in the name nor the annotation alone decides the outcome.
 *
 *   - `get_quote` and `get_accounts` are both plain reads on DIFFERENT endpoint
 *     budgets.
 *   - `get_watchlists` is a read with no published ceiling, so only the global cap
 *     bounds it.
 *   - `dry_run_order` is order-shaped and POSTs to the broker, yet its annotation is
 *     READ_ONLY, so it never touches the order cap.
 *   - `create_watchlist` is WRITE_NON_IDEMPOTENT, not destructive — where
 *     `update_watchlist` is destructive-classed and would be bound by the internal
 *     destructive cap long before the global one, measuring the wrong ceiling.
 *   - `cancel_order` is DESTRUCTIVE_IDEMPOTENT.
 */
const QUOTE_TOOL = "tastytrade_get_quote";
const CHAIN_TOOL = "tastytrade_get_option_chain_nested";
const ACCOUNTS_TOOL = "tastytrade_get_accounts";
const UNKEYED_READ_TOOL = "tastytrade_get_watchlists";
const WRITE_TOOL = "tastytrade_create_watchlist";
const DESTRUCTIVE_TOOL = "tastytrade_cancel_order";
const ORDER_SHAPED_READ_TOOL = "tastytrade_dry_run_order";

/**
 * The internal order cap, restated rather than imported — see the note in
 * test/safety/rate-limit.test.ts. It is not part of the published policy and
 * src/safety/rate-limit.ts does not export it.
 */
const ORDER_CAP_PER_SECOND = 20;

const ARGS: Record<string, Record<string, unknown>> = {
  [QUOTE_TOOL]: { symbols: ["SPY"] },
  [CHAIN_TOOL]: { symbol: "SPY" },
  [ACCOUNTS_TOOL]: {},
  [UNKEYED_READ_TOOL]: {},
  [WRITE_TOOL]: { name: "my-list", symbols: ["AAPL"] },
  [DESTRUCTIVE_TOOL]: { account_number: ACCOUNT, order_id: "1001" },
  [ORDER_SHAPED_READ_TOOL]: {
    account_number: ACCOUNT,
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
  },
};

const ROUTES: Route[] = [
  { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
  { matcher: "/option-chains/SPY/nested", reply: { data: { items: [] } } },
  // This route is not only the answer to
  // `tastytrade_get_accounts` — it is also what the dispatcher's account-scope
  // gate reads to decide which accounts this credential may act on, so an empty
  // list here refuses every account-scoped tool in the file.
  {
    matcher: "/customers/me/accounts",
    reply: { data: { items: [{ account: { "account-number": ACCOUNT } }] } },
  },
  // POST first, and specifically: creating a watchlist answers with the created
  // entity, not with a collection, and `find` takes the first matching route.
  {
    matcher: "/watchlists",
    method: "POST",
    reply: { data: { name: "my-list", "watchlist-entries": [] } },
  },
  { matcher: "/watchlists", method: "GET", reply: { data: { items: [] } } },
  { matcher: "/watchlists/my-list", reply: { data: { name: "my-list" } } },
  {
    matcher: /^\/accounts\/[^/]+\/orders\/dry-run$/,
    reply: { data: { warnings: [], errors: [] } },
  },
  {
    matcher: /^\/accounts\/[^/]+\/orders\/1001$/,
    method: "DELETE",
    reply: { data: { id: "1001", status: "Cancelled" } },
  },
];

interface Envelope {
  isError: boolean;
  /** The parsed tool payload — a `ToolError` when `isError` is true. */
  payload: any;
}

/**
 * Calls a tool and returns the envelope without asserting on success, because
 * these tests care about the transition from allowed to refused.
 */
async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown> = ARGS[name] ?? {},
): Promise<Envelope> {
  const res = (await h.client.callTool({ name, arguments: args })) as {
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
  return { isError: res.isError === true, payload };
}

/** Calls a tool `n` times and returns every envelope, oldest first. */
async function callN(h: Harness, name: string, n: number): Promise<Envelope[]> {
  const out: Envelope[] = [];
  for (let i = 0; i < n; i++) out.push(await call(h, name));
  return out;
}

/** Calls a tool `n` times, asserting every call was allowed. */
async function callNOk(h: Harness, name: string, n: number): Promise<void> {
  for (const env of await callN(h, name, n)) expect(env.isError).toBe(false);
}

/** Asserts an envelope is a rate-limit refusal and returns the ToolError. */
function expectRateLimited(env: Envelope): ToolError {
  expect(env.isError).toBe(true);
  const err = env.payload as ToolError;
  expect(err.code).toBe("rate_limit_exceeded");
  expect(err.retryable).toBe(true);
  return err;
}

/**
 * Every string anywhere in a refusal envelope — the whole of what an agent, or
 * a human reading the transcript, actually reads.
 *
 * Numeric fields are deliberately left out. `retry_after_ms` is machine backoff
 * data the envelope contract requires, and folding it into a text search is how
 * a disclosure assertion ends up passing on an arithmetic coincidence instead
 * of on its meaning.
 */
function textIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) textIn(v, out);
  else if (value !== null && typeof value === "object")
    for (const v of Object.values(value)) textIn(v, out);
  return out;
}

/**
 * Moves the fake clock forward without firing timers. The limiter refills off
 * `Date.now()` alone, so this is the whole of "time passing" for it.
 */
function advanceClock(ms: number): void {
  jest.setSystemTime(Date.now() + ms);
}

let h: Harness;
let previousReadOnly: string | undefined;

beforeEach(async () => {
  // Read-only mode is a startup decision that would withhold the write and
  // destructive tools entirely. Cleared explicitly so a leaked environment
  // variable from another suite cannot silently change what is being measured.
  previousReadOnly = process.env.TASTYTRADE_READ_ONLY;
  delete process.env.TASTYTRADE_READ_ONLY;

  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-03-14T15:00:00.000Z"));

  h = await createHarness({ routes: ROUTES });

  // The reset moved BELOW createHarness. The harness
  // resolves the credential's account set at construction now, and that lookup
  // is a broker request carrying a global-bucket debt — so a reset above it
  // meant every budget measured here started one token down. After the clock is
  // fixed either way, which is what makeBucket()'s `lastRefill` stamp needs.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h.close();
  jest.useRealTimers();
  _resetRateLimitsForTest();
  if (previousReadOnly === undefined) delete process.env.TASTYTRADE_READ_ONLY;
  else process.env.TASTYTRADE_READ_ONLY = previousReadOnly;
});

describe("the endpoint budget comes from the tool name, not the annotation", () => {
  it("gives two identically-annotated reads two independent budgets", async () => {
    // The registry is the authority; anchor the premise so this test explains
    // itself if the tables ever change.
    expect(accessClassFor(TOOL_ANNOTATIONS[QUOTE_TOOL])).toBe("read");
    expect(accessClassFor(TOOL_ANNOTATIONS[ACCOUNTS_TOOL])).toBe("read");
    expect(rateKeyForTool(QUOTE_TOOL)).toBe("market_data");
    expect(rateKeyForTool(ACCOUNTS_TOOL)).toBe("accounts");

    await callNOk(h, QUOTE_TOOL, PER_SECOND_LIMITS.market_data);
    const refused = expectRateLimited(await call(h, QUOTE_TOOL));
    expect(refused.message).toContain('"market_data"');

    // Under the old annotation-keyed buckets these three shared one 60/min
    // budget, so a quote poll throttled every other read in the server. They
    // are separate endpoints upstream, and separate budgets here.
    expect((await call(h, ACCOUNTS_TOOL)).isError).toBe(false);
    expect((await call(h, CHAIN_TOOL)).isError).toBe(false);
    expect((await call(h, UNKEYED_READ_TOOL)).isError).toBe(false);
  });

  it("bounds a tool with no published ceiling by the global cap alone", async () => {
    expect(rateKeyForTool(UNKEYED_READ_TOOL)).toBeUndefined();
    expect(rateKeyForTool(WRITE_TOOL)).toBeUndefined();

    // Fifty reads of an unkeyed endpoint is the whole global budget, and far
    // more than any per-endpoint ceiling would have allowed.
    await callNOk(h, UNKEYED_READ_TOOL, GLOBAL_PER_SECOND);
    const refused = expectRateLimited(await call(h, UNKEYED_READ_TOOL));
    expect(refused.message).toContain('"global"');
  });

  it("charges the same budget for a tool that reaches the same endpoint by another route", async () => {
    // get_position has no endpoint of its own: it reads the whole positions
    // list and filters client-side. If it were unkeyed it would be a 50/sec
    // route to a 1/sec endpoint.
    expect(rateKeyForTool("tastytrade_get_positions")).toBe("positions");
    expect(rateKeyForTool("tastytrade_get_position")).toBe("positions");

    h.route({
      matcher: `/accounts/${ACCOUNT}/positions`,
      reply: { data: { items: [] } },
    });
    expect(
      (await call(h, "tastytrade_get_positions", { account_number: ACCOUNT }))
        .isError,
    ).toBe(false);

    const refused = expectRateLimited(
      await call(h, "tastytrade_get_position", {
        account_number: ACCOUNT,
        symbol: "AAPL",
      }),
    );
    expect(refused.message).toContain('"positions"');
  });
});

describe("the order cap comes from the annotation, not the endpoint", () => {
  it("does not charge a dry-run against it, so exhausting it leaves the dry-run callable", async () => {
    expect(accessClassFor(TOOL_ANNOTATIONS[DESTRUCTIVE_TOOL])).toBe(
      "destructive",
    );
    expect(accessClassFor(TOOL_ANNOTATIONS[ORDER_SHAPED_READ_TOOL])).toBe(
      "read",
    );

    await callNOk(h, DESTRUCTIVE_TOOL, ORDER_CAP_PER_SECOND);
    expectRateLimited(await call(h, DESTRUCTIVE_TOOL));

    // Same family of endpoints, same "order" in the name, different annotation.
    expect((await call(h, ORDER_SHAPED_READ_TOOL)).isError).toBe(false);
  });

  it("refuses without naming the cap, or blaming a bucket that is not empty", async () => {
    await callNOk(h, DESTRUCTIVE_TOOL, ORDER_CAP_PER_SECOND);
    const err = expectRateLimited(await call(h, DESTRUCTIVE_TOOL));

    // The cap is an internal safety backstop mirroring the upstream API, and is
    // not part of the published policy: nothing the caller READS may name the
    // bucket or quote its size.
    //
    // Scoped to the envelope's TEXT rather than to `JSON.stringify(err)`, which
    // is what this would search. That form also read `retry_after_ms`, so it
    // held only while the cap's digits happened not to occur in the backoff the
    // cap itself produces: make the cap 10/sec and the wait becomes 100ms, and
    // the check fails on "10" with nothing whatever disclosed. The arithmetic,
    // not the property, was doing the work.
    const prose = textIn(err);
    expect(prose).toContain(err.message);
    expect(prose.join("\n")).not.toContain(String(ORDER_CAP_PER_SECOND));
    for (const text of prose) {
      expect(text).not.toMatch(/destructive/i);
      // No figure at all, which is the strongest available form of "does not
      // quote the cap".
      expect(text).not.toMatch(/\d/);
      // ...and it must not name `global` instead, which would be false: twenty
      // cancels leave the 50/sec global bucket holding thirty tokens.
      expect(text).not.toMatch(/global/i);
    }
    // It is still actionable — that is the whole contract of the envelope.
    expect(err.retry_after_ms).toBe(50); // 20/sec = one token every 50ms
    expect((await call(h, UNKEYED_READ_TOOL)).isError).toBe(false);
  });
});

describe("exhaustion envelope", () => {
  it("returns the exact wait for a one-per-second endpoint", async () => {
    await callNOk(h, ACCOUNTS_TOOL, PER_SECOND_LIMITS.accounts);
    const err = expectRateLimited(await call(h, ACCOUNTS_TOOL));

    expect(err.retry_after_ms).toBe(1_000);
    // No streamer hint: DXLink does not serve the accounts endpoint.
    expect(err.hint).toBeUndefined();
  });

  it("returns a sub-second wait where that is the truth, with the streamer hint", async () => {
    await callNOk(h, QUOTE_TOOL, PER_SECOND_LIMITS.market_data);
    const err = expectRateLimited(await call(h, QUOTE_TOOL));

    // 2/sec regenerates in 500ms. Rounding that up to a second would cost a
    // well-behaved caller half its throughput on every backoff.
    expect(err.retry_after_ms).toBe(500);
    expect(err.hint ?? "").toMatch(/streamer|streaming/i);
  });

  it("returns a 20ms wait when the global cap is what bound", async () => {
    await callNOk(h, WRITE_TOOL, GLOBAL_PER_SECOND);
    const err = expectRateLimited(await call(h, WRITE_TOOL));

    expect(err.message).toContain('"global"');
    expect(err.retry_after_ms).toBe(20); // 50/sec = one token every 20ms
  });
});

describe("refill", () => {
  it("stays refused just before a token regenerates and is allowed exactly on it", async () => {
    await callNOk(h, ACCOUNTS_TOOL, PER_SECOND_LIMITS.accounts);

    advanceClock(999);
    const stillRefused = expectRateLimited(await call(h, ACCOUNTS_TOOL));
    // A millisecond short of a whole token. The bucket holds a fractional
    // count, so the figure can land a millisecond high; exact equality is
    // avoided on purpose. What matters is that it is tiny and that the call
    // really is still refused.
    expect(stillRefused.retry_after_ms).toBeGreaterThan(0);
    expect(stillRefused.retry_after_ms).toBeLessThanOrEqual(2);

    advanceClock(1);
    expect((await call(h, ACCOUNTS_TOOL)).isError).toBe(false);

    // That single regenerated token is all there was.
    expectRateLimited(await call(h, ACCOUNTS_TOOL));
  });

  it("refills continuously rather than in whole-second resets", async () => {
    await callNOk(h, QUOTE_TOOL, PER_SECOND_LIMITS.market_data);
    expectRateLimited(await call(h, QUOTE_TOOL));

    // Half a second at 2/sec buys one quote, not two.
    advanceClock(500);
    expect((await call(h, QUOTE_TOOL)).isError).toBe(false);
    expectRateLimited(await call(h, QUOTE_TOOL));
  });

  it("caps refill at capacity — idling does not bank extra tokens", async () => {
    advanceClock(60 * 60_000);

    await callNOk(h, QUOTE_TOOL, PER_SECOND_LIMITS.market_data);
    expectRateLimited(await call(h, QUOTE_TOOL));
  });
});

describe("the charge happens before dispatch", () => {
  it("charges a call that fails upstream, so a 404 still costs a token", async () => {
    h.route({
      matcher: /^\/accounts\/[^/]+\/orders\/1001$/,
      method: "DELETE",
      reply: { status: 404 },
    });

    for (const env of await callN(h, DESTRUCTIVE_TOOL, ORDER_CAP_PER_SECOND)) {
      expect(env.isError).toBe(true);
      expect((env.payload as ToolError).code).toBe("not_found");
    }
    expect(h.requests).toHaveLength(ORDER_CAP_PER_SECOND);

    // Twenty failures spent the whole order budget: a call that costs nothing
    // when it fails would be a free way to hammer the broker.
    expectRateLimited(await call(h, DESTRUCTIVE_TOOL));
  });

  it("charges a call that never reaches HTTP at all, such as a leg-action validation refusal", async () => {
    const badLegs = {
      ...ARGS[ORDER_SHAPED_READ_TOOL],
      legs: [
        {
          instrument_type: "Equity",
          symbol: "AAPL",
          // Equity requires an open/close action; 'Buy' is futures-only.
          action: "Buy",
          quantity: 1,
        },
      ],
    };

    for (let i = 0; i < GLOBAL_PER_SECOND; i++) {
      const env = await call(h, ORDER_SHAPED_READ_TOOL, badLegs);
      expect(env.isError).toBe(true);
      expect((env.payload as ToolError).code).toBe("validation");
    }
    // The handler rejected all fifty before touching the transport.
    expect(h.requests).toHaveLength(0);

    // The global budget is nonetheless gone.
    expectRateLimited(await call(h, UNKEYED_READ_TOOL));
  });

  it("refuses an unmatched tool name before charging, so a bad name cannot drain a bucket", async () => {
    for (let i = 0; i < 100; i++) {
      const env = await call(h, "tastytrade_not_a_real_tool", {});
      expect(env.isError).toBe(true);
      expect((env.payload as ToolError).code).toBe("not_found");
    }

    // A hundred unknown-tool calls is twice the global capacity; none of them
    // reached the limiter, because the annotation lookup fails first.
    expect((await call(h, UNKEYED_READ_TOOL)).isError).toBe(false);
    expect((await call(h, QUOTE_TOOL)).isError).toBe(false);
    expect((await call(h, DESTRUCTIVE_TOOL)).isError).toBe(false);
  });
});

describe("a refused call does no work", () => {
  it("never reaches the HTTP layer once the bucket is empty", async () => {
    await callNOk(h, ACCOUNTS_TOOL, PER_SECOND_LIMITS.accounts);
    const beforeRefusals = h.requests.length;
    expect(beforeRefusals).toBe(PER_SECOND_LIMITS.accounts);

    for (let i = 0; i < 10; i++) {
      expectRateLimited(await call(h, ACCOUNTS_TOOL));
    }

    // The whole point of a local limiter: the refused calls cost the broker
    // nothing, so `requests` is byte-for-byte unchanged.
    expect(h.requests).toHaveLength(beforeRefusals);
  });

  it("does not consume a token from the bucket it refused, so the refusal is not self-worsening", async () => {
    await callNOk(h, ACCOUNTS_TOOL, PER_SECOND_LIMITS.accounts);

    // Ten refusals spread over a second. A limiter that charged for its own
    // refusals would push `retry_after_ms` up as the caller retried; this one
    // counts down on the wall clock alone.
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) {
      waits.push(
        expectRateLimited(await call(h, ACCOUNTS_TOOL)).retry_after_ms!,
      );
      advanceClock(100);
    }

    expect(waits[0]).toBe(1_000); // a full second at the instant of exhaustion
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]).toBeLessThan(waits[i - 1]!);
    }
    // Nine tenths of a second of refill later, a tenth of a second remains.
    // (Bounded rather than exact: repeated fractional refills leave float dust
    // in the ceil(), and the limiter rounds up, never down.)
    expect(waits[waits.length - 1]).toBeGreaterThanOrEqual(100);
    expect(waits[waits.length - 1]).toBeLessThanOrEqual(102);

    advanceClock(100);
    expect((await call(h, ACCOUNTS_TOOL)).isError).toBe(false);
  });
});

describe("the global cap is a real aggregate, and it recovers in milliseconds", () => {
  /**
   * The per-minute scheme had no aggregate ceiling on purpose: against a 60/min
   * read budget, any binding aggregate would have let read polling starve the
   * budget an agent needs to CANCEL a working order, and a minute is a long
   * time to be starved.
   *
   * A 50/sec global cap exists upstream whether or not this server mirrors it,
   * and it is a far cheaper trade: the global bucket refills at 50 tokens a
   * second, so a saturating burst delays a cancel by 20ms — not by a minute.
   * These two tests pin both halves of that claim, because the second half is
   * the entire reason the first is acceptable.
   */
  it("refuses every tool once fifty calls have been spent in one second", async () => {
    // Spread across four different endpoint budgets, none of which is close to
    // exhausted: what binds is the aggregate.
    await callNOk(h, QUOTE_TOOL, 2);
    await callNOk(h, CHAIN_TOOL, 2);
    await callNOk(h, ACCOUNTS_TOOL, 1);
    await callNOk(h, UNKEYED_READ_TOOL, GLOBAL_PER_SECOND - 5);

    for (const tool of [UNKEYED_READ_TOOL, WRITE_TOOL, DESTRUCTIVE_TOOL]) {
      const err = expectRateLimited(await call(h, tool));
      expect(err.message).toContain('"global"');
    }
  });

  it("hands a cancel back its budget 20ms later", async () => {
    await callNOk(h, UNKEYED_READ_TOOL, GLOBAL_PER_SECOND);
    expectRateLimited(await call(h, DESTRUCTIVE_TOOL));

    advanceClock(20);
    expect((await call(h, DESTRUCTIVE_TOOL)).isError).toBe(false);
  });
});

describe("the limiter is process-wide, not per connection", () => {
  it("shares one budget with a second server instance in the same process", async () => {
    await callNOk(h, ACCOUNTS_TOOL, PER_SECOND_LIMITS.accounts);
    expectRateLimited(await call(h, ACCOUNTS_TOOL));

    // A brand-new server and client, freshly connected — and no fresh budget,
    // because the buckets live in module state, not on the instance.
    const second = await createHarness({ routes: ROUTES });
    try {
      expectRateLimited(await call(second, ACCOUNTS_TOOL));
      expect(second.requests).toHaveLength(0);
      // Its quote budget is intact: only the accounts endpoint was drained.
      expect((await call(second, QUOTE_TOOL)).isError).toBe(false);
    } finally {
      await second.close();
    }
  });

  it("is the same limiter the safety module exposes, so a direct charge is visible to the dispatcher", async () => {
    // Drains the market-data bucket without any tool call at all.
    for (let i = 0; i < PER_SECOND_LIMITS.market_data; i++) {
      chargeRateLimit({ rateKey: "market_data" });
    }

    expectRateLimited(await call(h, QUOTE_TOOL));
    expect(h.requests).toHaveLength(0);
  });
});

describe("the rate tables agree with the registries they key off", () => {
  it("keys only tools this server actually registers", async () => {
    // A tool renamed without its entry silently loses its per-endpoint ceiling
    // and falls back to 50/sec — the quietest possible regression.
    for (const name of Object.keys(TOOL_RATE_KEYS)) {
      expect(Object.keys(TOOL_ANNOTATIONS)).toContain(name);
    }
    // And the tools it keys are all reads: nothing that moves money should be
    // sharing a budget with a market-data poll.
    for (const name of Object.keys(TOOL_RATE_KEYS)) {
      expect(accessClassFor(TOOL_ANNOTATIONS[name])).toBe("read");
    }
  });

  it("leaves no published ceiling unreachable except the ones it names", () => {
    // A bucket nothing charges is dead code that reads like a control. The
    // previous scheme shipped one for months, so the exceptions are declared
    // rather than discovered: every published ceiling is charged by some tool
    // or by the safety layer, or it is listed in UNCHARGED_RATE_KEYS.
    const charged = new Set<RateKey>([
      ...Object.values(TOOL_RATE_KEYS),
      ...SAFETY_LAYER_RATE_KEYS,
    ]);
    for (const key of Object.keys(PER_SECOND_LIMITS) as RateKey[]) {
      if (UNCHARGED_RATE_KEYS.includes(key)) {
        expect([...charged]).not.toContain(key);
        continue;
      }
      expect([...charged]).toContain(key);
    }
    // And there is no exception left to declare. `trading_status` would be
    // listed here on the claim that only the account-summary resource reached
    // it; runSanityChecks reads it before every live submit, so the ceiling was
    // decorative on the one path that moves money. It is charged now.
    expect([...UNCHARGED_RATE_KEYS]).toEqual([]);
    expect([...SAFETY_LAYER_RATE_KEYS]).toEqual(["trading_status"]);
  });
});

// ---------------------------------------------------------------------------
// One tool call, three broker requests.
//
// The pre-flight charges once per `tools/call`. `place_order` makes three requests —
// two GETs from runSanityChecks, then the POST — so on one token it would spend three
// of the broker's: 60 requests/second at the internal order cap, against a global
// budget that claims 50. These pin the same accounting `chargeResourceRead` already
// applies to a template's fan-out, and that the trading-status GET reaches its own
// published 1/sec bucket.
// ---------------------------------------------------------------------------

describe("the order path pays for the requests it actually makes", () => {
  const ORDER_ACCT = ACCOUNT;
  const ORDER_ARGS = {
    account_number: ORDER_ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.00",
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

  const ORDER_ROUTES: Route[] = [
    {
      matcher: /\/accounts\/[^/]+\/orders\/dry-run$/,
      method: "POST",
      reply: {
        data: {
          order: { status: "Received" },
          warnings: [],
          "buying-power-effect": { "change-in-buying-power": "-100.00" },
        },
      },
    },
    {
      matcher: /\/accounts\/[^/]+\/orders$/,
      method: "POST",
      reply: { data: { order: { id: 4242, status: "Received" } } },
    },
    {
      matcher: /\/accounts\/[^/]+\/position-limit$/,
      method: "GET",
      reply: {
        data: {
          "equity-order-size": 1_000,
          "equity-option-order-size": 1_000,
          "future-order-size": 1_000,
          "future-option-order-size": 1_000,
        },
      },
    },
    {
      matcher: /\/accounts\/[^/]+\/trading-status$/,
      method: "GET",
      reply: { data: {} },
    },
  ];

  /** Dry-run then place, asserting both were accepted. */
  async function placeOne(hh: Harness): Promise<void> {
    const dry = (await callOk(hh, "tastytrade_dry_run_order", ORDER_ARGS)) as {
      confirmation_token: string;
    };
    await callOk(hh, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    });
  }

  it("charges the global bucket once per broker request, not once per tool call", async () => {
    await h.close();
    h = await createHarness({ routes: ORDER_ROUTES });
    // A second harness is a second server, so it resolves
    // the credential's account set again and that lookup carries its own
    // global-bucket debt. Reset AFTER construction so what is counted below is
    // this test's four order requests and nothing else.
    _resetRateLimitsForTest();

    await placeOne(h);

    // dry-run POST (1 tool call, 1 request) + place_order (1 tool call, 3
    // requests) = 4 broker requests, and 4 global tokens.
    expect(h.requests).toHaveLength(4);
    let spent = 0;
    for (;;) {
      try {
        chargeRateLimit({});
        spent += 1;
      } catch {
        break;
      }
    }
    expect(spent).toBe(GLOBAL_PER_SECOND - 4);
  });

  it("bills the trading-status GET to its own published 1/sec bucket", async () => {
    await h.close();
    h = await createHarness({ routes: ORDER_ROUTES });

    // Nothing has touched trading_status yet, so it holds its one token.
    await placeOne(h);
    expect(h.requests.some((r) => /\/trading-status$/.test(r.url))).toBe(true);

    // And now it is empty — which it could never be before, because the
    // limiter did not know this endpoint was being reached at all.
    let refused: ToolError | undefined;
    try {
      chargeRateLimit({ rateKey: "trading_status" });
    } catch (e) {
      refused = (e as { toolError: ToolError }).toolError;
    }
    expect(refused?.code).toBe("rate_limit_exceeded");
    expect(refused?.retry_after_ms).toBe(1_000);
  });

  it("does not let the fan-out debt refuse an order already in flight", async () => {
    await h.close();
    h = await createHarness({ routes: ORDER_ROUTES });

    // Spend the trading_status bucket before the order runs. The submit must
    // still complete: the debt is forgiven, never turned into a refusal after
    // the confirmation token has been consumed.
    chargeRateLimit({ rateKey: "trading_status" });
    await placeOne(h);

    expect(
      h.requests.filter((r) => r.method === "POST" && /\/orders$/.test(r.url)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The fan-out that was not billed.
//
// The pre-flight charges once per `tools/call`, which is the truth only for a
// tool that makes one broker request. The two watchlist symbol tools make two:
// the API has no POST /watchlists/{name}/entries, so the client does
// GET-modify-PUT. Measured before the debt was charged: 104 broker requests for
// 52 admitted calls, 0.5 tokens per broker request against the 1.0 the
// limiter's own header states.
// ---------------------------------------------------------------------------

/** A watchlist the fan-out tools can read and put back. */
const FANOUT_WATCHLIST = {
  name: "Movers",
  "watchlist-entries": [{ symbol: "SPY", "instrument-type": "Equity" }],
};

/** Global tokens still available, counted by draining the bucket. */
function globalTokensLeft(): number {
  let spent = 0;
  for (;;) {
    try {
      chargeRateLimit({});
      spent += 1;
    } catch {
      return spent;
    }
  }
}

const FANOUT_TOOLS: Array<[string, Record<string, unknown>]> = [
  [
    "tastytrade_add_watchlist_symbol",
    { name: "Movers", symbol: "AAPL", instrument_type: "Equity" },
  ],
  [
    "tastytrade_remove_watchlist_symbol",
    { name: "Movers", symbol: "SPY", instrument_type: "Equity" },
  ],
];

describe("the watchlist fan-out pays for the requests it actually makes", () => {
  beforeEach(() => {
    h.route({
      matcher: "/watchlists/Movers",
      reply: { data: FANOUT_WATCHLIST },
    });
  });

  it.each(FANOUT_TOOLS)(
    "charges one global token per broker request for %s",
    async (tool, args) => {
      await callOk(h, tool, args);
      // GET the list, PUT it back: two broker requests for one tools/call.
      expect(h.requests).toHaveLength(2);
      expect(globalTokensLeft()).toBe(GLOBAL_PER_SECOND - 2);
    },
  );

  it("does not double-bill the single-request read the fan-out borrows", async () => {
    // The debt belongs to the fan-out method, not to getWatchlist: a plain
    // tastytrade_get_watchlist already paid admission and must cost exactly one.
    await callOk(h, "tastytrade_get_watchlist", { name: "Movers" });
    expect(h.requests).toHaveLength(1);
    expect(globalTokensLeft()).toBe(GLOBAL_PER_SECOND - 1);
  });

  it("holds the whole fleet of fan-out calls inside the stated global budget", async () => {
    // The property the limiter's own header claims: "the budget means the same
    // number of BROKER calls however it is spent". Measured with the clock
    // frozen, so no refill can hide the overspend.
    for (;;) {
      const res = (await h.client.callTool({
        name: "tastytrade_add_watchlist_symbol",
        arguments: {
          name: "Movers",
          symbol: "AAPL",
          instrument_type: "Equity",
        },
      })) as { isError?: boolean };
      if (res.isError) break;
    }
    expect(h.requests.length).toBeLessThanOrEqual(GLOBAL_PER_SECOND);
  });

  it("does not let the debt refuse a modification already computed", async () => {
    // One token left: admission takes it, the debt finds the bucket empty and
    // is forgiven, and the PUT still goes out. A refusal between the GET and
    // the PUT would abandon a modification already computed.
    for (let i = 0; i < GLOBAL_PER_SECOND - 1; i++) chargeRateLimit({});
    await callOk(h, "tastytrade_add_watchlist_symbol", {
      name: "Movers",
      symbol: "AAPL",
      instrument_type: "Equity",
    });
    expect(h.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    // And the refusal arrives on the NEXT admission instead.
    const res = (await h.client.callTool({
      name: "tastytrade_get_watchlists",
      arguments: {},
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});

// The durable half: a third fan-out added later cannot go unbilled, because the
// method list and each method's request count are DERIVED from the source at
// test time rather than enumerated here. A literal count is how a stale
// denominator passes a green test.
describe("every fan-out in the API client bills its extra broker requests", () => {
  const SOURCE = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/api-client.ts",
    ),
    "utf8",
  );

  /** Each `TastytradeClient` method, mapped to the text of its body. */
  function methodBodies(): Map<string, string> {
    const lines = SOURCE.split("\n");
    const decl =
      /^ {2}(?:private |protected |public )?(?:async )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
    const starts: Array<[string, number]> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = decl.exec(lines[i]);
      if (m && m[1] !== "constructor" && m[1] !== "if" && m[1] !== "for") {
        starts.push([m[1], i]);
      }
    }
    const out = new Map<string, string>();
    for (let k = 0; k < starts.length; k++) {
      const [name, from] = starts[k];
      const to = k + 1 < starts.length ? starts[k + 1][1] : lines.length;
      out.set(name, lines.slice(from, to).join("\n"));
    }
    return out;
  }

  const bodies = methodBodies();

  /** Direct upstream requests a body makes itself. */
  function directRequests(body: string): number {
    return (body.match(/this\.client\.(?:get|post|put|patch|delete)\(/g) ?? [])
      .length;
  }

  /** Debt charges a body makes itself. */
  function directDebts(body: string): number {
    return (body.match(/chargeUpstreamCallDebt\(/g) ?? []).length;
  }

  /** Sibling methods this body delegates to. */
  function delegates(body: string): string[] {
    const out: string[] = [];
    const re = /await this\.([A-Za-z_][A-Za-z0-9_]*)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (bodies.has(m[1])) out.push(m[1]);
    }
    return out;
  }

  /** Requests and debts a method accounts for, following its delegates. */
  function totals(
    name: string,
    seen: Set<string> = new Set(),
  ): { requests: number; debts: number } {
    if (seen.has(name)) return { requests: 0, debts: 0 };
    seen.add(name);
    const body = bodies.get(name) ?? "";
    let requests = directRequests(body);
    let debts = directDebts(body);
    for (const d of delegates(body)) {
      const sub = totals(d, seen);
      requests += sub.requests;
      debts += sub.debts;
    }
    return { requests, debts };
  }

  it("finds the client's request-making methods, so the invariant is not vacuous", () => {
    const requesting = [...bodies.keys()].filter((n) => totals(n).requests > 0);
    expect(requesting.length).toBeGreaterThan(50);
    expect(requesting).toContain("addSymbolToWatchlist");
    expect(requesting).toContain("removeSymbolFromWatchlist");
  });

  it("leaves at most ONE unbilled request per method — the one admission pays for", () => {
    // Whatever method a tool enters by, the pre-flight charges once and every
    // further broker request must carry its own debt. `getPosition` and
    // `getRiskFreeRate` delegate to a sibling and make ONE request between
    // them, so they are correctly silent; the two watchlist methods make two.
    const overspending: string[] = [];
    for (const name of bodies.keys()) {
      const { requests, debts } = totals(name);
      if (requests - debts > 1) {
        overspending.push(`${name}: ${requests} requests, ${debts} debt(s)`);
      }
    }
    expect(overspending).toEqual([]);
  });
});
