/**
 * In-memory token-bucket rate limiter. Single-process state, which is correct for
 * one process per stdio session.
 *
 * Every charged call draws on the `global` bucket (50 req/sec across all tool
 * calls and API-backed resource reads), the per-endpoint bucket for the endpoint
 * it reaches when that endpoint has a published ceiling, and an internal cap on
 * order-moving calls. A call is admitted only if EVERY bucket it draws on can
 * pay, and a refused call consumes nothing from any of them.
 *
 * A tool that fans out to more than one broker request pays for the rest through
 * `chargeUpstreamCallDebt`, which never refuses — so the budget means the same
 * number of BROKER calls however it is spent, and no mid-flight refusal can
 * abandon an order already in progress.
 *
 * The numbers are tastytrade's published limits, keyed off the endpoint a call
 * reaches rather than its MCP annotation: locally-invented per-minute figures
 * keyed off the annotation correspond to nothing upstream. The aggregate is less
 * sharp than a per-minute bucket — the global bucket refills at 50/sec, so the
 * worst a saturating burst does to a risk-reducing call is delay it by 20ms —
 * and the per-endpoint buckets stay independent of one another.
 *
 * On exhaustion, callers get `rate_limit_exceeded` with `retry_after_ms` set to
 * the time until at least one token regenerates, reported sub-second rather than
 * rounded up to a misleading whole second.
 */

import { toolError } from "./errors.js";

/**
 * Per-endpoint rate-limit keys. Each maps to a per-second ceiling in
 * PER_SECOND_LIMITS, and `rateKeyForTool` maps a tool name to one of them. A
 * call with no key — including every `resources/read`, which is not a tool and
 * can fan out across several endpoints at once — is bounded by the global cap
 * alone.
 */
export type RateKey =
  | "market_data"
  | "option_chains"
  | "single_equity"
  | "equities_list"
  | "futures"
  | "future_products"
  | "single_equity_option"
  | "single_future_option"
  | "positions"
  | "balances"
  | "trading_status"
  | "accounts";

/** Global cap across every charged call, in requests/second. Documented. */
export const GLOBAL_PER_SECOND = 50;

/**
 * Internal destructive/order cap, in requests/second. Mirrors the upstream
 * tastytrade API limit. Safety backstop only — DO NOT advertise it in the
 * docs, do not export it, and do not let a refusal name it: `chargeRateLimit`
 * names an exhausted bucket in its message only when that bucket is one of the
 * published ones.
 */
const DESTRUCTIVE_PER_SECOND = 20;

/** Published per-endpoint ceilings, in requests/second. */
export const PER_SECOND_LIMITS: Record<RateKey, number> = {
  market_data: 2, // GET /market-data/by-type
  option_chains: 2, // GET /option-chains/*, GET /futures-option-chains/*
  single_equity: 3, // GET /instruments/equities/{symbol}
  equities_list: 2, // GET /instruments/equities, GET /instruments/equities/active
  futures: 1, // GET /instruments/futures
  future_products: 1, // GET /instruments/future-products, /future-option-products
  single_equity_option: 3, // GET /instruments/equity-options/{symbol}
  single_future_option: 3, // GET /instruments/future-options/{symbol}
  positions: 1, // GET /accounts/{account_number}/positions
  balances: 1, // GET /accounts/{account_number}/balances
  trading_status: 1, // GET /accounts/{account_number}/trading-status — see below
  accounts: 1, // GET /customers/me/accounts
};

/**
 * Published ceilings that nothing charges. Empty, and it has to stay empty: a
 * bucket nothing charges is dead code that reads like a live control.
 *
 * `trading_status` is NOT exempt. `runSanityChecks` reads GET
 * /accounts/{n}/trading-status before EVERY live order submit, so its published
 * 1/sec ceiling is reached on the one path that moves money. It is charged where
 * that read is made, through `chargeUpstreamCallDebt`.
 *
 * That this list is exhaustive is asserted in test/e2e/rate-limits.test.ts, not
 * the unit suite: the check has to cross-check PER_SECOND_LIMITS against the tool
 * registry and the safety layer.
 */
