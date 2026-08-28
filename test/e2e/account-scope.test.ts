/**
 * The account named in a call must be one the configured credential
 * actually holds.
 *
 * Every assertion here is on the RECORDED WIRE, not on the shape of the
 * refusal. "The check ran" is proven by the ABSENCE of the request: a refusal
 * message alone can be produced by a change that dispatches anyway and then
 * apologises.
 */

import { callError, callOk, createHarness, type Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { ACCOUNT_ARGUMENT_FIELDS } from "../../src/safety/account-scope.js";
import * as dispatcher from "../../src/mcp-server/index.js";
import * as resources from "../../src/mcp-server/resources.js";

/** The one account `/customers/me/accounts` reports for this credential. */
const HELD = "5WX00001";
/** An account the credential does not hold. The agent names it anyway. */
const UNHELD = "5WX99999";

const ACCOUNTS_PATH = "/customers/me/accounts";

/**
 * One body that satisfies both unwrap shapes the client uses — `.data.data`
 * for a single entity and `.data.data.items` for a list — so a test can route
 * everything it does not care about to one reply.
 */
const ANY_BODY = {
  items: [{ "account-number": HELD, symbol: "AAPL" }],
  "account-number": HELD,
  "cash-balance": "1.00",
};

function accountsRoute(numbers: string[]) {
  return {
    matcher: ACCOUNTS_PATH,
    reply: {
      data: {
        items: numbers.map((n) => ({ account: { "account-number": n } })),
      },
    },
  };
}

async function harness(numbers: string[] = [HELD]): Promise<Harness> {
  return createHarness({
    routes: [
      accountsRoute(numbers),
      { matcher: /.*/, reply: { data: ANY_BODY } },
    ],
  });
}

/** Requests that named an account, in the path or in a query parameter. */
function requestsNaming(h: Harness, account: string) {
  return h.requests
    .filter(
      (r) =>
        r.url.includes(account) ||
        JSON.stringify(r.params).includes(account) ||
        JSON.stringify(r.body ?? null).includes(account),
    )
    .map((r) => `${r.method} ${r.url}`);
}

beforeEach(() => {
  _resetRateLimitsForTest();
});

describe("a call naming an account the credential does not hold", () => {
  it("is refused before any request for that account is sent", async () => {
    const h = await harness();
    try {
      const err = await callError(h, "tastytrade_get_balances", {
        account_number: UNHELD,
      });
      expect(err.code).toBe("auth_failed");
      expect(err.retryable).toBe(false);
      expect(requestsNaming(h, UNHELD)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("is refused on a DESTRUCTIVE arm too, with nothing dispatched", async () => {
    const h = await harness();
    try {
      const err = await callError(h, "tastytrade_cancel_order", {
        account_number: UNHELD,
        order_id: "1075264",
      });
      expect(err.code).toBe("auth_failed");
      expect(requestsNaming(h, UNHELD)).toEqual([]);
      expect(h.requests.some((r) => r.method === "DELETE")).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("names the account it refused and points at the tool that lists the set", async () => {
    const h = await harness();
    try {
      const err = (await callError(h, "tastytrade_get_positions", {
        account_number: UNHELD,
      })) as { message: string; hint?: string };
      expect(err.message).toContain(UNHELD);
      expect(err.hint ?? "").toMatch(/tastytrade_get_accounts/);
    } finally {
      await h.close();
    }
  });

  // The list is DERIVED from the advertised schemas, never enumerated: this
  // surface has already gone from 93 tools to 86, and a literal denominator is
  // how a stale figure passes a green test.
  it("is refused on every tool whose schema declares an account", async () => {
    const h = await harness();
    try {
      const { tools } = await h.client.listTools();
      const naming = tools.filter(
        (t) =>
          (t.inputSchema?.properties as Record<string, unknown> | undefined)
            ?.account_number !== undefined,
      );
      // Non-vacuity: a filter that stopped matching would pass this loop by
      // testing nothing at all.
      expect(naming.length).toBeGreaterThanOrEqual(20);

      for (const tool of naming) {
        _resetRateLimitsForTest();
        const before = h.requests.length;
        const res = (await h.client.callTool({
          name: tool.name,
          arguments: { account_number: UNHELD, order_id: "1", symbol: "AAPL" },
        })) as { isError?: boolean; content?: Array<{ text?: string }> };
        const text = res.content?.[0]?.text ?? "";
        expect([tool.name, res.isError]).toEqual([tool.name, true]);
        expect([tool.name, JSON.parse(text).code]).toEqual([
          tool.name,
          "auth_failed",
        ]);
        expect([
          tool.name,
          h.requests
            .slice(before)
            .filter((r) => r.url.includes(UNHELD))
            .map((r) => r.url),
        ]).toEqual([tool.name, []]);
      }
    } finally {
      await h.close();
    }
  });

  // The claim the gate's design rests on: there are exactly TWO argument names
  // that carry an account into this server. Derived from every advertised input
  // schema at test time rather than trusted, so a third spelling arriving in a
  // new tool fails here instead of arriving ungated.
  it("has no account-naming argument outside the two the gate reads", async () => {
    const h = await harness();
    try {
      const { tools } = await h.client.listTools();
      const naming = new Set<string>();
      for (const tool of tools) {
        const props = (tool.inputSchema?.properties ?? {}) as Record<
          string,
          unknown
        >;
        for (const key of Object.keys(props)) {
          if (/account/i.test(key)) naming.add(key);
        }
      }
      // Non-vacuity: an empty set would satisfy the comparison below by finding
      // nothing at all.
      expect(naming.size).toBeGreaterThan(1);
      expect([...naming].sort()).toEqual([...ACCOUNT_ARGUMENT_FIELDS].sort());
    } finally {
      await h.close();
    }
  });

  it("refuses when any element of an account_numbers[] list is not held", async () => {
    const h = await harness();
    try {
      const err = await callError(h, "tastytrade_search_customer_orders", {
        account_numbers: [HELD, UNHELD],
      });
      expect(err.code).toBe("auth_failed");
      expect(requestsNaming(h, UNHELD)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("reads the account fields off the bag, not off the schema", async () => {
    // `tastytrade_get_quote_snapshot` declares no account at all. An unheld
    // account number sent to it is still refused: the control must not depend
    // on 86 input schemas being right about which fields reach the wire.
    const h = await harness();
    try {
      const err = await callError(h, "tastytrade_get_quote_snapshot", {
        symbols: ["AAPL"],
        instrument_type: "Equity",
        account_number: UNHELD,
      });
      expect(err.code).toBe("auth_failed");
      expect(requestsNaming(h, UNHELD)).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("the account the credential does hold is unaffected", () => {
  it("still serves it", async () => {
    const h = await harness();
    try {
      await callOk(h, "tastytrade_get_balances", { account_number: HELD });
      expect(
        h.requests.some((r) => r.url === `/accounts/${HELD}/balances`),
      ).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("permits a second account once the credential reports two", async () => {
    const h = await harness([HELD, UNHELD]);
    try {
      await callOk(h, "tastytrade_get_balances", { account_number: UNHELD });
      expect(
        h.requests.some((r) => r.url === `/accounts/${UNHELD}/balances`),
      ).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("asks the broker which accounts it holds no more than once", async () => {
    // The harness resolves the set at construction and clears the log (see its
    // warm-up), so ZERO further lookups is the same claim as "exactly one": a
    // dozen calls, half of them refused, add nothing. That a REFUSAL cannot
    // drive a lookup is the half that matters — otherwise a caller that gets
    // nothing spends the operator's budget. The count itself is pinned directly
    // on the cache in test/safety/account-scope.test.ts.
    const h = await harness();
    try {
      for (let i = 0; i < 6; i += 1) {
        _resetRateLimitsForTest();
        await callOk(h, "tastytrade_get_balances", { account_number: HELD });
      }
      for (let i = 0; i < 6; i += 1) {
        _resetRateLimitsForTest();
        await callError(h, "tastytrade_get_balances", {
          account_number: UNHELD,
        });
      }
      expect(h.requests.filter((r) => r.url === ACCOUNTS_PATH)).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("refuses rather than guesses when the account list cannot be read", async () => {
    const h = await createHarness({
      routes: [
        { matcher: ACCOUNTS_PATH, reply: { status: 503, data: {} } },
        { matcher: /.*/, reply: { data: ANY_BODY } },
      ],
    });
    try {
      const err = await callError(h, "tastytrade_get_balances", {
        account_number: HELD,
      });
      expect(err.code).toBe("upstream_error");
      expect(requestsNaming(h, HELD)).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("customer_id is pinned to the authenticated customer", () => {
  it("is not an argument either customer tool advertises", async () => {
    const h = await harness();
    try {
      const { tools } = await h.client.listTools();
      const customerTools = tools.filter((t) => t.name.includes("customer"));
      expect(customerTools.length).toBeGreaterThanOrEqual(2);
      for (const tool of customerTools) {
        const props = tool.inputSchema?.properties as
          | Record<string, unknown>
          | undefined;
        expect([tool.name, props?.customer_id]).toEqual([tool.name, undefined]);
      }
    } finally {
      await h.close();
    }
  });

  it("never lets a caller-supplied customer_id reach the wire", async () => {
    const h = await harness();
    try {
      await h.client.callTool({
        name: "tastytrade_search_customer_orders",
        arguments: { customer_id: "99999" },
      });
      expect(h.requests.some((r) => r.url.includes("99999"))).toBe(false);
      expect(h.requests.some((r) => r.url === "/customers/me/orders")).toBe(
        true,
      );
    } finally {
      await h.close();
    }
  });

  it("pins the live-orders route the same way", async () => {
    const h = await harness();
    try {
      await h.client.callTool({
        name: "tastytrade_get_customer_live_orders",
        arguments: { customer_id: "99999" },
      });
      expect(h.requests.some((r) => r.url.includes("99999"))).toBe(false);
      expect(
        h.requests.some((r) => r.url === "/customers/me/orders/live"),
      ).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("the shared order-search mapper allow-lists only what it declares", () => {
  // DERIVED on both sides: the mapper's key set against the schema fragment's
  // key set. `account_numbers` was in the mapper and in neither account-scoped
  // tool's schema, so it reached the wire from a tool that never offered it.
  it("translates exactly the fields the shared schema fragment declares", () => {
    const fragment = (
      dispatcher as unknown as {
        ORDER_SEARCH_PROPERTIES?: Record<string, unknown>;
      }
    ).ORDER_SEARCH_PROPERTIES;
    expect(fragment).toBeDefined();
    const declared = Object.keys(fragment ?? {});
    expect(declared.length).toBeGreaterThan(5);

    const everyField = Object.fromEntries(declared.map((k) => [k, "x"]));
    const translated = Object.keys(dispatcher.snakeToKebabParams(everyField));
    expect(translated).toHaveLength(declared.length);

    const withAccounts = dispatcher.snakeToKebabParams({
      ...everyField,
      account_numbers: [HELD],
    });
    expect(Object.keys(withAccounts)).toEqual(translated);
  });

  it("emits no account-numbers[] filter from the single-account search tool", async () => {
    const h = await harness();
    try {
      await h.client.callTool({
        name: "tastytrade_search_orders",
        arguments: { account_number: HELD, account_numbers: [HELD] },
      });
      const search = h.requests.filter(
        (r) => r.url === `/accounts/${HELD}/orders`,
      );
      expect(search).toHaveLength(1);
      expect(Object.keys(search[0].params)).not.toContain("account-numbers[]");
    } finally {
      await h.close();
    }
  });

  it("still emits it from the customer tool that does declare it", async () => {
    const h = await harness();
    try {
      await h.client.callTool({
        name: "tastytrade_search_customer_orders",
        arguments: { account_numbers: [HELD] },
      });
      const search = h.requests.filter((r) => r.url === "/customers/me/orders");
      expect(search).toHaveLength(1);
      expect(search[0].params["account-numbers[]"]).toEqual([HELD]);
    } finally {
      await h.close();
    }
  });
});

describe("resources/read traverses the same two gates", () => {
  it("refuses a resource URI naming an account the credential does not hold", async () => {
    const h = await harness();
    try {
      await expect(
        h.client.readResource({
          uri: `tastytrade://accounts/${UNHELD}/positions`,
        }),
      ).rejects.toThrow();
      expect(requestsNaming(h, UNHELD)).toEqual([]);
    } finally {
      await h.close();
    }
  });

  // DERIVED from the published template list, so a sixth account-bearing
  // template cannot arrive ungated.
  it("refuses on every account-bearing template", async () => {
    const h = await harness();
    try {
      const { resourceTemplates } = await h.client.listResourceTemplates();
      const bearing = resourceTemplates.filter((t) =>
        t.uriTemplate.includes("{account_number}"),
      );
      expect(bearing.length).toBeGreaterThanOrEqual(5);
      for (const t of bearing) {
        _resetRateLimitsForTest();
        const uri = t.uriTemplate
          .replace("{account_number}", UNHELD)
          .replace("{range}", "1d");
        const before = h.requests.length;
        await expect(h.client.readResource({ uri })).rejects.toThrow();
        expect([
          t.uriTemplate,
          h.requests.slice(before).filter((r) => r.url.includes(UNHELD)),
        ]).toEqual([t.uriTemplate, []]);
      }
    } finally {
      await h.close();
    }
  });

  it("still serves an account-bearing template for the held account", async () => {
    const h = await harness();
    try {
      const res = await h.client.readResource({
        uri: `tastytrade://accounts/${HELD}/positions`,
      });
      expect(res.contents).toHaveLength(1);
      expect(
        h.requests.some((r) => r.url === `/accounts/${HELD}/positions`),
      ).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("consults the operator's read-only posture on this transport too", () => {
    // Every template is a read today, so the gate withholds nothing — what is
    // asserted is that the gate is REACHED, through a declaration every
    // template now has to carry. A future non-GET template inherits the
    // refusal instead of escaping the operator's posture in silence.
    const templates = resources.RESOURCE_TEMPLATES as unknown as Array<{
      uriTemplate: string;
      accessClass?: string;
    }>;
    expect(templates.length).toBeGreaterThan(5);
    for (const t of templates) {
      expect([t.uriTemplate, t.accessClass]).toEqual([t.uriTemplate, "read"]);
    }
  });
});
