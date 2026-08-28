/**
 * The account-state hard block runs on EVERY route that spends a confirmation token,
 * and every route discloses which checks it did not run.
 *
 * There are exactly two paths from a spent token to a live money-moving request:
 * `runSanityChecks` and `runStoredDryRunChecks`. With the `is-frozen` hard block in the
 * first only, the same frozen account `place_order` refuses outright accepts an edit —
 * and `order_type` is settable on the replace route, so a resting Limit could become a
 * MARKET order through a path that read no account state at all.
 *
 * The reasoning for that omission is sound for the two checks that need `legs` and was
 * applied to a check that reads one boolean off the account and needs none.
 *
 * The second half is the disclosure. `sanity_warnings: []` from an edit on a frozen
 * account was byte-identical to the same from a fully checked healthy one, so "checked,
 * nothing found" and "never checked" were the same value. The check list is now DATA:
 * every route declares what it ran and the difference is returned as `checks_not_run`.
 *
 * "The check ran" is only provable from the wire, so the e2e half asserts on the
 * presence of `GET /trading-status` and the ABSENCE of the mutating request.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, callOk, callError } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import * as sanityChecks from "../../src/safety/sanity-checks.js";
import { isToolErrorException } from "../../src/safety/errors.js";
import type { TastytradeClient } from "../../src/api-client.js";

const ACCT = "5WX00001";
const ORDER_ID = "8801";
const COMPLEX_ID = "7701";

const FROZEN_STATUS = {
  "account-number": ACCT,
  "is-frozen": true,
  "is-closing-only": false,
  "is-in-margin-call": false,
  "is-risk-reducing-only": false,
};
const CLEAN_STATUS = {
  "is-frozen": false,
  "is-closing-only": false,
  "is-in-margin-call": false,
  "is-risk-reducing-only": false,
};
const ALL_LIMITS = {
  "equity-order-size": 1_000_000,
  "equity-option-order-size": 1_000_000,
  "future-order-size": 1_000_000,
  "future-option-order-size": 1_000_000,
};
const CLEAN_DRY_RUN = {
  order: { status: "Received" },
  warnings: [],
  "buying-power-effect": {
    "change-in-buying-power": "-100.00",
    "change-in-buying-power-effect": "Debit",
  },
};
const SUBMITTED = { id: 8801, status: "Received" };

const ORDER_ARGS = {
  account_number: ACCT,
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
const EDIT_ARGS = {
  account_number: ACCT,
  order_id: ORDER_ID,
  order_type: "Market",
  time_in_force: "Day",
};
const COMPLEX_EDIT_ARGS = {
  account_number: ACCT,
  complex_order_id: COMPLEX_ID,
  ratio_price_threshold: "1.50",
};

/** One route table serving every money path, parameterised by account state. */
function routesFor(status: unknown): Route[] {
  return [
    {
      matcher: `/accounts/${ACCT}/trading-status`,
      method: "GET",
      reply: { data: status },
    },
    {
      matcher: `/accounts/${ACCT}/position-limit`,
      method: "GET",
      reply: { data: ALL_LIMITS },
    },
    { matcher: /\/dry-run$/, method: "POST", reply: { data: CLEAN_DRY_RUN } },
    { matcher: /.*/, reply: { data: SUBMITTED } },
  ];
}

let h: Harness | undefined;
const priorEnv: Record<string, string | undefined> = {};
const PINNED_ENV = {
  MAX_ORDER_NOTIONAL_USD: "50000",
  TASTYTRADE_READ_ONLY: undefined,
} as const;

