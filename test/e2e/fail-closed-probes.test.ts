/**
 * A failed account read refuses an order that might open a position.
 *
 * `place_order` reads the account's position limits and trading status after the
 * confirmation token is spent. When either cannot be read, or what comes back is not
 * demonstrably that account's record, there is nothing to check the order against:
 *
 *   - an order with any leg that might open a position, and the three routes whose body
 *     carries no legs (replace_order, edit_order, edit_complex_order), are refused with
 *     `sanity_check_failed` and nothing is sent;
 *   - an order whose every leg is exactly Buy to Close or Sell to Close still goes ahead
 *     with a warning, so a position can be closed while these reads are down.
 *
 * Everything here goes through the real dispatcher and the harness's route table. "No
 * live write" is read off the wire, not off the response.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callOk } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import { toolError } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCT = "5WX00001";
const OTHER_ACCT = "5WX99999";
const ORDER_ID = "8801";
const COMPLEX_ID = "7701";

const POSITION_LIMIT = `/accounts/${ACCT}/position-limit`;
const TRADING_STATUS = `/accounts/${ACCT}/trading-status`;
const ORDERS_URL = `/accounts/${ACCT}/orders`;

const CLOSING_SENTENCE =
  "An order whose every leg is Buy to Close or Sell to Close is not refused for this reason.";

const ALL_LIMITS = {
  "account-number": ACCT,
  "equity-order-size": 1_000_000,
  "equity-option-order-size": 1_000_000,
  "future-order-size": 1_000_000,
  "future-option-order-size": 1_000_000,
};
const CLEAN_STATUS = {
  "account-number": ACCT,
  "is-frozen": false,
  "is-closing-only": false,
  "is-in-margin-call": false,
  "is-risk-reducing-only": false,
};
const CLEAN_DRY_RUN = {
  order: { status: "Received" },
  warnings: [],
  "buying-power-effect": {
    "change-in-buying-power": "-100.00",
    "change-in-buying-power-effect": "Debit",
  },
};
const SUBMITTED = { order: { id: 8801, status: "Received" } };

function orderArgs(action: string, quantity = 1): Record<string, unknown> {
  return {
    account_number: ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.00",
    price_effect: "Debit",
    legs: [{ symbol: "AAPL", instrument_type: "Equity", action, quantity }],
  };
}
const OPENING = orderArgs("Buy to Open");
const CLOSING = orderArgs("Sell to Close");

const COMPLEX_ORDERS_URL = `/accounts/${ACCT}/complex-orders`;
function complexArgs(action: string): Record<string, unknown> {
  const component = {
    order_type: "Limit",
    time_in_force: "Day",
    price: "1.00",
    price_effect: "Debit",
    legs: [{ symbol: "AAPL", instrument_type: "Equity", action, quantity: 1 }],
  };
  return {
    account_number: ACCT,
    type: "OTO",
    trigger_order: component,
    orders: [component],
  };
}

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

/** What one probe answers. Anything not given is a healthy answer. */
type Reply = { reply: Route["reply"] };
const healthy = (data: unknown): Reply => ({ reply: { data } });
const raw = (data: unknown): Reply => ({
  reply: { raw: true, data: { data } },
});

function routes(limits: Reply, status: Reply): Route[] {
  return [
    { matcher: POSITION_LIMIT, method: "GET", ...limits },
    { matcher: TRADING_STATUS, method: "GET", ...status },
    // Every dry-run answers clean; anything else, the live write included,
    // is accepted.
    { matcher: /\/dry-run$/, method: "POST", reply: { data: CLEAN_DRY_RUN } },
    { matcher: /.*/, reply: { data: SUBMITTED } },
  ];
}

let h: Harness | undefined;

