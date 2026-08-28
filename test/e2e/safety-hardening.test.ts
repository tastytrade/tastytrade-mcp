/**
 * End-to-end cover for two fail-open defects in the safety layer.
 *
 * The unit tests in test/safety/ call `redactSecrets`, `redactDeep` and
 * `runSanityChecks` directly. This suite drives the same two guarantees through the
 * real server — a genuine `tools/call`, the real pre-flight, a real axios instance
 * over a route table, and the real `catch` that builds the envelope — because each
 * is only interesting at the boundary an agent actually sees:
 *
 *   1. Redaction is not defeatable by key spelling. A hostile upstream picks the key
 *      names, so the same credential is echoed back under a table of spellings and
 *      none may survive into the envelope.
 *   2. A leg quantity that cannot be read is refused, not compared to NaN. Asserted
 *      at both layers that can refuse it, with the assertion that matters: nothing
 *      was POSTed.
 *
 * A third would be pinned here — that a client-side abort reaches the agent as
 * `network` and never `upstream_error` — but it is covered end-to-end through this
 * same harness by test/e2e/resilience.test.ts and test/e2e/errors.test.ts, both of
 * which assert strictly more.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { createHarness, callOk, callError } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { TastytradeClient } from "../../src/api-client.js";
import {
  runSanityChecks,
  runStoredDryRunChecks,
} from "../../src/safety/sanity-checks.js";
import { isToolErrorException, REDACTED } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import { TOOL_METADATA } from "../../src/mcp-server/tool-metadata.js";

const ACCT = "5WX00001";
const BALANCES = /\/accounts\/[^/]+\/balances$/;
const POSITION_LIMIT = /\/accounts\/[^/]+\/position-limit$/;
const TRADING_STATUS = /\/accounts\/[^/]+\/trading-status$/;

/**
 * Every account-state flag answered, all of them "no".
 *
 * File-level because the legless submit routes now read
 * the trading status too, so more than one block needs a healthy one. `{}`
 * cannot serve — it is a readable object carrying no readable flag, which is
 * the "no evidence any check ran" case and comes with its own warning.
 */
const HEALTHY_TRADING_STATUS = {
  "is-frozen": false,
  "is-closing-only": false,
  "is-in-margin-call": false,
  "is-risk-reducing-only": false,
};
const ORDER_DRY_RUN = /\/accounts\/[^/]+\/orders\/dry-run$/;
const ORDER_SUBMIT = /\/accounts\/[^/]+\/orders$/;

let h: Harness | undefined;

beforeEach(() => {
  // Both are module-level singletons: the order bucket is finite and shared by
  // every harness in the process, and a stale token map would let one test's
  // token satisfy another's place call.
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function envelope(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolError> {
  if (!h) throw new Error("harness not created");
  return (await callError(h, name, args)) as unknown as ToolError;
}

// ---------------------------------------------------------------------------
// 1. Credential redaction survives creative key spelling
// ---------------------------------------------------------------------------

describe("the envelope scrubs a credential under any key spelling", () => {
  /**
   * One secret, echoed under many names. Long and distinctive so a single
   * `toContain` is proof: it cannot be a substring of anything else here.
   */
  const SECRET = "tt_NOT_A_REAL_CREDENTIAL_FIXTURE_9f3c1d7b5a24";

  /**
   * The spellings a gateway actually produces. The first four are the ones that
   * reached the envelope intact under the old fully-anchored key list — the rest
   * are the case, separator and camelCase variants that the same list would have
   * missed for the same reason.
   */
  const KEY_SPELLINGS = [
    "token",
    "remember-token",
    "x-api-key",
    "x-auth-token",
    "Token",
    "rememberToken",
    "X_AUTH_TOKEN",
    "xApiKey",
    "authorization",
    "set-cookie",
    "client_secret",
    "refreshToken",
    "totp_secret",
    "credentials",
    "creds",
    "sessionCookie",
    "user.password",
    "x-amz-security-token",
  ];

  /** An upstream failure that echoes the request back under every spelling. */
  function hostileBody(): Record<string, unknown> {
    const echoedHeaders: Record<string, string> = {};
    for (const key of KEY_SPELLINGS) echoedHeaders[key] = SECRET;
    return {
      error: {
        code: "invalid_request",
        // Free text, not a keyed object: the other scrub pass has to catch these.
        message: `rejected (x-api-key=${SECRET}, remember-token: ${SECRET})`,
        echoed_request: {
          headers: { ...echoedHeaders, "accept-version": "20260815" },
          body: { grant_type: "refresh_token", symbol: "AAPL" },
        },
      },
    };
  }

  it("leaks the secret under none of them, and keeps the diagnostics", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          reply: { status: 422, data: hostileBody(), raw: true },
        },
      ],
    });

    const err = await envelope("tastytrade_get_balances", {
      account_number: ACCT,
    });
    const serialized = JSON.stringify(err);

    expect(err.code).toBe("validation");
    expect(serialized).not.toContain(SECRET);
    // Scrubbed, not dropped: the envelope exists to carry the reason.
    expect(serialized).toContain(REDACTED);
    const body = err.upstream?.body as any;
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.echoed_request.headers["accept-version"]).toBe(
      "20260815",
    );
    expect(body.error.echoed_request.body.symbol).toBe("AAPL");
    // Every credential-shaped key is present but empty of its value, so an
    // operator can still see WHAT was echoed at them.
    for (const key of KEY_SPELLINGS) {
      expect(body.error.echoed_request.headers[key]).toBe(REDACTED);
    }
  });

  it("scrubs the same secret out of a free-text upstream message", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          reply: {
            status: 500,
            data: { error: { message: `upstream: token=${SECRET}` } },
            raw: true,
          },
        },
      ],
    });

    const err = await envelope("tastytrade_get_balances", {
      account_number: ACCT,
    });
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// 2. A leg quantity that cannot be read
// ---------------------------------------------------------------------------

