import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  chargeRateLimit,
  chargeUpstreamCallDebt,
  rateKeyForTool,
  _resetRateLimitsForTest,
  GLOBAL_PER_SECOND,
  PER_SECOND_LIMITS,
  TOOL_RATE_KEYS,
  UNCHARGED_RATE_KEYS,
  SAFETY_LAYER_RATE_KEYS,
  type RateKey,
} from "../../src/safety/rate-limit.js";
import { isToolErrorException } from "../../src/safety/errors.js";

/**
 * The internal order cap, restated here rather than imported.
 *
 * src/safety/rate-limit.ts deliberately does not export it: it is a safety
 * backstop mirroring the upstream API and is not part of the published policy.
 * Pinning the number from outside is the point — if someone loosens the
 * backstop, this fails, and it fails without giving the constant a public name
 * that documentation tooling could pick up.
 */
const DESTRUCTIVE_PER_SECOND = 20;

function chargeN(n: number, opts: Parameters<typeof chargeRateLimit>[0]): void {
  for (let i = 0; i < n; i++) chargeRateLimit(opts);
}

function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw, but nothing was thrown");
}

/** The ToolError behind a refusal, with the branding checked. */
function refusalOf(fn: () => unknown) {
  const e = captureThrow(fn);
  if (!isToolErrorException(e)) throw new Error("expected ToolErrorException");
  expect(e.toolError.code).toBe("rate_limit_exceeded");
  expect(e.toolError.retryable).toBe(true);
  return e.toolError;
}

/**
 * Spends the global bucket dry with unkeyed charges and returns how many it
 * still held. Destructive: call it once, at the end of a test.
 */
function drainGlobal(): number {
  let left = 0;
  for (;;) {
    try {
      chargeRateLimit({});
      left += 1;
    } catch {
      return left;
    }
  }
}

const ALL_KEYS = Object.keys(PER_SECOND_LIMITS) as RateKey[];

/** The instant every test starts from, so a clock step can be expressed against it. */
const START = new Date("2026-03-14T15:00:00.000Z").getTime();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(START));
  // After the clock is fixed: makeBucket() stamps lastRefill with Date.now().
  _resetRateLimitsForTest();
});

afterEach(() => {
  jest.useRealTimers();
  _resetRateLimitsForTest();
});

describe("the published rate policy", () => {
  it("is the global per-second cap plus the per-endpoint ceilings", () => {
    expect(GLOBAL_PER_SECOND).toBe(50);
    expect(PER_SECOND_LIMITS).toEqual({
      market_data: 2,
      option_chains: 2,
      single_equity: 3,
      equities_list: 2,
      futures: 1,
      future_products: 1,
      single_equity_option: 3,
      single_future_option: 3,
      positions: 1,
      balances: 1,
      trading_status: 1,
      accounts: 1,
    });
  });

  it("keeps every per-endpoint ceiling under the global cap, so none is dead", () => {
    // A per-endpoint bucket wider than the global one could never refuse: the
    // global cap would always bind first. The previous scheme shipped exactly
    // that mistake — a 300/min "global" bucket above budgets summing to 85/min,
    // which never refused a single call in its life.
    for (const key of ALL_KEYS) {
      expect(PER_SECOND_LIMITS[key]).toBeLessThan(GLOBAL_PER_SECOND);
      expect(PER_SECOND_LIMITS[key]).toBeGreaterThan(0);
    }
  });

  it("keeps every per-endpoint budget reachable and binding", () => {
    // Charging a bucket to exactly its capacity must succeed, and one more must
    // fail — the definition of a limit that actually binds.
    for (const key of ALL_KEYS) {
      _resetRateLimitsForTest();
      chargeN(PER_SECOND_LIMITS[key], { rateKey: key });
      const err = refusalOf(() => chargeRateLimit({ rateKey: key }));
      expect(err.message).toContain(`"${key}"`);
    }
  });

  it("charges the global bucket for a call with no per-endpoint ceiling", () => {
    chargeN(GLOBAL_PER_SECOND, {});
    const err = refusalOf(() => chargeRateLimit({}));
    expect(err.message).toContain('"global"');
    expect(err.retry_after_ms).toBe(20); // 50/sec = one token every 20ms
  });
});

