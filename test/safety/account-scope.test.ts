/**
 * The credential's own account set: reading it, caching it, and refusing
 * against it.
 *
 * The end-to-end half of this control — that a call naming an unheld account is
 * refused on every tool and every resource template, with nothing on the wire —
 * lives in test/e2e/account-scope.test.ts. What is here is the module's own
 * behaviour, especially the two ways it must NOT fail: an unreadable answer
 * must not be cached as an empty one, and a refused caller must not be able to
 * make the server re-ask.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  ACCOUNT_ARGUMENT_FIELDS,
  ACCOUNT_SET_MIN_REFRESH_INTERVAL_MS,
  AccountScope,
  namedAccounts,
  readAccountSet,
  type AccountDirectory,
} from "../../src/safety/account-scope.js";
import {
  chargeRateLimit,
  GLOBAL_PER_SECOND,
  PER_SECOND_LIMITS,
  _resetRateLimitsForTest,
} from "../../src/safety/rate-limit.js";
import { toolError, type ToolError } from "../../src/safety/errors.js";

/** A directory that answers with a fixed payload and counts the asks. */
function directory(payload: unknown): AccountDirectory & { asks: number } {
  const d = {
    asks: 0,
    async getAccounts() {
      d.asks += 1;
      return payload;
    },
  };
  return d;
}

/** The membership-record shape `GET /customers/me/accounts` returns. */
function items(...numbers: string[]) {
  return { items: numbers.map((n) => ({ account: { "account-number": n } })) };
}

/** The ToolError carried by a refusal, or a failure if nothing was thrown. */
async function refusalOf(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (e) {
    return (e as { toolError: ToolError }).toolError;
  }
  throw new Error("expected a refusal, but the call resolved");
}