export const UNCHARGED_RATE_KEYS: readonly RateKey[] = [];

/**
 * Per-endpoint ceilings charged from inside the safety layer rather than by a
 * tool of their own. Exported so the e2e suite can account for every published
 * ceiling: a key here is reachable, just not through `TOOL_RATE_KEYS`.
 *
 * KEEP IT IN STEP WITH THE `chargeUpstreamCallDebt` CALL SITES, which live in
 * three files:
 *
 *   - src/safety/sanity-checks.ts — the position-limit GET (unkeyed) and the
 *     trading-status GET (`trading_status`) before every live submit.
 *   - src/mcp-server/index.ts — every `resources/read` request beyond the first.
 *   - src/api-client.ts — the two watchlist symbol methods, whose GET-modify-PUT
 *     is two broker requests for one `tools/call`. Both UNKEYED: /watchlists has
 *     no published ceiling.
 *
 * That every multi-request client method carries a debt per request past the
 * first is asserted in test/e2e/rate-limits.test.ts from a DERIVED list, not an
 * enumerated one.
 */
export const SAFETY_LAYER_RATE_KEYS: readonly RateKey[] = ["trading_status"];

/**
 * Maps a tool name to the per-endpoint ceiling its upstream GET falls under.
 *
 * Key a tool when the path it requests is one of the paths listed against
 * PER_SECOND_LIMITS. A tool reaching a neighbouring but distinct path is
 * deliberately unkeyed and bounded by the global cap — there is no published
 * ceiling for it, and inventing one is the error this scheme exists to avoid.
 *
 * `trading_status` has no tool: it is charged from inside the safety layer on
 * every live submit. Exported so the suite can pin it against the tool registry,
 * since a tool renamed without its entry falls back to the global cap silently.
 * Read it through `rateKeyForTool` — a bare index is not a membership test.
 */
export const TOOL_RATE_KEYS: Record<string, RateKey> = {
  // Market data — GET /market-data/by-type
  tastytrade_get_quote: "market_data",
  tastytrade_get_quote_snapshot: "market_data",

  // Option chains & futures option chains
  tastytrade_get_option_chain: "option_chains",
  tastytrade_get_option_chain_compact: "option_chains",
  tastytrade_get_option_chain_nested: "option_chains",
  tastytrade_get_option_chain_full: "option_chains",
  tastytrade_get_option_expirations: "option_chains",
  tastytrade_get_futures_option_chains: "option_chains",
  tastytrade_get_futures_option_chain_full: "option_chains",

  // Single equity — GET /instruments/equities/{symbol}
  tastytrade_get_instrument: "single_equity",

  // Equities list — GET /instruments/equities[/active]
  tastytrade_get_instruments: "equities_list",
  tastytrade_get_active_equities: "equities_list",

  // Futures list — GET /instruments/futures
  tastytrade_get_futures: "futures",

  // Future products & future option products
  tastytrade_get_future_products: "future_products",
  tastytrade_get_future_product: "future_products",
  tastytrade_get_future_option_products: "future_products",
  tastytrade_get_future_option_product: "future_products",

  // Single equity option — GET /instruments/equity-options/{symbol}
  // (get_equity_definition is a deprecated alias hitting the same endpoint)
  tastytrade_get_equity_option: "single_equity_option",
  tastytrade_get_equity_definition: "single_equity_option",

  // Single future option — GET /instruments/future-options/{symbol}
  tastytrade_get_future_option: "single_future_option",

  // Account reads. get_position has no endpoint of its own — it reads the
  // whole positions list and filters client-side — so it spends the same
  // budget get_positions does, or it would be a cheaper route to the same GET.
  tastytrade_get_positions: "positions",
  tastytrade_get_position: "positions",
  tastytrade_get_balances: "balances",
  tastytrade_get_accounts: "accounts",
};