beforeEach(() => {
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Every request that could create or change an order, dry-runs excluded. */
function liveWrites(harness: Harness) {
  return harness.requests.filter(
    (r) =>
      !r.url.endsWith("/dry-run") &&
      (r.method === "POST" || r.method === "PUT" || r.method === "PATCH"),
  );
}
const orderPosts = (harness: Harness) =>
  harness.requests.filter((r) => r.method === "POST" && r.url === ORDERS_URL);

async function tokenFor(
  harness: Harness,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = (await callOk(harness, tool, args)) as {
    confirmation_token?: string;
  };
  expect(typeof res.confirmation_token).toBe("string");
  return res.confirmation_token as string;
}

async function call(
  harness: Harness,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const res = (await harness.client.callTool({
    name: tool,
    arguments: args,
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  return {
    isError: res.isError === true,
    body: JSON.parse(res.content?.[0]?.text ?? "{}") as Record<string, unknown>,
  };
}

/** Dry-run, then submit with the token; the submit is expected to be refused. */
async function refused(
  harness: Harness,
  dryRunTool: string,
  submitTool: string,
  args: Record<string, unknown>,
): Promise<ToolError> {
  const token = await tokenFor(harness, dryRunTool, args);
  const res = await call(harness, submitTool, {
    ...args,
    confirmation_token: token,
  });
  expect(res.isError).toBe(true);
  const err = res.body as unknown as ToolError;
  expect(err.code).toBe("sanity_check_failed");
  expect(err.retryable).toBe(false);
  return err;
}

const refusedPlace = (harness: Harness, args = OPENING) =>
  refused(harness, "tastytrade_dry_run_order", "tastytrade_place_order", args);

/** Dry-run, then submit with the token; the submit is expected to go through. */
async function placedClosing(harness: Harness): Promise<{
  sanity_warnings: string[];
  checks_not_run: string[];
}> {
  const token = await tokenFor(harness, "tastytrade_dry_run_order", CLOSING);
  const res = await call(harness, "tastytrade_place_order", {
    ...CLOSING,
    confirmation_token: token,
  });
  expect(res.isError).toBe(false);
  return res.body as unknown as {
    sanity_warnings: string[];
    checks_not_run: string[];
  };
}

// ===========================================================================
// T1. The position-limit read fails
// ===========================================================================

describe("a failed position-limit read", () => {
  const FAILS = { reply: { status: 503 } } as Reply;

  it("refuses an order that might open a position, and sends nothing", async () => {
    h = await createHarness({ routes: routes(FAILS, healthy(CLEAN_STATUS)) });
    const err = await refusedPlace(h);

    expect(err.message).toContain("position limits");
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("was not sent");
    // Status only: no body, no code, nothing the broker wrote.
    expect(err.upstream).toEqual({ status: 503 });
    expect(err.hint).toContain("transient");
    expect(err.hint).toContain("dry_run");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
    expect(orderPosts(h)).toHaveLength(0);
  });

  it("still sends an order whose every leg closes, with the warning", async () => {
    h = await createHarness({ routes: routes(FAILS, healthy(CLEAN_STATUS)) });
    const res = await placedClosing(h);

    expect(res.sanity_warnings).toContain(
      "Could not fetch account position limits — relying on server-side enforcement.",
    );
    expect(res.checks_not_run).toContain("per_leg_order_size");
    expect(orderPosts(h)).toHaveLength(1);
  });
});

describe("a closing order whose limits record has no ceiling for its class", () => {
  it("goes ahead with the warning and lists per_leg_order_size as not run", async () => {
    h = await createHarness({
      routes: routes(
        healthy({ "account-number": ACCT, "future-order-size": 5 }),
        healthy(CLEAN_STATUS),
      ),
    });
    const res = await placedClosing(h);

    expect(res.sanity_warnings.join(" ")).toContain('"equity-order-size"');
    expect(res.checks_not_run).toContain("per_leg_order_size");
    expect(orderPosts(h)).toHaveLength(1);
  });

  it("lists it as run when the record carries the ceiling", async () => {
    h = await createHarness({
      routes: routes(healthy(ALL_LIMITS), healthy(CLEAN_STATUS)),
    });
    const res = await placedClosing(h);

    expect(res.checks_not_run).not.toContain("per_leg_order_size");
  });
});

// ===========================================================================
// T2. The trading-status read fails, on every route that reads it
// ===========================================================================

describe("a failed trading-status read", () => {
  const FAILURES: Array<[string, Reply]> = [
    ["a connection reset", { reply: { networkError: "ECONNRESET" } }],
    ["a null answer", raw(null)],
    ["an empty record", raw({})],
    // Names the account and nothing else: the readable-record test passes, so
    // this is the "no flag" path rather than the unnamed one that `{}` takes.
    [
      "a record naming the account with no flags",
      healthy({ "account-number": ACCT }),
    ],
    [
      "a record carrying only is-in-margin-call",
      healthy({ "account-number": ACCT, "is-in-margin-call": false }),
    ],
    [
      "a record whose is-frozen is not a boolean",
      healthy({ ...CLEAN_STATUS, "is-frozen": "" }),
    ],
    [
      "another account's record",
      healthy({ ...CLEAN_STATUS, "account-number": OTHER_ACCT }),
    ],
  ];

  it.each(FAILURES)(
    "refuses place_order, replace_order, edit_order and edit_complex_order on %s",
    async (_label, status) => {
      h = await createHarness({ routes: routes(healthy(ALL_LIMITS), status) });

      const place = await refusedPlace(h);
      expect(place.message).toContain("trading status");
      expect(place.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
      await refused(
        h,
        "tastytrade_dry_run_replace_order",
        "tastytrade_replace_order",
        EDIT_ARGS,
      );
      await refused(
        h,
        "tastytrade_dry_run_edit_order",
        "tastytrade_edit_order",
        EDIT_ARGS,
      );
      await refused(
        h,
        "tastytrade_dry_run_edit_complex_order",
        "tastytrade_edit_complex_order",
        COMPLEX_EDIT_ARGS,
      );

      expect(liveWrites(h)).toEqual([]);
    },
  );

  it.each(FAILURES)(
    "still sends a place_order whose every leg closes on %s, with the warning",
    async (_label, status) => {
      h = await createHarness({ routes: routes(healthy(ALL_LIMITS), status) });
      const res = await placedClosing(h);

      expect(res.sanity_warnings.join(" ")).toMatch(/trading status/);
      expect(res.checks_not_run).toContain("account_frozen");
      expect(orderPosts(h)).toHaveLength(1);
    },
  );
});

// ===========================================================================
// T3. A position-limit record that is not this account's
// ===========================================================================

describe("a position-limit record for another account", () => {
  const FOREIGN = {
    "account-number": OTHER_ACCT,
    "equity-order-size": 1,
  };

  it("is refused, and neither the message nor the hint repeats either account number or the ceiling", async () => {
    h = await createHarness({
      routes: routes(healthy(FOREIGN), healthy(CLEAN_STATUS)),
    });
    const err = await refusedPlace(h, orderArgs("Buy to Open", 5));

    expect(err.message).not.toContain(OTHER_ACCT);
    expect(err.message).not.toContain(ACCT);
    expect(err.message).not.toContain("limit 1");
    expect(err.hint).not.toContain(OTHER_ACCT);
    expect(err.hint).toContain("not this account");
    expect(err.hint).toContain("TASTYTRADE_API_URL");
    expect(orderPosts(h)).toHaveLength(0);
  });

  it("is compared against when it names this account", async () => {
    h = await createHarness({
      routes: routes(
        healthy({ ...FOREIGN, "account-number": ACCT }),
        healthy(CLEAN_STATUS),
      ),
    });
    const err = await refusedPlace(h, orderArgs("Buy to Open", 5));

    expect(err.message).toContain("exceeds account order limit 1");
  });
});

// ===========================================================================
// T4. What the hint says, by cause
// ===========================================================================

describe("the hint on a refused order names the cause", () => {
  const limitsFailing = (reply: Route["reply"]) =>
    routes({ reply }, healthy(CLEAN_STATUS));

  it("says a 404 cannot be fixed by trying again, and never calls it transient", async () => {
    h = await createHarness({ routes: limitsFailing({ status: 404 }) });
    const err = await refusedPlace(h);

    expect(err.hint).toContain("will not change");
    expect(err.hint).not.toContain("transient");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
    expect(err.upstream).toEqual({ status: 404 });
  });

  it("calls a 503 transient", async () => {
    h = await createHarness({ routes: limitsFailing({ status: 503 }) });
    const err = await refusedPlace(h);

    expect(err.hint).toContain("transient");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
  });

  it("calls a 429 transient and carries the wait", async () => {
    h = await createHarness({ routes: limitsFailing({ status: 429 }) });
    const err = await refusedPlace(h);

    expect(err.hint).toContain("transient");
    expect(err.retry_after_ms).toBe(1000);
    expect(err.hint).toContain("1000ms");
    expect(err.upstream).toEqual({ status: 429 });
  });

  it("tells a 403 on the read itself that this login may not read the account, without pointing at credentials", async () => {
    h = await createHarness({ routes: limitsFailing({ status: 403 }) });
    const err = await refusedPlace(h);

    expect(err.hint).toContain("account_number");
    expect(err.hint).not.toContain("TASTYTRADE_CLIENT_ID");
    expect(err.hint).not.toContain("TASTYTRADE_REFRESH_TOKEN");
    expect(err.hint).not.toContain("transient");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
  });

  it("gives any other status a neutral hint", async () => {
    h = await createHarness({ routes: limitsFailing({ status: 400 }) });
    const err = await refusedPlace(h);

    expect(err.message).toContain("HTTP 400");
    expect(err.hint).toContain("unlikely to help");
    expect(err.hint).not.toContain("transient");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
  });

  it("reports a failed credential exchange as a failed read, with the hint the client gave", async () => {
    // The grant works for the dry-run and fails on the first read of the submit,
    // which is the request interceptor throwing a finished ToolError rather than
    // the read answering. The API client's own finished ToolErrors for a read
    // carry the same codes, so the two are not told apart: the refusal says the
    // read could not be completed and carries the status, nothing more.
    let grantWorks = true;
    h = await createHarness({
      routes: routes(healthy(ALL_LIMITS), healthy(CLEAN_STATUS)),
      tokenProvider: () => {
        if (grantWorks) return "test-access-token";
        throw toolError({
          code: "auth_failed",
          message: "The tastytrade token endpoint refused the refresh token.",
          retryable: false,
          upstream: { status: 400 },
          hint: "Check TASTYTRADE_REFRESH_TOKEN and restart the server.",
        });
      },
    });
    const token = await tokenFor(h, "tastytrade_dry_run_order", OPENING);
    grantWorks = false;
    const res = await call(h, "tastytrade_place_order", {
      ...OPENING,
      confirmation_token: token,
    });
    const err = res.body as unknown as ToolError;

    expect(err.code).toBe("sanity_check_failed");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("(HTTP 400)");
    expect(err.upstream).toEqual({ status: 400 });
    expect(err.hint).toContain("TASTYTRADE_REFRESH_TOKEN");
    expect(err.hint).toContain("dry_run");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
    expect(orderPosts(h)).toHaveLength(0);
  });
});

// ===========================================================================
// T4b. A read the API client itself gave up on is not a token-grant failure
// ===========================================================================

describe("a read failure the client reports as a finished error", () => {
  // The body goes out as given, not inside the `{data: ...}` envelope, which
  // is what a proxy page or an empty reply looks like on the wire.
  const bare = (body: string): Reply => ({ reply: { raw: true, data: body } });

  // Each of these makes the API client throw its own finished ToolError for
  // the read (a 2xx that is not JSON, or a transport abort), which carries a
  // code the OAuth client also uses for its grant failures.
  const CASES: Array<[string, Reply, Reply, string]> = [
    [
      "a 200 HTML page on trading-status",
      healthy(ALL_LIMITS),
      bare("<html>proxy</html>"),
      "trading status",
    ],
    [
      "a 200 with an empty body on position-limit",
      bare(""),
      healthy(CLEAN_STATUS),
      "position limits",
    ],
    [
      "an ECONNABORTED on position-limit",
      { reply: { networkError: "ECONNABORTED" } },
      healthy(CLEAN_STATUS),
      "position limits",
    ],
  ];

  it.each(CASES)(
    "does not blame the token grant for %s",
    async (_label, limits, status, probe) => {
      h = await createHarness({ routes: routes(limits, status) });
      const err = await refusedPlace(h);

      expect(err.message).toContain(`read the account's ${probe}`);
      expect(err.message).not.toContain("token grant");
      expect(err.hint ?? "").not.toContain("token grant");
      expect(err.hint ?? "").not.toContain("The token");
      expect(err.upstream?.code).toBeUndefined();
      expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
      expect(orderPosts(h)).toHaveLength(0);
    },
  );
});

// ===========================================================================
// T5. place_complex_order reads the same two records
// ===========================================================================

describe("place_complex_order on a failed probe", () => {
  const refusedComplex = (harness: Harness, args: Record<string, unknown>) =>
    refused(
      harness,
      "tastytrade_dry_run_complex_order",
      "tastytrade_place_complex_order",
      args,
    );
  const complexPosts = (harness: Harness) =>
    harness.requests.filter(
      (r) => r.method === "POST" && r.url === COMPLEX_ORDERS_URL,
    );

  it("refuses when the position-limit read fails, and sends nothing", async () => {
    h = await createHarness({
      routes: routes({ reply: { status: 503 } }, healthy(CLEAN_STATUS)),
    });
    const err = await refusedComplex(h, complexArgs("Buy to Open"));

    expect(err.message).toContain("position limits");
    expect(err.message).toContain("HTTP 503");
    expect(err.upstream).toEqual({ status: 503 });
    expect(complexPosts(h)).toHaveLength(0);
  });

  it("refuses when the trading status names another account", async () => {
    h = await createHarness({
      routes: routes(
        healthy(ALL_LIMITS),
        healthy({ ...CLEAN_STATUS, "account-number": OTHER_ACCT }),
      ),
    });
    const err = await refusedComplex(h, complexArgs("Buy to Open"));

    expect(err.message).toContain("trading status");
    expect(err.message).not.toContain(OTHER_ACCT);
    expect(complexPosts(h)).toHaveLength(0);
  });

  it("sends the same order when both reads are healthy", async () => {
    // Control: only the probes differ from the refusals above.
    h = await createHarness({
      routes: routes(healthy(ALL_LIMITS), healthy(CLEAN_STATUS)),
    });
    const args = complexArgs("Buy to Open");
    const token = await tokenFor(h, "tastytrade_dry_run_complex_order", args);
    const res = await call(h, "tastytrade_place_complex_order", {
      ...args,
      confirmation_token: token,
    });

    expect(res.isError).toBe(false);
    expect(complexPosts(h)).toHaveLength(1);
  });

  it("still sends an order whose every leg closes when the read fails, with the warning", async () => {
    h = await createHarness({
      routes: routes({ reply: { status: 503 } }, healthy(CLEAN_STATUS)),
    });
    const args = complexArgs("Sell to Close");
    const token = await tokenFor(h, "tastytrade_dry_run_complex_order", args);
    const res = await call(h, "tastytrade_place_complex_order", {
      ...args,
      confirmation_token: token,
    });

    expect(res.isError).toBe(false);
    expect(res.body.sanity_warnings).toContain(
      "Could not fetch account position limits — relying on server-side enforcement.",
    );
    expect(complexPosts(h)).toHaveLength(1);
  });
});

// ===========================================================================
// T6. A limits record that names the account but has no ceiling for the leg
// ===========================================================================

describe("a position-limit record with no ceiling for the leg's class", () => {
  const NO_EQUITY_CEILING = {
    "account-number": ACCT,
    "future-order-size": 5,
  };

  it("refuses an opening order, however large, and sends nothing", async () => {
    h = await createHarness({
      routes: routes(healthy(NO_EQUITY_CEILING), healthy(CLEAN_STATUS)),
    });
    const err = await refusedPlace(h, orderArgs("Buy to Open", 1_000_000_000));

    expect(err.message).toContain("no usable ceiling");
    expect(err.hint).toContain("not a transient failure");
    expect(err.hint?.endsWith(CLOSING_SENTENCE)).toBe(true);
    expect(orderPosts(h)).toHaveLength(0);
  });

  it("sends a closing order with the warning", async () => {
    h = await createHarness({
      routes: routes(healthy(NO_EQUITY_CEILING), healthy(CLEAN_STATUS)),
    });
    const res = await placedClosing(h);

    expect(res.sanity_warnings.join(" ")).toContain(
      'no usable "equity-order-size"',
    );
    expect(orderPosts(h)).toHaveLength(1);
  });
});
