/**
 * End-to-end, adversarial tests for the dry-run-first confirmation-token flow.
 *
 * This is the mechanism that stops an agent dry-running a one-share order and
 * submitting a thousand-share one, so it is tested from the attacker's side: every
 * arg mutated one at a time, tokens replayed, forged, expired, cross-wired between
 * actions, and fed prototype keys.
 *
 * Everything runs through the real MCP protocol and the real dispatcher; the only
 * fake is the HTTP transport. That matters, because the binding is only as strong as
 * the tuple the DISPATCHER hashes: `consumeToken` cannot protect a field that
 * `buildOrderBody` never puts in the body, which a unit test of confirmation.ts
 * cannot see.
 *
 * The load-bearing invariant every refusal asserts is `liveWrites(h)` being empty:
 * not merely "an error came back", but "nothing that could move money ever reached
 * the API".
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness, RecordedRequest, Route, RouteReply } from "./harness.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import { toolError } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { GATED_ROUTES } from "../../src/api-client.js";
import {
  MCP_ORDER_SOURCE,
  TOOL_ANNOTATIONS,
} from "../../src/mcp-server/index.js";
import { accessClassFor } from "../../src/mcp-server/annotations.js";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ACCT = "5WX00001";
/** A second account, for the "dry-run here, submit there" attack. */
const OTHER_ACCT = "5WX99999";
const ORDER_ID = "1075264";
const OTHER_ORDER_ID = "1075999";
const COMPLEX_ORDER_ID = "3";

const ORDERS_URL = `/accounts/${ACCT}/orders`;
const ORDER_DRY_RUN_URL = `/accounts/${ACCT}/orders/dry-run`;
const ORDER_BY_ID_URL = `/accounts/${ACCT}/orders/${ORDER_ID}`;
const ORDER_BY_ID_DRY_RUN_URL = `${ORDER_BY_ID_URL}/dry-run`;
const COMPLEX_URL = `/accounts/${ACCT}/complex-orders`;
const COMPLEX_DRY_RUN_URL = `${COMPLEX_URL}/dry-run`;
const COMPLEX_BY_ID_DRY_RUN_URL = `${COMPLEX_URL}/${COMPLEX_ORDER_ID}/dry-run`;
const COMPLEX_BY_ID_URL = `${COMPLEX_URL}/${COMPLEX_ORDER_ID}`;
const POSITION_LIMIT_URL = `/accounts/${ACCT}/position-limit`;
const TRADING_STATUS_URL = `/accounts/${ACCT}/trading-status`;

/**
 * A well-formed UUID that was never issued. Taken from the scrubbed
 * `confirmation_token` field of the recorded dry-run payload, which is exactly
 * the kind of value a replaying or hallucinating agent would present.
 */
const NEVER_ISSUED_UUID = "00000000-0000-0000-0000-000000000000";

/** One recorded order, used as the live POST /orders response body. */
const RECORDED_ORDER = (
  loadFixture("tastytrade_get_orders") as {
    items: Array<Record<string, unknown>>;
  }
).items[0];

const PLACED_ORDER_RESPONSE = {
  order: RECORDED_ORDER,
  warnings: [],
  "buying-power-effect": { "change-in-buying-power": "102.0" },
};

/** A clean single-order dry-run reply: no `errors`, no `warnings`, small BP. */
const CLEAN_ORDER_DRY_RUN = {
  order: {
    "account-number": ACCT,
    "order-type": "Limit",
    price: "1.02",
    "price-effect": "Debit",
    "time-in-force": "Day",
    status: "Received",
  },
  warnings: [],
  "buying-power-effect": {
    "change-in-buying-power": "102.0",
    "change-in-buying-power-effect": "Debit",
  },
  "fee-calculation": { "total-fees": "0.001", "total-fees-effect": "Debit" },
};

type Leg = {
  symbol: string;
  instrument_type: string;
  action: string;
  quantity: number;
};

function leg(overrides: Partial<Leg> = {}): Leg {
  return {
    symbol: "AAPL",
    instrument_type: "Equity",
    action: "Buy to Open",
    quantity: 1,
    ...overrides,
  };
}

/** The baseline single order every binding test mutates one field of. */
function orderArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    account_number: ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.02",
    price_effect: "Debit",
    legs: [leg()],
    ...overrides,
  };
}

/** The kebab-case body the dispatcher builds from `orderArgs()` — and hashes. */
const EXPECTED_ORDER_BODY = {
  "time-in-force": "Day",
  "order-type": "Limit",
  source: MCP_ORDER_SOURCE,
  "automated-source": false,
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

/** Baseline OTOCO complex order: a trigger plus a two-order OCO bracket. */
function complexArgs(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    account_number: ACCT,
    type: "OTOCO",
    trigger_order: {
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Debit",
      legs: [leg({ symbol: "SPY" })],
    },
    orders: [
      {
        order_type: "Limit",
        time_in_force: "GTC",
        price: "99999.0",
        price_effect: "Credit",
        legs: [leg({ symbol: "SPY", action: "Sell to Close" })],
      },
      {
        order_type: "Stop",
        time_in_force: "GTC",
        stop_trigger: "1.0",
        legs: [leg({ symbol: "SPY", action: "Sell to Close" })],
      },
    ],
    ...overrides,
  };
}

function accountStateRoutes(): Route[] {
  return [
    {
      matcher: POSITION_LIMIT_URL,
      method: "GET",
      reply: {
        data: {
          "equity-order-size": 1000,
          "equity-option-order-size": 100,
          "future-order-size": 10,
        },
      },
    },
    {
      matcher: TRADING_STATUS_URL,
      method: "GET",
      reply: {
        data: {
          "is-frozen": false,
          "is-closing-only": false,
          "is-in-margin-call": false,
        },
      },
    },
  ];
}

/** Routes for the single-order flow, with a swappable dry-run reply. */
function orderRoutes(dryRun: unknown = CLEAN_ORDER_DRY_RUN): Route[] {
  return [
    { matcher: ORDER_DRY_RUN_URL, method: "POST", reply: { data: dryRun } },
    {
      matcher: ORDERS_URL,
      method: "POST",
      reply: { data: PLACED_ORDER_RESPONSE },
    },
    ...accountStateRoutes(),
  ];
}

/** Routes for the replace / edit flow (both dry-run through one endpoint). */
function replaceRoutes(dryRun: unknown = CLEAN_ORDER_DRY_RUN): Route[] {
  return [
    {
      matcher: ORDER_BY_ID_DRY_RUN_URL,
      method: "POST",
      reply: { data: dryRun },
    },
    {
      matcher: ORDER_BY_ID_URL,
      reply: { data: { ...RECORDED_ORDER, status: "Received" } },
    },
    ...accountStateRoutes(),
  ];
}

/** Routes for the complex-order flow. */
function complexRoutes(
  dryRun: unknown = loadFixture("tastytrade_dry_run_complex_order"),
): Route[] {
  return [
    { matcher: COMPLEX_DRY_RUN_URL, method: "POST", reply: { data: dryRun } },
    {
      matcher: COMPLEX_URL,
      method: "POST",
      reply: { data: { "complex-order": { id: 3, type: "OTOCO" } } },
    },
    {
      matcher: COMPLEX_BY_ID_DRY_RUN_URL,
      method: "POST",
      reply: { data: dryRun },
    },
    {
      matcher: COMPLEX_BY_ID_URL,
      reply: { data: { "complex-order": { id: 3, type: "PAIRS" } } },
    },
    ...accountStateRoutes(),
  ];
}

const open: Harness[] = [];

async function boot(
  routes: Route[],
  tokenProvider?: () => string,
): Promise<Harness> {
  const h = await createHarness({ routes, tokenProvider });
  open.push(h);
  return h;
}

/**
 * Every request that could create or modify a live order, on ANY path — so an
 * account-swap or order-id-swap attack cannot hide behind a path-specific
 * assertion. Dry-runs are excluded: they are the safe half of the flow.
 */
function liveWrites(h: Harness): RecordedRequest[] {
  return h.requests.filter(
    (r) =>
      !r.url.endsWith("/dry-run") &&
      (r.method === "POST" || r.method === "PUT" || r.method === "PATCH"),
  );
}

type DryRunOutput = Record<string, unknown> & {
  confirmation_token: string | null;
};

/** Runs a dry-run tool and asserts it handed back a usable token. */
async function issuedToken(
  h: Harness,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const out = (await callOk(h, tool, args)) as DryRunOutput;
  expect(typeof out.confirmation_token).toBe("string");
  expect(out.confirmation_token).not.toBe("");
  return out.confirmation_token as string;
}

beforeEach(() => {
  // Both stores are module-global singletons. Without these resets the
  // destructive rate-limit bucket would starve this file after a handful of
  // placements, and tokens would leak between tests.
  _resetTokensForTest();
  _resetRateLimitsForTest();
});

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

