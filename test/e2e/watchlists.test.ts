import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callOk, callError } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import {
  TOOL_ANNOTATIONS,
  MCP_ERROR_INVALID_PARAMS,
} from "../../src/mcp-server/index.js";
import { accessClassFor } from "../../src/mcp-server/annotations.js";

/**
 * The watchlist mutators, and what they tell a client they will do.
 *
 * `PUT /watchlists/{name}` is a FULL REPLACEMENT — "any entry not present in `entries`
 * is removed" — and three tools issue it: `update_watchlist` directly, and
 * `add_watchlist_symbol` / `remove_watchlist_symbol` through a GET-modify-PUT that is
 * not atomic. All three shipped `destructiveHint: false`, the one machine-readable field
 * an MCP client's approval UI keys on, while `delete_watchlist` destroys the same data
 * with the same permanence and shipped `true`.
 *
 * The second half is wipe by omission. `toWatchlistEntries` returns `[]` for any
 * non-array, so an ABSENT `symbols` produces exactly the same emptying PUT as an
 * explicit `symbols: []` — against a list holding four entries, with no GET first, no
 * diff, no size check and no confirmation token. The schema declares it required, but
 * the low-level SDK does not enforce `inputSchema`, so the dispatcher has to.
 *
 * WHAT THIS FILE DOES NOT CLAIM. Correcting the hint is a mitigation, not a control:
 * `destructiveHint` is advisory per the MCP spec, so a client that raises no dialog
 * still offers no human gate; an explicit `symbols: []` still empties the list in one
 * call, because that is a legitimate request and no watchlist tool has a `dry_run_*`
 * twin; and add/remove are still a non-atomic GET-modify-PUT. The explicit-empty case is
 * asserted as STILL WORKING, deliberately, because blocking it would be a payload block
 * rather than an intent check.
 */

let h: Harness | undefined;

beforeEach(() => {
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  _resetRateLimitsForTest();
});

const WL = "Core Holdings";
const WL_PATH = "/watchlists/Core%20Holdings";
const EXISTING = {
  name: WL,
  "watchlist-entries": [
    { symbol: "AAPL", "instrument-type": "Equity" },
    { symbol: "MSFT", "instrument-type": "Equity" },
  ],
};

const MUTATORS = [
  "tastytrade_update_watchlist",
  "tastytrade_add_watchlist_symbol",
  "tastytrade_remove_watchlist_symbol",
] as const;