describe("a leg quantity the order-size check cannot compare", () => {
  const LIMITS = { "equity-order-size": 100, "equity-option-order-size": 10 };

  const DRY_RUN_BODY = {
    order: { status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "-100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };

  /** Every account-state flag answered, all of them "no". */
  const CLEAN_TRADING_STATUS = {
    "account-number": ACCT,
    "is-frozen": false,
    "is-closing-only": false,
    "is-in-margin-call": false,
    "is-risk-reducing-only": false,
  };

  function routes(): Route[] {
    return [
      { matcher: ORDER_DRY_RUN, method: "POST", reply: { data: DRY_RUN_BODY } },
      {
        matcher: ORDER_SUBMIT,
        method: "POST",
        reply: { data: { order: { id: 9001, status: "Received" } } },
      },
      { matcher: POSITION_LIMIT, method: "GET", reply: { data: LIMITS } },
      {
        matcher: TRADING_STATUS,
        method: "GET",
        // A COMPLETE status, all four restrictions off. `{}` would stand in
        // for "healthy account" here, which is the same fixture as "the
        // endpoint answered and told us nothing" — and a payload carrying no
        // readable account-state flag is now a reported gap, so `{}` would
        // attach that warning to every order in this file.
        reply: { data: CLEAN_TRADING_STATUS },
      },
    ];
  }

  function orderArgs(quantity: unknown): Record<string, unknown> {
    return {
      account_number: ACCT,
      order_type: "Limit",
      time_in_force: "Day",
      price: "10.00",
      price_effect: "Debit",
      legs: [
        {
          symbol: "AAPL",
          instrument_type: "Equity",
          action: "Buy to Open",
          quantity,
        },
      ],
    };
  }

  /** Every live submit the transport actually saw. */
  function liveSubmits(): number {
    return (h?.requests ?? []).filter(
      (r) => r.method === "POST" && /\/orders$/.test(r.url),
    ).length;
  }

  // The shapes the reviewers named. `{q:1}`, `"NaN"` and `"1_000"` coerce to
  // NaN, and `NaN > limit` is false; `[1]` and `true` coerce to 1 and `null` to
  // 0, which is worse than useless — the check then vets a quantity nobody sent.
  const UNUSABLE: unknown[] = [{ q: 1 }, [1], "NaN", "1_000", true, null];

  it.each(UNUSABLE.map((q) => [JSON.stringify(q) ?? String(q), q] as const))(
    "is refused as validation with quantity %s, and nothing is POSTed",
    async (_label, quantity) => {
      h = await createHarness({ routes: routes() });

      // The advertised inputSchema does not stop this: the low-level MCP Server
      // does not validate arguments against it, so the shape genuinely arrives.
      const err = await envelope("tastytrade_place_order", {
        ...orderArgs(quantity),
        confirmation_token: "00000000-0000-0000-0000-000000000000",
      });

      expect(err.code).toBe("validation");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/quantity must be a positive, finite number/);
      expect(liveSubmits()).toBe(0);
    },
  );

  it("refuses inside runSanityChecks too, if one ever reaches it", async () => {
    // Defence in depth, and worth pinning as such: the dispatcher's boundary
    // guard refuses these shapes before a body is ever built, so the safety
    // layer's own guard is unreachable through the four order tools today.
    // Asserting it at the module boundary — with a REAL client over the same
    // credential-free transport — keeps it honest for a future caller that skips
    // the boundary, and pins that BOTH layers answer with the same code.
    const seen: string[] = [];
    const client = new TastytradeClient(
      { apiUrl: "https://api.cert.tastyworks.com" },
      {
        tokenProvider: () => "test-access-token",
        adapter: async (config: AxiosRequestConfig) => {
          seen.push(String(config.url));
          return {
            data: { data: LIMITS },
            status: 200,
            statusText: "200",
            headers: {},
            config,
          } as AxiosResponse;
        },
      },
    );

    let caught: unknown;
    try {
      await runSanityChecks(
        client,
        ACCT,
        {
          legs: [
            {
              "instrument-type": "Equity",
              symbol: "AAPL",
              action: "Buy to Open",
              quantity: "1_000" as unknown as number,
            },
          ],
        },
        { errors: [], "buying-power-effect": { "change-in-buying-power": -1 } },
      );
    } catch (e) {
      caught = e;
    }

    expect(isToolErrorException(caught)).toBe(true);
    if (isToolErrorException(caught)) {
      expect(caught.toolError.code).toBe("validation");
      expect(caught.toolError.message).toMatch(/Leg 0 \(AAPL\)/);
    }
    // Refused before any account lookup: the guard is first, not incidental.
    expect(seen).toEqual([]);
  });

  it("still places an order whose quantity is a decimal string", async () => {
    // The fail-closed rule must not close on the legitimate case: tastytrade
    // sends and accepts decimal strings, and cryptocurrency is fractional.
    h = await createHarness({ routes: routes() });
    const args = orderArgs("1.5");

    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string | null;
    };
    expect(typeof dry.confirmation_token).toBe("string");

    const placed = (await callOk(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: dry.confirmation_token,
    })) as {
      upstream?: { order?: { id?: number } };
      sanity_warnings?: string[];
    };

    // The broker's payload is boxed under `upstream`.
    expect(placed.upstream?.order?.id).toBe(9001);
    expect(placed.sanity_warnings).toEqual([]);
    expect(liveSubmits()).toBe(1);
    // Verbatim on the wire — the checks parse the quantity, they never rewrite it.
    const submit = h.requests.find(
      (r) => r.method === "POST" && /\/orders$/.test(r.url),
    );
    expect((submit?.body as any).legs[0].quantity).toBe("1.5");
  });

  it("still refuses a parseable quantity that busts the position limit", async () => {
    // The complement: a quantity that DOES parse must reach the limit
    // comparison and fail it as an over-size order, not as a malformed one.
    h = await createHarness({ routes: routes() });
    const args = orderArgs(200);

    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string | null;
    };
    const err = await envelope("tastytrade_place_order", {
      ...args,
      confirmation_token: dry.confirmation_token,
    });

    expect(err.code).toBe("sanity_check_failed");
    expect(err.message).toMatch(/exceeds account order limit 100/);
    expect(liveSubmits()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // `legs` that is not a list at all
  // -------------------------------------------------------------------------
  //
  // Both leg validators return null for a non-array, so the first thing to touch the
  // value is `buildOrderBody`'s `(args.legs ?? []).map` — and the agent gets
  // `upstream_error: "(args.legs ?? []).map is not a function"`, a bare V8 diagnostic
  // crossing the taxonomy boundary and blaming the broker for the caller's own
  // mistake. No money is at risk (it fires on the dry-run, before any token exists);
  // the contract is what breaks.

  const NOT_A_LIST: ReadonlyArray<readonly [string, unknown]> = [
    ["an object keyed by index", { 0: { symbol: "AAPL" } }],
    ["an empty object", {}],
    ["a string", "AAPL"],
    ["a number", 1],
    ["a boolean", true],
    // Falsy non-arrays are the ones a truthiness guard skips, which is how the
    // complex-order path kept the wart after its own fix.
    ["zero", 0],
    ["an empty string", ""],
  ];

  it.each(NOT_A_LIST)(
    "refuses legs supplied as %s with validation, not upstream_error",
    async (_label, legs) => {
      h = await createHarness({ routes: routes() });
      const err = await envelope("tastytrade_dry_run_order", {
        account_number: ACCT,
        order_type: "Limit",
        time_in_force: "Day",
        price: "10.00",
        price_effect: "Debit",
        legs,
      });

      expect(err.code).toBe("validation");
      expect(err.code).not.toBe("upstream_error");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/"legs" must be an array of leg objects/);
      // No raw JavaScript diagnostic reaches the agent.
      expect(err.message).not.toMatch(/is not a function/);
      expect(err.hint).toBeDefined();
      // And nothing was dispatched — this is refused at the boundary.
      expect(h.requests).toHaveLength(0);
    },
  );

  it.each(NOT_A_LIST)(
    "refuses a complex order's trigger_order legs supplied as %s",
    async (_label, legs) => {
      h = await createHarness({ routes: routes() });
      const err = await envelope("tastytrade_dry_run_complex_order", {
        account_number: ACCT,
        type: "OTO",
        trigger_order: {
          order_type: "Limit",
          time_in_force: "Day",
          price: "10.00",
          price_effect: "Debit",
          legs,
        },
        orders: [],
      });

      expect(err.code).toBe("validation");
      expect(err.message).toMatch(/"legs" must be an array of leg objects/);
      expect(err.message).toContain("trigger_order");
      expect(h.requests).toHaveLength(0);
    },
  );

  it("refuses a component order's legs supplied as an object, naming which one", async () => {
    h = await createHarness({ routes: routes() });
    const leg = {
      symbol: "AAPL",
      instrument_type: "Equity",
      action: "Buy to Open",
      quantity: 1,
    };
    const err = await envelope("tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OCO",
      orders: [
        { order_type: "Limit", time_in_force: "Day", legs: [leg] },
        { order_type: "Limit", time_in_force: "Day", legs: { 0: leg } },
      ],
    });

    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/"legs" must be an array of leg objects/);
    expect(err.message).toContain("orders[1]");
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a non-array legs on dry_run_margin_impact, the third site", async () => {
    // The twin sweep. dry_run_margin_impact builds its own leg array and had
    // NEITHER guard, so it carried the identical wart after both order paths
    // were fixed. Shape only there: `quantity` is optional on that endpoint, so
    // the quantity check would narrow a read-only tool for no gain.
    h = await createHarness({ routes: routes() });
    const err = await envelope("tastytrade_dry_run_margin_impact", {
      account_number: ACCT,
      underlying_symbol: "AAPL",
      order_type: "Limit",
      time_in_force: "Day",
      legs: { 0: { symbol: "AAPL" } },
    });

    expect(err.code).toBe("validation");
    expect(err.code).not.toBe("upstream_error");
    expect(err.message).toMatch(/"legs" must be an array of leg objects/);
    expect(err.message).not.toMatch(/is not a function/);
    expect(h.requests).toHaveLength(0);
  });

  it("still accepts an absent legs, which the API is what rejects", async () => {
    // The fail-closed rule must not close on the shape `(args.legs ?? []).map`
    // is already well defined for. Refusing `undefined` here would change what
    // an unrelated caller sees, and the schema's `required: ["legs"]` plus the
    // broker are what own that case.
    h = await createHarness({ routes: routes() });
    const out = (await callOk(h, "tastytrade_dry_run_order", {
      account_number: ACCT,
      order_type: "Limit",
      time_in_force: "Day",
      price: "10.00",
      price_effect: "Debit",
    })) as Record<string, unknown>;

    expect(out).toBeDefined();
    // It reached the broker rather than being refused locally.
    expect(h.requests.filter((r) => r.method === "POST")).not.toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // `legs` that IS a list, of something that is not a leg
  // -------------------------------------------------------------------------
  //
  // The same fault one level down, and it survives the guard above because both leg
  // validators deliberately tolerate a null element (`legs[i] ?? {}`), so the first
  // thing to touch the value is `buildOrderBody`'s `.map`, reading
  // `leg.instrument_type` off null. An array element is the quieter half: it has no
  // `symbol`, `action` or `instrument_type`, so it does not throw — it builds an order
  // body full of `undefined` and sends it, which is worse than a refusal.

  const NOT_A_LEG: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["an array", ["AAPL"]],
    ["a string", "AAPL"],
    ["a number", 1],
    ["a boolean", true],
  ];

  it.each(NOT_A_LEG)(
    "refuses a legs element that is %s with validation, naming its index",
    async (_label, element) => {
      h = await createHarness({ routes: routes() });
      const good = {
        symbol: "AAPL",
        instrument_type: "Equity",
        action: "Buy to Open",
        quantity: 1,
      };
      const err = await envelope("tastytrade_dry_run_order", {
        account_number: ACCT,
        order_type: "Limit",
        time_in_force: "Day",
        price: "10.00",
        price_effect: "Debit",
        // Second position, so the message has to name WHICH element rather than
        // getting the index right by accident.
        legs: [good, element],
      });

      expect(err.code).toBe("validation");
      expect(err.code).not.toBe("upstream_error");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/Leg 1 must be a leg object/);
      // No raw JavaScript diagnostic reaches the agent.
      expect(err.message).not.toMatch(/Cannot read properties/);
      // And nothing was dispatched — this is refused at the boundary.
      expect(h.requests).toHaveLength(0);
    },
  );

  it("refuses a null element inside a complex order's component legs, naming which order", async () => {
    // The twin sweep, same as the non-array case above: the complex path
    // reaches `buildComponentOrderBody`'s `.map`, a different call site with
    // the identical dereference.
    h = await createHarness({ routes: routes() });
    const err = await envelope("tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OCO",
      orders: [
        {
          order_type: "Limit",
          time_in_force: "Day",
          legs: [
            {
              symbol: "AAPL",
              instrument_type: "Equity",
              action: "Buy to Open",
              quantity: 1,
            },
          ],
        },
        { order_type: "Limit", time_in_force: "Day", legs: [null] },
      ],
    });

    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/Leg 0 must be a leg object/);
    expect(err.message).toContain("orders[1]");
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a null element on dry_run_margin_impact, the third .map site", async () => {
    h = await createHarness({ routes: routes() });
    const err = await envelope("tastytrade_dry_run_margin_impact", {
      account_number: ACCT,
      underlying_symbol: "AAPL",
      order_type: "Limit",
      time_in_force: "Day",
      legs: [null],
    });

    expect(err.code).toBe("validation");
    expect(err.code).not.toBe("upstream_error");
    expect(err.message).toMatch(/Leg 0 must be a leg object/);
    expect(err.message).not.toMatch(/Cannot read properties/);
    expect(h.requests).toHaveLength(0);
  });

  it("still accepts a leg object the broker is the one to judge", async () => {
    // The boundary this guard keeps: it refuses shapes that cannot be turned
    // into an order body, and leaves "an order tastytrade will not accept" to
    // tastytrade. An empty object is a leg object; it goes out.
    h = await createHarness({ routes: routes() });
    const out = (await callOk(h, "tastytrade_dry_run_order", {
      account_number: ACCT,
      order_type: "Limit",
      time_in_force: "Day",
      price: "10.00",
      price_effect: "Debit",
      legs: [{}],
    })) as Record<string, unknown>;

    expect(out).toBeDefined();
    expect(h.requests.filter((r) => r.method === "POST")).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2b. The same fault ONE LEVEL UP: a component that is not an order
// ---------------------------------------------------------------------------
//
// Three caller-controlled `.map` sites are guarded above; the fourth is not over legs
// at all. `buildComplexOrderBody` maps `args.orders` through
// `buildComponentOrderBody`, and `trigger_order` goes through the same function on
// its own — and both complex validators walk past a component they cannot read, so
// nothing between the agent and the builder looks at the component itself.
//
// The two halves mirror the leg guard's, one layer out:
//
//   - `orders: [null]` and `trigger_order: null` reach `c.order_type` and throw
//     `upstream_error: "Cannot read properties of null"` — the V8 diagnostic blaming
//     the broker for the caller's mistake.
//   - `orders: ["x", 5, true]` does NOT throw. `order_type` off a string is
//     `undefined`, `(c.legs ?? []).map` is `[]`, and JSON.stringify drops the
//     undefined members — so a LIVE `POST /complex-orders` goes out carrying
//     `{"orders":[{"legs":[]},{"legs":[]},{"legs":[]}]}`. The order the agent
//     described is not the order that was sent.
//
// A component is refused rather than skipped: dropping a null out of `orders` would
// change the strategy's arity, and silently sending something other than what was
// asked for is what this whole file is about.

describe("a complex-order component that is not an order object", () => {
  const COMPLEX_DRY_RUN = `/accounts/${ACCT}/complex-orders/dry-run`;
  const COMPLEX_SUBMIT = `/accounts/${ACCT}/complex-orders`;

  const GOOD_LEG = {
    symbol: "AAPL",
    instrument_type: "Equity",
    action: "Buy to Open",
    quantity: 1,
  };
  const GOOD_COMPONENT = {
    order_type: "Limit",
    time_in_force: "Day",
    price: "10.00",
    price_effect: "Debit",
    legs: [GOOD_LEG],
  };

  function routes(): Route[] {
    return [
      {
        matcher: COMPLEX_DRY_RUN,
        method: "POST",
        // A payload the broker could actually have sent. An EMPTY
        // buying-power-effect with no complex-order proves nothing was priced,
        // and describedAnOrder refuses to mint a token for it — correctly, so
        // the double is what changed rather than the guard.
        reply: {
          data: {
            warnings: [],
            "complex-order": { id: 1, type: "OCO", orders: [] },
            "buying-power-effect": {
              "change-in-buying-power": "100.00",
              "change-in-buying-power-effect": "Debit",
            },
          },
        },
      },
      {
        matcher: COMPLEX_SUBMIT,
        method: "POST",
        reply: { data: { id: 56544, status: "Received" } },
      },
      { matcher: POSITION_LIMIT, method: "GET", reply: { data: {} } },
      { matcher: TRADING_STATUS, method: "GET", reply: { data: {} } },
    ];
  }

  const NOT_A_COMPONENT: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["an array", [{ order_type: "Limit" }]],
    ["a string", "Limit"],
    ["a number", 5],
    ["a boolean", true],
  ];

  it.each(NOT_A_COMPONENT)(
    "refuses an `orders` element that is %s, naming its index",
    async (_label, component) => {
      h = await createHarness({ routes: routes() });
      const err = await envelope("tastytrade_dry_run_complex_order", {
        account_number: ACCT,
        type: "OCO",
        // Second position, so the message has to name WHICH component rather
        // than getting the index right by accident.
        orders: [GOOD_COMPONENT, component],
      });

      expect(err.code).toBe("validation");
      expect(err.code).not.toBe("upstream_error");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/must be an order object/);
      expect(err.message).toContain("orders[1]");
      // Neither symptom reaches the agent: no V8 diagnostic, and no request.
      expect(err.message).not.toMatch(/Cannot read properties/);
      expect(h.requests).toHaveLength(0);
    },
  );

  it.each(NOT_A_COMPONENT)(
    "refuses a `trigger_order` that is %s",
    async (_label, component) => {
      // The twin. `buildComplexOrderBody` calls the same builder on
      // `trigger_order` through a separate `!== undefined` branch, so a guard
      // on the array alone would leave this half exactly as it was.
      h = await createHarness({ routes: routes() });
      const err = await envelope("tastytrade_dry_run_complex_order", {
        account_number: ACCT,
        type: "OTO",
        trigger_order: component,
        orders: [GOOD_COMPONENT],
      });

      expect(err.code).toBe("validation");
      expect(err.code).not.toBe("upstream_error");
      expect(err.message).toMatch(/must be an order object/);
      expect(err.message).toContain("trigger_order");
      expect(err.message).not.toMatch(/Cannot read properties/);
      expect(h.requests).toHaveLength(0);
    },
  );

  it("refuses an `orders` that is present but not a list", async () => {
    h = await createHarness({ routes: routes() });
    const err = await envelope("tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OCO",
      orders: { 0: GOOD_COMPONENT },
    });

    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/"orders" must be an array of order objects/);
    expect(h.requests).toHaveLength(0);
  });

  it("refuses the LIVE submit too, before the request goes out", async () => {
    // The money half. The dry-run refusal above fires before a token exists, so
    // nothing is at risk there. This one matters: `place_complex_order` builds
    // the same body from the same args, and an agent holding a token from a
    // clean dry-run could otherwise mutate `orders` on the submit call. The
    // binding catches a mutation — but only if something reads the components
    // first, and the builder is what runs before consumeToken.
    h = await createHarness({ routes: routes() });
    const args = {
      account_number: ACCT,
      type: "OCO",
      orders: [GOOD_COMPONENT],
    };
    const dry = (await callOk(h, "tastytrade_dry_run_complex_order", args)) as {
      confirmation_token: string;
    };
    expect(typeof dry.confirmation_token).toBe("string");

    const before = h.requests.length;
    const err = await envelope("tastytrade_place_complex_order", {
      ...args,
      orders: [GOOD_COMPONENT, null],
      confirmation_token: dry.confirmation_token,
    });

    expect(err.code).toBe("validation");
    expect(err.message).toContain("orders[1]");
    expect(err.message).not.toMatch(/Cannot read properties/);
    // Nothing was dispatched after the dry-run: no live POST at all.
    expect(h.requests.length).toBe(before);
  });

  it("still accepts an absent trigger_order and an absent orders", async () => {
    // The boundary, in the same direction the leg guard keeps it: this refuses
    // shapes that CANNOT be turned into a body, and leaves "a complex order
    // tastytrade will not accept" to tastytrade. `trigger_order: undefined` and
    // no `orders` at all are both well defined for the builder — it simply
    // omits them — so they must reach the broker.
    h = await createHarness({ routes: routes() });
    const out = (await callOk(h, "tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OCO",
    })) as Record<string, unknown>;

    expect(out).toBeDefined();
    expect(
      h.requests.filter(
        (r) => r.method === "POST" && r.url === COMPLEX_DRY_RUN,
      ),
    ).toHaveLength(1);
  });

  it("still accepts an empty component object, which the broker is the one to judge", async () => {
    // `{}` is an order object. It has no order_type and no legs, so the broker
    // rejects it — and that is the broker's call, not this guard's.
    h = await createHarness({ routes: routes() });
    const out = (await callOk(h, "tastytrade_dry_run_complex_order", {
      account_number: ACCT,
      type: "OCO",
      orders: [{}],
    })) as Record<string, unknown>;

    expect(out).toBeDefined();
    const sent = h.requests.find(
      (r) => r.method === "POST" && r.url === COMPLEX_DRY_RUN,
    );
    expect((sent?.body as any).orders).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. MAX_ORDER_NOTIONAL_USD applies to every gated route, not just the two that
//    happened to call runSanityChecks
// ---------------------------------------------------------------------------
//
// Of the checks the submit path runs, the position limits and the frozen /
// closing-only state are ALSO enforced by tastytrade. MAX_ORDER_NOTIONAL_USD is not:
// it exists only in this server, for this operator. A route that consumes its token
// and then submits with no local check lets an agent dry-run a small order and edit it
// past the ceiling — and `order_type` is settable on both single-order routes, so a
// resting limit could become a MARKET order through a path that compared nothing. The
// projection needed to apply the cap is already in hand: issueToken stores it and
// consumeToken returns it.

describe("the notional cap is enforced on replace, edit and complex-edit", () => {
  const ORDER_ID = "1075264";
  const COMPLEX_ID = "56544";
  const CAP_USD = 50_000;

  /** A dry-run whose projected buying-power impact is ten times the cap. */
  const OVER_CAP = {
    order: { id: 1, status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "500000.00",
      "change-in-buying-power-effect": "Debit",
    },
  };

  /** The same shape, comfortably inside it. */
  const UNDER_CAP = {
    order: { id: 1, status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };

  const REPLACE_ARGS = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Market",
    time_in_force: "GTC",
  };
  const EDIT_ARGS = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Market",
    time_in_force: "GTC",
  };
  const EDIT_COMPLEX_ARGS = {
    account_number: ACCT,
    complex_order_id: COMPLEX_ID,
    ratio_price_threshold: 0.98,
  };

  const priorCap = process.env.MAX_ORDER_NOTIONAL_USD;
  beforeEach(() => {
    // Pinned rather than inherited: the cap is read from the environment on
    // every check, so a developer shell that raised it would silently turn
    // these assertions into no-ops.
    process.env.MAX_ORDER_NOTIONAL_USD = String(CAP_USD);
  });
  afterEach(() => {
    if (priorCap === undefined) delete process.env.MAX_ORDER_NOTIONAL_USD;
    else process.env.MAX_ORDER_NOTIONAL_USD = priorCap;
  });

  function singleOrderRoutes(dryRun: unknown): Route[] {
    return [
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
        method: "POST",
        reply: { data: dryRun },
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
        method: "PUT",
        reply: { data: { id: 2, status: "Received" } },
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
        method: "PATCH",
        reply: { data: { id: 3, status: "Received" } },
      },
      { matcher: POSITION_LIMIT, method: "GET", reply: { data: {} } },
      // This read is now on the money path for these
      // three routes, so it answers with a real status rather than `{}`.
      {
        matcher: TRADING_STATUS,
        method: "GET",
        reply: { data: HEALTHY_TRADING_STATUS },
      },
    ];
  }

  function complexEditRoutes(dryRun: unknown): Route[] {
    return [
      {
        matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
        method: "POST",
        reply: { data: dryRun },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
        method: "PATCH",
        reply: { data: { id: Number(COMPLEX_ID), type: "PAIRS" } },
      },
      // Updated for , same reason.
      {
        matcher: TRADING_STATUS,
        method: "GET",
        reply: { data: HEALTHY_TRADING_STATUS },
      },
    ];
  }

  /** Live state-changing requests the transport saw (dry-runs excluded). */
  function liveWrites(): string[] {
    return (h?.requests ?? [])
      .filter((r) => r.method !== "GET" && !r.url.endsWith("/dry-run"))
      .map((r) => `${r.method} ${r.url}`);
  }

  async function tokenFrom(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const dry = (await callOk(h!, tool, args)) as {
      confirmation_token: string | null;
    };
    expect(typeof dry.confirmation_token).toBe("string");
    return dry.confirmation_token as string;
  }

  const CASES: ReadonlyArray<
    readonly [
      string,
      string,
      string,
      Record<string, unknown>,
      (dryRun: unknown) => Route[],
    ]
  > = [
    [
      "replace_order",
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      REPLACE_ARGS,
      singleOrderRoutes,
    ],
    [
      "edit_order",
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
      singleOrderRoutes,
    ],
    [
      "edit_complex_order",
      "tastytrade_dry_run_edit_complex_order",
      "tastytrade_edit_complex_order",
      EDIT_COMPLEX_ARGS,
      complexEditRoutes,
    ],
  ];

  it.each(CASES)(
    "%s refuses a projection over the cap and sends nothing",
    async (_label, dryRunTool, liveTool, args, routesFor) => {
      h = await createHarness({ routes: routesFor(OVER_CAP) });
      const token = await tokenFrom(dryRunTool, args);

      const err = await envelope(liveTool, {
        ...args,
        confirmation_token: token,
      });

      expect(err.code).toBe("sanity_check_failed");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/exceeds MAX_ORDER_NOTIONAL_USD/);
      // The whole point: the live PUT / PATCH never happened.
      expect(liveWrites()).toEqual([]);
    },
  );

  it.each(CASES)(
    "%s adds ONE account read to the money path, and it is the account-state one",
    async (_label, dryRunTool, liveTool, args, routesFor) => {
      // This case would assert ZERO GETs, which is the
      // shape that let a frozen account be edited: `is-frozen` is a hard block
      // that needs no legs, and it lived behind a read these routes never made.
      // So the count moves from zero to one — and the assertion that matters
      // now is which one. The POSITION-LIMIT read stays absent: it would fetch
      // ceilings a legless body has nothing to compare against, and it is the
      // second read that would put the money call at the far end of a
      // four-request sequence (see ADVISORY_READ_BUDGET_MS for why that
      // direction is the dangerous one).
      h = await createHarness({ routes: routesFor(UNDER_CAP) });
      const token = await tokenFrom(dryRunTool, args);
      await callOk(h, liveTool, { ...args, confirmation_token: token });

      const gets = h.requests.filter((r) => r.method === "GET");
      expect(gets.map((r) => r.url)).toEqual([
        expect.stringContaining("/trading-status"),
      ]);
      expect(h.requests).toHaveLength(3);
    },
  );

  it("still submits, with warnings attached, when the projection is inside the cap", async () => {
    // The complement, and the thing that would break if the new check refused
    // too much: a normal replace goes through, and the soft warnings the check
    // produced are surfaced the way place_order surfaces them.
    h = await createHarness({ routes: singleOrderRoutes(UNDER_CAP) });
    const token = await tokenFrom(
      "tastytrade_dry_run_replace_order",
      REPLACE_ARGS,
    );

    const result = (await callOk(h, "tastytrade_replace_order", {
      ...REPLACE_ARGS,
      confirmation_token: token,
    })) as { upstream: { id: number }; sanity_warnings: string[] };

    // The broker's payload is boxed under `upstream`, so
    // an edit's `result.id` is now `result.upstream.id`.
    expect(result.upstream.id).toBe(2);
    expect(result.sanity_warnings).toEqual([]);
    expect(liveWrites()).toEqual([`PUT /accounts/${ACCT}/orders/${ORDER_ID}`]);
  });

  /** A dry-run that projects nothing the cap can be compared against. */
  const UNMEASURED = {
    order: { id: 1, status: "Received" },
    warnings: [],
    "buying-power-effect": {},
  };

  it.each(CASES)(
    "%s submits with an explicit 'not measured' warning when the projection carries no figure",
    async (_label, dryRunTool, liveTool, args, routesFor) => {
      // The half of the cap the tool descriptions were over-claiming. A hard
      // block needs a number, and `applyNotionalCap` deliberately does NOT
      // refuse when the dry-run supplies none — refusing would make an
      // instrument class untradeable. So the route succeeds, and the only thing
      // standing between the operator and a false sense of a ceiling is this
      // warning. It is asserted here as BEHAVIOUR, and the companion test below
      // holds the tool descriptions to it.
      h = await createHarness({ routes: routesFor(UNMEASURED) });
      const token = await tokenFrom(dryRunTool, args);

      const out = (await callOk(h, liveTool, {
        ...args,
        confirmation_token: token,
      })) as { sanity_warnings: string[] };

      expect(out.sanity_warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cap could not be applied"),
        ]),
      );
      // It really did submit — this is a warning, not a block.
      expect(liveWrites()).toHaveLength(1);
    },
  );

  /**
   * A broker note in the STORED dry-run must still reach the caller.
   *
   * These three routes make no account reads — their bodies carry no legs for a
   * position limit or trading status to be measured against — so the dry-run's own
   * `warnings` are the ONLY broker commentary a human sees on a replace or an edit. The
   * API uses that field to say things like "your order will be rejected if you were to
   * try to route it".
   *
   * Pinned here because the passthrough was reachable but unobserved: deleting
   * `collectDryRunWarnings` from `runStoredDryRunChecks` left the whole gate green,
   * while deleting it from the full checks failed 27 tests. Same helper, same one-line
   * deletion, and only the `place` side was held to it.
   *
   * The two shapes are the ones the merged renderer exists to handle: an array carrying
   * a null element and a `{code}`-only element, and a container that is not an array.
   */
  const NOTE_SHAPES: ReadonlyArray<readonly [string, unknown, string[]]> = [
    [
      "an array with a null element and a code-only element",
      [
        null,
        { code: "tif.next_valid_session" },
        { message: "will be rejected" },
      ],
      ["tif.next_valid_session", "will be rejected"],
    ],
    [
      "a container that is not an array",
      { message: "your order will be rejected if you route it" },
      ["your order will be rejected if you route it"],
    ],
  ];

  const STORED_ROUTES: ReadonlyArray<
    readonly [string, string, string, Record<string, unknown>]
  > = [
    [
      "replace_order",
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      REPLACE_ARGS,
    ],
    [
      "edit_order",
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
    ],
    [
      "edit_complex_order",
      "tastytrade_dry_run_edit_complex_order",
      "tastytrade_edit_complex_order",
      EDIT_COMPLEX_ARGS,
    ],
  ];

  it.each(
    STORED_ROUTES.flatMap(([label, dryTool, liveTool, args]) =>
      NOTE_SHAPES.map(
        ([shape, warnings, expected]) =>
          [
            `${label} + ${shape}`,
            dryTool,
            liveTool,
            args,
            warnings,
            expected,
          ] as const,
      ),
    ),
  )(
    // The note still reaches the caller — that is the
    // point of this sweep, and it is why the container mirror exists — but it
    // reaches `upstream_notes`, not the array this server states its own
    // verdicts in. The second assertion is the new half: a broker note must NOT
    // be able to put anything into `sanity_warnings`, and asserting the absence
    // is what makes the provenance claim testable rather than descriptive.
    "%s: the broker note reaches upstream_notes, never sanity_warnings",
    async (_label, dryTool, liveTool, args, warnings, expected) => {
      const dryRun = { ...UNDER_CAP, warnings };
      h = await createHarness({
        routes: liveTool.includes("complex")
          ? complexEditRoutes(dryRun)
          : singleOrderRoutes(dryRun),
      });
      const dry = (await callOk(h, dryTool, args)) as {
        confirmation_token: string;
      };
      expect(typeof dry.confirmation_token).toBe("string");

      const res = (await callOk(h, liveTool, {
        ...args,
        confirmation_token: dry.confirmation_token,
      })) as { sanity_warnings: string[]; upstream_notes: string[] };
      for (const note of expected) {
        expect(res.upstream_notes.join("\n")).toContain(note);
        expect(res.sanity_warnings.join("\n")).not.toContain(note);
      }
    },
  );

  it("does not let a tool description promise the hard block unconditionally", () => {
    // Doc truth, pinned against the behaviour proven directly above rather than against
    // a sentence. An operator reads the description, not the source, and "HARD-BLOCKS
    // when the buying-power impact exceeds the max notional" is true only when the broker
    // supplied an impact — a description that stops there teaches over-trust in the one
    // ceiling tastytrade does not also enforce. Any tool making the claim must also name
    // the case where the cap cannot be applied.
    //
    // Selected by SUBJECT — every description that mentions the cap — rather than by the
    // phrasing of the claim, because matching "HARD-BLOCKS … max notional" misses
    // place_complex_order, which promises the same thing in different words.
    const claiming = Object.entries(TOOL_METADATA).filter(([, meta]) =>
      /MAX_ORDER_NOTIONAL_USD|max notional/i.test(meta.description ?? ""),
    );
    // The five token-gated order tools, and the rule is worthless if it applies
    // to nothing.
    expect(claiming.map(([name]) => name).sort()).toEqual([
      "tastytrade_edit_complex_order",
      "tastytrade_edit_order",
      // Not token-gated, and it earns its place: it is where the instrument
      // classes with no published size cap are documented, and it would tell
      // the reader they were "bounded only by MAX_ORDER_NOTIONAL_USD" — the
      // over-trust this rule exists to catch, on exactly the legs for which the
      // notional cap is the last local ceiling. It now names the unmeasured
      // case like the other five.
      "tastytrade_get_position_limit",
      "tastytrade_place_complex_order",
      "tastytrade_place_order",
      "tastytrade_replace_order",
    ]);
    for (const [name, meta] of claiming) {
      expect(`${name}: ${meta.description}`).toMatch(
        /no usable change-in-buying-power/i,
      );
      expect(`${name}: ${meta.description}`).toMatch(
        /NOT applied|not measured/,
      );
    }
  });

  it("refuses a replace whose stored dry-run reported errors", async () => {
    // The other half of the offline check, and the one that matters most on a
    // route with no other gate: a dry-run the broker answered with a blocking
    // errors[] must never be submittable. isCleanDryRun already withholds the
    // token for that case, so this drives the check directly through the
    // module rather than pretending the token path can reach it.
    // The checks now also read the account state, so the
    // function takes a client and an account number and is async. The dry-run
    // half still refuses FIRST — before any broker call — which is what the
    // stub client asserts by never being reached.
    const client = {
      getAccountStatus: async () => {
        throw new Error("the dry-run half must refuse before this is reached");
      },
    } as unknown as TastytradeClient;
    await expect(
      runStoredDryRunChecks(client, "5WX00001", {
        errors: [{ code: "invalid_order", message: "market closed" }],
        "buying-power-effect": { "change-in-buying-power": "1.00" },
      }),
    ).rejects.toThrow(/Dry-run blocked/);
  });
});