// Nothing in this file mutes stderr. Nothing on these paths writes to it
// either, and that is worth leaving unmuted rather than assumed: an adversarial
// suite is exactly where a stray log of an order body or a credential should be
// impossible to miss.

// ---------------------------------------------------------------------------
// 1. A token exists only after a clean dry-run
// ---------------------------------------------------------------------------

describe("issuance: only a clean dry-run mints a token", () => {
  it("issues a token and places the exact body the token was bound to", async () => {
    const h = await boot(orderRoutes());

    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const placed = (await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    })) as Record<string, unknown>;

    // The dry-run and the live submit must send byte-identical bodies: the
    // hashed tuple is the same object the dispatcher POSTs.
    const dryRunReq = h.requests.find((r) => r.url === ORDER_DRY_RUN_URL);
    const liveReq = liveWrites(h)[0];
    expect(dryRunReq?.body).toEqual(EXPECTED_ORDER_BODY);
    expect(liveReq.url).toBe(ORDERS_URL);
    expect(liveReq.method).toBe("POST");
    expect(liveReq.body).toEqual(EXPECTED_ORDER_BODY);
    expect(liveReq.body).toEqual(dryRunReq?.body);

    expect(placed.sanity_warnings).toEqual([]);
    // The broker's payload is under `upstream`.
    expect(
      (
        (placed.upstream as Record<string, unknown>).order as Record<
          string,
          unknown
        >
      ).id,
    ).toBe(RECORDED_ORDER.id);
  });

  it("does not let the upstream payload dictate the token", async () => {
    // A hostile or merely echoing upstream returns its own confirmation_token
    // field. The dispatcher spreads the dry-run result FIRST and its own token
    // last, so the API can never supply an acceptable token.
    const h = await boot(
      orderRoutes({
        ...CLEAN_ORDER_DRY_RUN,
        confirmation_token: NEVER_ISSUED_UUID,
      }),
    );

    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());
    expect(token).not.toBe(NEVER_ISSUED_UUID);

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: NEVER_ISSUED_UUID,
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("issues no token when the dry-run payload carries errors", async () => {
    const h = await boot(
      orderRoutes({
        ...CLEAN_ORDER_DRY_RUN,
        errors: [
          { code: "insufficient_buying_power", message: "Not enough BP." },
        ],
      }),
    );

    const out = (await callOk(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    )) as DryRunOutput;
    expect(out.confirmation_token).toBeNull();

    // With no token to present, the live call cannot proceed at all.
    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: NEVER_ISSUED_UUID,
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("issues no token when the dry-run endpoint itself rejects the order", async () => {
    const h = await boot([
      {
        matcher: ORDER_DRY_RUN_URL,
        method: "POST",
        reply: {
          status: 422,
          raw: true,
          data: { error: { code: "validation_error", errors: [] } },
        },
      },
      {
        matcher: ORDERS_URL,
        method: "POST",
        reply: { data: PLACED_ORDER_RESPONSE },
      },
    ]);

    const dryRunErr = await callError(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    );
    expect(dryRunErr.code).toBe("validation");

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: randomUUID(),
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("issues no token when `errors` is an object rather than an array", async () => {
    // The old guard was `!dryRunResult?.errors?.length`: an `errors` OBJECT has
    // no `.length`, so it read as falsy, a token WAS issued, and runSanityChecks
    // re-checked with the same shape and waved the order through. Both gates now
    // call isCleanDryRun, which treats any non-empty `errors` of any shape as a
    // failed dry-run. Unreachable against the real API (it returns an array, see
    // order-submission.md) — but it is the difference between a payload we
    // understood and one we merely failed to parse.
    const h = await boot(
      orderRoutes({
        ...CLEAN_ORDER_DRY_RUN,
        errors: {
          code: "insufficient_buying_power",
          message: "Not enough BP.",
        },
      }),
    );

    const out = (await callOk(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    )) as DryRunOutput;
    expect(out.confirmation_token).toBeNull();

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: NEVER_ISSUED_UUID,
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("issues no token when the dry-run payload is null", async () => {
    // `{data: null}` is not a shape the real API returns, but it would mint a
    // token (null has no `errors`), and runSanityChecks then dereferenced null
    // and threw a raw TypeError that adaptError flattened into an opaque
    // `upstream_error`. Now the payload never earns a token in the first place:
    // the checks cannot be run against nothing, so there is no authority to
    // grant. See test/e2e/sanity.test.ts for the module-boundary refusal.
    const h = await boot([
      {
        matcher: ORDER_DRY_RUN_URL,
        method: "POST",
        reply: { raw: true, data: { data: null } },
      },
      {
        matcher: ORDERS_URL,
        method: "POST",
        reply: { data: PLACED_ORDER_RESPONSE },
      },
      ...accountStateRoutes(),
    ]);

    const out = (await callOk(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    )) as DryRunOutput;
    expect(out.confirmation_token).toBeNull();

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: NEVER_ISSUED_UUID,
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  /**
   * The same `{data: null}` reply, aimed at the other four token-minting dry-run tools.
   *
   * The refusal above works for `tastytrade_dry_run_order` because that method unwraps
   * strictly, so `{data: null}` arrives at `isCleanDryRun` as `null` and fails its
   * readability test. A tolerant unwrap — `response.data?.data ?? response.data` —
   * turns the identical body into the truthy object `{data: null}`: readable, no
   * `errors` member, token minted. All four then accept the token, producing a live
   * POST, a live PUT and two live PATCHes, with the complex-order submit reporting only
   * that the notional cap "could not be applied" because the buying-power figure it
   * needs was never there.
   *
   * So this is not four variations on one test: it is the same defect four times,
   * because the rule was written down for one call site. `liveWrites` is the assertion
   * that matters — not "an error came back", but "nothing that could move an order was
   * sent".
   */
  const NULL_ENTITY: Route["reply"] = { raw: true, data: { data: null } };

  const replaceOrEditArgs = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.02",
    price_effect: "Debit",
  };
  const editComplexArgs = {
    account_number: ACCT,
    complex_order_id: COMPLEX_ORDER_ID,
    ratio_price_comparator: "gte",
    ratio_price_threshold: 1.5,
  };

  /** One token-minting flow, with its dry-run route answering `{data: null}`. */
  interface NullPayloadFlow {
    label: string;
    dryRunTool: string;
    submitTool: string;
    args: Record<string, unknown>;
    routes: Route[];
  }

  const nullPayloadFlows: NullPayloadFlow[] = [
    {
      label: "a replace (live PUT)",
      dryRunTool: "tastytrade_dry_run_replace_order",
      submitTool: "tastytrade_replace_order",
      args: replaceOrEditArgs,
      routes: [
        {
          matcher: ORDER_BY_ID_DRY_RUN_URL,
          method: "POST",
          reply: NULL_ENTITY,
        },
        {
          matcher: ORDER_BY_ID_URL,
          reply: { data: { ...RECORDED_ORDER, status: "Received" } },
        },
        ...accountStateRoutes(),
      ],
    },
    {
      label: "an edit (live PATCH)",
      dryRunTool: "tastytrade_dry_run_edit_order",
      submitTool: "tastytrade_edit_order",
      args: replaceOrEditArgs,
      routes: [
        {
          matcher: ORDER_BY_ID_DRY_RUN_URL,
          method: "POST",
          reply: NULL_ENTITY,
        },
        {
          matcher: ORDER_BY_ID_URL,
          reply: { data: { ...RECORDED_ORDER, status: "Received" } },
        },
        ...accountStateRoutes(),
      ],
    },
    {
      label: "a complex order (live POST, and the notional cap goes with it)",
      dryRunTool: "tastytrade_dry_run_complex_order",
      submitTool: "tastytrade_place_complex_order",
      args: complexArgs(),
      routes: [
        { matcher: COMPLEX_DRY_RUN_URL, method: "POST", reply: NULL_ENTITY },
        {
          matcher: COMPLEX_URL,
          method: "POST",
          reply: { data: { "complex-order": { id: 3, type: "OTOCO" } } },
        },
        ...accountStateRoutes(),
      ],
    },
    {
      label: "a complex-order edit (live PATCH)",
      dryRunTool: "tastytrade_dry_run_edit_complex_order",
      submitTool: "tastytrade_edit_complex_order",
      args: editComplexArgs,
      routes: [
        {
          matcher: COMPLEX_BY_ID_DRY_RUN_URL,
          method: "POST",
          reply: NULL_ENTITY,
        },
        {
          matcher: COMPLEX_BY_ID_URL,
          reply: { data: { "complex-order": { id: 3, type: "PAIRS" } } },
        },
        ...accountStateRoutes(),
      ],
    },
  ];

  for (const flow of nullPayloadFlows) {
    it(`issues no token when the dry-run payload for ${flow.label} is null`, async () => {
      const h = await boot(flow.routes);

      const out = (await callOk(h, flow.dryRunTool, flow.args)) as DryRunOutput;
      // The whole payload, not just the token: a tolerant unwrap also leaked
      // the raw envelope back to the agent as `{"data": null}`, which reads as
      // a dry-run result and is not one.
      expect(out.confirmation_token).toBeNull();
      expect(out.data).toBeUndefined();

      const err = await callError(h, flow.submitTool, {
        ...flow.args,
        confirmation_token: NEVER_ISSUED_UUID,
      });
      expect(err.code).toBe("dry_run_required");
      expect(liveWrites(h)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Single use
// ---------------------------------------------------------------------------

describe("single use", () => {
  it("refuses the second use of a token and places exactly one order", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });

    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("mints distinct tokens per dry-run, and consuming one leaves the other alone", async () => {
    // Each dry-run authorises exactly one placement: two dry-runs of the same
    // order are two authorisations, not one that can be replayed.
    const h = await boot(orderRoutes());
    const first = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());
    const second = await issuedToken(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    );
    expect(second).not.toBe(first);

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: first,
    });
    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: second,
    });
    expect(liveWrites(h)).toHaveLength(2);
  });

  it("places exactly one order when the same token is submitted twice CONCURRENTLY", async () => {
    // Single-use is only worth anything if it is atomic. Every other test here spends the
    // token, awaits the whole round trip, and only then tries again — which cannot catch
    // a check-then-act gap, because the gap has closed by the time the second call
    // starts. An agent firing parallel tool calls, or retrying one it thinks stalled, is
    // the realistic way two submits of one token overlap.
    //
    // It holds because `consumeToken` looks up and deletes in one synchronous stretch,
    // with no await between them. Two refactors were tried against this and both were
    // caught: deferring the burn to after the dispatcher's `await runSanityChecks(...)`,
    // and the sneakier variant that defers it into a `finally` so the sanity-failure test
    // below still passes. Either lets both submits through `consumeToken` while the first
    // is parked on the sanity-check round trip. The same goes for a shared store, which
    // would make the lookup async.
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    const submit = () =>
      h.client.callTool({
        name: "tastytrade_place_order",
        arguments: { ...orderArgs(), confirmation_token: token },
      }) as Promise<{
        isError?: boolean;
        content?: Array<{ text?: string }>;
      }>;

    const results = await Promise.all([submit(), submit()]);
    const refusals = results.filter((r) => r.isError === true);
    const accepted = results.filter((r) => r.isError !== true);

    // Which of the two wins is a race and is not part of the contract; that
    // exactly one wins is.
    expect(accepted).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(
      (JSON.parse(refusals[0].content?.[0]?.text ?? "{}") as { code?: string })
        .code,
    ).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("burns the token when the post-consume sanity check hard-fails", async () => {
    // consumeToken runs BEFORE runSanityChecks, so a sanity failure costs the
    // token: the agent must dry-run again rather than retry the same token.
    const h = await boot([
      {
        matcher: ORDER_DRY_RUN_URL,
        method: "POST",
        reply: { data: CLEAN_ORDER_DRY_RUN },
      },
      {
        matcher: ORDERS_URL,
        method: "POST",
        reply: { data: PLACED_ORDER_RESPONSE },
      },
      {
        matcher: POSITION_LIMIT_URL,
        method: "GET",
        reply: { data: { "equity-order-size": 1 } },
      },
      { matcher: TRADING_STATUS_URL, method: "GET", reply: { data: {} } },
    ]);

    const args = orderArgs({ legs: [leg({ quantity: 5 })] });
    const token = await issuedToken(h, "tastytrade_dry_run_order", args);

    const blocked = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: token,
    });
    expect(blocked.code).toBe("sanity_check_failed");

    const replay = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: token,
    });
    expect(replay.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("keeps the token when the call is rejected before consume", async () => {
    // validateLegActions runs ahead of consumeToken, so a malformed submit is
    // refused without spending the token — the agent can still submit the
    // order it actually dry-ran.
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    const rejected = await callError(h, "tastytrade_place_order", {
      ...orderArgs({ legs: [leg({ action: "Buy" })] }),
      confirmation_token: token,
    });
    expect(rejected.code).toBe("validation");
    expect(rejected.message).toMatch(/Invalid order action/);

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("accepts a token issued through a different server instance in the same process", async () => {
    // NOTE, not a bug for stdio (one process per session), but worth knowing:
    // the token store is a module-level Map, not per-connection state. A host
    // that multiplexed several MCP clients onto one process would let one
    // client's dry-run authorise another client's submit.
    const issuer = await boot(orderRoutes());
    const consumer = await boot(orderRoutes());

    const token = await issuedToken(
      issuer,
      "tastytrade_dry_run_order",
      orderArgs(),
    );
    await callOk(consumer, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });

    expect(liveWrites(consumer)).toHaveLength(1);
    expect(liveWrites(issuer)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Expiry — the 60-second TTL, from both sides of the boundary
// ---------------------------------------------------------------------------

describe("expiry: the 60s TTL", () => {
  beforeEach(() => {
    // Both clocks must be faked — confirmation.ts holds a monotonic deadline
    // and a wall-clock one and expires on whichever fires first — but the
    // microtask and immediate queues must not be: the MCP client, the SDK
    // transport and axios all resolve through them, and faking those deadlocks
    // every await. `advanceTimersByTime` moves both clocks together, which is
    // what an ordinary elapsed-time test wants; the two clocks are pulled apart
    // in test/safety/confirmation.test.ts, where that is the subject.
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("still accepts a token at 59s", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    jest.advanceTimersByTime(59_000);

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("still accepts a token at exactly 60s (the TTL bound is inclusive)", async () => {
    // Both deadline comparisons are strict, so the final millisecond is still
    // valid. Asserting both sides of the boundary is the only way to catch an
    // off-by-one that expired live-ready tokens a tick early.
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    jest.advanceTimersByTime(60_000);

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("refuses a token one millisecond past the TTL", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    jest.advanceTimersByTime(60_001);

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    expect(err.code).toBe("dry_run_required");
    expect(err.retryable).toBe(false);
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("reports an expired token the same way however much other traffic ran first", async () => {
    // The code an expired token produces must not depend on what OTHER tools
    // did in the meantime, and through the dispatcher that is easy to get
    // wrong: an expired entry is dropped by any dry-run's sweep, so a second
    // agent minting a token for an unrelated order would change the answer
    // the first agent got. Three presentations of one dead token, under three
    // different amounts of intervening traffic, must all come back the same.
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    jest.advanceTimersByTime(120_000);

    const submit = () =>
      callError(h, "tastytrade_place_order", {
        ...orderArgs(),
        confirmation_token: token,
      });

    // 1. Straight away, with nothing in between.
    const first = await submit();
    // 2. After an unrelated dry-run has swept the store.
    await issuedToken(h, "tastytrade_dry_run_order", orderArgs({ price: "2" }));
    const second = await submit();
    // 3. And again, now that the entry is long gone.
    const third = await submit();

    expect(first.code).toBe("dry_run_required");
    expect([second.code, third.code]).toEqual([first.code, first.code]);
    expect(first.retryable).toBe(false);
    expect((first as { hint?: string }).hint).toMatch(
      /tastytrade_dry_run_order/,
    );
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("expires a complex-order token on the same 60s clock", async () => {
    const h = await boot(complexRoutes());
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_complex_order",
      complexArgs(),
    );

    jest.advanceTimersByTime(60_001);

    const err = await callError(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: token,
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Args binding — the actual attack, one mutated field at a time
// ---------------------------------------------------------------------------

describe("args binding: any change to the order invalidates the token", () => {
  const tampers: Array<[string, Record<string, unknown>]> = [
    [
      "quantity 1 -> 100 (dry-run small, submit large)",
      { legs: [leg({ quantity: 100 })] },
    ],
    [
      "quantity 1 -> 2 (an exact binding, not a threshold)",
      { legs: [leg({ quantity: 2 })] },
    ],
    ["symbol AAPL -> TSLA", { legs: [leg({ symbol: "TSLA" })] }],
    [
      "action Buy to Open -> Sell to Close",
      { legs: [leg({ action: "Sell to Close" })] },
    ],
    [
      "instrument_type Equity -> Equity Option",
      { legs: [leg({ instrument_type: "Equity Option" })] },
    ],
    [
      "account_number (submit into a different account)",
      {
        account_number: OTHER_ACCT,
      },
    ],
    ["price 1.02 -> 10.20", { price: "10.20" }],
    ["price_effect Debit -> Credit", { price_effect: "Credit" }],
    ["order_type Limit -> Market", { order_type: "Market" }],
    ["time_in_force Day -> GTC", { time_in_force: "GTC" }],
    ["stop_trigger added", { stop_trigger: "1.00" }],
  ];

  for (const [label, patch] of tampers) {
    it(`refuses a token when ${label}`, async () => {
      const h = await boot(orderRoutes());
      const token = await issuedToken(
        h,
        "tastytrade_dry_run_order",
        orderArgs(),
      );
      const err = await callError(h, "tastytrade_place_order", {
        ...orderArgs(patch),
        confirmation_token: token,
      });

      expect(err.code).toBe("confirmation_expired");
      expect(err.message).toMatch(/parameters changed since dry-run/i);
      expect(err.retryable).toBe(false);
      expect(liveWrites(h)).toHaveLength(0);
    });
  }

  it("refuses a token when a leg is appended, though the first leg still matches", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs({ legs: [leg(), leg({ symbol: "MSFT", quantity: 500 })] }),
      confirmation_token: token,
    });
    expect(err.code).toBe("confirmation_expired");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("refuses a token when two legs are swapped (arrays bind by position)", async () => {
    // canonicalize() sorts object keys but deliberately never reorders arrays,
    // so leg order is part of the binding. Strictly this refuses a resubmission
    // that is arguably equivalent — the conservative direction for a gate whose
    // job is to fail closed.
    const twoLegs = orderArgs({ legs: [leg(), leg({ symbol: "MSFT" })] });
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", twoLegs);

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs({ legs: [leg({ symbol: "MSFT" }), leg()] }),
      confirmation_token: token,
    });
    expect(err.code).toBe("confirmation_expired");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("burns the token on a tamper attempt, so the honest args cannot be replayed", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    const tampered = await callError(h, "tastytrade_place_order", {
      ...orderArgs({ legs: [leg({ quantity: 100 })] }),
      confirmation_token: token,
    });
    expect(tampered.code).toBe("confirmation_expired");

    // Detected tampering invalidates the token outright: even the exact args
    // the dry-run approved are now refused. Fail-closed, and it denies an
    // attacker unlimited guesses against one token.
    const honest = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    expect(honest.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("binds order_id for a replace, so a token cannot be aimed at another order", async () => {
    const h = await boot([
      ...replaceRoutes(),
      {
        matcher: `/accounts/${ACCT}/orders/${OTHER_ORDER_ID}`,
        reply: { data: RECORDED_ORDER },
      },
    ]);

    const replaceArgs = {
      account_number: ACCT,
      order_id: ORDER_ID,
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Debit",
    };
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_replace_order",
      replaceArgs,
    );

    const err = await callError(h, "tastytrade_replace_order", {
      ...replaceArgs,
      order_id: OTHER_ORDER_ID,
      confirmation_token: token,
    });
    expect(err.code).toBe("confirmation_expired");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("binds the price of an edit, so an approved edit cannot become a different one", async () => {
    const h = await boot(replaceRoutes());
    const editArgs = {
      account_number: ACCT,
      order_id: ORDER_ID,
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Debit",
    };
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_edit_order",
      editArgs,
    );

    const err = await callError(h, "tastytrade_edit_order", {
      ...editArgs,
      price: "99.99",
      confirmation_token: token,
    });
    expect(err.code).toBe("confirmation_expired");
    expect(liveWrites(h)).toHaveLength(0);

    // The honest edit does go through, on a fresh token — proving the refusal
    // above was the binding and not a broken route.
    const fresh = await issuedToken(
      h,
      "tastytrade_dry_run_edit_order",
      editArgs,
    );
    await callOk(h, "tastytrade_edit_order", {
      ...editArgs,
      confirmation_token: fresh,
    });
    const patched = liveWrites(h)[0];
    expect(patched.method).toBe("PATCH");
    expect(patched.url).toBe(ORDER_BY_ID_URL);
    expect(patched.body).toEqual({
      source: MCP_ORDER_SOURCE,
      "automated-source": false,
      "order-type": "Limit",
      price: "1.02",
      "price-effect": "Debit",
      "time-in-force": "Day",
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Canonicalization — the flip side: logically identical args must pass
// ---------------------------------------------------------------------------

describe("canonicalization: logically identical args are still accepted", () => {
  // Worth being precise about what this proves end-to-end. The hash is taken
  // over the body the dispatcher BUILDS (buildOrderBody), whose keys are
  // inserted in a fixed order, so the recursive key sort in canonicalize() is
  // defence in depth rather than the thing doing the work here. What these
  // tests do lock in is the agent-visible contract: reordering fields, or
  // adding fields the seam does not forward, must not break a valid token.
  it("accepts a token when the top-level args are reordered", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    await callOk(h, "tastytrade_place_order", {
      legs: [leg()],
      price_effect: "Debit",
      time_in_force: "Day",
      confirmation_token: token,
      price: "1.02",
      order_type: "Limit",
      account_number: ACCT,
    });
    expect(liveWrites(h)).toHaveLength(1);
    expect(liveWrites(h)[0].body).toEqual(EXPECTED_ORDER_BODY);
  });

  it("accepts a token when the keys inside a leg are reordered", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs({
        legs: [
          {
            quantity: 1,
            action: "Buy to Open",
            instrument_type: "Equity",
            symbol: "AAPL",
          },
        ],
      }),
      confirmation_token: token,
    });
    expect(liveWrites(h)).toHaveLength(1);
    expect(liveWrites(h)[0].body).toEqual(EXPECTED_ORDER_BODY);
  });

  it("accepts a token when a nested component order of a complex order is reordered", async () => {
    const h = await boot(complexRoutes());
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_complex_order",
      complexArgs(),
    );

    const reordered = complexArgs({
      trigger_order: {
        legs: [
          {
            quantity: 1,
            symbol: "SPY",
            action: "Buy to Open",
            instrument_type: "Equity",
          },
        ],
        price_effect: "Debit",
        price: "1.02",
        time_in_force: "Day",
        order_type: "Limit",
      },
    });

    await callOk(h, "tastytrade_place_complex_order", {
      ...reordered,
      confirmation_token: token,
    });
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("drops an unknown top-level arg rather than letting it break or ride along", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
      quantity: 9999,
      "order-type": "Market",
      not_a_real_field: { anything: true },
    });

    // Unknown args are neither hashed nor forwarded: the seam whitelists
    // fields, so there is nothing to smuggle past the binding.
    expect(liveWrites(h)).toHaveLength(1);
    expect(liveWrites(h)[0].body).toEqual(EXPECTED_ORDER_BODY);
  });

  it("drops an unknown field inside a leg rather than forwarding it", async () => {
    const h = await boot(orderRoutes());
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    await callOk(h, "tastytrade_place_order", {
      ...orderArgs({
        legs: [{ ...leg(), price: "0.01", "remaining-quantity": 500 }],
      }),
      confirmation_token: token,
    });
    expect(liveWrites(h)).toHaveLength(1);
    expect(liveWrites(h)[0].body).toEqual(EXPECTED_ORDER_BODY);
  });
});

// ---------------------------------------------------------------------------
// 6. Action binding — a token is valid for one action only
// ---------------------------------------------------------------------------

describe("action binding", () => {
  const replaceArgs = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.02",
    price_effect: "Debit",
  };

  it("refuses a place_order token on replace_order and on edit_order", async () => {
    const h = await boot([...orderRoutes(), ...replaceRoutes()]);

    const first = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());
    const onReplace = await callError(h, "tastytrade_replace_order", {
      ...replaceArgs,
      confirmation_token: first,
    });
    expect(onReplace.code).toBe("dry_run_required");
    expect(onReplace.message).toMatch(/issued for "place_order"/);

    const second = await issuedToken(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    );
    const onEdit = await callError(h, "tastytrade_edit_order", {
      ...replaceArgs,
      confirmation_token: second,
    });
    expect(onEdit.code).toBe("dry_run_required");
    expect(onEdit.message).toMatch(/issued for "place_order"/);

    expect(liveWrites(h)).toHaveLength(0);
  });

  it("refuses a replace_order token on place_order", async () => {
    const h = await boot([...orderRoutes(), ...replaceRoutes()]);
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_replace_order",
      replaceArgs,
    );

    const err = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });
    expect(err.code).toBe("dry_run_required");
    expect(err.message).toMatch(/issued for "replace_order"/);
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("refuses an edit_order token on replace_order, which is the only thing separating them", async () => {
    // buildEditBody and buildReplaceBody emit the SAME key set for these args
    // (order-type, time-in-force, price, price-effect) in different insertion
    // orders, and canonicalize() sorts keys — so the two argsHashes are equal.
    // The action binding is therefore the only barrier between "PATCH this
    // price" and "cancel and resubmit the whole order", which have different
    // consequences if the order partially filled in between.
    const h = await boot(replaceRoutes());
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_edit_order",
      replaceArgs,
    );

    const err = await callError(h, "tastytrade_replace_order", {
      ...replaceArgs,
      confirmation_token: token,
    });
    expect(err.code).toBe("dry_run_required");
    expect(err.message).toMatch(/issued for "edit_order", not "replace_order"/);
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("accepts each dry-run token on its own action", async () => {
    const h = await boot(replaceRoutes());

    const replaceToken = await issuedToken(
      h,
      "tastytrade_dry_run_replace_order",
      replaceArgs,
    );
    await callOk(h, "tastytrade_replace_order", {
      ...replaceArgs,
      confirmation_token: replaceToken,
    });
    expect(liveWrites(h)[0].method).toBe("PUT");

    const editToken = await issuedToken(
      h,
      "tastytrade_dry_run_edit_order",
      replaceArgs,
    );
    await callOk(h, "tastytrade_edit_order", {
      ...replaceArgs,
      confirmation_token: editToken,
    });
    expect(liveWrites(h)[1].method).toBe("PATCH");
  });

  it("refuses a complex-order token on place_order and vice versa", async () => {
    const h = await boot([...orderRoutes(), ...complexRoutes()]);

    const complexToken = await issuedToken(
      h,
      "tastytrade_dry_run_complex_order",
      complexArgs(),
    );
    const onSingle = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: complexToken,
    });
    expect(onSingle.code).toBe("dry_run_required");
    expect(onSingle.message).toMatch(/issued for "place_complex_order"/);

    const singleToken = await issuedToken(
      h,
      "tastytrade_dry_run_order",
      orderArgs(),
    );
    const onComplex = await callError(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: singleToken,
    });
    expect(onComplex.code).toBe("dry_run_required");
    expect(onComplex.message).toMatch(/issued for "place_order"/);

    expect(liveWrites(h)).toHaveLength(0);
  });

  it("refuses an edit_complex_order token on place_complex_order", async () => {
    const h = await boot(complexRoutes());
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_edit_complex_order",
      {
        account_number: ACCT,
        complex_order_id: COMPLEX_ORDER_ID,
        ratio_price_threshold: 1.5,
      },
    );

    const err = await callError(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: token,
    });
    expect(err.code).toBe("dry_run_required");
    expect(err.message).toMatch(/issued for "edit_complex_order"/);
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("burns the token on a wrong-action attempt", async () => {
    const h = await boot([...orderRoutes(), ...replaceRoutes()]);
    const token = await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    await callError(h, "tastytrade_replace_order", {
      ...replaceArgs,
      confirmation_token: token,
    });
    const afterwards = await callError(h, "tastytrade_place_order", {
      ...orderArgs(),
      confirmation_token: token,
    });

    expect(afterwards.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Missing, malformed and fabricated tokens
// ---------------------------------------------------------------------------

/**
 * The destructive tools that must not be callable without a dry-run first:
 * every one of them can open, enlarge or reprice a live position.
 */
const GATED = [
  "tastytrade_place_order",
  "tastytrade_place_complex_order",
  "tastytrade_replace_order",
  "tastytrade_edit_order",
  "tastytrade_edit_complex_order",
] as const;

/**
 * The destructive tools that deliberately need no token, each with the reason.
 * All of them either reduce exposure or touch no position at all, so requiring
 * a dry-run would make the safe action the slow one — the wrong incentive when
 * the account is moving against you.
 */
const UNGATED_DESTRUCTIVE: Record<string, string> = {
  tastytrade_cancel_order: "cancels a working order — reduces exposure",
  tastytrade_cancel_complex_order:
    "cancels a working strategy — reduces exposure",
  tastytrade_delete_quote_alert: "deletes an alert; moves no money",
  tastytrade_delete_watchlist: "deletes a saved list; moves no money",
  // Reclassified from write to destructive, because each
  // issues a full-replacement PUT that can empty the list. Still ungated, and
  // deliberately: a confirmation token is the money-path control, and these move
  // no money. What they gained is an honest `destructiveHint` for the client's
  // approval UI, the destructive rate budget, and a refusal when `symbols` is
  // absent rather than a silent wipe. That an explicit `symbols: []` still
  // empties the list with no second step is a declared residual, not an
  // oversight.
  tastytrade_update_watchlist:
    "replaces a saved list's contents; moves no money",
  tastytrade_add_watchlist_symbol:
    "rewrites a saved list to add one entry; moves no money",
  tastytrade_remove_watchlist_symbol:
    "rewrites a saved list to drop one entry; moves no money",
};

describe("missing, malformed and fabricated tokens", () => {
  const bogus: Array<[string, unknown]> = [
    ["an empty string", ""],
    ["whitespace", "   "],
    ["arbitrary text", "not-a-token"],
    ["a token-shaped string", "confirmation_token"],
    ["a fresh UUID that was never issued", randomUUID()],
    ["the all-zero UUID from a recorded payload", NEVER_ISSUED_UUID],
    ["a prototype key", "__proto__"],
    ["another prototype key", "constructor"],
    ["an inherited method name", "toString"],
    ["a number", 12345],
    ["null", null],
    ["a boolean", true],
    ["an object", { token: "x" }],
    ["an array", ["a", "b"]],
  ];

  for (const [label, value] of bogus) {
    it(`refuses ${label} with a structured error and no live write`, async () => {
      const h = await boot(orderRoutes());
      // A real token exists concurrently, so a refusal cannot be an artefact of
      // an empty store — the lookup genuinely has to miss.
      await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

      const err = await callError(h, "tastytrade_place_order", {
        ...orderArgs(),
        confirmation_token: value,
      });
      expect(err.code).toBe("dry_run_required");
      expect(err.retryable).toBe(false);
      expect(liveWrites(h)).toHaveLength(0);
    });
  }

  it("refuses an omitted confirmation_token", async () => {
    const h = await boot(orderRoutes());
    await issuedToken(h, "tastytrade_dry_run_order", orderArgs());

    const err = await callError(h, "tastytrade_place_order", orderArgs());
    expect(err.code).toBe("dry_run_required");
    expect(err.message).toMatch(/no usable confirmation token/i);
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("refuses every destructive order tool with no token at all", async () => {
    const h = await boot([
      ...orderRoutes(),
      ...replaceRoutes(),
      ...complexRoutes(),
    ]);

    const calls: Array<[string, Record<string, unknown>]> = [
      ["tastytrade_place_order", orderArgs()],
      ["tastytrade_place_complex_order", complexArgs()],
      [
        "tastytrade_replace_order",
        {
          account_number: ACCT,
          order_id: ORDER_ID,
          order_type: "Limit",
          time_in_force: "Day",
        },
      ],
      [
        "tastytrade_edit_order",
        {
          account_number: ACCT,
          order_id: ORDER_ID,
          order_type: "Limit",
          time_in_force: "Day",
        },
      ],
      [
        "tastytrade_edit_complex_order",
        {
          account_number: ACCT,
          complex_order_id: COMPLEX_ORDER_ID,
          ratio_price_threshold: 2,
        },
      ],
    ];

    // Tied to the registry invariant below, so a newly gated tool cannot be
    // added to one list and forgotten in the other.
    expect(calls.map(([tool]) => tool).sort()).toEqual([...GATED].sort());

    for (const [tool, args] of calls) {
      const err = await callError(h, tool, args);
      expect(err.code).toBe("dry_run_required");
    }
    expect(liveWrites(h)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7b. The gate is advertised, not just enforced
// ---------------------------------------------------------------------------

describe("registry: the confirmation gate is advertised, not only enforced", () => {
  // Read-only mode withholds every destructive tool, which would make the
  // partition below vacuously true. Cleared explicitly rather than trusted.
  let previousReadOnly: string | undefined;
  beforeEach(() => {
    previousReadOnly = process.env.TASTYTRADE_READ_ONLY;
    delete process.env.TASTYTRADE_READ_ONLY;
  });
  afterEach(() => {
    if (previousReadOnly === undefined) delete process.env.TASTYTRADE_READ_ONLY;
    else process.env.TASTYTRADE_READ_ONLY = previousReadOnly;
  });

  it("sorts every destructive tool into gated or explicitly-ungated", async () => {
    // A new destructive tool lands in neither list and fails here, which is the
    // point: someone has to say in writing whether it can move money. The
    // runtime refusal is not enough on its own — `consumeToken(undefined)`
    // throws for a tool nobody remembered to gate as readily as for one that
    // was designed to be, so "it throws" proves nothing about intent.
    const h = await boot([]);
    const { tools } = await h.client.listTools();

    const destructive = tools
      .filter((t) => accessClassFor(TOOL_ANNOTATIONS[t.name]) === "destructive")
      .map((t) => t.name)
      .sort();

    expect(destructive).toEqual(
      [...GATED, ...Object.keys(UNGATED_DESTRUCTIVE)].sort(),
    );
  });

  it("marks confirmation_token REQUIRED in the schema every gated tool publishes", async () => {
    // An agent plans against the advertised schema, and this is the field that
    // tells it a dry-run has to come first. Dropping `confirmation_token` from
    // `required` changes no runtime behaviour — the dispatcher still refuses —
    // so nothing else in the suite notices, while the tool now advertises
    // itself as submittable in one step.
    const h = await boot([]);
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of GATED) {
      const schema = byName.get(name)?.inputSchema as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      expect(schema?.required ?? []).toContain("confirmation_token");
      expect(schema?.properties ?? {}).toHaveProperty("confirmation_token");
    }
  });

  it("leaves the risk-reducing tools free of a token they should not need", async () => {
    // The complement, so the gate cannot be "fixed" by requiring a token
    // everywhere: making a cancel wait for a dry-run round trip is a safety
    // regression, not an improvement.
    const h = await boot([]);
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    for (const name of Object.keys(UNGATED_DESTRUCTIVE)) {
      const schema = byName.get(name)?.inputSchema as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      expect(schema?.required ?? []).not.toContain("confirmation_token");
      expect(schema?.properties ?? {}).not.toHaveProperty("confirmation_token");
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Complex orders get the same treatment
// ---------------------------------------------------------------------------

describe("complex orders", () => {
  /** The kebab body the dispatcher builds from complexArgs() — and hashes. */
  const EXPECTED_COMPLEX_BODY = {
    type: "OTOCO",
    source: MCP_ORDER_SOURCE,
    "automated-source": false,
    "trigger-order": {
      "order-type": "Limit",
      "time-in-force": "Day",
      price: "1.02",
      "price-effect": "Debit",
      legs: [
        {
          "instrument-type": "Equity",
          symbol: "SPY",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    },
    orders: [
      {
        "order-type": "Limit",
        "time-in-force": "GTC",
        price: "99999.0",
        "price-effect": "Credit",
        legs: [
          {
            "instrument-type": "Equity",
            symbol: "SPY",
            action: "Sell to Close",
            quantity: 1,
          },
        ],
      },
      {
        "order-type": "Stop",
        "time-in-force": "GTC",
        "stop-trigger": "1.0",
        legs: [
          {
            "instrument-type": "Equity",
            symbol: "SPY",
            action: "Sell to Close",
            quantity: 1,
          },
        ],
      },
    ],
  };

  it("places the exact body the token was bound to, and surfaces dry-run warnings", async () => {
    const h = await boot(complexRoutes());
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_complex_order",
      complexArgs(),
    );

    const placed = (await callOk(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: token,
    })) as Record<string, unknown>;

    const dryRunReq = h.requests.find((r) => r.url === COMPLEX_DRY_RUN_URL);
    const liveReq = liveWrites(h)[0];
    expect(dryRunReq?.body).toEqual(EXPECTED_COMPLEX_BODY);
    expect(liveReq.url).toBe(COMPLEX_URL);
    expect(liveReq.body).toEqual(EXPECTED_COMPLEX_BODY);

    // The warnings the recorded dry-run carried are replayed from the stored
    // dry-run result, not re-fetched — that is why the token holds onto it.
    // They are the BROKER's notes, so they arrive under
    // an upstream name; `sanity_warnings` carries this server's own findings and
    // there are none on this account.
    expect(placed.upstream_notes).toEqual([
      "You cannot route a closing order without an existing position to close. This order will be updated to a sell to open order when routed.",
      "Your order will begin working during next valid session.",
    ]);
    expect(placed.sanity_warnings).toEqual([]);
  });

  it("is single-use", async () => {
    const h = await boot(complexRoutes());
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_complex_order",
      complexArgs(),
    );

    await callOk(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: token,
    });
    const err = await callError(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: token,
    });

    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(1);
  });

  it("issues no token when the complex dry-run payload carries errors", async () => {
    const fixture = loadFixture("tastytrade_dry_run_complex_order") as Record<
      string,
      unknown
    >;
    const h = await boot(
      complexRoutes({
        ...fixture,
        errors: [{ code: "invalid_pairs_ratio", message: "Bad ratio." }],
      }),
    );

    const out = (await callOk(
      h,
      "tastytrade_dry_run_complex_order",
      complexArgs(),
    )) as DryRunOutput;
    expect(out.confirmation_token).toBeNull();

    const err = await callError(h, "tastytrade_place_complex_order", {
      ...complexArgs(),
      confirmation_token: NEVER_ISSUED_UUID,
    });
    expect(err.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  const complexTampers: Array<[string, Record<string, unknown>]> = [
    [
      "a child leg's quantity is raised",
      {
        orders: [
          {
            order_type: "Limit",
            time_in_force: "GTC",
            price: "99999.0",
            price_effect: "Credit",
            legs: [
              leg({ symbol: "SPY", action: "Sell to Close", quantity: 500 }),
            ],
          },
          {
            order_type: "Stop",
            time_in_force: "GTC",
            stop_trigger: "1.0",
            legs: [leg({ symbol: "SPY", action: "Sell to Close" })],
          },
        ],
      },
    ],
    [
      "the trigger order's price is changed",
      {
        trigger_order: {
          order_type: "Limit",
          time_in_force: "Day",
          price: "500.00",
          price_effect: "Debit",
          legs: [leg({ symbol: "SPY" })],
        },
      },
    ],
    ["the strategy type is changed", { type: "OCO" }],
    ["the account number is changed", { account_number: OTHER_ACCT }],
    [
      "a whole child order is dropped",
      {
        orders: [
          {
            order_type: "Limit",
            time_in_force: "GTC",
            price: "99999.0",
            price_effect: "Credit",
            legs: [leg({ symbol: "SPY", action: "Sell to Close" })],
          },
        ],
      },
    ],
  ];

  for (const [label, patch] of complexTampers) {
    it(`refuses the token when ${label}`, async () => {
      const h = await boot(complexRoutes());
      const token = await issuedToken(
        h,
        "tastytrade_dry_run_complex_order",
        complexArgs(),
      );

      const err = await callError(h, "tastytrade_place_complex_order", {
        ...complexArgs(patch),
        confirmation_token: token,
      });
      expect(err.code).toBe("confirmation_expired");
      expect(err.message).toMatch(/parameters changed since dry-run/i);
      expect(liveWrites(h)).toHaveLength(0);
    });
  }

  it("burns the complex token when the flattened-leg sanity check hard-fails", async () => {
    // flattenLegs walks trigger-order + orders[].legs, so the limit check sees
    // the trigger leg too. The token is spent before that check runs.
    const fixture = loadFixture("tastytrade_dry_run_complex_order");
    const h = await boot([
      {
        matcher: COMPLEX_DRY_RUN_URL,
        method: "POST",
        reply: { data: fixture },
      },
      {
        matcher: COMPLEX_URL,
        method: "POST",
        reply: { data: { "complex-order": { id: 3 } } },
      },
      {
        matcher: POSITION_LIMIT_URL,
        method: "GET",
        reply: { data: { "equity-order-size": 10 } },
      },
      { matcher: TRADING_STATUS_URL, method: "GET", reply: { data: {} } },
    ]);

    const args = complexArgs({
      trigger_order: {
        order_type: "Limit",
        time_in_force: "Day",
        price: "1.02",
        price_effect: "Debit",
        legs: [leg({ symbol: "SPY", quantity: 50 })],
      },
    });
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_complex_order",
      args,
    );

    const blocked = await callError(h, "tastytrade_place_complex_order", {
      ...args,
      confirmation_token: token,
    });
    expect(blocked.code).toBe("sanity_check_failed");
    expect(blocked.message).toMatch(/exceeds account order limit 10/);

    const replay = await callError(h, "tastytrade_place_complex_order", {
      ...args,
      confirmation_token: token,
    });
    expect(replay.code).toBe("dry_run_required");
    expect(liveWrites(h)).toHaveLength(0);
  });

  it("binds complex_order_id on a PAIRS-threshold edit", async () => {
    const h = await boot([
      ...complexRoutes(),
      {
        matcher: `${COMPLEX_URL}/9/dry-run`,
        method: "POST",
        reply: { data: loadFixture("tastytrade_dry_run_complex_order") },
      },
      { matcher: `${COMPLEX_URL}/9`, reply: { data: { id: 9 } } },
    ]);

    const editArgs = {
      account_number: ACCT,
      complex_order_id: COMPLEX_ORDER_ID,
      ratio_price_comparator: "gte",
      ratio_price_threshold: 1.5,
    };
    const token = await issuedToken(
      h,
      "tastytrade_dry_run_edit_complex_order",
      editArgs,
    );

    const err = await callError(h, "tastytrade_edit_complex_order", {
      ...editArgs,
      complex_order_id: "9",
      confirmation_token: token,
    });
    expect(err.code).toBe("confirmation_expired");
    expect(liveWrites(h)).toHaveLength(0);

    const fresh = await issuedToken(
      h,
      "tastytrade_dry_run_edit_complex_order",
      editArgs,
    );
    await callOk(h, "tastytrade_edit_complex_order", {
      ...editArgs,
      confirmation_token: fresh,
    });
    expect(liveWrites(h)).toHaveLength(1);
    expect(liveWrites(h)[0].body).toEqual({
      "ratio-price-comparator": "gte",
      "ratio-price-threshold": 1.5,
    });
  });
});

// ---------------------------------------------------------------------------
// The retry advice on a request whose token is already gone
// ---------------------------------------------------------------------------

describe("a still-repeatable failure on the live write, after the token has been spent", () => {
  /**
   * `retryable: true` is a machine-readable instruction — "this identical call may be
   * repeated" — and on a token-gated write it is false the instant `consumeToken`
   * returns. The token is single-use and spent BEFORE the request goes out, so the
   * repeat the flag invites comes back `dry_run_required`, which reads as an unrelated
   * second fault at the exact moment the real one is happening.
   *
   * The distinction is about the token, not the verb, which is why it cannot live in
   * the transport: `tastytrade_cancel_order` is a DELETE with no handshake, so its 429
   * IS safely repeatable and stays `retryable: true`. Only the five handlers that spend
   * a token correct the flag.
   *
   * It is not about the CODE either. Enumerating the tools and pinning one fault lets
   * the never-dispatched transport class walk through the same handlers with
   * `{code: "network", retryable: true}` and no mention of the spent token. So the
   * faults are enumerated too, and the matrix is the cross product.
   */
  const REPEATABLE_FAULTS: ReadonlyArray<{
    /** Names the row in the test title. */
    label: string;
    reply: RouteReply;
    /** The code the taxonomy assigns; the rewrite must not change it. */
    code: string;
    /** Whether the taxonomy attaches a backoff the agent must honour. */
    backoff: boolean;
    /**
     * What the refusal has to say became of the request, and what it must not.
     *
     * Not a phrasing check — the claim itself is the contract. "Refused for
     * rate-limiting" and "never reached the broker" are the two answers to the
     * one question an agent asks after a failed write ("do I have to go and
     * look?"), and telling it the first about an unreachable host is precisely
     * the untruth this row was added to catch. Both patterns are deliberately
     * loose about wording and strict about the claim.
     */
    attributes: RegExp;
    misattributes: RegExp;
  }> = [
    // Refused rather than applied: src/safety/errors.ts calls it retryable for
    // a good reason, which is true of the request and false of the call.
    {
      label: "a 429",
      reply: { status: 429 },
      code: "rate_limit_exceeded",
      backoff: true,
      attributes: /rate.?limit/i,
      misattributes: /dispatch|connect/i,
    },
    // Never dispatched: NEVER_DISPATCHED_ERROR_CODES in api-client.ts
    // deliberately declines to dress these as unacknowledged writes, so they
    // arrive here untouched — `network`, retryable, and silent about the token.
    // Two of the five codes, one per failure stage: SYN refused, DNS unresolved.
    {
      label: "ECONNREFUSED",
      reply: { networkError: "ECONNREFUSED" },
      code: "network",
      backoff: false,
      attributes: /dispatch|connect/i,
      misattributes: /rate.?limit/i,
    },
    {
      label: "EAI_AGAIN",
      reply: { networkError: "EAI_AGAIN" },
      code: "network",
      backoff: false,
      attributes: /dispatch|connect/i,
      misattributes: /rate.?limit/i,
    },
  ];

  /** The five tools that call `consumeToken` before their live request. */
  const TOKEN_GATED: ReadonlyArray<{
    name: string;
    dryRun: string;
    routes: () => Route[];
    args: Record<string, unknown>;
    liveWrite: { matcher: string; method: string };
  }> = [
    {
      name: "tastytrade_place_order",
      dryRun: "tastytrade_dry_run_order",
      routes: orderRoutes,
      args: orderArgs(),
      liveWrite: { matcher: ORDERS_URL, method: "POST" },
    },
    {
      name: "tastytrade_replace_order",
      dryRun: "tastytrade_dry_run_replace_order",
      routes: replaceRoutes,
      args: {
        account_number: ACCT,
        order_id: ORDER_ID,
        order_type: "Limit",
        time_in_force: "Day",
        price: "1.03",
        price_effect: "Debit",
      },
      liveWrite: { matcher: ORDER_BY_ID_URL, method: "PUT" },
    },
    {
      name: "tastytrade_edit_order",
      dryRun: "tastytrade_dry_run_edit_order",
      routes: replaceRoutes,
      args: {
        account_number: ACCT,
        order_id: ORDER_ID,
        order_type: "Limit",
        time_in_force: "Day",
        price: "1.04",
        price_effect: "Debit",
      },
      liveWrite: { matcher: ORDER_BY_ID_URL, method: "PATCH" },
    },
    {
      name: "tastytrade_place_complex_order",
      dryRun: "tastytrade_dry_run_complex_order",
      routes: complexRoutes,
      args: complexArgs(),
      liveWrite: { matcher: COMPLEX_URL, method: "POST" },
    },
    {
      name: "tastytrade_edit_complex_order",
      dryRun: "tastytrade_dry_run_edit_complex_order",
      routes: complexRoutes,
      args: {
        account_number: ACCT,
        complex_order_id: COMPLEX_ORDER_ID,
        ratio_price_comparator: "gte",
        ratio_price_threshold: 1.5,
      },
      liveWrite: { matcher: COMPLEX_BY_ID_URL, method: "PATCH" },
    },
  ];

  /**
   * Every (tool, fault) pair. The cross product rather than one representative
   * of each axis, because the two defects this block exists for were both
   * "handled on one member of the family and not the twin" — the first version
   * covered all five tools and one fault, and missed a whole fault class.
   */
  const MATRIX = TOKEN_GATED.flatMap((tool) =>
    REPEATABLE_FAULTS.map((fault) => ({ tool, fault })),
  );

  it.each(MATRIX)(
    "$tool.name stops calling itself repeatable after $fault.label",
    async ({ tool, fault }) => {
      const h = await boot([
        { ...tool.liveWrite, reply: fault.reply },
        ...tool.routes(),
      ]);
      const token = await issuedToken(h, tool.dryRun, tool.args);

      // Read as the full taxonomy shape: the harness's convenience type names
      // only the three members every envelope has, and the whole point here is
      // the advisory members.
      const err = (await callError(h, tool.name, {
        ...tool.args,
        confirmation_token: token,
      })) as ToolError;

      // The classification is still the truth about what went wrong, and the
      // rewrite must not blur a throttle into an unreachable host.
      expect(err.code).toBe(fault.code);

      // What must not survive is the instruction to repeat.
      expect(err.retryable).toBe(false);

      // The backoff survives where there is one — the agent still has to wait
      // before doing anything at all against this endpoint — and the advice
      // may only send it to a field the envelope actually carries.
      const advice = `${err.message} ${err.hint ?? ""}`;
      if (fault.backoff) {
        expect(err.upstream?.status).toBe(429);
        expect(err.retry_after_ms).toBeGreaterThan(0);
        expect(advice).toContain("retry_after_ms");
      } else {
        expect(err.retry_after_ms).toBeUndefined();
        expect(advice).not.toContain("retry_after_ms");
      }

      // And the agent has to be told what to do instead, because the obvious
      // reading of `retryable: false` — "this can never work" — is also wrong.
      // Two facts, both load-bearing: the token is gone, and a dry-run is the
      // way back.
      expect(advice).toMatch(/confirmation token/i);
      expect(advice).toMatch(/dry.?run/i);

      // And it has to name the right cause: an agent decides whether to go and
      // reconcile on this sentence, not on the code.
      expect(advice).toMatch(fault.attributes);
      expect(advice).not.toMatch(fault.misattributes);

      // The claim the advice rests on: the repeat really is refused.
      const repeat = await callError(h, tool.name, {
        ...tool.args,
        confirmation_token: token,
      });
      expect(repeat.code).toBe("dry_run_required");
    },
  );

  it("corrects the same flag when the credential exchange is what failed", async () => {
    /**
     * The class neither the tools table nor the fault table above can reach, and the
     * reason this keys on `retryable` instead of a list of codes.
     *
     * `TastytradeOAuthClient` classifies its own grant failures as a RETRYABLE
     * `upstream_error`, and it is right to: a grant exchanges a credential and moves
     * nothing, so repeating it is safe. But the api-client request interceptor awaits
     * that grant, so on a token-gated write the rejection arrives after `consumeToken`
     * has already burned the token, and the flag invites the one repeat that cannot work.
     *
     * `upstream_error` is neither of the two codes a code-list rewrite would know about,
     * and no fault this suite can route produces it on a write — `adaptRequestFailure`
     * forces every other write failure non-retryable first. So it is injected at the seam
     * it really comes from.
     */
    let grantWorks = true;
    const h = await boot(orderRoutes(), () => {
      if (!grantWorks) {
        throw toolError({
          code: "upstream_error",
          message: "The tastytrade token endpoint failed with HTTP 503.",
          retryable: true,
        });
      }
      return "test-access-token";
    });
    const args = orderArgs();
    const token = await issuedToken(h, "tastytrade_dry_run_order", args);

    grantWorks = false;
    const err = (await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: token,
    })) as ToolError;

    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(false);

    // No claim is made about what became of the request, because nothing here
    // proves one — an unattributable grant failure is exactly the case where
    // "nothing was submitted" would be the expensive thing to get wrong. What
    // the agent is owed, and gets, is the token and the way back.
    const advice = `${err.message} ${err.hint ?? ""}`;
    expect(advice).toMatch(/confirmation token/i);
    expect(advice).toMatch(/dry.?run/i);

    // Nothing reached the order endpoint, so the repeat is refused for the
    // usual reason and the agent is not left guessing.
    expect(liveWrites(h)).toHaveLength(0);
    const repeat = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: token,
    });
    expect(repeat.code).toBe("dry_run_required");
  });

  it("covers every tool that spends a confirmation token", () => {
    // The defect this describe block fixes was applied to `place` and not to
    // `replace` twice before in this repository, so the list above is checked
    // against the dispatcher rather than maintained by hand: any new tool that
    // calls consumeToken has to appear here or this fails.
    const dispatcher = readFileSync(
      path.join(REPO_ROOT, "src", "mcp-server", "index.ts"),
      "utf8",
    );
    const SPENDER = /consumeToken\(\s*args\.confirmation_token,\s*"(\w+)"/g;
    const spenders = [...dispatcher.matchAll(SPENDER)].map(
      (m) => `tastytrade_${m[1]}`,
    );
    expect(spenders.length).toBeGreaterThan(0);
    expect([...new Set(spenders)].sort()).toEqual(
      TOKEN_GATED.map((t) => t.name).sort(),
    );

    // Derivation only works while the derivation sees everything. The pattern
    // above reads the action name straight out of the call, which means it only
    // matches the shape all five spenders happen to be written in today —
    // `consumeToken(args.confirmation_token, "…"`. A sixth that assigned the
    // token to a local first, or reordered the arguments, would be invisible to
    // it, and this test would keep passing while the list it guards went stale.
    // So the two counts are compared: every call to consumeToken anywhere in
    // the dispatcher must be one this pattern could read. A mention inside a
    // comment trips it too, which is the cheap direction to be wrong in — a
    // comment is one word away from not matching, an unnoticed spender is the
    // defect this block exists for.
    const allCalls = dispatcher.match(/\bconsumeToken\(/g) ?? [];
    expect(allCalls.length).toBe(spenders.length);
  });

  it("gives every token-gated tool a route pair, and nothing else one", () => {
    // `GATED_ROUTES` is where each gated action's submit
    // target and its pre-flight target are rendered, and it is what the gate
    // compares. A sixth gated tool with no entry would have no target to bind,
    // and an entry with no gated tool is a route nothing checks — so the two
    // registries are asserted equal rather than merely overlapping.
    expect(
      Object.keys(GATED_ROUTES)
        .map((action) => `tastytrade_${action}`)
        .sort(),
    ).toEqual(TOKEN_GATED.map((tool) => tool.name).sort());
  });
});

// ---------------------------------------------------------------------------
// 12. A pre-flight authorises exactly the endpoint it pre-flighted
//
// The args hash covers the body and the arguments. It cannot cover the request
// TARGET, because the target is a function of the arguments AFTER the URL layer
// normalises them: `order_id` of `.` is byte-identical on both legs, and
// `/accounts/A/orders/./dry-run` collapses to the PLACE-order pre-flight while
// `/accounts/A/orders/.` collapses to the orders collection — one endpoint
// pre-flighted, a different one submitted to, on a hash that agreed.
//
// The collapse is observable only against a real HTTP origin, since the offline
// adapter sits ABOVE URL normalisation, so what is asserted here is the consequence:
// no live write reaches the transport.
// ---------------------------------------------------------------------------

const TARGET_ROUTES: Route[] = [
  {
    matcher: /^\/accounts\/[^?]*$/,
    reply: {
      data: {
        order: { status: "Received" },
        warnings: [],
        "buying-power-effect": { "change-in-buying-power": "102.0" },
      },
    },
  },
  ...accountStateRoutes(),
];

const REPLACE_ARGS = {
  account_number: ACCT,
  order_id: ".",
  order_type: "Limit",
  time_in_force: "Day",
  price: "1.02",
  price_effect: "Debit",
};

const EDIT_ARGS = { account_number: ACCT, order_id: "..", price: "1.02" };

describe("a pre-flight authorises only the endpoint it pre-flighted", () => {
  let hh: Harness;

  beforeEach(async () => {
    hh = await boot(TARGET_ROUTES);
  });

  /**
   * Runs the dry-run and, if it minted anything, the submit — and reports what
   * came back. The refusal may land on either leg, and which one is a design
   * choice rather than the property: what must hold is that no live write ever
   * reaches the transport.
   */
  async function attempt(
    dryRunTool: string,
    submitTool: string,
    args: Record<string, unknown>,
  ): Promise<{ codes: string[] }> {
    const codes: string[] = [];
    const dry = (await hh.client.callTool({
      name: dryRunTool,
      arguments: args,
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    const dryPayload = JSON.parse(dry.content?.[0]?.text ?? "{}");
    if (dry.isError) codes.push(dryPayload.code);
    const token = dry.isError ? null : dryPayload.confirmation_token;
    if (token) {
      const submitted = (await hh.client.callTool({
        name: submitTool,
        arguments: { ...args, confirmation_token: token },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      const payload = JSON.parse(submitted.content?.[0]?.text ?? "{}");
      if (submitted.isError) codes.push(payload.code);
      else codes.push("ACCEPTED");
    }
    return { codes };
  }

  it("refuses a replace whose order_id renders a different endpoint on each leg", async () => {
    const { codes } = await attempt(
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      REPLACE_ARGS,
    );
    expect(codes).not.toContain("ACCEPTED");
    expect(codes[0]).toBe("validation");
    expect(liveWrites(hh)).toEqual([]);
  });

  it("refuses an edit whose order_id renders a different endpoint on each leg", async () => {
    const { codes } = await attempt(
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
    );
    expect(codes).not.toContain("ACCEPTED");
    expect(codes[0]).toBe("validation");
    expect(liveWrites(hh)).toEqual([]);
  });

  // THE TWO CONTROLS COMPOSE, and this is the case that shows where the line
  // between them falls.
  //
  // A value that makes BOTH legs normalise to the same wrong place satisfies
  // THIS gate's relation, because the relation compares the two legs to each
  // other: `order_id: ""` renders `PUT /accounts/A/orders/` and
  // `POST /accounts/A/orders//dry-run`, which do stand in the pre-flight
  // relation. It is admitted here, and asserted as admitted so the boundary is
  // visible rather than assumed. Refusing a value that becomes path
  // STRUCTURE rather than data is path construction's job, and `apiPath` now
  // refuses an empty segment outright — one layer earlier, before any request is
  // built. Neither control replaces the other: this one still catches any future
  // value whose two legs resolve APART, which a per-segment check cannot see.
  it("is backed by path construction for a value that resolves wrong on both legs", async () => {
    const { codes } = await attempt(
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      { ...REPLACE_ARGS, order_id: "" },
    );
    expect(codes).not.toContain("ACCEPTED");
    expect(codes[0]).toBe("validation");
    expect(liveWrites(hh)).toEqual([]);
  });

  it("still lets an ordinary replace through — the anti-overreach half", async () => {
    const args = { ...REPLACE_ARGS, order_id: "1075264" };
    const token = await callOk(
      hh,
      "tastytrade_dry_run_replace_order",
      args,
    ).then((o) => (o as { confirmation_token: string }).confirmation_token);
    expect(typeof token).toBe("string");
    await callOk(hh, "tastytrade_replace_order", {
      ...args,
      confirmation_token: token,
    });
    expect(liveWrites(hh).map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT /accounts/${ACCT}/orders/1075264`,
    ]);
  });

  it("still lets an ordinary place through", async () => {
    const args = {
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
    const token = await callOk(hh, "tastytrade_dry_run_order", args).then(
      (o) => (o as { confirmation_token: string }).confirmation_token,
    );
    await callOk(hh, "tastytrade_place_order", {
      ...args,
      confirmation_token: token,
    });
    expect(liveWrites(hh).map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST /accounts/${ACCT}/orders`,
    ]);
  });
});
