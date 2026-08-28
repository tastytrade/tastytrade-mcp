import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

/**
 * `tastytrade://accounts/{n}/pnl-today` — the arithmetic half of the resource's failure
 * policy.
 *
 * `test/e2e/resources-fail-open.test.ts` pins the INPUT half: a field the API did not
 * supply becomes `null`, the row is excluded from the totals, and the body says so.
 * This file pins the same guarantee for a figure the module DERIVED.
 *
 * Four finite operands can multiply to `Infinity`, `Infinity * 0` is `NaN`, and a total
 * of individually finite rows can overflow on its own. Unchecked, the poison is admitted
 * to the running sum (`NaN !== null` is true), counted as a good contributor, forwarded
 * by `sumOrNull` (`(Infinity).toFixed(2)` is the string `"Infinity"`) and rendered by
 * `JSON.stringify` as the JSON literal `null` — this module's encoding for UNKNOWN. So
 * the body reports an unknown total while `"partial-read": false` and an empty exclusion
 * list say the read was complete, beside a `note` asserting a cause that had not
 * happened: the same row's echoed inputs were all present and finite.
 *
 * The invariant asserted here is the module's own: a figure that could not be computed
 * is `null`, and whenever any figure is null the body names the row and the reason. The
 * reason is one of two — `unreadable-fields` for an input the API did not supply,
 * `non-finite-fields` / `non-finite-total` for arithmetic that produced no finite number
 * — so the body describes what happened rather than assuming which.
 */

let h: Harness | undefined;

// The rate limiter is module-global and `pnl-today` spends the 1/sec `positions`
// ceiling, so without a reset the second test would be refused before it reached
// the behaviour it asserts.
beforeEach(() => {
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  _resetRateLimitsForTest();
});

const ACCT = "5WX00001";
const PNL = `tastytrade://accounts/${ACCT}/pnl-today`;
const POSITIONS = `/accounts/${ACCT}/positions`;

/** Boots the harness with one positions payload and reads the computed body. */
async function withPositions(items: unknown[]): Promise<Record<string, any>> {
  h = await createHarness({
    routes: [{ matcher: POSITIONS, reply: { data: { items } } }],
  });
  const res = await h.client.readResource({ uri: PNL });
  expect(res.contents).toHaveLength(1);
  const text = (res.contents[0] as { text?: string }).text ?? "";
  return JSON.parse(text) as Record<string, any>;
}

/** An ordinary equity row: +$500 on the day, every field present and finite. */
const NORMAL = {
  symbol: "AAPL",
  "instrument-type": "Equity",
  "quantity-direction": "Long",
  quantity: 100,
  multiplier: 1,
  "mark-price": "190.00",
  "close-price": "185.00",
  "realized-day-gain": "0.00",
  "realized-day-gain-effect": "None",
};

/** One row worth +1.7e308 unrealized: finite on its own, not in pairs. */
const HALF_MAX = (symbol: string) => ({
  symbol,
  "instrument-type": "Future",
  "quantity-direction": "Long",
  quantity: 1,
  multiplier: 1,
  "mark-price": "1.7e308",
  "close-price": "0",
  "realized-day-gain": "0.00",
  "realized-day-gain-effect": "None",
});

/** The entry shape of `positions-excluded-from-estimate`. */
type Excluded = Array<{
  symbol?: string | null;
  "unreadable-fields"?: string[];
  "non-finite-fields"?: string[];
  "non-finite-total"?: string;
}>;

