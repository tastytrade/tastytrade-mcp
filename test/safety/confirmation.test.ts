import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  issueToken,
  consumeToken,
  canonicalize,
  _resetTokensForTest,
  _tokenCountForTest,
} from "../../src/safety/confirmation.js";
import {
  isToolErrorException,
  type ToolError,
  type ToolErrorCode,
} from "../../src/safety/errors.js";

/** The ToolError a refusal carried, or a failure if nothing was refused. */
function refusalOf(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (e) {
    if (isToolErrorException(e)) return e.toolError;
    throw new Error(`expected a ToolErrorException, got: ${String(e)}`, {
      cause: e,
    });
  }
  throw new Error("expected a ToolErrorException, but nothing was thrown");
}

function expectToolErrorCode(fn: () => unknown, code: ToolErrorCode): void {
  expect(refusalOf(fn).code).toBe(code);
}

/**
 * `issueToken` and `consumeToken` now bind the REQUEST
 * TARGET as well as the action and the args, so every call has to name the
 * endpoint it authorises. One place-order pairing serves the whole file — the
 * target-specific cases have their own describe block at the bottom.
 */
const BOUND_TARGETS = {
  dryRun: { method: "POST", path: "/accounts/5WX34382/orders/dry-run" },
  submit: { method: "POST", path: "/accounts/5WX34382/orders" },
};

const ARGS = {
  account_number: "5WX34382",
  body: { "order-type": "Limit", legs: [{ symbol: "AAPL", quantity: 1 }] },
};

/** A second, distinct order — a concurrently outstanding dry-run. */
const LIVE_ARGS = {
  account_number: "5WX99999",
  body: { "order-type": "Market", legs: [{ symbol: "MSFT", quantity: 2 }] },
};

beforeEach(() => {
  _resetTokensForTest();
});

describe("canonicalize", () => {
  it("is independent of object key order", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalize({ x: { p: 1, q: 2 } })).toBe(
      canonicalize({ x: { q: 2, p: 1 } }),
    );
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });
});

describe("issueToken / consumeToken", () => {
  it("round-trips a token for matching action + args and returns the dry-run result", () => {
    const issued = issueToken("place_order", { ok: true }, ARGS, BOUND_TARGETS);
    expect(issued.token).toBeTruthy();
    expect(issued.action).toBe("place_order");
    const consumed = consumeToken(
      issued.token,
      "place_order",
      ARGS,
      BOUND_TARGETS.submit,
    );
    expect(consumed.dryRunResult).toEqual({ ok: true });
  });

  it("is single-use — a second consume of the same token fails", () => {
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit);
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit),
      "dry_run_required",
    );
  });

  it("rejects an unknown token with dry_run_required", () => {
    expectToolErrorCode(
      () =>
        consumeToken(
          "does-not-exist",
          "place_order",
          ARGS,
          BOUND_TARGETS.submit,
        ),
      "dry_run_required",
    );
  });

  it("rejects a token consumed under the wrong action with dry_run_required", () => {
    // NOT `validation`. `validation` is the code for a malformed argument, and
    // an agent answers it by fixing the arguments and retrying — which can
    // never clear this refusal, because no edit to these args turns a
    // place_order approval into a replace_order one. `dry_run_required` names
    // the only thing that does work: dry-run the action being attempted.
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    const refusal = refusalOf(() =>
      consumeToken(issued.token, "replace_order", ARGS, BOUND_TARGETS.submit),
    );
    expect(refusal.code).toBe("dry_run_required");
    // The two actions still have to be named, or the refusal is
    // indistinguishable from "you presented no token at all".
    expect(refusal.message).toMatch(/issued for "place_order"/);
    expect(refusal.message).toMatch(/not "replace_order"/);
  });

  it.each([
    ["place_order", "tastytrade_dry_run_order"],
    ["place_complex_order", "tastytrade_dry_run_complex_order"],
    ["replace_order", "tastytrade_dry_run_replace_order"],
    ["edit_order", "tastytrade_dry_run_edit_order"],
    ["edit_complex_order", "tastytrade_dry_run_edit_complex_order"],
  ])(
    "points a %s refusal at %s, the dry-run tool that can actually mint its token",
    (action, dryRunTool) => {
      // A hint is the whole remedy for `dry_run_required`, so naming the wrong
      // tool is worse than naming none: the earlier rule stripped the first
      // word of the action and sent replace_order, edit_order and
      // edit_complex_order to `tastytrade_dry_run_order` — a real tool that
      // mints a real token bound to the wrong action, so the agent's next
      // attempt lands back on this same refusal.
      const missing = refusalOf(() =>
        consumeToken("no-such-token", action, {}, BOUND_TARGETS.submit),
      );
      expect(missing.hint).toContain(`${dryRunTool} `);

      const wrongAction = issueToken("cancel_order", {}, ARGS, BOUND_TARGETS);
      const mismatch = refusalOf(() =>
        consumeToken(wrongAction.token, action, ARGS, BOUND_TARGETS.submit),
      );
      expect(mismatch.hint).toContain(`${dryRunTool} `);
    },
  );

  it("is insensitive to arg key ordering (canonicalized hash)", () => {
    const issued = issueToken("place_order", {}, { a: 1, b: 2 }, BOUND_TARGETS);
    const consumed = consumeToken(
      issued.token,
      "place_order",
      { b: 2, a: 1 },
      BOUND_TARGETS.submit,
    );
    expect(consumed.action).toBe("place_order");
  });

  it("rejects mutated args (dry-run-small / submit-large) with confirmation_expired", () => {
    const issued = issueToken(
      "place_order",
      {},
      {
        account_number: "5WX34382",
        body: { legs: [{ symbol: "AAPL", quantity: 1 }] },
      },
      BOUND_TARGETS,
    );
    const tampered = {
      account_number: "5WX34382",
      body: { legs: [{ symbol: "AAPL", quantity: 1000 }] },
    };
    expectToolErrorCode(
      () =>
        consumeToken(
          issued.token,
          "place_order",
          tampered,
          BOUND_TARGETS.submit,
        ),
      "confirmation_expired",
    );
  });
});

