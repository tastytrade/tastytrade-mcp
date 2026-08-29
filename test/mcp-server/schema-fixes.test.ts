/**
 * Schema corrections that nothing else can catch.
 *
 * OUTPUT-schema types belong to test/e2e/output-schemas.test.ts, which settles them
 * against evidence rather than a copy of the literal. Anything that suite can falsify
 * belongs there, not here.
 *
 * What is left are the schema facts no payload and no spec can settle: INPUT enums
 * that must not offer a value the tool cannot send; INPUT properties whose absence
 * makes a tool unusable, since decorateTool closes every input object with
 * `additionalProperties: false`; two output shapes with no recorded payload, where a
 * narrowed type is invisible until it reaches a validating client; and `$id`
 * uniqueness, which is a property OF the registry rather than of any tool.
 *
 * Two neighbours of the same kind live here too — a RAW tool description that
 * decorateTool overwrites, and the field set of a validator's refusal object — plus
 * two prose invariants, because prose is the part of the surface no schema check
 * reads: the rate limits a shipped description quotes must agree with
 * src/safety/rate-limit.ts, and every paramDescriptions key must land on a property a
 * client can see.
 *
 * The enum-vs-description guard that walks every SHIPPED tool is in
 * test/e2e/protocol.test.ts, which sees the surface as a client does.
 */

import { describe, it, expect } from "@jest/globals";
import {
  MCP_ORDER_SOURCE,
  TastytradeMCPServer,
  decorateTool,
  toWatchlistEntries,
  validateLegActions,
} from "../../src/mcp-server/index.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import { TOOL_METADATA } from "../../src/mcp-server/tool-metadata.js";
import {
  GLOBAL_PER_SECOND,
  PER_SECOND_LIMITS,
  rateKeyForTool,
} from "../../src/safety/rate-limit.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

function rawTools(): any[] {
  const s = new TastytradeMCPServer({
    apiUrl: "https://api.cert.tastyworks.com",
  });
  return (s as unknown as { getTools(): Tool[] }).getTools() as any[];
}

function decoratedTools(): any[] {
  return rawTools().map(decorateTool) as any[];
}

const tools = decoratedTools();
const rawByName: Record<string, any> = Object.fromEntries(
  rawTools().map((t) => [t.name, t]),
);
const byName: Record<string, any> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);

const get = (obj: any, path: string): any =>
  path.split(".").reduce((cur, k) => cur?.[k], obj);

/** Recursively collect every `enum` array anywhere in a schema. */
function allEnums(node: any, acc: string[][] = []): string[][] {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node.enum)) acc.push(node.enum);
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") allEnums(v, acc);
  }
  return acc;
}

describe("dead enum values removed", () => {
  it("no tool offers the non-functional 'Notional Market' order type", () => {
    expect(
      tools
        .filter((t) =>
          allEnums(t.inputSchema).some((e) => e.includes("Notional Market")),
        )
        .map((t) => t.name),
    ).toEqual([]);
  });

  it("no tool offers the deprecated 'BLAST' complex-order type", () => {
    expect(
      tools
        .filter((t) => allEnums(t.inputSchema).some((e) => e.includes("BLAST")))
        .map((t) => t.name),
    ).toEqual([]);
  });
});