describe("pnl-today discloses a figure it could not represent", () => {
  it("excludes a row whose product overflows, and keeps the readable row's total", async () => {
    // Futures multipliers are legitimately large and both prices are ordinary
    // two-decimal strings, so every input passes `finiteOrNull` — but
    // 1 * (100 - 1) * 1e308 * 1e10 is `Infinity`.
    const body = await withPositions([
      NORMAL,
      {
        symbol: "/ESZ5",
        "instrument-type": "Future",
        "quantity-direction": "Long",
        quantity: 1e308,
        multiplier: 1e10,
        "mark-price": "100.00",
        "close-price": "1.00",
        "realized-day-gain": "0.00",
        "realized-day-gain-effect": "None",
      },
    ]);

    expect(body["partial-read"]).toBe(true);
    expect(body.warning).toMatch(/INCOMPLETE ESTIMATE/);
    const excluded = body["positions-excluded-from-estimate"] as Excluded;
    expect(excluded).toEqual([
      {
        symbol: "/ESZ5",
        "non-finite-fields": ["estimated-unrealized-day-pnl"],
      },
    ]);
    // Named as non-finite, NOT as unreadable: every input was supplied.
    expect(excluded[0]["unreadable-fields"]).toBeUndefined();

    // The poisoned row reports null for the figure it could not compute...
    expect(body.positions[1]["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body.positions[1]["estimated-total-day-pnl"]).toBeNull();
    // ...and the row that computed fine is not destroyed with it. This is
    // what the old `unrealized += Infinity` cost: the whole account total.
    expect(body["estimated-unrealized-day-pnl"]).toBe(500);
    expect(body["estimated-total-day-pnl"]).toBe(500);
  });

  it("excludes a row whose product is NaN via Infinity * 0", async () => {
    // A zero-quantity row is what a closed-out position looks like. It is the
    // route `positionUnrealized !== null` would admit, because `NaN !== null`
    // — which ALSO incremented the contributor count and so defeated
    // `sumOrNull`'s "no row fed this" test, the one guard in the right place.
    const body = await withPositions([
      NORMAL,
      {
        symbol: "/CLZ5",
        "instrument-type": "Future",
        "quantity-direction": "Long",
        quantity: 0,
        multiplier: 1,
        "mark-price": "1e308",
        "close-price": "-1e308",
        "realized-day-gain": "0.00",
        "realized-day-gain-effect": "None",
      },
    ]);

    expect(body["positions-excluded-from-estimate"]).toEqual([
      {
        symbol: "/CLZ5",
        "non-finite-fields": ["estimated-unrealized-day-pnl"],
      },
    ]);
    expect(body["partial-read"]).toBe(true);
    expect(body["estimated-unrealized-day-pnl"]).toBe(500);
    expect(body["estimated-total-day-pnl"]).toBe(500);
  });

  it("excludes a row whose realized + unrealized sum overflows", async () => {
    // Both addends finite, their sum not. The row's two component figures stay
    // readable; only the row total goes unknown, and only that is named.
    const body = await withPositions([
      {
        ...HALF_MAX("/A1"),
        "realized-day-gain": "1.7e308",
        "realized-day-gain-effect": "Credit",
      },
    ]);

    expect(body.positions[0]["estimated-unrealized-day-pnl"]).toBe(1.7e308);
    expect(body.positions[0]["realized-day-gain"]).toBe(1.7e308);
    expect(body.positions[0]["estimated-total-day-pnl"]).toBeNull();
    expect(body["partial-read"]).toBe(true);
    // The row is named for the figure it could not add up. The account's grand
    // total is unrepresentable for the same reason and is named separately,
    // because a row entry cannot speak for an account-level figure.
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { symbol: "/A1", "non-finite-fields": ["estimated-total-day-pnl"] },
      { "non-finite-total": "estimated-total-day-pnl" },
    ]);
  });

  it("discloses an unrealized TOTAL that overflows from rows that were each finite", async () => {
    const body = await withPositions([HALF_MAX("/A1"), HALF_MAX("/A2")]);

    // Every row computed a real number...
    expect(body.positions[0]["estimated-unrealized-day-pnl"]).toBe(1.7e308);
    expect(body.positions[1]["estimated-unrealized-day-pnl"]).toBe(1.7e308);
    // ...and the total of them is not representable, which the body must say.
    // A per-row guard alone would leave this one a bare, undisclosed null.
    expect(body["estimated-unrealized-day-pnl"]).toBeNull();
    expect(body["estimated-total-day-pnl"]).toBeNull();
    expect(body["partial-read"]).toBe(true);
    expect(body.warning).toMatch(/INCOMPLETE ESTIMATE/);
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { "non-finite-total": "estimated-unrealized-day-pnl" },
    ]);
  });

  it("discloses a realized TOTAL that overflows from rows that were each finite", async () => {
    const realizedOnly = (symbol: string) => ({
      symbol,
      "instrument-type": "Equity",
      "quantity-direction": "Long",
      quantity: 1,
      multiplier: 1,
      "mark-price": "10.00",
      "close-price": "10.00",
      "realized-day-gain": "1.7e308",
      "realized-day-gain-effect": "Credit",
    });

    const body = await withPositions([
      realizedOnly("AAPL"),
      realizedOnly("MSFT"),
    ]);

    expect(body["realized-day-pnl"]).toBeNull();
    expect(body["estimated-unrealized-day-pnl"]).toBe(0);
    expect(body["estimated-total-day-pnl"]).toBeNull();
    expect(body["partial-read"]).toBe(true);
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { "non-finite-total": "realized-day-pnl" },
    ]);
  });

  it("discloses a GRAND total that overflows from two finite component totals", async () => {
    // Realized and unrealized are each representable; their sum is not. Neither
    // row is excluded, because neither row failed — the account total did.
    const body = await withPositions([
      {
        ...HALF_MAX("/A1"),
        "mark-price": "10.00",
        "close-price": "10.00",
        "realized-day-gain": "1.7e308",
        "realized-day-gain-effect": "Credit",
      },
      HALF_MAX("/A2"),
    ]);

    expect(body["realized-day-pnl"]).toBe(1.7e308);
    expect(body["estimated-unrealized-day-pnl"]).toBe(1.7e308);
    expect(body["estimated-total-day-pnl"]).toBeNull();
    expect(body["partial-read"]).toBe(true);
    expect(body["positions-excluded-from-estimate"]).toEqual([
      { "non-finite-total": "estimated-total-day-pnl" },
    ]);
  });

  it("never claims a null figure means the input was missing", async () => {
    const body = await withPositions([NORMAL]);

    expect(body.note).not.toMatch(
      /A null figure means the input was missing from the API payload/,
    );
    // Both causes are named, and the reader is pointed at the row-level detail
    // rather than being told which one happened.
    expect(body.note).toMatch(/unreadable/i);
    expect(body.note).toMatch(/finite/i);
    expect(body.note).toMatch(/positions-excluded-from-estimate/);
    // The one sentence that must survive: null is unknown, never zero.
    expect(body.note).toMatch(/unknown, not zero/i);
  });

  // ---- the cases that must not move -----------------------------------------
  //
  // A guard on a derived figure is one edit away from refusing every figure, so
  // each of these is a lock against the fix being "verified" by a body that
  // discloses everything.

  it("still reports an ordinary two-row book with no disclosure", async () => {
    const body = await withPositions([
      NORMAL,
      {
        symbol: "MSFT",
        quantity: "5",
        multiplier: 1,
        "quantity-direction": "Long",
        "close-price": "300.00",
        "mark-price": "302.00",
        "realized-day-gain": "10.00",
        "realized-day-gain-effect": "Credit",
      },
    ]);

    expect(body["estimated-unrealized-day-pnl"]).toBe(510);
    expect(body["realized-day-pnl"]).toBe(10);
    expect(body["estimated-total-day-pnl"]).toBe(520);
    expect(body["partial-read"]).toBe(false);
    expect(body["positions-excluded-from-estimate"]).toEqual([]);
    expect("warning" in body).toBe(false);
  });

  it("still names a genuinely missing input as unreadable, not as non-finite", async () => {
    const body = await withPositions([{ ...NORMAL, "mark-price": undefined }]);

    expect(body["positions-excluded-from-estimate"]).toEqual([
      { symbol: "AAPL", "unreadable-fields": ["mark-price"] },
    ]);
  });

  it("still reports a real zero for a successfully-read flat book", async () => {
    const body = await withPositions([]);

    expect(body["realized-day-pnl"]).toBe(0);
    expect(body["estimated-unrealized-day-pnl"]).toBe(0);
    expect(body["estimated-total-day-pnl"]).toBe(0);
    expect(body["partial-read"]).toBe(false);
    expect(body["positions-excluded-from-estimate"]).toEqual([]);
  });

  it("still reports a large but representable figure as a number", async () => {
    // The guard is on representability, not on magnitude: a genuinely large
    // futures line must keep its number rather than being refused for looking
    // dangerous.
    const body = await withPositions([
      {
        symbol: "/ESZ5",
        "instrument-type": "Future",
        "quantity-direction": "Long",
        quantity: 10,
        multiplier: 50,
        "mark-price": "5800.00",
        "close-price": "5750.00",
        "realized-day-gain": "0.00",
        "realized-day-gain-effect": "None",
      },
    ]);

    expect(body["estimated-unrealized-day-pnl"]).toBe(25000);
    expect(body["partial-read"]).toBe(false);
  });
});