describe("token TTL (60s)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    _resetTokensForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("accepts a token within the 60s window", () => {
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    jest.advanceTimersByTime(59_000);
    expect(
      consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit)
        .action,
    ).toBe("place_order");
  });

  it("rejects a token after the 60s TTL with dry_run_required", () => {
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    jest.advanceTimersByTime(61_000);
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit),
      "dry_run_required",
    );
  });

  it("answers an expired token identically whether or not a sweep reached it first", () => {
    // The determinism this pins is the whole point of sweeping inside
    // consumeToken. Expiry would be reported two ways for one situation: an
    // expired entry still in the map came back `confirmation_expired`, the same
    // entry after an unrelated tool's issueToken had swept it came back
    // `dry_run_required`. Whether an agent saw one or the other depended on
    // traffic from tools it had nothing to do with — and this codebase tells
    // agents to branch on `code`.
    const unswept = issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    const swept = issueToken("place_order", {}, LIVE_ARGS, BOUND_TARGETS);
    jest.advanceTimersByTime(61_000);

    // `unswept` is presented with no intervening traffic at all.
    const a = refusalOf(() =>
      consumeToken(unswept.token, "place_order", ARGS, BOUND_TARGETS.submit),
    );
    // `swept` is presented after an unrelated dry-run has swept the store.
    issueToken(
      "cancel_order",
      {},
      { account_number: "5WX00000" },
      BOUND_TARGETS,
    );
    const b = refusalOf(() =>
      consumeToken(swept.token, "place_order", LIVE_ARGS, BOUND_TARGETS.submit),
    );

    expect(a.code).toBe(b.code);
    expect(a.code).toBe("dry_run_required");
    expect(a.retryable).toBe(false);
    // The TTL has to survive the merge, or an agent that just obtained a token
    // has no way to learn why it is already gone.
    expect(a.hint).toMatch(/60 seconds/);
  });

  it("issuing a token sweeps the expired ones and keeps the live ones", () => {
    // The store is in-memory and unbounded, and a dry-run that is never
    // followed by a submit leaves an entry behind. `issueToken` sweeps expired
    // entries for exactly that reason, and a token that is never consumed is
    // never swept by anything else — so with the sweep neutered a long stdio
    // session grows one token per abandoned dry-run, forever.
    //
    // The count is the observable. It would be the refusal code — a swept
    // token said `dry_run_required`, an expired-but-present one said
    // `confirmation_expired` — but those two now agree by design, so eviction
    // needs a window of its own or nothing in the suite notices it stopping.
    const stale = issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    jest.advanceTimersByTime(61_000);

    const live = issueToken("place_order", {}, LIVE_ARGS, BOUND_TARGETS);
    expect(_tokenCountForTest()).toBe(1);

    // A second issuance so the sweep runs with `live` already in the map: a
    // collector that took the predicate the wrong way round would drop the
    // in-flight confirmation instead of the abandoned one.
    issueToken(
      "cancel_order",
      {},
      { account_number: "5WX00000" },
      BOUND_TARGETS,
    );
    expect(_tokenCountForTest()).toBe(2);

    expectToolErrorCode(
      () =>
        consumeToken(stale.token, "place_order", ARGS, BOUND_TARGETS.submit),
      "dry_run_required",
    );
    expect(
      consumeToken(live.token, "place_order", LIVE_ARGS, BOUND_TARGETS.submit)
        .action,
    ).toBe("place_order");
  });
});

