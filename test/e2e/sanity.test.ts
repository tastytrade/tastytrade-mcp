/**
 * End-to-end pre-submit sanity checks.
 *
 * `runSanityChecks` is the last thing standing between an agent and a live order, and
 * test/safety/sanity-checks.test.ts already exercises it against a stubbed client.
 * This suite drives it the way production does: a real dry-run issues a real
 * confirmation token, and a real `place_order` consumes it, runs the checks against a
 * real `TastytradeClient` whose transport is a route table, and only then POSTs.
 *
 * That framing buys two things the unit tests cannot assert. NO MONEY MOVED: every
 * hard-block case asserts the live POST never appeared on the wire, and a check that
 * throws after the submit would pass a unit test and lose real money. And THE CHECKS
 * SEE THE DRY-RUN THE TOKEN CAPTURED: the buying-power figure the cap reads is the one
 * the endpoint returned and `issueToken` stored, not one handed in by the test.
 *
 * One branch of `runSanityChecks` is deliberately NOT reachable through the dispatcher
 * — see "dry-run errors" below.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { TastytradeClient } from "../../src/api-client.js";
import { runSanityChecks } from "../../src/safety/sanity-checks.js";
import { isToolErrorException } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import { MCP_ORDER_SOURCE } from "../../src/mcp-server/index.js";

const ACCT = "5WX00001";

const POSITION_LIMIT = /\/accounts\/[^/]+\/position-limit$/;
const TRADING_STATUS = /\/accounts\/[^/]+\/trading-status$/;
const ORDER_DRY_RUN = /\/accounts\/[^/]+\/orders\/dry-run$/;
const ORDER_SUBMIT = /\/accounts\/[^/]+\/orders$/;
const COMPLEX_DRY_RUN = /\/accounts\/[^/]+\/complex-orders\/dry-run$/;
const COMPLEX_SUBMIT = /\/accounts\/[^/]+\/complex-orders$/;

/** What the API returns from a successful live submit. */
const PLACED = { order: { id: 8801, status: "Received" } };

/**
 * A trading status that answers every account-state question, all of them "no".
 *
 * The default for any case whose subject is not the trading status. `{}` used
 * to serve here, which made one fixture stand for both "healthy account" and
 * "the endpoint answered and told us nothing" — so the harness could not
 * express the difference, and a payload carrying no readable flag passed as a
 * clean checked account throughout the file. That gap is now reported, and `{}`
 * would attach its warning to every order placed here.
 */
const CLEAN_TRADING_STATUS = {
  "account-number": ACCT,
  "is-frozen": false,
  "is-closing-only": false,
  "is-in-margin-call": false,
  "is-risk-reducing-only": false,
};

interface Leg {
  symbol: string;
  instrument_type: string;
  action: string;
  quantity: number;
}

function leg(
  symbol: string,
  instrument_type: string,
  action: string,
  quantity: number,
): Leg {
  return { symbol, instrument_type, action, quantity };
}

/** A minimal dry-run response carrying the buying-power figure under test. */
function dryRunBody(
  changeInBuyingPower: string | number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    order: { status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": changeInBuyingPower,
      "change-in-buying-power-effect": "Debit",
    },
    ...extra,
  };
}

/**
 * A position-limit payload carrying every published ceiling, generously sized.
 *
 * The default for any test whose subject is NOT the limits payload. It has to
 * be a complete payload rather than `{}`: a ceiling the payload does not carry
 * is now a reported gap ("this leg was not checked"), so `{}` would attach a
 * warning to every order in the file and drown the one each test is asserting.
 */
const ALL_LIMITS = {
  "equity-order-size": 1_000_000,
  "equity-option-order-size": 1_000_000,
  "future-order-size": 1_000_000,
  "future-option-order-size": 1_000_000,
};

interface HarnessSpec {
  /** `change-in-buying-power` the dry-run endpoint reports. */
  bp?: string | number;
  /** Extra top-level fields on the dry-run payload (e.g. `warnings`). */
  dryRunExtra?: Record<string, unknown>;
  /** Body for GET /position-limit. Omit for ALL_LIMITS (everything published). */
  limits?: unknown;
  /** Make GET /position-limit fail, exercising the soft-warning path. */
  limitsUnreachable?: boolean;
  /** Body for GET /trading-status. Omit for CLEAN_TRADING_STATUS. */
  status?: unknown;
  /** Make GET /trading-status fail, exercising the soft-warning path. */
  statusUnreachable?: boolean;
}

async function harnessFor(spec: HarnessSpec = {}): Promise<Harness> {
  const dry = { data: dryRunBody(spec.bp ?? "-100.00", spec.dryRunExtra) };
  const routes: Route[] = [
    { matcher: ORDER_DRY_RUN, method: "POST", reply: dry },
    { matcher: COMPLEX_DRY_RUN, method: "POST", reply: dry },
    { matcher: ORDER_SUBMIT, method: "POST", reply: { data: PLACED } },
    { matcher: COMPLEX_SUBMIT, method: "POST", reply: { data: PLACED } },
    {
      matcher: POSITION_LIMIT,
      method: "GET",
      reply: spec.limitsUnreachable
        ? { status: 503 }
        : // `raw`, and `in` rather than `??`: a `{data: null}` body and an
          // absent one are themselves cases under test, and the harness's
          // convenience wrapper (`{ data: reply.data ?? {} }`) would rewrite
          // both of them into `{}` before the client ever saw them.
          {
            raw: true,
            data: { data: "limits" in spec ? spec.limits : ALL_LIMITS },
          },
    },
    {
      matcher: TRADING_STATUS,
      method: "GET",
      reply: spec.statusUnreachable
        ? { networkError: "ECONNREFUSED" }
        : // `raw` and `in`, for the same reason the position-limit route above
          // uses them: `{data: null}` and a non-object body are themselves
          // cases under test, and both `??` and the harness's convenience
          // wrapper rewrite them into `{}` before the client sees them. The
          // limits route was corrected for this and this one was not, which is
          // why the whole unreadable-trading-status class was unreachable from
          // the suite.
          {
            raw: true,
            data: {
              data: "status" in spec ? spec.status : CLEAN_TRADING_STATUS,
            },
          },
    },
  ];
  return createHarness({ routes });
}