/** How many global tokens are left, measured by spending them. */
function remainingGlobal(): number {
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

beforeEach(() => {
  _resetRateLimitsForTest();
});

describe("readAccountSet", () => {
  it("reads the membership-record shape the accounts endpoint returns", () => {
    expect(readAccountSet(items("5WX00001", "5WX00002"))).toEqual({
      numbers: ["5WX00001", "5WX00002"],
      entries: 2,
    });
  });

  it("reads a bare array as well as an items wrapper", () => {
    expect(
      readAccountSet([{ account: { "account-number": "5WX00001" } }]).numbers,
    ).toEqual(["5WX00001"]);
  });

  it("reads an account object supplied directly, without the wrapper", () => {
    expect(readAccountSet({ items: [{ "account-number": "5WX7" }] })).toEqual({
      numbers: ["5WX7"],
      entries: 1,
    });
  });

  it("counts an entry it could not read, rather than dropping it silently", () => {
    // The distinction the whole cache turns on: entries present and no numbers
    // read is a payload-shape change, not a credential with no accounts.
    expect(readAccountSet({ items: [{}, null, 7, "x"] })).toEqual({
      numbers: [],
      entries: 4,
    });
  });

  it("ignores a value that is not a non-empty string", () => {
    expect(
      readAccountSet({
        items: [
          { account: { "account-number": null } },
          { account: { "account-number": 5 } },
          { account: { "account-number": "" } },
          { account: null, "account-number": "5WX9" },
        ],
      }),
    ).toEqual({ numbers: ["5WX9"], entries: 4 });
  });

  it("deduplicates, keeping first-seen order", () => {
    expect(readAccountSet(items("b", "a", "b")).numbers).toEqual(["b", "a"]);
  });

  it("reads nothing out of a payload with no entries at all", () => {
    for (const payload of [undefined, null, {}, 7, "x", { items: 3 }]) {
      expect([payload, readAccountSet(payload)]).toEqual([
        payload,
        { numbers: [], entries: 0 },
      ]);
    }
  });
});

describe("namedAccounts", () => {
  it("names the fields it reads, and reads exactly those", () => {
    expect([...ACCOUNT_ARGUMENT_FIELDS]).toEqual([
      "account_number",
      "account_numbers",
    ]);
  });

  it("reads the singular field", () => {
    expect(namedAccounts({ account_number: "5WX00001" })).toEqual(["5WX00001"]);
  });

  it("reads every string element of the plural field", () => {
    expect(
      namedAccounts({ account_numbers: ["5WX1", 7, null, "", "5WX2"] }),
    ).toEqual(["5WX1", "5WX2"]);
  });

  it("reads both at once", () => {
    expect(
      namedAccounts({ account_number: "a", account_numbers: ["b"] }),
    ).toEqual(["a", "b"]);
  });

  it("names nothing for a bag that carries no account", () => {
    for (const bag of [
      undefined,
      null,
      "5WX00001",
      42,
      {},
      { account_number: "" },
      { account_number: 42 },
      { account_number: { nested: "5WX1" } },
      { account_numbers: "5WX1" },
      { account_numbers: {} },
    ]) {
      expect([bag, namedAccounts(bag)]).toEqual([bag, []]);
    }
  });
});

describe("AccountScope", () => {
  it("asks nothing when the call names no account", async () => {
    const d = directory(items("5WX00001"));
    await new AccountScope(d).assertPermitted([], 'Tool "x"');
    expect(d.asks).toBe(0);
  });

  it("permits an account the credential holds", async () => {
    const d = directory(items("5WX00001"));
    await expect(
      new AccountScope(d).assertPermitted(["5WX00001"], 'Tool "x"'),
    ).resolves.toBeUndefined();
  });

  it("refuses an account it does not, naming the account and the set size", async () => {
    const scope = new AccountScope(directory(items("5WX00001")));
    const err = await refusalOf(
      scope.assertPermitted(["5WX99999"], 'Tool "tastytrade_get_balances"'),
    );
    expect(err.code).toBe("auth_failed");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("5WX99999");
    expect(err.message).toContain("covers 1 account,");
    expect(err.message).toContain("an account");
    expect(err.message).toContain('Tool "tastytrade_get_balances"');
    expect(err.hint).toContain("tastytrade_get_accounts");
  });

  it("pluralises when more than one named account is unheld", async () => {
    const scope = new AccountScope(directory(items("a", "b")));
    const err = await refusalOf(
      scope.assertPermitted(["x", "y"], "Resource r"),
    );
    expect(err.message).toContain("accounts this");
    expect(err.message).toContain("x, y");
    expect(err.message).toContain("covers 2 accounts,");
  });

  it("refuses the whole call when only one element of a list is unheld", async () => {
    const scope = new AccountScope(directory(items("a")));
    const err = await refusalOf(scope.assertPermitted(["a", "b"], "Tool t"));
    expect(err.message).toContain("b");
    expect(err.message).not.toContain("a, b");
  });

  it("bounds an account number it echoes back", async () => {
    const scope = new AccountScope(directory(items("a")));
    const err = await refusalOf(
      scope.assertPermitted(["Z".repeat(5_000)], "Tool t"),
    );
    expect(err.message.length).toBeLessThan(1_000);
  });

  it("asks once and answers every later call from the cache", async () => {
    const d = directory(items("5WX00001"));
    const scope = new AccountScope(d);
    for (let i = 0; i < 5; i += 1) {
      await scope.assertPermitted(["5WX00001"], "Tool t");
    }
    expect(d.asks).toBe(1);
    expect(scope.upstreamLookups()).toBe(1);
  });

  it("does not let a REFUSED call drive an upstream request", async () => {
    // The whole reason the refresh is interval-bounded: a loop of refusals must
    // not spend the operator's budget on the broker's behalf.
    const d = directory(items("5WX00001"));
    const scope = new AccountScope(d);
    for (let i = 0; i < 20; i += 1) {
      await refusalOf(scope.assertPermitted(["5WX99999"], "Tool t"));
    }
    expect(d.asks).toBe(1);
  });

  it("shares one request between concurrent first calls", async () => {
    let asks = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scope = new AccountScope({
      async getAccounts() {
        asks += 1;
        await gate;
        return items("5WX00001");
      },
    });
    const calls = [1, 2, 3, 4, 5, 6].map(() =>
      scope.assertPermitted(["5WX00001"], "Tool t"),
    );
    release!();
    await Promise.all(calls);
    expect(asks).toBe(1);
    expect(scope.upstreamLookups()).toBe(1);
  });

  it("re-asks on a miss once the answer is older than the interval", async () => {
    let held = ["5WX00001"];
    let asks = 0;
    const scope = new AccountScope(
      {
        async getAccounts() {
          asks += 1;
          return items(...held);
        },
      },
      // Zero rather than a moved clock: the branch under test is "the cached
      // answer is at least this old", and zero makes every miss eligible with
      // no clock to freeze or fake. The default is pinned separately below.
      0,
    );

    await refusalOf(scope.assertPermitted(["5WX00002"], "Tool t"));
    expect(asks).toBe(2); // the first resolve, then one refresh on the miss

    held = ["5WX00001", "5WX00002"];
    await expect(
      scope.assertPermitted(["5WX00002"], "Tool t"),
    ).resolves.toBeUndefined();
  });

  it("does not re-ask on a miss inside the interval", async () => {
    const d = directory(items("5WX00001"));
    const scope = new AccountScope(d, ACCOUNT_SET_MIN_REFRESH_INTERVAL_MS);
    await refusalOf(scope.assertPermitted(["5WX00002"], "Tool t"));
    expect(d.asks).toBe(1);
  });

  it("defaults the interval to a minute", () => {
    expect(ACCOUNT_SET_MIN_REFRESH_INTERVAL_MS).toBe(60_000);
  });

  it("fails the call, and does not cache an answer, when the lookup fails", async () => {
    let asks = 0;
    const scope = new AccountScope({
      async getAccounts() {
        asks += 1;
        throw toolError({
          code: "rate_limit_exceeded",
          message: "slow down",
          retryable: true,
          retry_after_ms: 250,
        });
      },
    });

    const err = await refusalOf(scope.assertPermitted(["5WX00001"], "Tool t"));
    // The upstream code travels, so an agent can tell "wait and retry" from
    // "this account is not yours".
    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.retryable).toBe(true);
    expect(err.retry_after_ms).toBe(250);
    expect(err.message).toContain("could not read which accounts");
    expect(err.hint).toContain("fails closed");

    // Not cached: an unreadable list is not an empty list, so the next call
    // asks again rather than inheriting a lock-out.
    await refusalOf(scope.assertPermitted(["5WX00001"], "Tool t"));
    expect(asks).toBe(2);
  });

  it("refuses, and does not cache, a payload it cannot read an account out of", async () => {
    let asks = 0;
    const scope = new AccountScope({
      async getAccounts() {
        asks += 1;
        return { items: [{ accountNumber: "5WX00001" }] };
      },
    });
    const err = await refusalOf(scope.assertPermitted(["5WX00001"], "Tool t"));
    expect(err.code).toBe("upstream_error");
    expect(err.message).toContain("1 entry");
    expect(err.hint).toContain("Accept-Version");

    await refusalOf(scope.assertPermitted(["5WX00001"], "Tool t"));
    expect(asks).toBe(2);
  });

  it("says how many entries it could not read, plural included", async () => {
    const scope = new AccountScope({
      async getAccounts() {
        return { items: [{}, {}] };
      },
    });
    const err = await refusalOf(scope.assertPermitted(["a"], "Tool t"));
    expect(err.message).toContain("2 entries");
  });

  it("caches a credential that genuinely holds no accounts", async () => {
    // Distinct from the unreadable case above, and it has to be: an empty list
    // is a real answer, so it is cached and every account-scoped call is
    // refused against it without re-asking.
    const d = directory({ items: [] });
    const scope = new AccountScope(d);
    const err = await refusalOf(scope.assertPermitted(["5WX00001"], "Tool t"));
    expect(err.code).toBe("auth_failed");
    expect(err.message).toContain("covers 0 accounts,");
    await refusalOf(scope.assertPermitted(["5WX00001"], "Tool t"));
    expect(d.asks).toBe(1);
  });
});