// ---------------------------------------------------------------------------
// The TTL measures ELAPSED time, not the difference between two readings of a
// settable clock.
//
// The limiter next door was moved off `Date.now()` because one backward step froze
// refill for the duration of the step — fail-CLOSED and loud. This one is fail-OPEN
// and silent: timed off the wall clock, a backward step of N ms gives every
// outstanding token an effective life of 60s + N, and the entry's stored
// `dryRunResult` is not inert — the dispatcher hands it to runSanityChecks, so the
// notional cap and the dry-run verdict are evaluated against a projection made an
// arbitrary time ago. The 60 seconds IS the recency guarantee the handshake rests on.
//
// The other way a clock fails to measure elapsed time is by not moving when real time
// does — CLOCK_MONOTONIC does not advance across a suspend — and that direction is
// fail-OPEN too. So the TTL is the AND of both clocks, and this block exercises both
// halves.
//
// `jest.setSystemTime` moves the wall clock and deliberately NOT the monotonic one,
// which is what makes both halves expressible: a backward step grants no elapsed
// time, and a forward step is exactly the shape a resumed suspend leaves behind.
// ---------------------------------------------------------------------------

describe("token TTL vs. a clock step", () => {
  const START = Date.UTC(2026, 2, 14, 15, 0, 0);
  /** The documented TTL, so the boundary cases below read as one bound. */
  const TTL_MS = 60_000;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(START));
    _resetTokensForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("expires a token 60s of REAL time after issue even when the wall clock steps back an hour", () => {
    const issued = issueToken(
      "place_order",
      { stale: true },
      ARGS,
      BOUND_TARGETS,
    );

    // The step lands immediately after the dry-run, so wall-clock arithmetic
    // reports a NEGATIVE elapsed time for the rest of the token's life and can
    // never expire it.
    jest.setSystemTime(new Date(START - 60 * 60_000));
    jest.advanceTimersByTime(61_000);

    // 61 real seconds have passed; `Date.now()` says -3,539,000ms.
    expect(Date.now()).toBeLessThan(START);
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit),
      "dry_run_required",
    );
  });

  it("still honours the full 60s window after a backward step — the step neither grants nor removes time", () => {
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);

    jest.setSystemTime(new Date(START - 60 * 60_000));
    jest.advanceTimersByTime(59_000);

    expect(
      consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit)
        .action,
    ).toBe("place_order");
  });

  it("does not expire a token when the wall clock moves forward inside the window", () => {
    // The AND below must not be so eager that ordinary clock drift or a small
    // NTP correction throws away a confirmation the agent obtained a moment
    // ago. Thirty seconds of wall movement inside a sixty-second TTL is not
    // evidence of anything, and neither clock has reached its deadline.
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);

    jest.setSystemTime(new Date(START + 30_000));

    expect(
      consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit)
        .action,
    ).toBe("place_order");
  });

  it("expires a token when the wall clock has moved a TTL that the monotonic clock did not count", () => {
    // System suspend, and why the TTL is an AND of both clocks rather than the monotonic
    // reading alone.
    //
    // `performance.now()` measures elapsed time on a scale nothing can SET — what a
    // backward step needed — but on Linux it derives from CLOCK_MONOTONIC, which does not
    // advance while the machine is suspended. This repo ships a Dockerfile and a stdio
    // server lives on a laptop, so "the process was frozen for eight hours" is an
    // ordinary Tuesday: a token issued a second before the lid closed still believes it
    // is milliseconds old on resume, and the stored dry-run is handed to runSanityChecks
    // as fresh.
    //
    // A forward move on the wall clock and real time the monotonic clock skipped are
    // INDISTINGUISHABLE from inside the process, so this also fixes which way that
    // ambiguity resolves: expired. Being wrong that way costs one repeated dry-run; the
    // other gates a live order on an hours-old projection.
    const issued = issueToken(
      "place_order",
      { stale: true },
      ARGS,
      BOUND_TARGETS,
    );

    jest.setSystemTime(new Date(START + 8 * 60 * 60_000));

    // Not one millisecond of monotonic time has passed: the token would still
    // read as brand new on the clock round two moved it to.
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit),
      "dry_run_required",
    );
  });

  // -------------------------------------------------------------------------
  // WHERE the wall deadline sits.
  //
  // The two tests above pin that a wall step inside the window is tolerated and a step
  // of hours is not, which leaves the boundary between them unpinned — and the boundary
  // is the part an edit can move without failing anything. Anchoring the wall deadline
  // at `now + TTL` on each consume, or deriving it from the monotonic clock's remaining
  // life, passes both and quietly hands the AND back to the single clock it supplements.
  //
  // So this fixes the anchor: the wall deadline is TTL milliseconds after the moment of
  // ISSUE and does not move afterwards. The token is deliberately aged a second first,
  // so a deadline derived from "remaining monotonic life" would land 1,000ms away and be
  // caught.
  //
  // Both sides are asserted because only the pair catches an off-by-one, and the
  // inclusive side is the one that costs an agent a confirmation it legitimately
  // obtained.
  // -------------------------------------------------------------------------
  it.each([
    ["well inside the window is accepted", 30_000, "accepted"],
    [
      "at exactly the TTL is accepted, because the bound is inclusive",
      TTL_MS,
      "accepted",
    ],
    ["one millisecond past the TTL is expired", TTL_MS + 1, "expired"],
    ["hours past the TTL is expired", 8 * 60 * 60_000, "expired"],
  ] as const)("a wall clock sitting %s", (_label, wallOffset, outcome) => {
    const issued = issueToken("place_order", {}, ARGS, BOUND_TARGETS);

    // One second of REAL time, on both clocks: the token is now demonstrably
    // alive and demonstrably not brand new.
    jest.advanceTimersByTime(1_000);

    // Wall only from here. The monotonic clock stays a second old, so every
    // case below turns entirely on the wall deadline.
    jest.setSystemTime(new Date(START + wallOffset));

    if (outcome === "accepted") {
      expect(
        consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit)
          .action,
      ).toBe("place_order");
    } else {
      expectToolErrorCode(
        () =>
          consumeToken(issued.token, "place_order", ARGS, BOUND_TARGETS.submit),
        "dry_run_required",
      );
    }
  });

  it("evicts a token the monotonic clock alone would have kept alive", () => {
    // The sweep has to agree with the consume check, or the store retains
    // entries that can never be spent — the mirror of the backward-step
    // eviction test below.
    issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    jest.setSystemTime(new Date(START + 8 * 60 * 60_000));

    issueToken("place_order", {}, LIVE_ARGS, BOUND_TARGETS);
    expect(_tokenCountForTest()).toBe(1);
  });

  it("evicts a token that a backward wall-clock step would have kept alive", () => {
    // The sweep runs on the same scale, so the store cannot be stopped from
    // draining by moving the wall clock either.
    issueToken("place_order", {}, ARGS, BOUND_TARGETS);
    jest.setSystemTime(new Date(START - 60 * 60_000));
    jest.advanceTimersByTime(61_000);

    issueToken("place_order", {}, LIVE_ARGS, BOUND_TARGETS);
    expect(_tokenCountForTest()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE TARGET BINDING.
//
// The gate's guarantee is "the broker pre-flighted THIS request", and a request is a
// (method, URI, body) triple. The args hash covers the body and cannot cover the URI,
// because the URI is a function of the arguments AFTER the URL layer normalises them
// — so an identifier byte-identical on both legs can still dial two endpoints.
//
// This module holds no route table and parses no URLs: it compares opaque
// already-normalised pairs the api-client renders, and asserts the one structural
// relation the API arranges every gated route by.
// ---------------------------------------------------------------------------

describe("the request-target binding", () => {
  const SUBMIT = { method: "PUT", path: "/accounts/A/orders/9999" };
  const PREFLIGHT = {
    method: "POST",
    path: "/accounts/A/orders/9999/dry-run",
  };

  it("mints when the pre-flight is the pre-flight of the submit", () => {
    const issued = issueToken("replace_order", { ok: true }, ARGS, {
      dryRun: PREFLIGHT,
      submit: SUBMIT,
    });
    expect(
      consumeToken(issued.token, "replace_order", ARGS, SUBMIT).dryRunResult,
    ).toEqual({ ok: true });
  });

  it("refuses to mint when the two legs name different endpoints", () => {
    // The PoC, at the level this module can see it: `order_id` of `.` collapses
    // the pre-flight to the PLACE-order endpoint and the submit to the orders
    // collection. Neither leg is malformed; they simply do not pair.
    const refusal = refusalOf(() =>
      issueToken("replace_order", {}, ARGS, {
        dryRun: { method: "POST", path: "/accounts/A/orders/dry-run" },
        submit: { method: "PUT", path: "/accounts/A/orders/" },
      }),
    );
    expect(refusal.code).toBe("validation");
    expect(refusal.retryable).toBe(false);
    // And nothing was stored, so no token exists to be presented later.
    expect(_tokenCountForTest()).toBe(0);
  });

  it("refuses to mint when the pre-flight uses the wrong verb", () => {
    expectToolErrorCode(
      () =>
        issueToken("replace_order", {}, ARGS, {
          dryRun: { method: "PUT", path: "/accounts/A/orders/9999/dry-run" },
          submit: SUBMIT,
        }),
      "validation",
    );
  });

  it("refuses a submit to a path the token did not authorise", () => {
    const issued = issueToken("replace_order", {}, ARGS, {
      dryRun: PREFLIGHT,
      submit: SUBMIT,
    });
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "replace_order", ARGS, {
          method: "PUT",
          path: "/accounts/A/orders/1111",
        }),
      "confirmation_expired",
    );
  });

  it("refuses a submit by a verb the token did not authorise", () => {
    const issued = issueToken("replace_order", {}, ARGS, {
      dryRun: PREFLIGHT,
      submit: SUBMIT,
    });
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "replace_order", ARGS, {
          method: "PATCH",
          path: SUBMIT.path,
        }),
      "confirmation_expired",
    );
  });

  it("burns the token on a target mismatch, so it cannot be retried", () => {
    const issued = issueToken("replace_order", {}, ARGS, {
      dryRun: PREFLIGHT,
      submit: SUBMIT,
    });
    expectToolErrorCode(
      () =>
        consumeToken(issued.token, "replace_order", ARGS, {
          method: "PUT",
          path: "/accounts/A/orders/1111",
        }),
      "confirmation_expired",
    );
    expectToolErrorCode(
      () => consumeToken(issued.token, "replace_order", ARGS, SUBMIT),
      "dry_run_required",
    );
  });

  it("compares the verb case-insensitively, so one spelling cannot refuse itself", () => {
    const issued = issueToken("replace_order", {}, ARGS, {
      dryRun: { method: "post", path: PREFLIGHT.path },
      submit: SUBMIT,
    });
    expect(
      consumeToken(issued.token, "replace_order", ARGS, {
        method: "put",
        path: SUBMIT.path,
      }).action,
    ).toBe("replace_order");
  });
});