/** Runs the dry-run tool and returns the token it issued. */
async function tokenFor(
  h: Harness,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = (await callOk(h, tool, args)) as {
    confirmation_token: string | null;
  };
  if (typeof res.confirmation_token !== "string") {
    throw new Error(
      `${tool} issued no confirmation_token: ${JSON.stringify(res)}`,
    );
  }
  return res.confirmation_token;
}

/** Every live submit (single or complex) the transport actually saw. */
function liveSubmits(h: Harness) {
  return h.requests.filter(
    (r) => r.method === "POST" && /\/(complex-)?orders$/.test(r.url),
  );
}

/** Dry-run then place, expecting the place to be refused. */
async function expectBlocked(
  h: Harness,
  args: Record<string, unknown>,
  { complex = false }: { complex?: boolean } = {},
): Promise<ToolError> {
  const token = await tokenFor(
    h,
    complex ? "tastytrade_dry_run_complex_order" : "tastytrade_dry_run_order",
    args,
  );
  const err = (await callError(
    h,
    complex ? "tastytrade_place_complex_order" : "tastytrade_place_order",
    { ...args, confirmation_token: token },
  )) as unknown as ToolError;
  expect(err.code).toBe("sanity_check_failed");
  expect(err.retryable).toBe(false);
  // The whole point: a hard block must happen BEFORE the order goes out.
  expect(liveSubmits(h)).toHaveLength(0);
  return err;
}

/**
 * Dry-run then place, expecting success, and return BOTH channels.
 *
 * A successful submit now carries two arrays, and which
 * one a note is in is the assertion. `sanity_warnings` is what THIS SERVER
 * found; `upstream_notes` is what the broker sent. They would be one array
 * with two authors, so a broker note reading "Account is closing-only." was
 * indistinguishable from this server's own verdict of the same words.
 */
async function placeAndSplit(
  h: Harness,
  args: Record<string, unknown>,
  { complex = false }: { complex?: boolean } = {},
): Promise<{ warnings: string[]; upstreamNotes: string[] }> {
  const token = await tokenFor(
    h,
    complex ? "tastytrade_dry_run_complex_order" : "tastytrade_dry_run_order",
    args,
  );
  const res = (await callOk(
    h,
    complex ? "tastytrade_place_complex_order" : "tastytrade_place_order",
    { ...args, confirmation_token: token },
  )) as {
    upstream?: { order?: unknown };
    sanity_warnings?: string[];
    upstream_notes?: string[];
  };
  // The broker's payload is boxed under `upstream`, so it
  // can occupy none of the names this server owns — `sanity_warnings` chief
  // among them, which is the channel these tests are about.
  expect(res.upstream?.order).toEqual(PLACED.order);
  expect(liveSubmits(h)).toHaveLength(1);
  expect(Array.isArray(res.sanity_warnings)).toBe(true);
  // Appended unconditionally, which is what lets it be `required` in the
  // published schemas.
  expect(Array.isArray(res.upstream_notes)).toBe(true);
  return {
    warnings: res.sanity_warnings ?? [],
    upstreamNotes: res.upstream_notes ?? [],
  };
}

/** Dry-run then place, expecting success, and return the SERVER's warnings. */
async function expectAllowed(
  h: Harness,
  args: Record<string, unknown>,
  opts: { complex?: boolean } = {},
): Promise<string[]> {
  return (await placeAndSplit(h, args, opts)).warnings;
}

/**
 * A REAL `TastytradeClient` over a stub adapter, for driving `runSanityChecks`
 * directly at the module boundary. `seen` records every URL the checks fetched,
 * so a test can prove a guard short-circuited before any account lookup.
 */
function stubClient(): { client: TastytradeClient; seen: string[] } {
  const seen: string[] = [];
  const client = new TastytradeClient(
    { apiUrl: "https://api.cert.tastyworks.com" },
    {
      tokenProvider: () => "test-access-token",
      adapter: async (config: AxiosRequestConfig) => {
        const url = String(config.url);
        seen.push(url);
        // `{}` for everything was fine while an empty body meant "nothing
        // flagged", but the trading-status half of that is now a reported gap:
        // a body with no readable account-state flag cannot be told apart from
        // an account that was checked and found healthy, so it warns. This stub
        // exists to keep the checks OUT of the way of whatever each case is
        // asserting, so it answers that one endpoint properly.
        const data = TRADING_STATUS.test(url) ? CLEAN_TRADING_STATUS : {};
        return {
          data: { data },
          status: 200,
          statusText: "200",
          headers: {},
          config,
        } as AxiosResponse;
      },
    },
  );
  return { client, seen };
}

/** Await a promise expected to reject, and hand back what it threw. */
async function captureRejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, but the promise resolved");
}

function orderArgs(legs: Leg[]): Record<string, unknown> {
  return {
    account_number: ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "10.00",
    price_effect: "Debit",
    legs,
  };
}

function component(legs: Leg[]): Record<string, unknown> {
  return {
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.00",
    price_effect: "Debit",
    legs,
  };
}

/**
 * A deliberately spread-out set of ceilings: no two are equal, so a refusal
 * that quotes a figure proves WHICH field was consulted. `future-option` is
 * tighter than both `future` and `equity-option`, which is the real-world
 * shape and the one that made the missing field a fail-open.
 */
const EQUITY_LIMITS = {
  "equity-order-size": 100,
  "equity-option-order-size": 10,
  "future-order-size": 5,
  "future-option-order-size": 3,
};

let h: Harness | undefined;
const prevCap = process.env.MAX_ORDER_NOTIONAL_USD;
/** Everything written to stderr during a test, one entry per console.error. */
let stderr: string[] = [];