/**
 * Resolve a tool name to its per-endpoint rate key, if any.
 *
 * `hasOwnProperty`, not a bare index: the name arrives over the wire, and a
 * plain object literal answers `toString` and `constructor` with an
 * `Object.prototype` member. A bare index would hand `chargeRateLimit` a
 * function where it expects a RateKey.
 */
export function rateKeyForTool(name: string): RateKey | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_RATE_KEYS, name)
    ? TOOL_RATE_KEYS[name]
    : undefined;
}

interface BucketState {
  /** Current token count (fractional — refills continuously). */
  tokens: number;
  /** Capacity / max tokens. */
  capacity: number;
  /** Refill rate in tokens per ms. */
  refillPerMs: number;
  /** Last time we refilled. */
  lastRefill: number;
}

/**
 * The bucket clock: milliseconds on a scale that NEVER runs backwards.
 *
 * Refilling straight off `Date.now()` is unsafe: if `refill` returns early
 * without re-anchoring `lastRefill` whenever elapsed time is not positive, one
 * backward step strands every bucket's `lastRefill` in the future and stops ALL
 * of them regenerating for the step's duration, while each refusal reports the
 * healthy 20ms wait. Triggers are mundane — an NTP correction, a host clock sync,
 * a snapshot restore.
 *
 * This projects the wall clock onto a non-decreasing sequence, so a backward step
 * contributes zero rather than negative time and the step itself is the whole
 * cost. `performance.now()` is genuinely monotonic but deliberately NOT used
 * here: it does not move under `jest.setSystemTime`, and a clock the tests cannot
 * advance is a limiter whose refill cannot be pinned.
 */
let lastWallClock = Date.now();
let monotonicMs = 0;

function monotonicNow(): number {
  const wall = Date.now();
  const elapsed = wall - lastWallClock;
  lastWallClock = wall;
  if (elapsed > 0) monotonicMs += elapsed;
  return monotonicMs;
}

function makeBucket(perSecond: number, now: number): BucketState {
  return {
    tokens: perSecond,
    capacity: perSecond,
    refillPerMs: perSecond / 1_000,
    lastRefill: now,
  };
}

interface Buckets {
  global: BucketState;
  destructive: BucketState;
  perEndpoint: Record<RateKey, BucketState>;
}

function makeBuckets(): Buckets {
  const now = monotonicNow();
  const perEndpoint = {} as Record<RateKey, BucketState>;
  for (const key of Object.keys(PER_SECOND_LIMITS) as RateKey[]) {
    perEndpoint[key] = makeBucket(PER_SECOND_LIMITS[key], now);
  }
  return {
    global: makeBucket(GLOBAL_PER_SECOND, now),
    destructive: makeBucket(DESTRUCTIVE_PER_SECOND, now),
    perEndpoint,
  };
}

let buckets: Buckets = makeBuckets();

function refill(b: BucketState, now: number) {
  const elapsed = now - b.lastRefill;
  if (elapsed <= 0) {
    // Belt and braces behind `monotonicNow`, which cannot produce a negative
    // elapsed: if this is ever handed a clock that runs backwards again,
    // re-anchor rather than freeze. Leaving `lastRefill` in the future is
    // precisely what wedged every bucket for the length of a backward step.
    b.lastRefill = now;
    return;
  }
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
  b.lastRefill = now;
}

/**
 * How long until this bucket holds one whole token again. Only meaningful for a
 * bucket that is short of one, and both call sites are inside the refusal path
 * below, over buckets already established as exhausted.
 */
function msUntilOneToken(b: BucketState): number {
  return Math.ceil((1 - b.tokens) / b.refillPerMs);
}

/** One bucket a call must draw on, labelled for the refusal message. */
interface ChargedBucket {
  label: string;
  bucket: BucketState;
  /** Whether a refusal message may name this bucket. */
  published: boolean;
}