describe("rateKeyForTool", () => {
  it("maps hot read tools onto the endpoint they GET", () => {
    expect(rateKeyForTool("tastytrade_get_quote")).toBe("market_data");
    expect(rateKeyForTool("tastytrade_get_option_chain_nested")).toBe(
      "option_chains",
    );
    expect(rateKeyForTool("tastytrade_get_instrument")).toBe("single_equity");
    expect(rateKeyForTool("tastytrade_get_instruments")).toBe("equities_list");
    expect(rateKeyForTool("tastytrade_get_positions")).toBe("positions");
    // get_position has no endpoint of its own — it reads the whole positions
    // list and filters client-side, so it must not be a cheaper route to the
    // same GET.
    expect(rateKeyForTool("tastytrade_get_position")).toBe("positions");
  });

  it("leaves a tool unkeyed when its path has no published ceiling", () => {
    // Neighbouring but distinct endpoints. Inventing a ceiling for these is
    // exactly what the per-minute scheme did wrong.
    expect(rateKeyForTool("tastytrade_get_account")).toBeUndefined();
    expect(
      rateKeyForTool("tastytrade_get_balance_by_currency"),
    ).toBeUndefined();
    expect(rateKeyForTool("tastytrade_get_future")).toBeUndefined();
    expect(rateKeyForTool("tastytrade_place_order")).toBeUndefined();
  });

  it("answers undefined for an Object.prototype member, not a function", () => {
    // The name arrives over the wire. A bare `TABLE[name]` would hand
    // chargeRateLimit `Object.prototype.toString` where it expects a RateKey.
    for (const name of ["toString", "constructor", "__proto__", "valueOf"]) {
      expect(rateKeyForTool(name)).toBeUndefined();
    }
  });

  it("maps only real rate keys, from a table with no dead entries", () => {
    for (const [tool, key] of Object.entries(TOOL_RATE_KEYS)) {
      expect(ALL_KEYS).toContain(key);
      expect(rateKeyForTool(tool)).toBe(key);
    }
  });
});