beforeEach(() => {
  // Both are module-level singletons shared by every harness in this file: the
  // order bucket is finite and this file places more orders than it holds, and
  // a stale token map would let one test's token satisfy another's place call.
  _resetRateLimitsForTest();
  _resetTokensForTest();
  // The MAX_ORDER_NOTIONAL_USD misconfiguration warning is a stderr-only signal
  // for the operator, and several tests below assert on its exact text, so it
  // has to be captured rather than printed. That is the only reason console is
  // touched here: nothing else on these paths logs, and this capture must not
  // become a way to not notice that changing.
  stderr = [];
  jest
    .spyOn(console, "error")
    .mockImplementation(
      (...args: unknown[]) => void stderr.push(args.join(" ")),
    );
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  jest.restoreAllMocks();
  if (prevCap === undefined) delete process.env.MAX_ORDER_NOTIONAL_USD;
  else process.env.MAX_ORDER_NOTIONAL_USD = prevCap;
});

// ---------------------------------------------------------------------------
// Hard block: the dry-run reported errors
// ---------------------------------------------------------------------------

describe("sanity checks: a dry-run that returned errors", () => {
  it("issues no token at all, so the live submit is refused as dry_run_required", async () => {
    // This is the reachable contract. `tastytrade_dry_run_order` issues a token
    // ONLY when the dry-run came back error-free, so an errored dry-run never
    // produces something place_order could consume.
    h = await createHarness({
      routes: [
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: {
            data: dryRunBody("-100.00", {
              errors: [
                { code: "insufficient_buying_power", message: "not enough bp" },
              ],
            }),
          },
        },
        { matcher: ORDER_SUBMIT, method: "POST", reply: { data: PLACED } },
      ],
    });
    const args = orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]);

    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string | null;
      upstream: { errors: unknown[] };
    };
    expect(dry.confirmation_token).toBeNull();
    // The broker's errors[] is under `upstream`.
    expect(dry.upstream.errors).toHaveLength(1);

    const err = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: "00000000-0000-0000-0000-000000000000",
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveSubmits(h)).toHaveLength(0);
  });

  it("hard-fails inside runSanityChecks if an errored dry-run ever reaches it", async () => {
    // Because of the test above, `runSanityChecks`' own dry-run-errors guard is
    // defence in depth: both gates now call the same `isCleanDryRun` predicate, so
    // the dispatcher cannot hand it an errored dry-run today. Asserting it at the
    // module boundary — with a REAL client over the same credential-free
    // transport — keeps the guard honest if a future caller skips the token flow.
    const { client, seen } = stubClient();

    const caught = await captureRejection(
      runSanityChecks(
        client,
        ACCT,
        {
          legs: [{ "instrument-type": "Equity", symbol: "AAPL", quantity: 1 }],
        },
        { errors: [{ message: "not enough bp" }] },
      ),
    );

    expect(isToolErrorException(caught)).toBe(true);
    if (isToolErrorException(caught)) {
      expect(caught.toolError.code).toBe("sanity_check_failed");
      expect(caught.toolError.message).toMatch(/not enough bp/);
    }
    // The guard is first: it short-circuits before any account lookup.
    expect(seen).toEqual([]);
  });

  // An `errors` value that is not an array is not a shape the API produces, but
  // the old guard (`errors?.length`) read it as falsy — no `.length` on an
  // object — so an errored dry-run minted a token AND passed the re-check.
  const NON_ARRAY_ERRORS: Array<[label: string, errors: unknown]> = [
    ["an object", { code: "insufficient_buying_power", message: "no bp" }],
    ["a bare string", "insufficient_buying_power"],
    ["a keyed map of errors", { "0": { message: "no bp" } }],
    ["a scalar we cannot interpret", 1],
  ];

  it.each(NON_ARRAY_ERRORS)(
    "treats %s in `errors` as a failed dry-run, so no token is issued",
    async (_label, errors) => {
      h = await createHarness({
        routes: [
          {
            matcher: ORDER_DRY_RUN,
            method: "POST",
            reply: { data: dryRunBody("-100.00", { errors }) },
          },
          { matcher: ORDER_SUBMIT, method: "POST", reply: { data: PLACED } },
        ],
      });
      const args = orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]);

      const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
        confirmation_token: string | null;
      };
      expect(dry.confirmation_token).toBeNull();
      expect(liveSubmits(h)).toHaveLength(0);
    },
  );

  it.each(NON_ARRAY_ERRORS)(
    "hard-fails inside runSanityChecks on %s in `errors`",
    async (_label, errors) => {
      const { client, seen } = stubClient();
      const caught = await captureRejection(
        runSanityChecks(client, ACCT, { legs: [] }, { errors }),
      );

      expect(isToolErrorException(caught)).toBe(true);
      if (isToolErrorException(caught)) {
        expect(caught.toolError.code).toBe("sanity_check_failed");
        expect(caught.toolError.message).toMatch(/Dry-run blocked/);
      }
      expect(seen).toEqual([]);
    },
  );

  it("still treats an EMPTY errors value of any shape as a clean dry-run", async () => {
    // The hardening must not start refusing well-formed clean payloads: `[]`,
    // `{}`, `""` and an absent field all mean "no errors".
    for (const errors of [[], {}, "", null, undefined]) {
      const { client } = stubClient();
      const res = await runSanityChecks(
        client,
        ACCT,
        { legs: [] },
        { errors, "buying-power-effect": { "change-in-buying-power": -100 } },
      );
      expect(res.warnings).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Hard block: the dry-run described nothing
// ---------------------------------------------------------------------------

describe("sanity checks: a dry-run that described no order", () => {
  it("hard-fails inside runSanityChecks if a contentless dry-run ever reaches it", async () => {
    // The same defence-in-depth argument as the errored-dry-run block above, for the other
    // half of the gate. `isCleanDryRun` will not mint a token from a payload that describes
    // no order, so the dispatcher cannot hand this function one today. But the check
    // immediately downstream is the notional cap, and the cap reads its figure off
    // `buying-power-effect`: a submit that slipped past issuance would run with
    // MAX_ORDER_NOTIONAL_USD downgraded to a string in `sanity_warnings` — the last
    // mechanical guard against a quantity multiplied by a thousand, reduced to a sentence,
    // on exactly the payload that proves nothing was checked. So the module refuses it
    // itself.
    const { client, seen } = stubClient();

    const caught = await captureRejection(
      runSanityChecks(
        client,
        ACCT,
        {
          legs: [{ "instrument-type": "Equity", symbol: "AAPL", quantity: 1 }],
        },
        { warnings: [], errors: [] },
      ),
    );

    expect(isToolErrorException(caught)).toBe(true);
    if (isToolErrorException(caught)) {
      expect(caught.toolError.code).toBe("sanity_check_failed");
      expect(caught.toolError.retryable).toBe(false);
      // Names the members it looked for, so an operator staring at a proxy's
      // empty 200 can tell which claim failed.
      expect(caught.toolError.message).toMatch(/buying-power-effect/);
    }
    // Refused before any account lookup, like every other 1x guard.
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hard block: a dry-run payload the checks cannot even be run against
// ---------------------------------------------------------------------------

describe("sanity checks: an unreadable dry-run payload", () => {
  // `{data: null}` unwraps to null, which has no `errors` and no
  // `buying-power-effect`. It would mint a token and then throw a raw
  // TypeError out of runSanityChecks, which adaptError flattened into an opaque
  // `upstream_error`. "We could not look" is not "we looked and it was fine".
  const UNREADABLE: Array<[label: string, payload: unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["an array", [{ order: {} }]],
    ["a string", "OK"],
    ["a number", 0],
  ];

  it("issues no token when the dry-run payload is null", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: ORDER_DRY_RUN,
          method: "POST",
          reply: { raw: true, data: { data: null } },
        },
        { matcher: ORDER_SUBMIT, method: "POST", reply: { data: PLACED } },
      ],
    });
    const args = orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]);

    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string | null;
    };
    expect(dry.confirmation_token).toBeNull();

    const err = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: "00000000-0000-0000-0000-000000000000",
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveSubmits(h)).toHaveLength(0);
  });

  it.each(UNREADABLE)(
    "refuses as sanity_check_failed when the payload is %s",
    async (_label, payload) => {
      const { client, seen } = stubClient();
      const caught = await captureRejection(
        runSanityChecks(
          client,
          ACCT,
          {
            legs: [
              { "instrument-type": "Equity", symbol: "AAPL", quantity: 1 },
            ],
          },
          payload,
        ),
      );

      expect(isToolErrorException(caught)).toBe(true);
      if (isToolErrorException(caught)) {
        // A clear refusal, not a TypeError flattened into upstream_error.
        expect(caught.toolError.code).toBe("sanity_check_failed");
        expect(caught.toolError.retryable).toBe(false);
        expect(caught.toolError.message).toMatch(
          /could not be performed|Refusing to submit/,
        );
        expect(caught.toolError.hint).toMatch(/dry_run_/);
      }
      // Refused before any account lookup, and long before any submit.
      expect(seen).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Hard block: per-leg quantity vs. account position limits
// ---------------------------------------------------------------------------

describe("sanity checks: per-leg position limits", () => {
  it("blocks an equity leg over equity-order-size", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const err = await expectBlocked(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 101)]),
    );
    expect(err.message).toMatch(
      /Leg quantity 101 for AAPL exceeds account order limit 100/,
    );
  });

  it("allows an equity leg exactly AT equity-order-size", async () => {
    // The check is `qty > limit`, so the limit itself is a permitted size.
    h = await harnessFor({ limits: EQUITY_LIMITS });
    expect(
      await expectAllowed(
        h,
        orderArgs([leg("AAPL", "Equity", "Buy to Open", 100)]),
      ),
    ).toEqual([]);
  });

  it("blocks an option leg over equity-option-order-size", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const err = await expectBlocked(
      h,
      orderArgs([
        leg("AAPL  260116C00200000", "Equity Option", "Buy to Open", 11),
      ]),
    );
    expect(err.message).toMatch(/exceeds account order limit 10/);
  });

  it("blocks an outright future leg over future-order-size", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    // Outright futures use Buy/Sell, not the open/close actions.
    const err = await expectBlocked(
      h,
      orderArgs([leg("/ESZ6", "Future", "Buy", 6)]),
    );
    expect(err.message).toMatch(/Leg quantity 6 for \/ESZ6/);
    expect(err.message).toMatch(/exceeds account order limit 5/);
  });

  it("measures a Future Option against future-option-order-size", async () => {
    // The account's real futures-option ceiling is 3. The equity-option ceiling is 10 and
    // the outright-futures ceiling is 5, so a 4-lot order separates all three: it must be
    // refused, by the field that actually applies.
    //
    // An `isFutureLeg` test that excludes anything containing "Option" drops a Future
    // Option to the equity-option branch — and with `future-option-order-size` not even
    // declared on the type, the account's real ceiling is never read. Verified against a
    // spec-shaped payload: with equity-option 2,000 and future-option 10, a 500-lot
    // futures-option leg is admitted silently, fifty times the real cap, on the
    // highest-notional class this server supports.
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const err = await expectBlocked(
      h,
      orderArgs([
        leg("./ESZ6 EW4U6 260116C6000", "Future Option", "Buy to Open", 4),
      ]),
    );
    expect(err.message).toMatch(
      /exceeds account order limit 3 \(future-option-order-size\)/,
    );
  });

  it("allows a Future Option within future-option-order-size", async () => {
    // The complement: the fix must not become a false block at the boundary.
    h = await harnessFor({ limits: EQUITY_LIMITS });
    expect(
      await expectAllowed(
        h,
        orderArgs([
          leg("./ESZ6 EW4U6 260116C6000", "Future Option", "Buy to Open", 3),
        ]),
      ),
    ).toEqual([]);
  });

  it("does not measure a Cryptocurrency leg against the equity share cap", async () => {
    // equity-order-size is a limit on SHARES; crypto unit counts are routinely
    // in the thousands. Comparing them refused legitimate orders, and the only
    // workaround was to raise an equity limit in order to buy crypto. The API
    // publishes no crypto ceiling, so the check is skipped — and says so.
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("BTC/USD", "Cryptocurrency", "Buy to Open", 5_000)]),
    );
    expect(warnings.join(" ")).toMatch(
      /Cryptocurrency has no published per-order size limit/,
    );
  });

  // Instrument types open-api-spec/orders.md documents on an order leg that the
  // four published ceilings do not cover. None appears in the order tools'
  // schema enum, and the MCP SDK does not validate arguments against an enum, so
  // an agent's value arrives here untouched — which is why the fallthrough
  // mattered.
  const UNCEILINGED = [
    "Event Contract",
    "Fixed Income Security",
    "Liquidity Pool",
  ];

  it.each(UNCEILINGED)(
    "admits a %s leg but discloses that no size ceiling applied to it",
    async (instrumentType) => {
      // This would be SILENT, and silently wrong in the loose direction.
      // `equity-order-size` was the fallthrough and it is the loosest of the
      // four ceilings — here 100, against future-option's 3 — so a type the
      // broker accepts and this module does not recognise was measured against
      // a share cap with no relationship to it, and came back
      // `sanity_warnings: []`: indistinguishable from a clean, checked pass in
      // the one module whose rule is that the caller is always told which
      // checks did not run. The comment shipped alongside called the
      // fallthrough "the conservative direction — it refuses more, never less",
      // which is the exact inverse.
      h = await harnessFor({ limits: EQUITY_LIMITS });
      const warnings = await expectAllowed(
        h,
        orderArgs([leg("XYZ", instrumentType, "Buy to Open", 99)]),
      );
      expect(warnings.join(" ")).toContain(
        `no per-order size limit for instrument type "${instrumentType}"`,
      );
      // Asserts the proposition, not the sentence: the caller is told what is
      // left bounding the leg, AND that the notional cap is itself conditional.
      // The old assertion pinned "...enforcement only", which was the affirmative
      // claim that had to go — `applyNotionalCap` can append "the cap could not
      // be applied" to the very same array two steps later.
      const joined = warnings.join(" ");
      expect(joined).toMatch(/MAX_ORDER_NOTIONAL_USD/);
      expect(joined).toMatch(/server-side enforcement/);
      expect(joined).toMatch(
        /only when the dry-run supplied a buying-power figure/,
      );
      expect(joined).not.toMatch(/enforcement only/);
    },
  );

  it("does not let an unrecognised instrument type read as a checked pass at 50,000 units", async () => {
    // The size that makes the old behaviour visible: 50,000 is 500x the equity
    // ceiling of 100, so under the fallthrough this order was HARD-BLOCKED
    // against a ceiling that does not apply to it. Both directions of the same
    // defect — the wrong ceiling refuses as readily as it admits — and the
    // honest answer is one warning, not a comparison.
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("XYZ", "Event Contract", "Buy to Open", 50_000)]),
    );
    expect(warnings.join(" ")).toContain(
      'no per-order size limit for instrument type "Event Contract"',
    );
  });

  it("checks every leg of a single order's legs[], not just the first", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const err = await expectBlocked(
      h,
      orderArgs([
        leg("AAPL", "Equity", "Buy to Open", 1),
        leg("MSFT", "Equity", "Sell to Open", 500),
      ]),
    );
    expect(err.message).toMatch(/Leg quantity 500 for MSFT/);
  });

  it("says so when the payload carries no ceiling for the leg's type", async () => {
    // A payload missing `equity-order-size` must not be read as a limit of
    // zero — but it must not read as a clean pass either. This would skip the
    // per-leg loop and return an empty warnings array, so a response that had
    // checked nothing was indistinguishable from one that had checked and
    // approved. "We could not look" is not "we looked and it was fine".
    h = await harnessFor({ limits: { "future-order-size": 5 } });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 9_999)]),
    );
    expect(warnings).toEqual([
      'Account position limits carry no usable "equity-order-size", so the ' +
        "matching leg(s) were not checked against a per-order size ceiling — " +
        "relying on server-side enforcement.",
    ]);
  });

  it.each([
    ["null", null, "null"],
    ["an array", [], "an array, not an object"],
    ["a string", "equity-order-size: 100", "not an object (string)"],
  ])(
    "says so when the whole payload is %s rather than an object",
    async (_label, payload, shape) => {
      // api-client maps `{data: null}` straight to null, and a 200 whose body
      // is not the expected envelope yields undefined; both would fall
      // through the per-leg loop in complete silence, while a THROWN fetch
      // correctly warned. Same claim, same disclosure.
      h = await harnessFor({ limits: payload });
      const warnings = await expectAllowed(
        h,
        orderArgs([leg("AAPL", "Equity", "Buy to Open", 9_999_999)]),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `Account position limits came back ${shape}`,
      );
    },
  );

  it("compares against a string-typed ceiling, the dialect quantities already use", async () => {
    // usableLegQuantity accepts "1.5" because the API sends and accepts decimal
    // strings. The ceiling it is compared against would require a JSON
    // number, so a string-typed limit silently disabled the check for that leg.
    h = await harnessFor({ limits: { "equity-order-size": "100" } });
    const err = await expectBlocked(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 101)]),
    );
    expect(err.message).toMatch(/exceeds account order limit 100/);
  });
});