describe("what the lookup costs the broker's budget", () => {
  it("bills one global token, because it is one broker request", async () => {
    const before = remainingGlobal();
    _resetRateLimitsForTest();
    await new AccountScope(directory(items("5WX00001"))).assertPermitted(
      ["5WX00001"],
      "Tool t",
    );
    expect(before).toBe(GLOBAL_PER_SECOND);
    expect(remainingGlobal()).toBe(GLOBAL_PER_SECOND - 1);
  });

  it("bills a FAILED lookup too, because the request still happened", async () => {
    await refusalOf(
      new AccountScope({
        async getAccounts() {
          throw new Error("boom");
        },
      }).assertPermitted(["5WX00001"], "Tool t"),
    );
    expect(remainingGlobal()).toBe(GLOBAL_PER_SECOND - 1);
  });

  it("leaves the published accounts ceiling alone, deliberately", async () => {
    // Keying this to `accounts` would spend that 1/sec bucket inside the
    // pre-flight of the first account-scoped call, so `tastytrade_get_accounts`
    // — the tool the refusal tells an agent to call — would come back
    // rate_limit_exceeded for the rest of the second. The traffic is still
    // recorded, on the global bucket.
    await new AccountScope(directory(items("5WX00001"))).assertPermitted(
      ["5WX00001"],
      "Tool t",
    );
    expect(PER_SECOND_LIMITS.accounts).toBeGreaterThan(0);
    for (let i = 0; i < PER_SECOND_LIMITS.accounts; i += 1) {
      expect(() => chargeRateLimit({ rateKey: "accounts" })).not.toThrow();
    }
  });
});