// ---------------------------------------------------------------------------
// 4. The client's clock, which the server would ignore
// ---------------------------------------------------------------------------
//
// The MCP client runs a per-request timer this server cannot see (60s in the
// reference SDK, often lower). One place_order makes three sequential broker
// requests, each with its own 30s ceiling and no ceiling on the total. When the
// client's timer fires it rejects with a bare `-32001 Request timed out` and the
// server carries on and submits: the agent is told the call timed out, with none of
// the unknown-outcome language, for an order about to be live — and `consumeToken`
// has already burnt the token, so the natural recovery re-dry-runs and places a
// SECOND order.
//
// Two changes answer it, both asserted here: the two SOFT reads get a deadline of
// their own so the POST is reached inside a few seconds, and the submit paths check
// the request's abort signal in the last instant when "nothing was sent" is still a
// fact rather than a guess.

describe("a submit the caller has stopped waiting for is not sent", () => {
  const ORDER_ID = "1075264";
  const COMPLEX_ID = "56544";

  const DRY_RUN = {
    order: { id: 1, status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };
  const COMPLEX_DRY_RUN = {
    "complex-order": { id: Number(COMPLEX_ID), type: "OCO" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };

  const LEG = {
    symbol: "AAPL",
    instrument_type: "Equity",
    action: "Buy to Open",
    quantity: 1,
  };
  const PLACE_ARGS = {
    account_number: ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "10.00",
    price_effect: "Debit",
    legs: [LEG],
  };
  const COMPLEX_ARGS = {
    account_number: ACCT,
    type: "OCO",
    orders: [
      {
        order_type: "Limit",
        time_in_force: "Day",
        price: "10.00",
        price_effect: "Debit",
        legs: [LEG],
      },
    ],
  };
  const REPLACE_ARGS = {
    account_number: ACCT,
    order_id: ORDER_ID,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.05",
    price_effect: "Debit",
  };
  const EDIT_COMPLEX_ARGS = {
    account_number: ACCT,
    complex_order_id: COMPLEX_ID,
    ratio_price_threshold: 0.98,
  };

  function allRoutes(): Route[] {
    return [
      { matcher: POSITION_LIMIT, method: "GET", reply: { data: {} } },
      { matcher: TRADING_STATUS, method: "GET", reply: { data: {} } },
      { matcher: ORDER_DRY_RUN, method: "POST", reply: { data: DRY_RUN } },
      {
        matcher: ORDER_SUBMIT,
        method: "POST",
        reply: { data: { order: { id: 9001, status: "Received" } } },
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}/dry-run`,
        method: "POST",
        reply: { data: DRY_RUN },
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
        method: "PUT",
        reply: { data: { id: 2, status: "Received" } },
      },
      {
        matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
        method: "PATCH",
        reply: { data: { id: 3, status: "Received" } },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/dry-run`,
        method: "POST",
        reply: { data: COMPLEX_DRY_RUN },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders`,
        method: "POST",
        reply: { data: { "complex-order": { id: 7, type: "OCO" } } },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}/dry-run`,
        method: "POST",
        // A payload the broker could actually have sent. An EMPTY
        // buying-power-effect with no complex-order proves nothing was priced,
        // and describedAnOrder refuses to mint a token for it — correctly, so
        // the double is what changed rather than the guard.
        reply: {
          data: {
            warnings: [],
            "complex-order": { id: 1, type: "OCO", orders: [] },
            "buying-power-effect": {
              "change-in-buying-power": "100.00",
              "change-in-buying-power-effect": "Debit",
            },
          },
        },
      },
      {
        matcher: `/accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
        method: "PATCH",
        reply: { data: { id: Number(COMPLEX_ID), type: "PAIRS" } },
      },
    ];
  }

  /** Every state-changing request the transport saw (dry-runs excluded). */
  function liveWrites(): string[] {
    return (h?.requests ?? [])
      .filter((r) => r.method !== "GET" && !r.url.endsWith("/dry-run"))
      .map((r) => `${r.method} ${r.url}`);
  }

  /**
   * `dispatchToolCall` is the seam the SDK's abort signal arrives on, and it is
   * private. Reaching it by cast is deliberate: the alternative is racing a
   * real timer to land the abort in the right microsecond, which would make
   * five assertions flaky to prove one thing. A separate test below drives the
   * real SDK timeout end to end to show the signal genuinely aborts.
   */
  type Dispatchable = {
    dispatchToolCall(
      name: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>;
  };

  const GATED: ReadonlyArray<
    readonly [string, string, string, Record<string, unknown>]
  > = [
    [
      "place_order",
      "tastytrade_dry_run_order",
      "tastytrade_place_order",
      PLACE_ARGS,
    ],
    [
      "place_complex_order",
      "tastytrade_dry_run_complex_order",
      "tastytrade_place_complex_order",
      COMPLEX_ARGS,
    ],
    [
      "replace_order",
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      REPLACE_ARGS,
    ],
    [
      "edit_order",
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      REPLACE_ARGS,
    ],
    [
      "edit_complex_order",
      "tastytrade_dry_run_edit_complex_order",
      "tastytrade_edit_complex_order",
      EDIT_COMPLEX_ARGS,
    ],
  ];

  it.each(GATED)(
    "%s refuses with request_cancelled once the caller is gone",
    async (_label, dryRunTool, liveTool, args) => {
      h = await createHarness({ routes: allRoutes() });
      const dry = (await callOk(h, dryRunTool, args)) as {
        confirmation_token: string | null;
      };
      expect(typeof dry.confirmation_token).toBe("string");

      const aborted = new AbortController();
      aborted.abort();
      const res = await (h.server as unknown as Dispatchable).dispatchToolCall(
        liveTool,
        { ...args, confirmation_token: dry.confirmation_token },
        aborted.signal,
      );

      expect(res.isError).toBe(true);
      const err = JSON.parse(res.content?.[0]?.text ?? "{}") as ToolError;
      expect(err.code).toBe("request_cancelled");
      expect(err.retryable).toBe(false);
      // The only assertion that would matter if the envelope were never read:
      // nothing was sent.
      expect(liveWrites()).toEqual([]);
    },
  );

  it("still sends the same submit when the caller is still there", async () => {
    // The complement. A signal that exists and is NOT aborted must change
    // nothing — a guard that refused on the mere presence of a signal would
    // disable every write against a spec-compliant client.
    h = await createHarness({ routes: allRoutes() });
    const dry = (await callOk(h, "tastytrade_dry_run_order", PLACE_ARGS)) as {
      confirmation_token: string;
    };
    const live = new AbortController();
    const res = await (h.server as unknown as Dispatchable).dispatchToolCall(
      "tastytrade_place_order",
      { ...PLACE_ARGS, confirmation_token: dry.confirmation_token },
      live.signal,
    );

    expect(res.isError).toBeFalsy();
    expect(liveWrites()).toEqual([`POST /accounts/${ACCT}/orders`]);
  });

  it("does not gate a cancel, because refusing to cancel is the dangerous direction", async () => {
    // Deliberate asymmetry, and worth pinning as one: a cancel cannot create an
    // obligation and it reduces exposure, so if the client has gone away the
    // right answer is still to send it. Gating it would leave a working order
    // live precisely when nobody is watching.
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/orders/${ORDER_ID}`,
          method: "DELETE",
          reply: { data: { id: 1, status: "Cancelled" } },
        },
      ],
    });
    const aborted = new AbortController();
    aborted.abort();
    const res = await (h.server as unknown as Dispatchable).dispatchToolCall(
      "tastytrade_cancel_order",
      { account_number: ACCT, order_id: ORDER_ID },
      aborted.signal,
    );

    expect(res.isError).toBeFalsy();
    expect(liveWrites()).toEqual([
      `DELETE /accounts/${ACCT}/orders/${ORDER_ID}`,
    ]);
  });

  it("places no order when the real MCP request timeout fires mid-pre-flight", async () => {
    // The end-to-end proof that the signal the five cases above use is the one
    // the SDK actually aborts: the client's own per-request timeout sends
    // `notifications/cancelled`, the server's Protocol aborts the handler's
    // signal, and the submit that was about to happen does not happen.
    //
    // The stall is on /position-limit, which is one of the two SOFT reads — a
    // failure of either only pushes a warning — so before this the order path
    // could spend its entire budget on advisory reads and then submit into a
    // caller that had already been told the call timed out.
    h = await createHarness({
      routes: [
        {
          matcher: POSITION_LIMIT,
          method: "GET",
          reply: { data: {}, delayMs: 250 },
        },
        ...allRoutes(),
      ],
    });
    const dry = (await callOk(h, "tastytrade_dry_run_order", PLACE_ARGS)) as {
      confirmation_token: string;
    };

    await expect(
      h.client.callTool(
        {
          name: "tastytrade_place_order",
          arguments: {
            ...PLACE_ARGS,
            confirmation_token: dry.confirmation_token,
          },
        },
        undefined,
        { timeout: 50 },
      ),
    ).rejects.toThrow(/timed out/i);

    // The handler is still inside the stalled read at this point. Let it run to
    // completion — the assertion is about what it does NEXT, and asserting
    // before it gets there would pass for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(liveWrites()).toEqual([]);
  });
});