/**
 * Charge one unit against the global bucket, the per-endpoint bucket (if the
 * call has a rate key), and the internal destructive bucket (if the call moves
 * an order). If any charged bucket is exhausted, throw a `rate_limit_exceeded`
 * ToolError and consume nothing from any of them.
 */
export function chargeRateLimit(opts: {
  rateKey?: RateKey;
  destructive?: boolean;
}): void {
  const now = monotonicNow();

  const charged: ChargedBucket[] = [
    { label: "global", bucket: buckets.global, published: true },
  ];
  if (opts.rateKey !== undefined) {
    charged.push({
      label: opts.rateKey,
      bucket: buckets.perEndpoint[opts.rateKey],
      published: true,
    });
  }
  if (opts.destructive === true) {
    charged.push({
      label: "destructive",
      bucket: buckets.destructive,
      published: false,
    });
  }

  for (const c of charged) refill(c.bucket, now);

  const exhausted = charged.filter((c) => c.bucket.tokens < 1);
  if (exhausted.length > 0) {
    const wait = Math.max(...exhausted.map((c) => msUntilOneToken(c.bucket)));
    // Name a bucket only when it is one of the published ones. When the internal
    // order cap is the only thing binding there is nothing to name, and blaming
    // `global` would be false — 20 order calls in a second leave it holding 30
    // tokens. Among the published buckets that ARE empty, name the one whose wait is
    // the wait being reported: taking the first in charge order names `global`
    // whenever it is among them, so a 1/sec endpoint could be binding while the
    // message blames a 20ms bucket and `retry_after_ms` quotes the full second.
    const named =
      exhausted.find(
        (c) => c.published && msUntilOneToken(c.bucket) === wait,
      ) ?? exhausted.find((c) => c.published);
    throw toolError({
      code: "rate_limit_exceeded",
      message:
        named === undefined
          ? "Local rate limit hit: too many requests in the last second."
          : `Local rate limit hit on the "${named.label}" bucket.`,
      retryable: true,
      retry_after_ms: wait,
      hint:
        opts.rateKey === "market_data"
          ? "If you're polling for live data, switch to the DXLink streamer (see tastytrade://streaming-reference)."
          : undefined,
    });
  }

  for (const c of charged) c.bucket.tokens -= 1;
}

/**
 * Bill an upstream broker call the caller is ALREADY committed to making.
 *
 * The tool pre-flight charges once per `tools/call`, which is only true when a
 * tool makes one request. `tastytrade_place_order` makes three, so on one token
 * it would spend three of the broker's — 60 broker requests/second against a
 * global budget claiming 50, with a published 1/sec ceiling out of sight.
 *
 * IT CANNOT REFUSE. The call it pays for has already been admitted; refusing
 * would abort a sanity check mid-submit after the token was consumed, turning a
 * budget overrun into a lost order. The overspend is repaid instead: the next
 * ADMITTING charge finds the buckets short and is refused, so the aggregate still
 * binds and `chargeRateLimit`'s "a refused call consumes nothing" is untouched.
 *
 * EACH BUCKET IS DEBITED INDEPENDENTLY, unlike an admitting charge: a debt
 * records a request that HAPPENED, so the global cap must record it whatever the
 * per-endpoint bucket's state is. An all-or-nothing charge would fail on the
 * drained 1/sec bucket and never reach `global`, leaving the global cap
 * under-counting the burst it bounds. A bucket already at zero stays at zero.
 */
export function chargeUpstreamCallDebt(opts: { rateKey?: RateKey } = {}): void {
  const now = monotonicNow();
  const drawn: BucketState[] = [buckets.global];
  if (opts.rateKey !== undefined) drawn.push(buckets.perEndpoint[opts.rateKey]);
  for (const b of drawn) {
    refill(b, now);
    b.tokens = Math.max(0, b.tokens - 1);
  }
}

/** For tests / introspection. */
export function _resetRateLimitsForTest(): void {
  buckets = makeBuckets();
}