beforeEach(() => {
  for (const [key, value] of Object.entries(PINNED_ENV)) {
    priorEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** METHOD + path of everything that crossed the transport. */
const wire = (harness: Harness): string[] =>
  harness.requests.map((r) => `${r.method} ${r.url.split("?")[0]}`);

const sawTradingStatus = (harness: Harness): boolean =>
  harness.requests.some(
    (r) => r.method === "GET" && r.url.endsWith("/trading-status"),
  );

/** Mint a token the honest way, then call the live tool with it. */
async function withToken(
  harness: Harness,
  dryRunTool: string,
  liveTool: string,
  args: Record<string, unknown>,
): Promise<{ token: string }> {
  const dry = (await callOk(harness, dryRunTool, args)) as {
    confirmation_token?: string;
  };
  expect(typeof dry.confirmation_token).toBe("string");
  return { token: dry.confirmation_token as string };
}

// ===========================================================================
// 1. The hard block, on every route that spends a token
// ===========================================================================

describe("a frozen account is refused on every gated submit route", () => {
  it("blocks place_order — the control that gives the rest meaning", async () => {
    h = await createHarness({ routes: routesFor(FROZEN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_order",
      "tastytrade_place_order",
      ORDER_ARGS,
    );
    const err = await callError(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: token,
    });
    expect(err.code).toBe("sanity_check_failed");
    expect(err.message).toMatch(/frozen/i);
    expect(wire(h)).not.toContain(`POST /accounts/${ACCT}/orders`);
    expect(sawTradingStatus(h)).toBe(true);
  });

  it("blocks edit_order, and the PATCH never leaves", async () => {
    h = await createHarness({ routes: routesFor(FROZEN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
    );
    const err = await callError(h, "tastytrade_edit_order", {
      ...EDIT_ARGS,
      confirmation_token: token,
    });
    expect(err.code).toBe("sanity_check_failed");
    expect(err.message).toMatch(/frozen/i);
    // Both halves matter: the check RAN (the GET is on the wire) and the money
    // request did NOT (the PATCH is absent).
    expect(sawTradingStatus(h)).toBe(true);
    expect(wire(h)).not.toContain(`PATCH /accounts/${ACCT}/orders/${ORDER_ID}`);
  });

  it("blocks replace_order — the route where order_type is settable", async () => {
    h = await createHarness({ routes: routesFor(FROZEN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_replace_order",
      "tastytrade_replace_order",
      EDIT_ARGS,
    );
    const err = await callError(h, "tastytrade_replace_order", {
      ...EDIT_ARGS,
      confirmation_token: token,
    });
    expect(err.code).toBe("sanity_check_failed");
    expect(err.message).toMatch(/frozen/i);
    expect(sawTradingStatus(h)).toBe(true);
    expect(wire(h)).not.toContain(`PUT /accounts/${ACCT}/orders/${ORDER_ID}`);
  });

  it("blocks edit_complex_order", async () => {
    h = await createHarness({ routes: routesFor(FROZEN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_edit_complex_order",
      "tastytrade_edit_complex_order",
      COMPLEX_EDIT_ARGS,
    );
    const err = await callError(h, "tastytrade_edit_complex_order", {
      ...COMPLEX_EDIT_ARGS,
      confirmation_token: token,
    });
    expect(err.code).toBe("sanity_check_failed");
    expect(err.message).toMatch(/frozen/i);
    expect(sawTradingStatus(h)).toBe(true);
    expect(wire(h)).not.toContain(
      `PATCH /accounts/${ACCT}/complex-orders/${COMPLEX_ID}`,
    );
  });

  it("still lets a healthy account through, with the read on the wire", async () => {
    h = await createHarness({ routes: routesFor(CLEAN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
    );
    const res = (await callOk(h, "tastytrade_edit_order", {
      ...EDIT_ARGS,
      confirmation_token: token,
    })) as Record<string, unknown>;
    expect(res.sanity_warnings).toEqual([]);
    expect(sawTradingStatus(h)).toBe(true);
    expect(wire(h)).toContain(`PATCH /accounts/${ACCT}/orders/${ORDER_ID}`);
  });
});

// ===========================================================================
// 2. The disclosure: "nothing found" and "never checked" are different values
// ===========================================================================

describe("every route discloses the checks it did not run", () => {
  it("names the legless route's two unrunnable checks", async () => {
    h = await createHarness({ routes: routesFor(CLEAN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
    );
    const res = (await callOk(h, "tastytrade_edit_order", {
      ...EDIT_ARGS,
      confirmation_token: token,
    })) as { checks_not_run?: unknown };

    expect(Array.isArray(res.checks_not_run)).toBe(true);
    const notRun = res.checks_not_run as string[];
    // The two checks that genuinely read `legs`, and nothing else.
    expect(notRun).toContain("per_leg_order_size");
    expect(notRun).toContain("account_closing_only");
    expect(notRun).not.toContain("account_frozen");
  });

  it("differs from place_order's, which runs everything", async () => {
    h = await createHarness({ routes: routesFor(CLEAN_STATUS) });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_order",
      "tastytrade_place_order",
      ORDER_ARGS,
    );
    const res = (await callOk(h, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: token,
    })) as { checks_not_run?: unknown };
    expect(res.checks_not_run).toEqual([]);
  });

  it("discloses the account-state checks when the read fails", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/trading-status`,
          method: "GET",
          reply: { networkError: "ECONNREFUSED" },
        },
        ...routesFor(CLEAN_STATUS).slice(1),
      ],
    });
    const { token } = await withToken(
      h,
      "tastytrade_dry_run_edit_order",
      "tastytrade_edit_order",
      EDIT_ARGS,
    );
    const res = (await callOk(h, "tastytrade_edit_order", {
      ...EDIT_ARGS,
      confirmation_token: token,
    })) as { checks_not_run?: unknown; sanity_warnings?: unknown };

    const notRun = res.checks_not_run as string[];
    expect(notRun).toContain("account_frozen");
    expect(notRun).toContain("account_margin_call");
    // And the prose channel still says what happened, as it did before.
    expect(
      (res.sanity_warnings as string[]).some((w) => /trading status/i.test(w)),
    ).toBe(true);
  });
});

// ===========================================================================
// 3. The helper both submit paths call
// ===========================================================================

describe("runAccountStateChecks", () => {
  /**
   * Read off the module namespace rather than imported by name, so this file
   * compiles against the revision that does not export it yet and the failure
   * is a measured one instead of a type error.
   */
  const runAccountStateChecks = (
    sanityChecks as unknown as Record<string, unknown>
  )["runAccountStateChecks"] as
    | ((
        client: TastytradeClient,
        accountNumber: string,
        legs?: unknown[],
      ) => Promise<{ warnings: string[]; ran: string[] }>)
    | undefined;

  const clientWith = (status: unknown, fail = false): TastytradeClient =>
    ({
      getAccountStatus: jest.fn(async () => {
        if (fail) throw new Error("status endpoint down");
        return status;
      }),
    }) as unknown as TastytradeClient;

  const openingLeg = [
    {
      symbol: "AAPL",
      "instrument-type": "Equity",
      action: "Buy to Open",
      quantity: 1,
    },
  ];

  it("is exported, so both submit paths can share one implementation", () => {
    expect(typeof runAccountStateChecks).toBe("function");
  });

  it("throws on is-frozen, with or without legs", async () => {
    if (!runAccountStateChecks) throw new Error("not exported");
    for (const legs of [undefined, openingLeg]) {
      let thrown: unknown;
      try {
        await runAccountStateChecks(clientWith(FROZEN_STATUS), ACCT, legs);
      } catch (e) {
        thrown = e;
      }
      expect(isToolErrorException(thrown)).toBe(true);
      expect(String((thrown as Error).message)).toMatch(/frozen/i);
    }
  });

  it("warns rather than throws on closing-only when there are no legs", async () => {
    if (!runAccountStateChecks) throw new Error("not exported");
    const res = await runAccountStateChecks(
      clientWith({ ...CLEAN_STATUS, "is-closing-only": true }),
      ACCT,
      undefined,
    );
    expect(res.warnings.some((w) => /closing-only/i.test(w))).toBe(true);
    // The GATE is what could not run; the FLAG was still read and reported.
    expect(res.ran).not.toContain("account_closing_only");
    expect(res.ran).toContain("account_frozen");
  });

  it("still throws on closing-only when a leg would open a position", async () => {
    if (!runAccountStateChecks) throw new Error("not exported");
    let thrown: unknown;
    try {
      await runAccountStateChecks(
        clientWith({ ...CLEAN_STATUS, "is-closing-only": true }),
        ACCT,
        openingLeg,
      );
    } catch (e) {
      thrown = e;
    }
    expect(isToolErrorException(thrown)).toBe(true);
    expect(String((thrown as Error).message)).toMatch(/closing-only/i);
  });

  it("warns and reports nothing run on an unreadable payload", async () => {
    if (!runAccountStateChecks) throw new Error("not exported");
    const res = await runAccountStateChecks(clientWith(null), ACCT, undefined);
    expect(res.warnings.some((w) => /trading status/i.test(w))).toBe(true);
    expect(res.ran).toEqual([]);
  });

  it("warns and reports nothing run on an object carrying no flags", async () => {
    if (!runAccountStateChecks) throw new Error("not exported");
    const res = await runAccountStateChecks(clientWith({}), ACCT, undefined);
    expect(res.warnings.some((w) => /did not run/i.test(w))).toBe(true);
    expect(res.ran).toEqual([]);
  });

  it("warns and reports nothing run when the endpoint is down", async () => {
    if (!runAccountStateChecks) throw new Error("not exported");
    const res = await runAccountStateChecks(
      clientWith(CLEAN_STATUS, true),
      ACCT,
      undefined,
    );
    expect(res.warnings.some((w) => /trading status/i.test(w))).toBe(true);
    expect(res.ran).toEqual([]);
  });
});

// ===========================================================================
// 4. The block is unbranchable: one implementation, and both paths reach it
// ===========================================================================

describe("the hard block cannot be reached around", () => {
  it("reads is-frozen in exactly one place", () => {
    // One implementation is what makes the block unbranchable: a second copy is
    // a second place a route can fail to reach.
    const source = readSanityChecksSource();
    expect(source.split('status["is-frozen"]').length - 1).toBe(1);
  });

  it("routes both submit paths through the shared helper", () => {
    const source = readSanityChecksSource();
    const bodyOf = (name: string): string => {
      const at = source.indexOf(`export async function ${name}(`);
      expect(at).toBeGreaterThan(-1);
      return source.slice(at).split("\n}")[0];
    };
    expect(bodyOf("runSanityChecks")).toContain("runAccountStateChecks(");
    expect(bodyOf("runStoredDryRunChecks")).toContain("runAccountStateChecks(");
  });
});

function readSanityChecksSource(): string {
  return readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/safety/sanity-checks.ts",
    ),
    "utf8",
  );
}