// ---------------------------------------------------------------------------
// Hard block: flattenLegs across the complex-order shape
// ---------------------------------------------------------------------------

describe("sanity checks: flattenLegs covers both order shapes", () => {
  const triggerLeg = leg("AAPL", "Equity", "Buy to Open", 1);

  it("flattens trigger-order legs on a complex order", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const err = await expectBlocked(
      h,
      {
        account_number: ACCT,
        type: "OTOCO",
        trigger_order: component([leg("SPY", "Equity", "Buy to Open", 250)]),
        orders: [component([leg("SPY", "Equity", "Sell to Close", 1)])],
      },
      { complex: true },
    );
    expect(err.message).toMatch(/Leg quantity 250 for SPY/);
  });

  it("flattens every component of orders[] on a complex order", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const err = await expectBlocked(
      h,
      {
        account_number: ACCT,
        type: "OTOCO",
        trigger_order: component([triggerLeg]),
        orders: [
          component([leg("AAPL", "Equity", "Sell to Close", 1)]),
          // Second component, second leg — reached only by a full flatten.
          component([
            leg("AAPL", "Equity", "Sell to Close", 1),
            leg("NVDA", "Equity", "Sell to Open", 777),
          ]),
        ],
      },
      { complex: true },
    );
    expect(err.message).toMatch(/Leg quantity 777 for NVDA/);
  });

  it("allows a complex order whose every flattened leg is within limits", async () => {
    h = await harnessFor({ limits: EQUITY_LIMITS });
    expect(
      await expectAllowed(
        h,
        {
          account_number: ACCT,
          type: "OCO",
          orders: [
            component([leg("AAPL", "Equity", "Sell to Close", 100)]),
            component([leg("MSFT", "Equity", "Sell to Close", 100)]),
          ],
        },
        { complex: true },
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hard block: the notional cap, and its exact boundary
// ---------------------------------------------------------------------------

describe("sanity checks: MAX_ORDER_NOTIONAL_USD", () => {
  const oneLeg = orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]);

  it("allows an order exactly AT the cap", async () => {
    process.env.MAX_ORDER_NOTIONAL_USD = "1000";
    h = await harnessFor({ bp: "-1000.00" });
    expect(await expectAllowed(h, oneLeg)).toEqual([]);
  });

  it("blocks an order one cent over the cap", async () => {
    process.env.MAX_ORDER_NOTIONAL_USD = "1000";
    h = await harnessFor({ bp: "-1000.01" });
    const err = await expectBlocked(h, oneLeg);
    expect(err.message).toMatch(
      /buying-power impact \$1000\.01 exceeds MAX_ORDER_NOTIONAL_USD \(\$1000\)/,
    );
  });

  it("caps on magnitude, so a credit of the same size is blocked too", async () => {
    // parseBuyingPowerEffect is wrapped in Math.abs: a huge credit is just as
    // much of a "quantity times a thousand" tell as a huge debit.
    process.env.MAX_ORDER_NOTIONAL_USD = "1000";
    h = await harnessFor({ bp: 1000.01 });
    const err = await expectBlocked(h, oneLeg);
    expect(err.message).toMatch(/\$1000\.01 exceeds/);
    expect(err.hint).toMatch(/MAX_ORDER_NOTIONAL_USD/);
  });

  it("falls back to the documented $50,000 default when the env var is unset", async () => {
    delete process.env.MAX_ORDER_NOTIONAL_USD;
    h = await harnessFor({ bp: "-50000.00" });
    expect(await expectAllowed(h, oneLeg)).toEqual([]);
    await h.close();

    h = await harnessFor({ bp: "-50000.01" });
    const err = await expectBlocked(h, oneLeg);
    expect(err.message).toMatch(/\$50000\.01 exceeds MAX_ORDER_NOTIONAL_USD/);
  });

  it("reads a plain number of dollars as the cap", async () => {
    process.env.MAX_ORDER_NOTIONAL_USD = "250000";
    h = await harnessFor({ bp: "-100000.00" });
    expect(await expectAllowed(h, oneLeg)).toEqual([]);
    await h.close();

    h = await harnessFor({ bp: "-250000.01" });
    const err = await expectBlocked(h, oneLeg);
    expect(err.message).toMatch(/exceeds MAX_ORDER_NOTIONAL_USD \(\$250000\)/);
  });

  // Every one of these is a plausible fat-finger for "fifty thousand dollars",
  // and every one would make `Number()` return NaN (or a non-positive number)
  // and skip the notional check ENTIRELY — on the one check whose whole job is
  // catching a quantity that got multiplied by a thousand. They must all fall
  // back to the documented $50,000 default, never to "unlimited".
  const UNUSABLE: Array<[label: string, value: string]> = [
    ["a suffixed number", "50k"],
    ["a currency symbol", "$50000"],
    ["thousands separators", "50,000"],
    ["a typo", "not-a-number"],
    ["a negative", "-1"],
    ["zero", "0"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    // Number("Infinity") is Infinity, which is > 0 — the one non-finite value
    // that would slip past a `> 0` test alone and mean "no ceiling".
    ["Infinity", "Infinity"],
  ];

  it.each(UNUSABLE)(
    "falls back to the $50,000 default — never unlimited — for %s (%p)",
    async (_label, value) => {
      process.env.MAX_ORDER_NOTIONAL_USD = value;
      h = await harnessFor({ bp: "-50000.01" });

      const err = await expectBlocked(h, oneLeg);
      expect(err.message).toMatch(
        /\$50000\.01 exceeds MAX_ORDER_NOTIONAL_USD \(\$50000\)/,
      );

      // Loud on stderr, naming the offending value verbatim so the operator can
      // see what they actually set.
      const warning = stderr.find((line) =>
        line.includes("MAX_ORDER_NOTIONAL_USD"),
      );
      expect(warning).toBeDefined();
      expect(warning).toContain(JSON.stringify(value));
      expect(warning).toMatch(/not been disabled/i);
    },
  );

  it("surfaces the misconfiguration to the caller as a sanity warning too", async () => {
    // Under the cap, so the order goes through — but the response says the cap
    // is not the one the operator configured. An agent reading sanity_warnings
    // sees the misconfiguration even if nobody is watching stderr.
    process.env.MAX_ORDER_NOTIONAL_USD = "50k";
    h = await harnessFor({ bp: "-100.00" });

    const warnings = await expectAllowed(h, oneLeg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MAX_ORDER_NOTIONAL_USD is not a usable");
    expect(warnings[0]).toContain('"50k"');
  });

  it("still enforces a low valid cap that a malformed one would have raised", async () => {
    // The fallback is the DEFAULT, not the last good value and not the highest
    // plausible reading of the string: "5k" does not become 5000.
    process.env.MAX_ORDER_NOTIONAL_USD = "5k";
    h = await harnessFor({ bp: "-6000.00" });
    // $6,000 is over a literal reading of "5k" but under the $50,000 default,
    // so it is allowed — with the warning attached.
    const warnings = await expectAllowed(h, oneLeg);
    expect(warnings.join(" ")).toContain("MAX_ORDER_NOTIONAL_USD");
  });
});

// ---------------------------------------------------------------------------
// Hard block: account state
// ---------------------------------------------------------------------------

describe("sanity checks: account state hard blocks", () => {
  it("blocks any order into a frozen account", async () => {
    h = await harnessFor({ status: { "is-frozen": true } });
    const err = await expectBlocked(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(err.message).toMatch(/frozen/i);
  });

  it("blocks a frozen account even for a closing order", async () => {
    // Frozen is checked before the closing-only branch, so "I'm only reducing
    // risk" is not an escape hatch.
    h = await harnessFor({
      status: { "is-frozen": true, "is-closing-only": true },
    });
    const err = await expectBlocked(
      h,
      orderArgs([leg("AAPL", "Equity", "Sell to Close", 1)]),
    );
    expect(err.message).toMatch(/frozen/i);
  });

  it("blocks an opening order into a closing-only account", async () => {
    h = await harnessFor({ status: { "is-closing-only": true } });
    const err = await expectBlocked(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(err.message).toMatch(/closing-only/);
    expect(err.hint).toMatch(/to Close/);
  });

  it("blocks a closing-only account when ANY leg opens", async () => {
    h = await harnessFor({ status: { "is-closing-only": true } });
    const err = await expectBlocked(
      h,
      orderArgs([
        leg("AAPL", "Equity", "Sell to Close", 1),
        leg("MSFT", "Equity", "Buy to Open", 1),
      ]),
    );
    expect(err.message).toMatch(/closing-only/);
  });

  it("blocks an opening leg inside a complex order into a closing-only account", async () => {
    h = await harnessFor({ status: { "is-closing-only": true } });
    const err = await expectBlocked(
      h,
      {
        account_number: ACCT,
        type: "OTOCO",
        trigger_order: component([leg("SPY", "Equity", "Buy to Open", 1)]),
        orders: [component([leg("SPY", "Equity", "Sell to Close", 1)])],
      },
      { complex: true },
    );
    expect(err.message).toMatch(/closing-only/);
  });
});

// ---------------------------------------------------------------------------
// Soft conditions: warnings, not failures
// ---------------------------------------------------------------------------

describe("sanity checks: soft conditions become warnings", () => {
  it("ALLOWS a closing order into a closing-only account, warning instead", async () => {
    // Refusing this would be a real defect: a closing-only account is exactly
    // the account that most needs to be able to close.
    h = await harnessFor({ status: { "is-closing-only": true } });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("AAPL", "Equity", "Sell to Close", 1)]),
    );
    expect(warnings).toContain("Account is closing-only.");
  });

  it("warns, and submits, when the account is in a margin call", async () => {
    h = await harnessFor({ status: { "is-in-margin-call": true } });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(warnings).toContain("Account is in margin call.");
  });

  it("warns, and submits, when the position-limit endpoint is unreachable", async () => {
    h = await harnessFor({ limitsUnreachable: true });
    const warnings = await expectAllowed(
      h,
      // An oversized quantity sails through: with no limits fetched there is
      // nothing to compare against, so the API's own enforcement is the backstop.
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 100_000)]),
    );
    expect(warnings).toContain(
      "Could not fetch account position limits — relying on server-side enforcement.",
    );
  });

  it("warns, and submits, when the trading-status endpoint is unreachable", async () => {
    h = await harnessFor({ statusUnreachable: true });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(warnings).toContain(
      "Could not fetch account trading status — submit may still bounce upstream.",
    );
  });

  it.each([
    ["null", null, "null"],
    ["an array", [], "an array, not an object"],
    ["a string", "frozen", "not an object (string)"],
    ["a number", 5, "not an object (number)"],
  ])(
    "warns, and submits, when the trading-status payload is %s rather than an object",
    async (_label, payload, shape) => {
      // The 200 half of the unreachable case, and it was the silent one: a
      // payload the transport admits but that no field can be read off skipped
      // the frozen and closing-only HARD BLOCKS and answered
      // `sanity_warnings: []` — the same order, through the same tool, reading
      // exactly like an account that had been checked and found healthy. The
      // throwing path above always disclosed; this one now says the same thing.
      h = await harnessFor({ status: payload });
      const warnings = await expectAllowed(
        h,
        orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        `Account trading status came back ${shape}`,
      );
      expect(warnings[0]).toMatch(/frozen/);
    },
  );

  it.each([
    ["an empty object", {}],
    ["a body carrying only identity fields", { "account-number": ACCT }],
    // The expensive one: the account IS frozen, and the flag is one level
    // deeper than the checks look. Through the real dispatcher this submitted a
    // live order into a frozen account and reported `sanity_warnings: []`.
    [
      "an envelope skew nesting the status a level down",
      { "trading-status": { "is-frozen": true } },
    ],
  ])(
    "warns, and submits, when the trading-status payload is %s",
    async (_label, payload) => {
      // One level in from the shape cases above. These payloads ARE objects, so
      // they clear the shape guard, and then every flag read comes back
      // undefined and the account reports healthy. The vendored spec says a
      // partial payload is normal for this endpoint, so a payload with none of
      // the flags is what a version skew looks like from here — not an exotic
      // input.
      h = await harnessFor({ status: payload });
      const warnings = await expectAllowed(
        h,
        orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/carried no readable/);
      for (const flag of [
        "is-frozen",
        "is-closing-only",
        "is-in-margin-call",
        "is-risk-reducing-only",
      ]) {
        expect(warnings[0]).toContain(flag);
      }
    },
  );

  it("warns, and submits, on a risk-reducing-only account", async () => {
    // The fourth restriction the vendored spec lists under "Pre-trade
    // validation", and the one this server read nothing from. A warning rather
    // than a block: whether an order reduces risk is a fact about the position
    // book, which is not available here, so a protective put must not be
    // refused for opening a position.
    h = await harnessFor({
      status: { ...CLEAN_TRADING_STATUS, "is-risk-reducing-only": true },
    });
    const warnings = await expectAllowed(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(warnings.join(" ")).toMatch(/risk-reducing/i);
  });

  it("surfaces a broker warning that arrived without its array", async () => {
    // `errors: {message: "…"}` hard-blocks the submit; the byte-identical
    // `warnings: {message: "…"}` would be dropped whole, because the loop
    // was gated on Array.isArray. Two fields of one payload, one wire contract.
    h = await harnessFor({
      dryRunExtra: { warnings: { message: "your order will be rejected" } },
    });
    // The note is surfaced, in the upstream channel.
    const { warnings, upstreamNotes } = await placeAndSplit(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(upstreamNotes).toContain("your order will be rejected");
    expect(warnings).toEqual([]);
  });

  it("scrubs a credential out of a broker warning on the way to the caller", async () => {
    // `sanity_warnings` rides the SUCCESS body, which passes none of the gates
    // a ToolError passes: the same upstream text came out `Bearer [redacted]`
    // in an error and verbatim in a warning. Asserted end-to-end, on the JSON
    // the client actually receives, because the seam being tested is the one
    // between this module and everything downstream of it.
    h = await harnessFor({
      dryRunExtra: {
        warnings: [
          {
            detail:
              "Authorization: Bearer NOT_A_REAL_BEARER_TOKEN_FIXTURE_0000",
          },
        ],
      },
    });
    // The note travels in the upstream channel now. The
    // scrub is unchanged and is still what this test is about — provenance and
    // credentials are two separate questions about the same string.
    const { upstreamNotes } = await placeAndSplit(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );
    expect(upstreamNotes.join(" ")).not.toContain(
      "NOT_A_REAL_BEARER_TOKEN_FIXTURE_0000",
    );
    expect(upstreamNotes.join(" ")).toContain("[redacted]");
  });

  it("accumulates several warnings in one response", async () => {
    h = await harnessFor({
      limitsUnreachable: true,
      status: { "is-closing-only": true, "is-in-margin-call": true },
      dryRunExtra: {
        warnings: [
          {
            message: "Your order will begin working during next valid session.",
          },
        ],
      },
    });
    // This is now the sharpest statement of the fix in
    // the suite. The same call produces four notes; three are this server's own
    // findings and one is the broker's, and they arrive in two arrays instead of
    // interleaved in one where nothing said which was which.
    const { warnings, upstreamNotes } = await placeAndSplit(
      h,
      orderArgs([leg("AAPL", "Equity", "Sell to Close", 1)]),
    );
    expect(warnings).toEqual([
      "Could not fetch account position limits — relying on server-side enforcement.",
      "Account is closing-only.",
      "Account is in margin call.",
    ]);
    expect(upstreamNotes).toEqual([
      "Your order will begin working during next valid session.",
    ]);
  });

  it("surfaces the dry-run's own warnings from a recorded sandbox payload", async () => {
    // The real capture carries two warnings, including the one the sandbox emits
    // for closing with no position.
    const fixture = loadFixture("tastytrade_dry_run_complex_order") as {
      warnings: Array<{ message: string }>;
    };
    h = await createHarness({
      routes: [
        { matcher: COMPLEX_DRY_RUN, method: "POST", reply: { data: fixture } },
        { matcher: COMPLEX_SUBMIT, method: "POST", reply: { data: PLACED } },
        // Routed explicitly rather than left to the harness fallback: an empty
        // `{}` limits payload is now a reported gap, and this test is about the
        // dry-run's OWN warnings reaching the caller unaltered.
        { matcher: POSITION_LIMIT, method: "GET", reply: { data: ALL_LIMITS } },
        {
          matcher: TRADING_STATUS,
          method: "GET",
          // Same reason as the limits route above, one endpoint over: `{}` is
          // now a reported gap rather than a healthy account.
          reply: { data: CLEAN_TRADING_STATUS },
        },
      ],
    });

    // The dry-run's OWN warnings are the broker's, so
    // they arrive in the upstream channel, unaltered — and `sanity_warnings`
    // stays empty, which is the claim that matters on a clean account.
    const { warnings, upstreamNotes } = await placeAndSplit(
      h,
      {
        account_number: ACCT,
        type: "OCO",
        orders: [
          component([leg("SPY", "Equity", "Sell to Open", 1)]),
          component([leg("SPY", "Equity", "Sell to Close", 1)]),
        ],
      },
      { complex: true },
    );

    expect(upstreamNotes).toEqual(fixture.warnings.map((w) => w.message));
    expect(upstreamNotes.length).toBeGreaterThan(1);
    expect(warnings).toEqual([]);
  });

  it("returns an empty warnings array on a clean order", async () => {
    h = await harnessFor({
      limits: EQUITY_LIMITS,
      status: CLEAN_TRADING_STATUS,
    });
    expect(
      await expectAllowed(
        h,
        orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The checks run against the body that was actually dry-run
// ---------------------------------------------------------------------------

describe("sanity checks: the checked body is the submitted body", () => {
  it("dry-runs and submits the identical kebab-case body", async () => {
    // The confirmation token hashes the {account_number, body} tuple, so any
    // drift between these two bodies would mean the checks vetted something
    // other than what went out. Asserting equality on the wire proves the
    // dispatcher builds one body for both calls.
    h = await harnessFor({ limits: EQUITY_LIMITS });
    const args = orderArgs([leg("AAPL", "Equity", "Buy to Open", 3)]);

    await expectAllowed(h, args);

    const dry = h.requests.find((r) => /orders\/dry-run$/.test(r.url));
    const live = h.requests.find(
      (r) => r.method === "POST" && /\/orders$/.test(r.url),
    );
    expect(dry?.body).toEqual(live?.body);
    expect(live?.body).toEqual({
      "time-in-force": "Day",
      "order-type": "Limit",
      source: MCP_ORDER_SOURCE,
      price: "10.00",
      "price-effect": "Debit",
      legs: [
        {
          "instrument-type": "Equity",
          symbol: "AAPL",
          action: "Buy to Open",
          quantity: 3,
        },
      ],
    });
  });

  it("checks the account state of the account the order names", async () => {
    h = await harnessFor({ status: { "is-frozen": true } });
    await expectBlocked(
      h,
      orderArgs([leg("AAPL", "Equity", "Buy to Open", 1)]),
    );

    const statusReq = h.requests.find((r) => TRADING_STATUS.test(r.url));
    expect(statusReq?.url).toBe(`/accounts/${ACCT}/trading-status`);
  });
});