describe("chargeRateLimit", () => {
  it("refuses with rate_limit_exceeded and a truthful sub-second retry_after_ms", () => {
    // 2/sec regenerates a token every 500ms, and saying "1 second" would be a
    // lie that costs the caller half a second of throughput on every backoff.
    chargeN(PER_SECOND_LIMITS.market_data, { rateKey: "market_data" });
    const err = refusalOf(() => chargeRateLimit({ rateKey: "market_data" }));
    expect(err.retry_after_ms).toBe(500);

    _resetRateLimitsForTest();
    chargeN(PER_SECOND_LIMITS.single_equity, { rateKey: "single_equity" });
    // 3/sec is 333.33ms; rounded UP to the next whole ms, never up to a second.
    expect(
      refusalOf(() => chargeRateLimit({ rateKey: "single_equity" }))
        .retry_after_ms,
    ).toBe(334);
  });

  it("points a market-data poller at the streamer, and nobody else", () => {
    chargeN(PER_SECOND_LIMITS.market_data, { rateKey: "market_data" });
    expect(
      refusalOf(() => chargeRateLimit({ rateKey: "market_data" })).hint ?? "",
    ).toMatch(/stream/i);

    _resetRateLimitsForTest();
    chargeN(PER_SECOND_LIMITS.positions, { rateKey: "positions" });
    // Switching to DXLink does not help someone reading positions too fast.
    expect(
      refusalOf(() => chargeRateLimit({ rateKey: "positions" })).hint,
    ).toBeUndefined();
  });

  it("keeps per-endpoint buckets independent of one another", () => {
    chargeN(PER_SECOND_LIMITS.market_data, { rateKey: "market_data" });
    expect(() => chargeRateLimit({ rateKey: "market_data" })).toThrow();
    // An unrelated endpoint is untouched: quoting too fast must not stop an
    // agent reading its own positions.
    expect(() => chargeRateLimit({ rateKey: "positions" })).not.toThrow();
    expect(() => chargeRateLimit({ rateKey: "balances" })).not.toThrow();
  });

  it("charges the global bucket on top of the per-endpoint one", () => {
    chargeRateLimit({ rateKey: "positions" });
    // One keyed call spends one global token too — the global cap is the
    // aggregate across everything, not a separate lane.
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND - 1);
  });

  it("consumes nothing from any bucket when one of them refuses", () => {
    chargeRateLimit({ rateKey: "positions" }); // positions is 1/sec: now empty
    for (let i = 0; i < 100; i++) {
      expect(() => chargeRateLimit({ rateKey: "positions" })).toThrow();
    }
    // A hundred refusals must not have quietly spent a hundred global tokens.
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND - 1);
  });

  it("reports the longest wait when more than one bucket is exhausted", () => {
    chargeRateLimit({ rateKey: "positions" });
    chargeN(GLOBAL_PER_SECOND - 1, {});
    const err = refusalOf(() => chargeRateLimit({ rateKey: "positions" }));
    // global is 20ms away, positions a full second: quoting the shorter one
    // would just hand the caller a guaranteed second refusal.
    expect(err.retry_after_ms).toBe(1_000);
  });

  it("names the bucket whose wait it is reporting, not the first one it charged", () => {
    // `global` is always charged first, so naming the first exhausted bucket
    // always blamed it — a 20ms bucket — while `retry_after_ms` quoted the full
    // second owed by the endpoint that was actually binding. Two true facts
    // assembled into a wrong diagnosis, in the incident you would be reading it
    // during.
    chargeRateLimit({ rateKey: "positions" }); // positions is 1/sec: now empty
    chargeN(GLOBAL_PER_SECOND - 1, {}); // and now global is too
    const err = refusalOf(() => chargeRateLimit({ rateKey: "positions" }));
    expect(err.retry_after_ms).toBe(1_000);
    expect(err.message).toContain('"positions"');
    expect(err.message).not.toContain('"global"');
  });

  it("still names global when global is the bucket that owns the wait", () => {
    // The other direction: naming the slow bucket must not become a habit of
    // never naming the fast one. Drain global only, on a call with a key whose
    // own bucket is untouched.
    chargeN(GLOBAL_PER_SECOND, {});
    const err = refusalOf(() => chargeRateLimit({ rateKey: "positions" }));
    expect(err.retry_after_ms).toBe(20);
    expect(err.message).toContain('"global"');
  });

  it("refills continuously rather than in whole-window resets", () => {
    chargeN(PER_SECOND_LIMITS.option_chains, { rateKey: "option_chains" });
    expect(() => chargeRateLimit({ rateKey: "option_chains" })).toThrow();

    // 2/sec buys one token per 500ms, not two per second in a lump.
    jest.advanceTimersByTime(500);
    expect(() => chargeRateLimit({ rateKey: "option_chains" })).not.toThrow();
    expect(() => chargeRateLimit({ rateKey: "option_chains" })).toThrow();

    jest.advanceTimersByTime(499);
    expect(() => chargeRateLimit({ rateKey: "option_chains" })).toThrow();
    jest.advanceTimersByTime(1);
    expect(() => chargeRateLimit({ rateKey: "option_chains" })).not.toThrow();
  });

  it("caps refill at capacity — idling does not bank extra tokens", () => {
    jest.advanceTimersByTime(60 * 60_000);
    chargeN(PER_SECOND_LIMITS.futures, { rateKey: "futures" });
    expect(() => chargeRateLimit({ rateKey: "futures" })).toThrow();
  });

  it("does not consume a token when it refuses, so the refusal is not self-worsening", () => {
    chargeN(PER_SECOND_LIMITS.balances, { rateKey: "balances" });

    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      waits.push(
        refusalOf(() => chargeRateLimit({ rateKey: "balances" }))
          .retry_after_ms!,
      );
      jest.advanceTimersByTime(100);
    }
    // Counting down on the wall clock alone: 1000, 900, 800, 700, 600.
    expect(waits).toEqual([1_000, 900, 800, 700, 600]);
  });
});