describe("schema corrections", () => {
  // Each of these was a tool a schema-validating client could not drive, because
  // decorateTool closes the input object: a parameter absent from `properties`
  // cannot be passed at all, however well the handler would have handled it.
  it("get_total_fees takes a single `date`, not a date range", () => {
    const props = byName["tastytrade_get_total_fees"].inputSchema.properties;
    expect(props.date).toBeDefined();
    expect(props.start_date).toBeUndefined();
    expect(props.end_date).toBeUndefined();
  });

  it("get_transactions exposes offset pagination + richer filters", () => {
    const props = byName["tastytrade_get_transactions"].inputSchema.properties;
    expect(props.page_offset).toBeDefined();
    expect(props.per_page).toBeDefined();
    expect(props.instrument_type).toBeDefined();
  });

  it("get_net_liq_history supports absolute end_time + interval", () => {
    const props =
      byName["tastytrade_get_net_liq_history"].inputSchema.properties;
    expect(props.end_time).toBeDefined();
    expect(props.interval).toBeDefined();
  });

  it("get_equity_definition exposes the `active` filter", () => {
    expect(
      byName["tastytrade_get_equity_definition"].inputSchema.properties.active,
    ).toBeDefined();
  });

  it("get_market_session drops 'Zero Hash CLOB' but get_sessions_range keeps it", () => {
    expect(
      JSON.stringify(byName["tastytrade_get_market_session"].inputSchema),
    ).not.toContain("Zero Hash CLOB");
    expect(
      JSON.stringify(byName["tastytrade_get_sessions_range"].inputSchema),
    ).toContain("Zero Hash CLOB");
  });

  it("get_market_session's RAW description does not offer the collection its enum dropped", () => {
    // decorateTool overwrites `description` from TOOL_METADATA, so the literal
    // in getTools() never reaches an agent — which is exactly why it rotted:
    // it invited `collections` values of "Equity/CME/CFE/Zero Hash CLOB" long
    // after the enum narrowed to three. Dead text still gets read by the next
    // person editing the tool, and it is the description the tool falls back to
    // if its TOOL_METADATA entry is ever removed. Scoped to the RAW literal on
    // purpose: the shipped description mentions 'Zero Hash CLOB' truthfully,
    // naming the server-side `validation` refusal a non-validating client can
    // still trigger.
    expect(
      rawByName["tastytrade_get_market_session"].description,
    ).not.toContain("Zero Hash CLOB");
    expect(rawByName["tastytrade_get_market_session"].description).toContain(
      "Equity/CME/CFE",
    );
  });
});