async function watchlistHarness(): Promise<Harness> {
  return createHarness({
    routes: [
      // One watchlist, answered for every verb. POST /watchlists returns the
      // CREATED watchlist rather than a collection, so it needs its own route —
      // the tool declares an outputSchema and the SDK rejects a mismatch before
      // the test can look at the wire.
      { matcher: /^\/watchlists\//, reply: { data: EXISTING } },
      { matcher: "/watchlists", method: "POST", reply: { data: EXISTING } },
      {
        matcher: "/watchlists",
        method: "GET",
        reply: { data: { items: [EXISTING] } },
      },
    ],
  });
}

describe("the watchlist mutators declare what they do", () => {
  it("ships destructiveHint:true for every watchlist mutator", async () => {
    h = await createHarness();
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    const del = byName.get("tastytrade_delete_watchlist")!.annotations;
    for (const name of MUTATORS) {
      expect({ name, annotations: byName.get(name)!.annotations }).toEqual({
        name,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      });
    }
    // The semantically identical neighbour, unchanged.
    expect(del).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });

  it("classifies them into the destructive access class", () => {
    for (const name of MUTATORS) {
      expect({ name, klass: accessClassFor(TOOL_ANNOTATIONS[name]!) }).toEqual({
        name,
        klass: "destructive",
      });
    }
  });

  it("charges them against the same internal cap the order tools share", async () => {
    h = await watchlistHarness();
    h.route({
      matcher: /^\/accounts\/.*\/orders\//,
      method: "DELETE",
      reply: { data: { id: 1 } },
    });

    // Exhaust the destructive cap with an order cancel, without naming its size.
    let refusals = 0;
    for (let i = 0; i < 60; i++) {
      const res = (await h.client.callTool({
        name: "tastytrade_cancel_order",
        arguments: { account_number: "5WX00001", order_id: "1001" },
      })) as { isError?: boolean; content?: Array<{ text?: string }> };
      if (res.isError) {
        const err = JSON.parse(res.content?.[0]?.text ?? "{}");
        if (err.code === "rate_limit_exceeded") {
          refusals += 1;
          break;
        }
        throw new Error(`unexpected error: ${res.content?.[0]?.text}`);
      }
    }
    expect(refusals).toBe(1);

    // A watchlist mutator now shares that exhausted budget.
    const err = await callError(h, "tastytrade_update_watchlist", {
      name: WL,
      symbols: ["AAPL"],
    });
    expect(err.code).toBe("rate_limit_exceeded");
  });

  it("refuses update_watchlist when `symbols` is omitted, sending nothing", async () => {
    h = await watchlistHarness();

    const err = await callError(h, "tastytrade_update_watchlist", { name: WL });

    expect(err.code).toBe("validation");
    expect(err.message).toMatch(/symbols/);
    expect(h.requests).toEqual([]);
  });

  it("still performs the emptying PUT for an explicit `symbols: []`", async () => {
    // The discrimination that proves this is not a payload block: emptying a
    // list on purpose is a legitimate request and stays legal.
    h = await watchlistHarness();

    await callOk(h, "tastytrade_update_watchlist", { name: WL, symbols: [] });

    const req = h.lastRequest()!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(WL_PATH);
    expect(req.body).toEqual({ name: WL, "watchlist-entries": [] });
  });

  it("refuses create_watchlist when `symbols` is omitted, sending nothing", async () => {
    h = await watchlistHarness();

    const err = await callError(h, "tastytrade_create_watchlist", {
      name: "New",
    });

    expect(err.code).toBe("validation");
    expect(h.requests).toEqual([]);
  });

  it("still creates an intentionally empty watchlist", async () => {
    h = await watchlistHarness();

    await callOk(h, "tastytrade_create_watchlist", {
      name: "New",
      symbols: [],
    });

    expect(h.lastRequest()!.method).toBe("POST");
    expect(h.lastRequest()!.body).toEqual({
      name: "New",
      "watchlist-entries": [],
    });
  });

  it("refuses a `symbols` that is not an array at all", async () => {
    h = await watchlistHarness();
    for (const symbols of ["AAPL", 3, {}, null]) {
      _resetRateLimitsForTest();
      const err = await callError(h, "tastytrade_update_watchlist", {
        name: WL,
        symbols,
      });
      expect({ symbols, code: err.code }).toEqual({
        symbols,
        code: "validation",
      });
    }
    expect(h.requests).toEqual([]);
  });

  it("still updates a watchlist with real symbols", async () => {
    h = await watchlistHarness();

    await callOk(h, "tastytrade_update_watchlist", {
      name: WL,
      symbols: ["NVDA", { symbol: "/ESM6", instrument_type: "Future" }],
    });

    expect(h.lastRequest()!.body).toEqual({
      name: WL,
      "watchlist-entries": [
        { symbol: "NVDA", "instrument-type": "Equity" },
        { symbol: "/ESM6", "instrument-type": "Future" },
      ],
    });
  });

  // ---- the invariant, derived from the recorded wire --------------------------

  it("marks every tool that PUTs or DELETEs a watchlist as destructive", async () => {
    // Derived from what each tool actually DOES, not from a list written here:
    // drive every advertised watchlist tool, look at the verb it recorded, and
    // require the shipped annotation to agree. This is what fails when the next
    // PUT-shaped tool ships with the wrong hint.
    h = await watchlistHarness();
    h.route({
      matcher: /^\/watchlists\//,
      method: "DELETE",
      reply: { data: EXISTING },
    });
    const { tools } = await h.client.listTools();
    const watchlistTools = tools.filter(
      (t) => /watchlist/.test(t.name) && !/pairs|public/.test(t.name),
    );
    // Non-vacuity: an empty list would make the sweep below say nothing.
    expect(watchlistTools.length).toBeGreaterThanOrEqual(6);

    const ARGS: Record<string, Record<string, unknown>> = {
      tastytrade_get_watchlists: {},
      tastytrade_get_watchlist: { name: WL },
      tastytrade_create_watchlist: { name: WL, symbols: ["AAPL"] },
      tastytrade_update_watchlist: { name: WL, symbols: ["AAPL"] },
      tastytrade_delete_watchlist: { name: WL },
      tastytrade_add_watchlist_symbol: { watchlist_name: WL, symbol: "TSLA" },
      tastytrade_remove_watchlist_symbol: {
        watchlist_name: WL,
        symbol: "AAPL",
      },
    };

    const replacing: string[] = [];
    for (const tool of watchlistTools) {
      const args = ARGS[tool.name];
      if (args === undefined) {
        throw new Error(
          `No arguments recorded for advertised watchlist tool ${tool.name} — ` +
            "add them so the invariant keeps covering it.",
        );
      }
      _resetRateLimitsForTest();
      const before = h.requests.length;
      await h.client.callTool({ name: tool.name, arguments: args });
      const issued = h.requests.slice(before);
      if (issued.some((r) => r.method === "PUT" || r.method === "DELETE")) {
        replacing.push(tool.name);
      }
    }

    // Non-vacuity again: the sweep must actually have SEEN a replacing verb.
    expect(replacing.sort()).toEqual([
      "tastytrade_add_watchlist_symbol",
      "tastytrade_delete_watchlist",
      "tastytrade_remove_watchlist_symbol",
      "tastytrade_update_watchlist",
    ]);
    const misdeclared = replacing.filter(
      (name) => accessClassFor(TOOL_ANNOTATIONS[name]!) !== "destructive",
    );
    expect(misdeclared).toEqual([]);
  });

  it("keeps MCP_ERROR_INVALID_PARAMS reachable for the refusal taxonomy", () => {
    // Sanity on the import, so the constant cannot rot silently.
    expect(typeof MCP_ERROR_INVALID_PARAMS).toBe("number");
  });
});