describe("the internal order cap", () => {
  it("admits a burst of order calls, then refuses", () => {
    chargeN(DESTRUCTIVE_PER_SECOND, { destructive: true });
    const err = refusalOf(() => chargeRateLimit({ destructive: true }));
    expect(err.retry_after_ms).toBe(50); // 20/sec = one token every 50ms
  });

  it("never names itself, and never blames a bucket that is not empty", () => {
    chargeN(DESTRUCTIVE_PER_SECOND, { destructive: true });
    const err = refusalOf(() => chargeRateLimit({ destructive: true }));

    // The cap is a safety backstop, not part of the published policy, so the
    // refusal must not name it...
    expect(err.message).not.toMatch(/destructive/i);
    expect(err.message).not.toMatch(/\d/);
    // ...and must not name `global` either. Twenty order calls leave the 50/sec
    // global bucket holding thirty tokens; blaming it would be a plain
    // falsehood that sends the caller to back off the wrong thing.
    expect(err.message).not.toMatch(/global/i);
    expect(err.message).toMatch(/rate limit/i);
    expect(err.hint).toBeUndefined();
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND - DESTRUCTIVE_PER_SECOND);
  });

  it("still names the global bucket when that is what actually bound", () => {
    // When the published global cap is the empty one there is a true answer to
    // give, and the refusal gives it.
    chargeN(GLOBAL_PER_SECOND, {});
    const err = refusalOf(() => chargeRateLimit({ destructive: true }));
    expect(err.message).toContain('"global"');
  });

  it("does not charge order calls for a read, or reads for an order", () => {
    chargeN(DESTRUCTIVE_PER_SECOND, { destructive: true });
    expect(() => chargeRateLimit({ destructive: true })).toThrow();
    // A drained order budget leaves every read endpoint open...
    expect(() => chargeRateLimit({ rateKey: "positions" })).not.toThrow();

    _resetRateLimitsForTest();
    // ...and reads never touch the order budget. This is the direction that
    // matters most: read chatter must never consume the budget an agent needs
    // in order to CANCEL a working order. Drain every published read ceiling —
    // 22 calls, well short of the 50/sec global cap — and the order path is
    // still open for its full burst, refusing only on the call after it.
    for (const key of ALL_KEYS)
      chargeN(PER_SECOND_LIMITS[key], { rateKey: key });
    chargeN(DESTRUCTIVE_PER_SECOND, { destructive: true });
    expect(() => chargeRateLimit({ destructive: true })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A wall clock that does not run forwards.
//
// A `refill` that bails out on non-positive elapsed time WITHOUT re-anchoring
// `lastRefill` leaves every bucket's anchor stranded in the future after one
// backward step, stopping ALL of them regenerating for the whole duration — while
// each refusal reports the healthy 20ms wait, sending a well-behaved agent into a
// permanently futile retry loop. `cancel_order`, the one call that reduces risk, is
// refused with everything else. Triggers are mundane: an NTP correction, a host
// clock sync, a snapshot restore.
//
// `setSystemTime` moves the clock here, forwards AND backwards;
// `advanceTimersByTime` cannot go backwards at all.
// ---------------------------------------------------------------------------

describe("a system clock that steps backwards", () => {
  it("keeps refilling instead of wedging for the length of the step", () => {
    chargeN(GLOBAL_PER_SECOND, {});
    expect(() => chargeRateLimit({})).toThrow();

    // A minute, backwards, in one step.
    jest.setSystemTime(new Date(START - 60_000));
    // The call that observes the step re-anchors the clock. It is still
    // refused, correctly: no time has actually passed and the bucket is empty.
    expect(() => chargeRateLimit({})).toThrow();

    // From here time runs forwards again. One second later the global bucket
    // is full. Without the monotonic projection this call — and every call for
    // the next sixty seconds — is refused, with retry_after_ms still claiming 20.
    jest.setSystemTime(new Date(START - 59_000));
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND);
  });

  it("does not lock out the risk-reducing order path for an hour", () => {
    // The order cap is what a cancel draws on. An hour-long backward step used
    // to hold it — and every other bucket — empty for the whole hour.
    chargeN(DESTRUCTIVE_PER_SECOND, { destructive: true });
    expect(() => chargeRateLimit({ destructive: true })).toThrow();

    jest.setSystemTime(new Date(START - 60 * 60_000));
    expect(() => chargeRateLimit({ destructive: true })).toThrow(); // re-anchors
    jest.setSystemTime(new Date(START - 60 * 60_000 + 50)); // 20/sec = 50ms/token
    expect(() => chargeRateLimit({ destructive: true })).not.toThrow();
  });

  it("never hands out tokens for time that ran backwards", () => {
    // The clamp must not become a refill. A backward step is zero elapsed
    // time, not negative and not positive.
    chargeN(PER_SECOND_LIMITS.positions, { rateKey: "positions" });
    jest.setSystemTime(new Date(START - 10 * 60_000));
    expect(() => chargeRateLimit({ rateKey: "positions" })).toThrow();
    expect(() => chargeRateLimit({ rateKey: "positions" })).toThrow();
  });

  it("survives a step backwards taken while the buckets are still full", () => {
    // Nothing spent yet: the step must be a no-op, not a bucket that now
    // refuses because its anchor moved.
    jest.setSystemTime(new Date(START - 5_000));
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND);
  });
});

// ---------------------------------------------------------------------------
// Fan-out accounting.
//
// The tool pre-flight charges once per `tools/call`, which is only the truth
// when a tool makes one broker request. `tastytrade_place_order` makes three —
// the two account reads `runSanityChecks` does, then the POST — so on one token
// it spent three of the broker's, and it reached a published 1/sec ceiling
// (trading_status) that the limiter's own notes claimed no tool touched.
// ---------------------------------------------------------------------------

describe("chargeUpstreamCallDebt", () => {
  it("spends a global token, so the budget counts broker calls not tool calls", () => {
    chargeUpstreamCallDebt();
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND - 1);
  });

  it("spends the per-endpoint bucket it names", () => {
    // trading_status is 1/sec and has no tool of its own; this is the only
    // thing that charges it, and after one debt it must be empty.
    chargeUpstreamCallDebt({ rateKey: "trading_status" });
    const err = refusalOf(() => chargeRateLimit({ rateKey: "trading_status" }));
    expect(err.retry_after_ms).toBe(1_000);
  });

  it("never refuses, because the call it pays for is already committed", () => {
    // Refusing here would abort a sanity check mid-submit, after the
    // confirmation token had been consumed — a budget overrun turned into a
    // lost order.
    chargeN(GLOBAL_PER_SECOND, {});
    expect(() => chargeUpstreamCallDebt()).not.toThrow();
    expect(() =>
      chargeUpstreamCallDebt({ rateKey: "trading_status" }),
    ).not.toThrow();
  });

  it("keeps counting against the global cap once the endpoint bucket is empty", () => {
    // The whole point of the debt is that the global cap counts BROKER calls.
    // trading_status is 1/sec, so a burst of orders empties it on the first
    // one — and if that made the rest of the debt vanish, the global cap would
    // go on under-counting exactly the burst it exists to bound. Ten debts
    // against a bucket that can only pay for one must still cost ten globals.
    for (let i = 0; i < 10; i++) {
      chargeUpstreamCallDebt({ rateKey: "trading_status" });
    }
    expect(drainGlobal()).toBe(GLOBAL_PER_SECOND - 10);
  });

  it("does not drive a bucket below empty, so the wait stays truthful", () => {
    // Flooring at zero, not going negative: `retry_after_ms` is computed from
    // the token count, and a bucket 19 tokens in arrears would quote a wait
    // nobody actually has to serve.
    for (let i = 0; i < 20; i++) {
      chargeUpstreamCallDebt({ rateKey: "trading_status" });
    }
    const err = refusalOf(() => chargeRateLimit({ rateKey: "trading_status" }));
    expect(err.retry_after_ms).toBe(1_000);
  });

  it("bounds a burst of orders to roughly the global cap of broker requests", () => {
    // The measured regression: 20 orders/second, three broker requests each,
    // would put 60 requests on the wire while spending 20 global tokens
    // against a cap of 50. Now the cap binds on the requests themselves. The
    // small overrun is by design — the admitting charge is one token, and the
    // two debts that follow it may cross the line without refusing.
    let orders = 0;
    let requests = 0;
    for (let i = 0; i < 100; i++) {
      try {
        chargeRateLimit({ destructive: true }); // POST /orders
      } catch {
        break;
      }
      orders += 1;
      requests += 1;
      chargeUpstreamCallDebt(); // GET /position-limit
      requests += 1;
      chargeUpstreamCallDebt({ rateKey: "trading_status" }); // GET /trading-status
      requests += 1;
    }
    expect(orders).toBeLessThan(DESTRUCTIVE_PER_SECOND);
    expect(requests).toBeLessThanOrEqual(GLOBAL_PER_SECOND + 2);
  });
});

describe("the ledger of which ceilings are charged", () => {
  it("declares no published ceiling uncharged", () => {
    // A bucket nothing charges is dead code that reads like a live control.
    // `trading_status` would sit here on a false claim about its own call
    // graph — that only the account-summary resource reached it, when
    // runSanityChecks reads it before every live submit.
    expect([...UNCHARGED_RATE_KEYS]).toEqual([]);
  });

  it("declares trading_status as charged by the safety layer, not by a tool", () => {
    expect([...SAFETY_LAYER_RATE_KEYS]).toEqual(["trading_status"]);
    expect(Object.values(TOOL_RATE_KEYS)).not.toContain("trading_status");
  });
});