describe("shipped prose agrees with the rate limiter", () => {
  /**
   * Tool descriptions are the ONLY rate-limit documentation an agent ever reads — it
   * never opens the README — so a stale figure here mis-paces every
   * caller. Nine survived the per-second rewrite, quoting per-minute buckets against a
   * scheme that has no per-minute anything, and `./build.sh` stayed green throughout:
   * nothing in the battery read the prose. This is that reader.
   *
   * The assertion is not "no per-minute text", which only pins the shape of the last
   * mistake. It is "every rate figure a tool publishes is one src/safety/rate-limit.ts
   * actually enforces for THAT tool", so renaming a tool out of TOOL_RATE_KEYS, or
   * retuning PER_SECOND_LIMITS, breaks the descriptions that quote the old number.
   */

  /** `50/sec`, `2 per second`, `60/min`, `5 requests/minute`, … */
  const RATE_FIGURE =
    /(\d+(?:\.\d+)?)\s*(?:requests?\s*)?(?:\/|per\s+)\s*(seconds|second|secs|sec|s|minutes|minute|mins|min|hours|hour|hrs|hr)\b/gi;

  const PER_SECOND_UNITS = new Set(["seconds", "second", "secs", "sec", "s"]);

  /** Every string a client receives for one tool: description, params, output schema. */
  const shippedText = (tool: any): string => JSON.stringify(tool);

  /** The only ceilings a given tool may honestly name. */
  const publishableFor = (name: string): number[] => {
    const key = rateKeyForTool(name);
    return key
      ? [GLOBAL_PER_SECOND, PER_SECOND_LIMITS[key]]
      : [GLOBAL_PER_SECOND];
  };

  /** Every rate figure in `text` that rate-limit.ts does not enforce for `name`. */
  const illegalRates = (name: string, text: string): string[] => {
    const legal = publishableFor(name);
    const out: string[] = [];
    for (const m of text.matchAll(RATE_FIGURE)) {
      const value = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (!PER_SECOND_UNITS.has(unit)) {
        // The scheme is per-SECOND end to end. A per-minute or per-hour figure
        // cannot be right whatever its value.
        out.push(`${name}: "${m[0]}" (no per-${unit} limit exists)`);
      } else if (!legal.includes(value)) {
        out.push(`${name}: "${m[0]}" (enforced: ${legal.join("/sec, ")}/sec)`);
      }
    }
    return out;
  };

  it("no shipped description quotes a rate that rate-limit.ts does not enforce for that tool", () => {
    const offenders = tools.flatMap((t) =>
      illegalRates(t.name, shippedText(t)),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The same standard, applied to the RAW getTools() literal.
   *
   * decorateTool overwrites `description` from TOOL_METADATA, so the raw text never
   * reaches an agent — which is exactly why it rots. Held to the same rule for two
   * reasons: dead text still gets read by the next person editing the tool, and it is
   * the description the tool falls back to if its TOOL_METADATA entry is removed.
   *
   * The last surviving per-minute figure in src/ lived here, in `get_quote_snapshot`'s
   * raw literal, on an endpoint capped at 2/sec — a fallback that would have told an
   * agent to pace against a budget 30x too generous. The shipped-prose guard could not
   * see it (it iterates decorated tools) and the raw guard could not (it was hard-coded
   * to one tool name and one string).
   */
  it("no RAW description quotes a rate that rate-limit.ts does not enforce for that tool", () => {
    const raw = rawTools();
    // Non-vacuity only: a getTools() that returned nothing would make the
    // sweep below pass over an empty list. It is deliberately NOT a count
    // contract — the exact surface is pinned as a literal in
    // test/e2e/protocol.test.ts (EXPECTED_TOOL_COUNT), and the near-exact
    // floor this would carry (90, against a 93-tool surface) was a second
    // place to update that failed the moment a tool group was retired while
    // saying nothing about the sweep it guards.
    expect(raw.length).toBeGreaterThan(60);
    const offenders = raw.flatMap((t) =>
      illegalRates(t.name, JSON.stringify(t)),
    );
    expect(offenders).toEqual([]);
  });

  it("no RAW text names a bucket the limiter does not have", () => {
    const offenders = rawTools()
      .filter((t) =>
        /\b(read|write|destructive)[- ]bucket\b/i.test(JSON.stringify(t)),
      )
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("is not vacuous: the market-data tools do publish their real 2/sec ceiling", () => {
    // Without this, deleting every rate sentence would also make the guard
    // above pass, and an agent would be left pacing off nothing.
    for (const name of [
      "tastytrade_get_quote",
      "tastytrade_get_quote_snapshot",
    ]) {
      expect(rateKeyForTool(name)).toBe("market_data");
      expect(PER_SECOND_LIMITS.market_data).toBe(2);
      expect(byName[name].description).toContain("2/sec");
      expect(byName[name].description).toContain(`${GLOBAL_PER_SECOND}/sec`);
    }
  });

  it("no shipped text names a bucket the limiter does not have", () => {
    // The read/write/destructive buckets were the retired scheme's annotation
    // classes; naming one tells an agent to reason about a control that is not
    // there. The destructive one is worse than merely absent: rate-limit.ts
    // says of DESTRUCTIVE_PER_SECOND "DO NOT advertise it in the docs, do not
    // export it, and do not let a refusal name it", and chargeRateLimit is
    // built so a refusal never does. Four tool descriptions named it anyway.
    const offenders = tools
      .filter((t) =>
        /\b(read|write|destructive)[- ]bucket\b/i.test(shippedText(t)),
      )
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });
});

describe("no destructive tool tells the model that calling it is safe", () => {
  /**
   * The description is the only risk briefing the model gets — it never opens
   * the README, which says of exactly these two tools that cancelling a live order is
   * a single call with no second step, and an economically consequential act.
   *
   * The wire said the opposite: `cancel_order` shipped "cancelling is safe-by-design
   * and idempotent" and `cancel_complex_order` "DESTRUCTIVE but risk-reducing … cancels
   * only reduce exposure". Both are in the group of five destructive tools with NO
   * confirmation token and NO sanity check, so the description is the only hesitation
   * the interface offers, and both spent it arguing the model out of hesitating. Cancel
   * the stop on a short option position and the risk is unbounded within the minute.
   *
   * A cancel genuinely cannot create a new obligation, which is why it needs no token.
   * What is not fine is generalising that into "safe".
   */
  const destructive = tools.filter(
    (t) => t.annotations?.destructiveHint === true,
  );

  /** Claims about the ACT, not about a repeat of it being a no-op. */
  const SAFETY_CLAIMS: Array<[RegExp, string]> = [
    [/safe[- ]by[- ]design/i, "calls itself safe by design"],
    [/\brisk[- ]reducing\b/i, "calls itself risk-reducing"],
    [/only reduces? (?:exposure|risk)/i, "claims it only reduces exposure"],
    [/cancels? only reduce/i, "claims cancels only reduce exposure"],
    [/\bsafe to (?:repeat|call|retry|use)\b/i, "calls itself safe to repeat"],
    [/\bis (?:entirely |completely |perfectly )?safe\b/i, "calls itself safe"],
  ];

  it("is looking at a real set of destructive tools", () => {
    // Ten destructive tools today, five of them token-less. If annotations ever
    // stop reaching decorateTool, this filter empties and the check below passes
    // on nothing. The floor is deliberately below ten: reclassifying one tool's
    // access class is somebody else's decision to defend, not a failure here.
    expect(destructive.length).toBeGreaterThanOrEqual(8);
    expect(destructive.map((t) => t.name)).toContain("tastytrade_cancel_order");
    expect(destructive.map((t) => t.name)).toContain(
      "tastytrade_cancel_complex_order",
    );
  });

  it("no destructive description claims the act is safe or exposure-reducing", () => {
    const offenders: string[] = [];
    for (const t of destructive)
      for (const [pattern, why] of SAFETY_CLAIMS)
        if (pattern.test(t.description)) offenders.push(`${t.name}: ${why}`);
    expect(offenders.sort()).toEqual([]);
  });

  it("both cancel tools warn that a cancel changes the account's risk", () => {
    // The negative check alone would also pass if the descriptions said nothing
    // at all, which is how `tastytrade_cancel_order` reached review: it gave the
    // model nothing to weigh. That sentence has to reach the wire.
    for (const name of [
      "tastytrade_cancel_order",
      "tastytrade_cancel_complex_order",
    ]) {
      const description: string = byName[name].description;
      expect(description).toMatch(/NOT a harmless call/);
      expect(description).toMatch(/risk immediately/);
      expect(description).toMatch(/confirm/i);
      // And the true half of the old sentence survives: no token is needed
      // because a cancel cannot create an obligation.
      expect(description).toMatch(/cannot create (?:a )?new obligation/);
    }
  });
});

describe("every written parameter description reaches a client", () => {
  /**
   * decorateTool applies paramDescriptions to TOP-LEVEL `inputSchema.properties`
   * only. tool-metadata.ts had 39 keys naming nested fields in three conventions
   * — dotted (`legs.symbol`), bracketed (`symbols[].symbol`) and bare (`symbol`
   * on the complex-order and margin tools) — and every one was dropped without
   * a word, including the OCC-symbol guidance on the two tools that submit a
   * live OTOCO bracket. A description that silently evaporates is worse than an
   * absent one: nobody notices it is missing.
   *
   * tool-registry.test.ts's "zero undescribed params" walks the same top-level
   * properties, so it could never see the orphans — it asserted something
   * weaker than its name while these shipped. This is the mirror assertion:
   * every key must land somewhere a client can read it.
   */
  it("no paramDescriptions key names a property the tool does not expose", () => {
    const orphans: string[] = [];
    for (const t of Object.values<any>(rawByName)) {
      const props = t.inputSchema?.properties ?? {};
      for (const key of Object.keys(
        TOOL_METADATA[t.name]?.paramDescriptions ?? {},
      )) {
        if (!(key in props)) orphans.push(`${t.name}.${key}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("the nested guidance those keys carried is folded into the parent that does ship", () => {
    // Deleting the orphans without rehoming their content would have traded a
    // silent loss for a visible one. The parent property is the node an agent
    // actually reads, so the per-field text lives there now.
    expect(
      byName["tastytrade_place_complex_order"].inputSchema.properties.orders
        .description,
    ).toContain("OCC option");
    expect(
      byName["tastytrade_place_complex_order"].inputSchema.properties
        .trigger_order.description,
    ).toContain("OCC option");
    expect(
      byName["tastytrade_get_quote_snapshot"].inputSchema.properties.symbols
        .description,
    ).toContain("AAPL  260619C00200000");
    expect(
      byName["tastytrade_dry_run_margin_impact"].inputSchema.properties.legs
        .description,
    ).toContain("remaining_quantity");
  });

  it("no tool documents `source`, which is server-set and not an input", () => {
    // MCP_ORDER_SOURCE is stamped on every order body server-side and
    // deliberately absent from every input schema. Two entries still told the
    // reader it was an optional caller-supplied tag that "must match the
    // dry-run value if supplied" — impossible on both counts.
    const offenders: string[] = [];
    for (const [name, meta] of Object.entries(TOOL_METADATA)) {
      if ("source" in meta.paramDescriptions) offenders.push(name);
      if (byName[name].inputSchema?.properties?.source) {
        offenders.push(`${name} (input schema)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("validateLegActions returns only what its callers read", () => {
  /**
   * The refusal would carry `symbol`, `instrument_type` and `action` beside
   * `message`. Nothing read them: both call sites (place_order / dry_run_order)
   * and both complex-order call sites interpolate `.message` alone, and
   * `.message` already quotes all three values. A field nobody reads still
   * looks like a contract, so the next caller reaches for `err.action` — a
   * value no test covers and no consumer keeps honest. The shape now matches
   * LegQuantityError, its sibling refusal, exactly.
   */
  it("carries the index, the message and nothing else", () => {
    const err = validateLegActions([
      { instrument_type: "Future", action: "Buy to Open", symbol: "/ESZ4" },
    ]);
    expect(err).not.toBeNull();
    expect(Object.keys(err!).sort()).toEqual(["legIndex", "message"]);
    // The dropped fields are not lost information — the message carries them.
    expect(err!.message).toContain("/ESZ4");
    expect(err!.message).toContain("Future");
    expect(err!.message).toContain("Buy to Open");
  });
});

describe("position field types tolerate sandbox type variance", () => {
  // No position payload is recorded in test/e2e/_payloads (a cert account has
  // to be holding something to capture one), so this is the only guard on these
  // fields. The cert sandbox serializes quantity/restricted-quantity as JSON
  // numbers and multiplier as a string-decimal — the inverse of the documented
  // types — so the schemas accept both and validating MCP clients (the SDK's
  // callTool()) never reject a real payload. This broke
  // tastytrade_get_positions with MCP -32602 whenever a position was held.
  const cases: Array<[string, any]> = [
    [
      "get_positions item",
      byName["tastytrade_get_positions"].outputSchema.properties.items.items
        .properties,
    ],
    ["get_position", byName["tastytrade_get_position"].outputSchema.properties],
  ];

  for (const [label, props] of cases) {
    it(`${label}: quantity and restricted-quantity accept string or number`, () => {
      expect(props.quantity.type).toEqual(["string", "number"]);
      expect(props["restricted-quantity"].type).toEqual(["string", "number"]);
    });

    it(`${label}: multiplier accepts number or string`, () => {
      expect(props.multiplier.type).toEqual(["number", "string"]);
    });
  }
});

describe("settlement-type is an open string, not a guessed enum", () => {
  // The values are an open set the API extends without notice; the old enums
  // were inferred from the ones that happened to be observed. An enum narrower
  // than reality turns a good payload into MCP -32602 at the client. A recorded
  // payload cannot catch this — it only ever contains values that DID validate.
  it("get_option_chain: option-chain settlement-type carries no enum", () => {
    const prop = get(
      byName["tastytrade_get_option_chain"].outputSchema,
      "properties.items.items.properties.settlement-type",
    );
    expect(prop.type).toBe("string");
    expect(prop.enum).toBeUndefined();
  });

  it("get_equity_definition settlement-type carries no enum", () => {
    expect(
      get(
        byName["tastytrade_get_equity_definition"].outputSchema,
        "properties.settlement-type",
      ).enum,
    ).toBeUndefined();
  });
});

describe("get_future_option keeps its genuinely numeric field numeric", () => {
  /**
   * The decimals on this tool (strike-factor, notional-value,
   * future-price-ratio, underlying-count) arrive as JSON STRINGS, and declaring
   * them `number` made the tool unusable — the live sandbox sweep failed it with
   * `MCP error -32602: Structured content does not match the tool's output
   * schema: data/strike-factor must be number`. That direction is now enforced
   * registry-wide by test/e2e/output-schemas.test.ts ("no decimal-suspect field
   * is declared numeric-only"), so it is not restated here.
   *
   * The OPPOSITE error has no such guard, and is just as bad: widening a
   * genuinely numeric field to string forces every consumer to parse what the
   * API already typed. Verified against api.cert.tastyworks.com on 2026-08-15
   * with `./ESZ6 ESZ6  261218C4900`: days-to-expiration is 125, a JSON number.
   */
  it("days-to-expiration stays an integer, because it is one", () => {
    expect(
      get(
        byName["tastytrade_get_future_option"].outputSchema,
        "properties.days-to-expiration.type",
      ),
    ).toBe("integer");
  });
});

describe("no duplicate $id across any outputSchema", () => {
  it("shared-ajv clients resolve validators by $id; a collision validates a tool against the WRONG schema", () => {
    const ids = new Map<string, string[]>();
    const walk = (node: any, site: string) => {
      if (!node || typeof node !== "object") return;
      if (typeof node.$id === "string") {
        ids.set(node.$id, [...(ids.get(node.$id) ?? []), site]);
      }
      for (const v of Object.values(node)) walk(v, site);
    };
    for (const t of tools) walk(t.outputSchema, t.name);
    const dupes = [...ids.entries()].filter(([, sites]) => sites.length > 1);
    expect(dupes).toEqual([]);
  });
});

describe("toWatchlistEntries", () => {
  it("maps plain ticker strings to entries (instrument-type defaulted downstream)", () => {
    expect(toWatchlistEntries(["AAPL", "MSFT"])).toEqual([
      { symbol: "AAPL" },
      { symbol: "MSFT" },
    ]);
  });

  it("maps {symbol, instrument_type} objects to kebab entries", () => {
    expect(
      toWatchlistEntries([{ symbol: "/ESZ4", instrument_type: "Future" }]),
    ).toEqual([{ symbol: "/ESZ4", "instrument-type": "Future" }]);
  });

  it("returns [] for non-array input", () => {
    expect(toWatchlistEntries(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checks_not_run and the dry-run envelope
//
// The description IS the contract an agent reads. Both of these were prose that
// had drifted from the implementation, and prose drifts silently — so each is
// asserted here rather than left to review.
// ---------------------------------------------------------------------------

describe("every route that reports checks_not_run explains what it means", () => {
  /** Tools whose outputSchema declares the array. */
  const reporters = Object.entries(TOOL_METADATA).filter(([, meta]) =>
    JSON.stringify(meta.outputSchema ?? {}).includes("checks_not_run"),
  );

  it("finds the reporters, so an empty list cannot pass for a pass", () => {
    // If this drops to zero the assertion below becomes vacuous.
    expect(reporters.length).toBeGreaterThanOrEqual(10);
  });

  it.each(reporters.map(([name]) => name))(
    "%s says an empty sanity_warnings is not a completed check",
    (name) => {
      const description = TOOL_METADATA[name].description;
      // The sentence, not a paraphrase: an agent that dry-runs, sees an empty
      // sanity_warnings and reports "this order passed safety checks" is wrong,
      // and the tool it called is the only thing positioned to say so.
      expect(description).toContain("checks_not_run");
      expect(description).toMatch(
        /empty `?sanity_warnings`? means 'nothing found among the checks that ran', never 'everything was checked'/,
      );
    },
  );
});

describe("the dry-run routes describe the envelope they actually return", () => {
  const dryRunReporters = Object.keys(TOOL_METADATA).filter(
    (n) =>
      n.startsWith("tastytrade_dry_run_") &&
      JSON.stringify(TOOL_METADATA[n].outputSchema ?? {}).includes(
        "checks_not_run",
      ),
  );

  it.each(dryRunReporters)("%s names the upstream member", (name) => {
    const description = TOOL_METADATA[name].description;
    // Everything the broker sent is nested under `upstream`; the server's own
    // fields are its siblings. A description promising a flat payload sends
    // callers to response.order, which is undefined.
    expect(description).toContain("upstream");
  });

  it.each(dryRunReporters)(
    "%s does not tell a caller to read a top-level errors[]",
    (name) => {
      const description = TOOL_METADATA[name].description;
      // `errors[]` is absent from the envelope, not empty — code written to the
      // old wording does `response.errors.length` and throws. Any mention has
      // to qualify it as living under upstream.
      const bare = description.match(/(?<!upstream\.)errors\[\]/g);
      expect(bare ?? []).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Sibling tools describing the same thing differently
// ---------------------------------------------------------------------------

describe("the order-search filters document one vocabulary, not two", () => {
  const SIBLINGS = [
    "tastytrade_search_orders",
    "tastytrade_search_customer_orders",
  ];

  it("both name the same instrument-type values for the same filter", () => {
    const listed = SIBLINGS.map((name) => {
      const server = new TastytradeMCPServer();
      const tool = server.getTools().find((t: Tool) => t.name === name) as
        Tool | undefined;
      const prop = (
        tool?.inputSchema?.properties as
          Record<string, { description?: string }> | undefined
      )?.underlying_instrument_type;
      const d = prop?.description ?? "";
      // The vocabulary as a set, so wording may differ but the values may not.
      return new Set(
        d.match(
          /Cryptocurrency|Equity Option|Equity|Event Contract|Fixed Income Security|Future Option|Future|Liquidity Pool/g,
        ) ?? [],
      );
    });
    // Establish the premise: each side actually lists something.
    for (const s of listed) expect(s.size).toBeGreaterThan(0);
    expect([...listed[0]].sort()).toEqual([...listed[1]].sort());
  });
});

describe("multi-symbol reads say they do not preserve request order", () => {
  const MULTI = [
    "tastytrade_get_quote_snapshot",
    "tastytrade_get_market_metrics",
  ];

  it.each(MULTI)("%s tells the caller to key by symbol", (name) => {
    const description = TOOL_METADATA[name].description as string;
    // These fan out per instrument bucket and relay what the broker returns, so
    // the response order is not the request order and is not stable. A caller
    // that zips the two lists positionally gets the wrong symbol's data.
    // Deliberately narrow. A looser pattern matched "No state change, no order
    // impact" — nothing to do with response ordering — so this test passed
    // before the sentence it is supposed to require existed at all.
    expect(description).toMatch(/request order|key(?:ed)? by symbol/i);
  });
});

describe("internal metadata tracks its source", () => {
  it("the order source tag carries the package version", () => {
    // Order records are attributed by this string. A literal drifts from
    // package.json with nothing to catch it, which is the same reason
    // src/version.ts exists for serverInfo and the User-Agent.
    expect(MCP_ORDER_SOURCE).toBe(`tastytrade-mcp/${PACKAGE_VERSION}`);
    expect(MCP_ORDER_SOURCE).not.toBe("tastytrade-mcp/1.0");
  });

  it("the nested chain's expirations array describes its entries", () => {
    const schema = TOOL_METADATA["tastytrade_get_option_chain_nested"]
      .outputSchema as Record<string, any>;
    const find = (n: any): any => {
      if (!n || typeof n !== "object") return undefined;
      if (Array.isArray(n)) return n.map(find).find(Boolean);
      if (n.expirations) return n.expirations;
      return Object.values(n).map(find).find(Boolean);
    };
    const exp = find(schema);
    expect(exp).toBeDefined();
    // For an array instance ajv ignores `additionalProperties`, so `items` is
    // the only thing that makes the per-entry fields part of the contract.
    expect(exp.items).toBeDefined();
    expect(exp.items.properties?.["expiration-date"]).toBeDefined();
    // And the union type is retained deliberately — narrowing it would reject a
    // shape the broker may still send.
    expect(exp.type).toEqual(["array", "object"]);
  });
});
