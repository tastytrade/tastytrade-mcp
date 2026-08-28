/**
 * The OUTPUT-SCHEMA contract: does `structuredContent` actually satisfy the
 * `outputSchema` this server advertises?
 *
 * THE BUG CLASS THIS KILLS. A call reaches the API, SUCCEEDS, and is rejected on
 * the way back — by the client's own validator, against our own schema:
 *
 *     MCP error -32602: Structured content does not match the tool's output
 *     schema: data/strike-factor must be number
 *
 * Any client that validates `structuredContent` (the SDK does, by default) cannot
 * use such a tool at all, and the server-side tests all pass. tastytrade serializes
 * decimals as JSON STRINGS on its kebab-case endpoints — a deliberate choice in a
 * financial API, since a binary float cannot represent every decimal exactly.
 *
 * WHY VALIDATION GOES THROUGH `listTools()` FIRST. The SDK compiles and caches a
 * per-tool output validator inside `cacheToolMetadata()`, which runs ONLY from
 * `Client.listTools()`. Call `callTool()` without that round trip and
 * `getToolOutputValidator()` returns undefined, so the whole validation block is
 * skipped and the call passes whatever the payload looks like — a test that forgets
 * it asserts nothing. `armedClient()` makes the round trip explicit, and "the
 * validator is armed" is itself asserted twice.
 *
 * The SDK's own validator is also the only one that works: it builds ajv with
 * `validateSchema: false`, so the draft/2020-12 declarations compile. A hand-rolled
 * ajv v6 is draft-07 and refuses 10 of these schemas outright. Validate through the
 * client, never around it.
 *
 * THE KEYWORDS THAT CAN REJECT A SUCCESSFUL RESPONSE, all enforced here: `type`
 * (the decimal-as-string rule, section 3); `enum` (section 6 — ten order tools
 * advertised a status enum missing the status a SUCCESSFUL cancel returns);
 * `format` (the SDK's ajv runs `validateFormats: true`, so a `format: "date"` on a
 * timestamped field is enforced too, section 6e); `minimum`/`maximum`, simply
 * banned; `required` (section 7, live on 136 blocks across 93 tools and reaching
 * the live order POST); and `additionalProperties: false`, set only on a wrapper we
 * build, never on a shape the broker authors (section 9).
 *
 * Declaring an outputSchema at all is a seventh constraint that is not a keyword:
 * the reference client reads the spec as a MUST, so a successful response carrying
 * no entity is rejected unless the schema admits it (section 8).
 *
 * The pattern across them: a payload the broker authors, judged against a constraint
 * we wrote from a document, on the client, after the money has already moved. The
 * safe direction is always the loose one.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callOk, createHarness, loadFixture } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { TOOL_METADATA } from "../../src/mcp-server/tool-metadata.js";
import { OrderStatus } from "../../src/enums.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { TOOL_ANNOTATIONS } from "../../src/mcp-server/index.js";
import { accessClassFor } from "../../src/mcp-server/annotations.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
// Recorded sandbox responses, alongside this suite because this suite is what
// reads them. See _payloads/README.md for what was scrubbed and truncated.
const PAYLOAD_DIR = path.join(HERE, "_payloads");
const SPEC_DIR = path.join(
  REPO_ROOT,
  "tastytrade-llms-txt-docs",
  "docs",
  "open-api-spec",
);

/** The account number the recorded payloads were scrubbed to. */
const ACCT = "5XX00000";

let h: Harness | undefined;

beforeEach(() => {
  // Buckets in src/safety/rate-limit.ts are module-level and shared by every
  // harness in this file; `destructive` only allows 5/min. Reset per test so
  // suite duration never decides the outcome.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

/**
 * Boots a harness whose fake transport answers EVERY request with `payload`,
 * then performs the `tools/list` round trip that compiles the output
 * validators. Returns the harness with validation live.
 *
 * A blanket fallback rather than per-tool routes is deliberate: this suite is
 * asserting the response contract, not the request path (test/e2e/*.test.ts
 * already pin every URL), so the tool under test cannot fail for the unrelated
 * reason that its endpoint was not routed.
 */
async function armedClient(payload: unknown): Promise<Harness> {
  const harness = await createHarness({
    fallback: { status: 200, data: payload },
  });
  const listed = await harness.client.listTools();
  // If this ever returns tools without outputSchema, every validation below
  // silently becomes a no-op. Fail here instead.
  expect(listed.tools.length).toBeGreaterThan(0);
  expect(listed.tools.every((t) => t.outputSchema !== undefined)).toBe(true);
  h = harness;
  return harness;
}

/** Root `required` for one tool, as advertised. */
const rootRequired = (tool: string): string[] =>
  ((TOOL_METADATA[tool].outputSchema as { required?: string[] }).required ??
    []) as string[];

/**
 * `required` on the level the BROKER authors.
 *
 * The ten gated order routes box the broker's payload
 * under `upstream`, so a promise about a broker-authored field is declared
 * there now. Same promise, same rejection surface, one level down — which is
 * what keeps the tracked-exception inventory below meaning what it said.
 */
const upstreamRequired = (tool: string): string[] => {
  const upstream = (
    TOOL_METADATA[tool].outputSchema as {
      properties?: Record<string, { required?: string[] }>;
    }
  ).properties?.upstream;
  return (upstream?.required ?? []) as string[];
};

describe("the SDK output validator is armed by the tools/list round trip", () => {
  /**
   * `tastytrade_get_margin_config` types `risk-free-rate` as number|string and
   * requires it. A boolean therefore violates the type, and `{}` violates
   * `required` — both must be REJECTED once the validator is compiled, and both
   * must sail through when `listTools()` is skipped. Those two halves together
   * are the proof that every other assertion in this file has teeth.
   */
  const WRONG_TYPE = { "risk-free-rate": true };
  const MISSING_REQUIRED = {};

  it("rejects a type-violating payload once tools/list has run", async () => {
    const harness = await armedClient(WRONG_TYPE);
    await expect(
      harness.client.callTool({
        name: "tastytrade_get_margin_config",
        arguments: {},
      }),
    ).rejects.toThrow(/does not match the tool's output schema/);
  });

  it("rejects a payload missing a required field once tools/list has run", async () => {
    const harness = await armedClient(MISSING_REQUIRED);
    await expect(
      harness.client.callTool({
        name: "tastytrade_get_margin_config",
        arguments: {},
      }),
    ).rejects.toThrow(/does not match the tool's output schema/);
  });

  it("silently accepts the same payload when tools/list is skipped", async () => {
    // The trap, demonstrated. Without the round trip there is no cached
    // validator, so the identical bad payload sails through.
    h = await createHarness({ fallback: { status: 200, data: WRONG_TYPE } });
    const res = await h.client.callTool({
      name: "tastytrade_get_margin_config",
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual(WRONG_TYPE);
  });
});

// ===========================================================================
// 0b. The server's OWN bounding layer must not violate the schema it advertises
// ===========================================================================

/**
 * Every section below asks whether the BROKER's payload fits our schema. This one
 * asks whether OUR OWN output does, after the safety layer has rewritten it.
 *
 * `boundedDeep` caps an untrusted payload on two axes, and when the node budget runs
 * out inside an array it would push a marker STRING as the final element. Every
 * array of upstream entities in these schemas declares `items: { type: "object" }`,
 * so that marker makes the server emit a payload its own advertised schema forbids,
 * and the SDK rejects the entire SUCCESSFUL response with -32602.
 *
 * `/ES` returns 19,654 contracts of ~30 fields — roughly 590,000 nodes against a
 * 200,000-node default — so the budget is exhausted on every call and the tool is
 * unusable rather than degraded. The payload below is shaped to exhaust the same
 * real default, because a test that lowers the budget would not prove the shipped
 * configuration is safe.
 */
describe("bounding a large payload cannot violate the advertised outputSchema", () => {
  /** ~12,000 contracts x 20 fields ~ 252,000 nodes, over the 200,000 default. */
  const OVER_BUDGET = {
    items: Array.from({ length: 12_000 }, (_, i) => {
      const item: Record<string, string> = { symbol: `./ESZ6 E1CV6 P${i}` };
      for (let f = 0; f < 19; f += 1) item[`field-${f}`] = "v";
      return item;
    }),
  };

  it("delivers a truncated futures option chain instead of a -32602", async () => {
    const harness = await armedClient(OVER_BUDGET);
    const res = await harness.client.callTool({
      name: "tastytrade_get_futures_option_chain_full",
      arguments: { product_code: "ES" },
    });

    expect(res.isError).toBeFalsy();
    const items = (res.structuredContent as { items?: unknown[] }).items ?? [];
    // Truncated — otherwise the budget did not fire and this asserts nothing.
    expect(items.length).toBeLessThan(12_000);
    expect(items.length).toBeGreaterThan(0);
    // ...and every surviving element is still an entity, not a marker.
    const offenders = items
      .map((v, i) => ({ i, type: Array.isArray(v) ? "array" : typeof v }))
      .filter((e) => e.type !== "object");
    expect(offenders).toEqual([]);
  });

  it("still tells the caller the payload was truncated", async () => {
    // The tail is dropped rather than marked in band, so the out-of-band report
    // is now the ONLY channel. If it ever stops being emitted, truncation
    // becomes silent — which is worse than the bug this replaced.
    const harness = await armedClient(OVER_BUDGET);
    const res = await harness.client.callTool({
      name: "tastytrade_get_futures_option_chain_full",
      arguments: { product_code: "ES" },
    });
    const truncation = (
      res._meta as
        | { "tastytrade/provenance"?: { truncation?: Record<string, number> } }
        | undefined
    )?.["tastytrade/provenance"]?.truncation;

    expect(truncation).toBeDefined();
    expect(truncation!.nodesDroppedByBudget).toBeGreaterThan(0);
    expect(truncation!.arraysTruncated).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 1. Every recorded sandbox payload, through the SDK's own validator
// ===========================================================================

/**
 * The arguments each recorded tool needs. Values are only required to satisfy
 * the input schema — the fake transport answers every path with the fixture.
 */
const FIXTURE_ARGS: Record<string, Record<string, unknown>> = {
  tastytrade_dry_run_complex_order: {
    account_number: ACCT,
    type: "OTOCO",
    trigger_order: {
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Debit",
      legs: [
        {
          symbol: "SPY",
          instrument_type: "Equity",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    },
    orders: [
      {
        order_type: "Limit",
        time_in_force: "GTC",
        price: "99999.0",
        price_effect: "Credit",
        legs: [
          {
            symbol: "SPY",
            instrument_type: "Equity",
            action: "Sell to Close",
            quantity: 1,
          },
        ],
      },
    ],
  },
  tastytrade_get_customer_live_orders: {},
  tastytrade_get_future_option_products: {},
  tastytrade_get_future_product: { exchange: "CME", code: "ES" },
  tastytrade_get_future_products: {},
  tastytrade_get_futures: {},
  tastytrade_get_futures_option_chain_full: { product_code: "ES" },
  tastytrade_get_futures_option_chains: { product_code: "ES" },
  tastytrade_get_live_orders: { account_number: ACCT },
  tastytrade_get_margin_config: {},
  tastytrade_get_margin_requirements: { account_number: ACCT, symbol: "AAPL" },
  tastytrade_get_market_metrics: { symbols: ["AAPL"] },
  tastytrade_get_option_chain: { symbol: "AAPL" },
  tastytrade_get_option_chain_compact: { symbol: "AAPL" },
  tastytrade_get_option_chain_full: { symbol: "AAPL" },
  tastytrade_get_option_chain_nested: { symbol: "AAPL" },
  tastytrade_get_orders: { account_number: ACCT },
  tastytrade_get_quote: { symbols: ["AAPL"], instrument_type: "Equity" },
  tastytrade_get_quote_snapshot: {
    symbols: [{ symbol: "AAPL", instrument_type: "Equity" }],
  },
  tastytrade_get_transactions: { account_number: ACCT },
  tastytrade_search_customer_orders: {},
  tastytrade_search_orders: { account_number: ACCT },
};

// ===========================================================================
// 0. The validator is really armed
// ===========================================================================

/** The five token-minting dry-runs, with arguments the dispatcher accepts. */
const DRY_RUNS: ReadonlyArray<[string, Record<string, unknown>]> = [
  [
    "tastytrade_dry_run_order",
    {
      account_number: ACCT,
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Credit",
      legs: [
        {
          symbol: "AAPL",
          instrument_type: "Equity",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    },
  ],
  [
    "tastytrade_dry_run_replace_order",
    {
      account_number: ACCT,
      order_id: "1075264",
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Credit",
    },
  ],
  [
    "tastytrade_dry_run_edit_order",
    {
      account_number: ACCT,
      order_id: "1075264",
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.02",
      price_effect: "Credit",
    },
  ],
  [
    "tastytrade_dry_run_complex_order",
    FIXTURE_ARGS.tastytrade_dry_run_complex_order,
  ],
  [
    "tastytrade_dry_run_edit_complex_order",
    {
      account_number: ACCT,
      complex_order_id: "3",
      ratio_price_comparator: "gte",
      ratio_price_threshold: 1.5,
    },
  ],
];

/** Fixture names on disk, so a newly recorded payload is picked up for free. */
const RECORDED = readdirSync(PAYLOAD_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();

describe("recorded sandbox payloads satisfy the advertised outputSchema", () => {
  it("has an argument set for every recorded payload", () => {
    // Otherwise a new fixture would be recorded and never validated.
    expect(Object.keys(FIXTURE_ARGS).sort()).toEqual(RECORDED);
  });

  it.each(RECORDED)("%s", async (tool) => {
    const payload = loadFixture(tool);
    const harness = await armedClient(payload);

    // A validation failure surfaces as a THROWN McpError from callTool, not as
    // an in-band error result, so the assertion is simply that this resolves.
    const res = await harness.client.callTool({
      name: tool,
      arguments: FIXTURE_ARGS[tool],
    });

    // Resolving at all is the assertion: the SDK throws InvalidParams on a
    // schema mismatch and InvalidRequest when a tool that declares an
    // outputSchema returns no structuredContent, so both failures arrive as a
    // rejected promise rather than as a value to inspect. `isError` is the one
    // thing left that can come back in-band.
    expect(res.isError).toBeFalsy();
  });
});

// ===========================================================================
// 2. The empirical rule the schema fixes rest on
// ===========================================================================

/** JSON type name, distinguishing integral from fractional numbers. */
function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "float";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

/** Every `key -> observed JSON type` pair anywhere in the recorded corpus. */
function corpusTypes(): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  const visit = (value: unknown, fixture: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, fixture));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
      const byType = out.get(key) ?? new Map<string, Set<string>>();
      const seenIn = byType.get(jsonType(sub)) ?? new Set<string>();
      seenIn.add(fixture);
      byType.set(jsonType(sub), seenIn);
      out.set(key, byType);
      visit(sub, fixture);
    }
  };
  for (const name of RECORDED) visit(loadFixture(name), name);
  return out;
}

const CORPUS = corpusTypes();

describe("the recorded corpus pins the decimal-as-string convention", () => {
  it("contains no JSON float anywhere", () => {
    // This is the evidence the schema widenings below rest on: across 19
    // payloads from 7 endpoint families, every fractional value arrives as a
    // string and every JSON number is an integral count, id, or index. If a
    // newly recorded kebab-case payload ever contains a real float, that rule
    // is refuted and the affected schemas need re-deriving from the capture
    // rather than from this rule.
    const floats: string[] = [];
    for (const [key, byType] of CORPUS) {
      const seenIn = byType.get("float");
      if (seenIn) floats.push(`${key} (in ${[...seenIn].sort().join(", ")})`);
    }
    expect(floats).toEqual([]);
  });

  it("shows the decimal fields of the reported bug arriving as strings", () => {
    // The four fields from the live failure, plus their siblings. Not a
    // paraphrase of the schema — read straight off the recorded payloads.
    for (const key of [
      "strike-factor",
      "strike-price",
      "future-price-ratio",
      "underlying-count",
      "notional-value",
      "display-factor",
      "multiplier",
      "tick-size",
      "notional-multiplier",
      "contract-size",
      "clearing-price-multiplier",
      "fill-price",
      "risk-free-rate",
    ]) {
      expect([...(CORPUS.get(key)?.keys() ?? [])].sort()).toEqual(["string"]);
    }
  });
});

// ===========================================================================
// 3. Guard: no decimal-suspect field name may be declared numeric-only
// ===========================================================================

/**
 * Field names whose suffix marks them as a probable decimal in this API. A
 * numeric-only declaration on one of these is the bug that broke
 * `tastytrade_get_future_option`.
 */
const DECIMAL_SUSPECT =
  /(factor|ratio|price|value|multiplier|count|size|tick)$/i;

/**
 * Numeric-only declarations that are NOT string-decimals, keyed by the exact schema
 * path so a name collision cannot launder one site's evidence into another's.
 * Anything not listed here must accept a string.
 *
 * Each value starts with the class of evidence, checked by the tests below:
 * `fixture:` — a recorded payload shows this field name as a JSON integer and never
 * as a string; `spec:` — the vendored OpenAPI markdown types it as an integer and
 * no capture exists.
 */
const NUMERIC_BY_DESIGN: Record<string, string> = {
  // Counts confirmed as JSON integers by a recorded payload.
  "tastytrade_get_future_products.items[].base-tick": "fixture",
  "tastytrade_get_future_product.base-tick": "fixture",
  "tastytrade_get_future_products.items[].sub-tick": "fixture",
  "tastytrade_get_future_product.sub-tick": "fixture",
  "tastytrade_get_option_chain.items[].shares-per-contract": "fixture",
  "tastytrade_get_option_chain_full.items[].shares-per-contract": "fixture",
  "tastytrade_get_option_chain_compact.items[].shares-per-contract": "fixture",
  "tastytrade_get_option_chain_nested.items[].shares-per-contract": "fixture",
  "tastytrade_get_equity_option.shares-per-contract": "fixture",
  "tastytrade_get_equity_definition.shares-per-contract": "fixture",
  // Contract counts typed integer by the vendored spec; no capture available.
  "tastytrade_get_position_limit.equity-order-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.equity-position-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.equity-option-order-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.equity-option-position-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.future-order-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.future-position-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.future-option-order-size":
    "spec: risk-parameters.md (contract count)",
  "tastytrade_get_position_limit.future-option-position-size":
    "spec: risk-parameters.md (contract count)",
  // NOT a money amount: the COUNT of decimal places allowed in a quantity.
  // Distinct from every other `value` in the API, which is a string-decimal.
  "tastytrade_get_quantity_precisions.items[].value":
    "spec: instruments.md QuantityDecimalPrecision.value (decimal PLACES)",
  // The deliberate numeric twin of the sibling string field `threshold`.
  "tastytrade_get_quote_alerts.items[].threshold-numeric":
    "spec: quote-alerts.md response model",
  "tastytrade_create_quote_alert.threshold-numeric":
    "spec: quote-alerts.md response model",
  // NOTE: the former "camelCase service" entries for tastytrade_get_quote and
  // tastytrade_get_quote_snapshot were removed. Both schemas are now kebab-case
  // with string-decimal (number|string) price/size fields, verified against the
  // recorded fixtures, so none of those fields are numeric-only any longer.
};

/** Walks every property of an outputSchema, yielding `path`, name and schema. */
function eachProperty(
  schema: unknown,
  path: string,
  visit: (name: string, sub: Record<string, unknown>, at: string) => void,
  seen = new Set<unknown>(),
): void {
  if (schema === null || typeof schema !== "object" || seen.has(schema)) return;
  seen.add(schema);
  const node = schema as Record<string, unknown>;
  const props = node.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    for (const [name, sub] of Object.entries(props)) {
      if (sub !== null && typeof sub === "object") {
        visit(name, sub as Record<string, unknown>, `${path}.${name}`);
        eachProperty(sub, `${path}.${name}`, visit, seen);
      }
    }
  }
  if (node.items) eachProperty(node.items, `${path}[]`, visit, seen);
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === "object"
  )
    eachProperty(node.additionalProperties, `${path}{*}`, visit, seen);
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branch = node[key];
    if (Array.isArray(branch))
      branch.forEach((s, i) =>
        eachProperty(s, `${path}.${key}[${i}]`, visit, seen),
      );
  }
}

/** The declared JSON types of one property schema, `[]` when untyped. */
function declaredTypes(sub: Record<string, unknown>): string[] {
  const t = sub.type;
  if (t === undefined) return [];
  return Array.isArray(t) ? (t as string[]) : [t as string];
}

/** Every numeric-only-declared property in the whole registry, by path. */
function numericOnlyPaths(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [tool, meta] of Object.entries(TOOL_METADATA))
    eachProperty(meta.outputSchema, tool, (name, sub, at) => {
      const types = declaredTypes(sub);
      if (
        types.some((t) => t === "number" || t === "integer") &&
        !types.includes("string")
      )
        out.set(at, name);
    });
  return out;
}

/** The trailing field name of a schema path, e.g. `…items[].base-tick`. */
function fieldOf(schemaPath: string): string {
  return schemaPath.slice(schemaPath.lastIndexOf(".") + 1);
}

describe("no decimal-suspect field is declared numeric-only", () => {
  const NUMERIC_ONLY = numericOnlyPaths();

  it("every *factor/ratio/price/value/multiplier/count/size/tick accepts a string, or is justified", () => {
    const offenders = [...NUMERIC_ONLY.keys()]
      .filter((at) => DECIMAL_SUSPECT.test(fieldOf(at)))
      .filter((at) => !NUMERIC_BY_DESIGN[at])
      .sort();
    // A new tool, or a rename that lands on a decimal suffix, fails here rather
    // than in a client that validates structuredContent.
    expect(offenders).toEqual([]);
  });

  it("keeps the justification list minimal — no dead entries", () => {
    // An allowlist that outlives the field it excused is how the next instance
    // of this bug gets waved through.
    const dead = Object.keys(NUMERIC_BY_DESIGN)
      .filter((at) => !NUMERIC_ONLY.has(at))
      .sort();
    expect(dead).toEqual([]);
  });

  it("backs every `fixture:` justification with the recorded corpus", () => {
    // The claim is "a recorded payload shows this as a JSON integer". Check it,
    // rather than trusting the comment.
    const unproven: string[] = [];
    for (const [at, why] of Object.entries(NUMERIC_BY_DESIGN)) {
      if (!why.startsWith("fixture")) continue;
      const seen = CORPUS.get(fieldOf(at));
      if (!seen?.has("integer")) unproven.push(`${at}: never a JSON integer`);
      if (seen?.has("string")) unproven.push(`${at}: arrives as a string`);
      if (seen?.has("float")) unproven.push(`${at}: arrives as a float`);
    }
    expect(unproven).toEqual([]);
  });

  it("backs every `spec:` justification with the vendored spec", () => {
    const unproven: string[] = [];
    for (const [at, why] of Object.entries(NUMERIC_BY_DESIGN)) {
      if (!why.startsWith("spec")) continue;
      const spec = SPEC.get(fieldOf(at));
      if (!spec?.has("integer") && !spec?.has("number"))
        unproven.push(`${at}: spec does not type it numeric`);
    }
    expect(unproven).toEqual([]);
  });

  it("declares no numeric range bound on a live market value", () => {
    // `minimum`/`maximum` reject a successful call exactly as a wrong `type`
    // does. Market metrics documented IV rank and liquidity as decimals 0-1 and
    // the schema enforced that band; a live value one tick outside it would
    // have made the tool unusable. Bands belong in the description.
    const bounded: string[] = [];
    for (const [tool, meta] of Object.entries(TOOL_METADATA))
      eachProperty(meta.outputSchema, tool, (_name, sub, at) => {
        for (const kw of [
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf",
        ])
          if (sub[kw] !== undefined) bounded.push(`${at}: ${kw}`);
      });
    expect(bounded).toEqual([]);
  });
});

// ===========================================================================
// 4. Static cross-check against the vendored OpenAPI spec
// ===========================================================================

/**
 * Parses the field tables out of the vendored spec markdown:
 *
 *     | `strike-factor` | number (double) | Factor applied to the strike price |
 *
 * Rows whose second column is a request location (`path`/`query`/`body`) are
 * parameter tables, not response models, and are skipped.
 */
function specFieldTypes(): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  const normalize = (raw: string): string | undefined => {
    const t = raw.toLowerCase().trim();
    if (/^number/.test(t) || /double|float|decimal/.test(t)) return "number";
    if (/^integer/.test(t) || /int64|int32/.test(t)) return "integer";
    if (/^bool/.test(t)) return "boolean";
    if (/^(datetime|date|time|string|uuid|enum)/.test(t)) return "string";
    if (/^array/.test(t)) return "array";
    if (/^object/.test(t)) return "object";
    return undefined; // model reference, e.g. `Instrument`
  };
  for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(path.join(SPEC_DIR, file), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
      if (!m) continue;
      const raw = m[2].trim();
      if (/^(path|query|body|header)$/i.test(raw)) continue;
      const mapped = normalize(raw);
      if (!mapped) continue;
      const byType = out.get(m[1].trim()) ?? new Map<string, Set<string>>();
      const sources = byType.get(mapped) ?? new Set<string>();
      sources.add(file.replace(/\.md$/, ""));
      byType.set(mapped, sources);
      out.set(m[1].trim(), byType);
    }
  }
  return out;
}

const SPEC = specFieldTypes();

/**
 * Field names where this server's schema deliberately disagrees with the vendored
 * spec, mapped to the reason. Every entry is a case where the SPEC is wrong.
 *
 * Two systematic errors run through the vendored markdown. It types every
 * money/price/quantity decimal as `number (double)`, where the kebab-case endpoints
 * serialize them as strings — the corpus test above finds zero JSON floats in 19
 * payloads, and the schema follows the wire, not the doc. And it types some nested
 * containers loosely as `object` where the payload is an `array`, and the dry-run
 * sub-documents as `string` where the payload is an object.
 */
const SPEC_IS_WRONG: Record<string, string> = {
  // (1) decimal-as-string — schema says string, spec says number.
  "available-trading-funds": "decimal-as-string",
  "average-daily-market-close-price": "decimal-as-string",
  "average-open-price": "decimal-as-string",
  "average-yearly-market-close-price": "decimal-as-string",
  "borrow-rate": "decimal-as-string",
  "cash-available-to-withdraw": "decimal-as-string",
  "cash-balance": "decimal-as-string",
  "clearing-fees": "decimal-as-string",
  "close-price": "decimal-as-string",
  commission: "decimal-as-string",
  "cryptocurrency-margin-requirement": "decimal-as-string",
  "day-trade-excess": "decimal-as-string",
  "day-trading-buying-power": "decimal-as-string",
  "derivative-buying-power": "decimal-as-string",
  "equity-buying-power": "decimal-as-string",
  "fill-price": "decimal-as-string (fixture-confirmed: get_orders)",
  "fixing-price": "decimal-as-string",
  "future-price-ratio": "decimal-as-string (fixture-confirmed)",
  "futures-margin-requirement": "decimal-as-string",
  "long-cryptocurrency-value": "decimal-as-string",
  "long-derivative-value": "decimal-as-string",
  "long-equity-value": "decimal-as-string",
  "long-futures-value": "decimal-as-string",
  "maintenance-call-value": "decimal-as-string",
  "maintenance-excess": "decimal-as-string",
  "maintenance-requirement": "decimal-as-string",
  "margin-equity": "decimal-as-string",
  mark: "decimal-as-string",
  "mark-price": "decimal-as-string",
  "net-liquidating-value": "decimal-as-string",
  "notional-value": "decimal-as-string (fixture-confirmed)",
  "pending-cash": "decimal-as-string",
  "ratio-price-threshold": "decimal-as-string",
  "realized-day-gain": "decimal-as-string",
  "realized-today": "decimal-as-string",
  "reg-t-call-value": "decimal-as-string",
  "reg-t-margin-requirement": "decimal-as-string",
  "regulatory-fees": "decimal-as-string",
  "short-cryptocurrency-value": "decimal-as-string",
  "short-derivative-value": "decimal-as-string",
  "short-equity-value": "decimal-as-string",
  "short-futures-value": "decimal-as-string",
  "strike-factor": "decimal-as-string (fixture-confirmed; the reported bug)",
  "strike-price": "decimal-as-string (fixture-confirmed)",
  "tick-size": "decimal-as-string (fixture-confirmed)",
  "underlying-count": "decimal-as-string (fixture-confirmed)",
  "used-derivative-buying-power": "decimal-as-string",
  // A name collision, not a disagreement: instruments.md types
  // QuantityDecimalPrecision.value as integer (decimal PLACES) while orders.md
  // and transactions.md type the money `value` as a decimal. Both are honoured
  // at their own sites; the name-level check cannot tell them apart.
  value: "name collision: precision count vs money amount",
  // (2) spec containers typed loosely.
  "buying-power-effect":
    "spec types the sub-document as string; it is an object",
  "fee-calculation": "spec types the sub-document as string; it is an object",
  "closing-fee-calculation":
    "spec types the sub-document as string; it is an object",
  expirations: "spec says object; the payload is an array",
  futures: "spec says object; the payload is an array",
  "option-chains": "spec says object; the payload is an array",
  // Fixture-confirmed epoch-millis integer on orders, ISO datetime on balances.
  "restricted-quantity":
    "spec says object; schema accepts number|string — see cannotSettleOffline",
};

describe("outputSchema types agree with the vendored OpenAPI spec", () => {
  it("parses field tables out of the vendored spec", () => {
    // If the markdown is reformatted the parse silently empties and this whole
    // section stops asserting anything. Pin a few known rows.
    expect(SPEC.size).toBeGreaterThan(400);
    expect([...(SPEC.get("strike-factor")?.keys() ?? [])]).toEqual(["number"]);
    expect([...(SPEC.get("shares-per-contract")?.keys() ?? [])]).toEqual([
      "integer",
    ]);
  });

  it("reports no undocumented type disagreement", () => {
    const disagreements: string[] = [];
    for (const [tool, meta] of Object.entries(TOOL_METADATA)) {
      eachProperty(meta.outputSchema, tool, (name, sub, at) => {
        const declared = declaredTypes(sub).filter((t) => t !== "null");
        const spec = SPEC.get(name);
        if (declared.length === 0 || !spec) return;
        const overlaps = declared.some(
          (t) => spec.has(t) || (t === "integer" && spec.has("number")),
        );
        if (overlaps) return;
        if (SPEC_IS_WRONG[name]) return;
        disagreements.push(
          `${at}: schema ${JSON.stringify(sub.type)} vs spec ${[...spec.keys()].join("|")}`,
        );
      });
    }
    expect(disagreements).toEqual([]);
  });

  it("keeps the spec-is-wrong list minimal — no dead entries", () => {
    const stillDisagreeing = new Set<string>();
    for (const meta of Object.values(TOOL_METADATA))
      eachProperty(meta.outputSchema, "", (name, sub) => {
        const declared = declaredTypes(sub).filter((t) => t !== "null");
        const spec = SPEC.get(name);
        if (declared.length === 0 || !spec) return;
        const overlaps = declared.some(
          (t) => spec.has(t) || (t === "integer" && spec.has("number")),
        );
        if (!overlaps) stillDisagreeing.add(name);
      });
    expect(
      Object.keys(SPEC_IS_WRONG)
        .filter((n) => !stillDisagreeing.has(n))
        .sort(),
    ).toEqual([]);
  });
});

// ===========================================================================
// 5. The blind spots — tools whose output contract is genuinely unverified
// ===========================================================================

/** Every property name declared anywhere in a tool's outputSchema. */
function declaredNames(schema: unknown): string[] {
  const names = new Set<string>();
  eachProperty(schema, "", (name) => {
    if (name !== "items") names.add(name);
  });
  return [...names];
}

/**
 * Tools with NEITHER a recorded payload NOR a single spec-documented field
 * name: nothing offline can check their output contract. They are the list a
 * live sweep should record first.
 */
const UNVERIFIABLE_OFFLINE = [
  "tastytrade_delete_quote_alert",
  "tastytrade_get_market_holidays",
  "tastytrade_get_market_session",
  "tastytrade_get_total_fees",
];

/**
 * Of those, the two that nonetheless CONSTRAIN their payload — an unverified
 * schema that constrains nothing cannot reject a real response, but these two
 * can. Both were derived from convention rather than from a documented model,
 * so both are live-sweep priorities above the rest of the list.
 */
const CONSTRAINED_BLIND_SPOTS: Record<string, string> = {
  tastytrade_get_total_fees:
    "requires the field name `total-fees`, which the transactions spec never states for this endpoint (it says only that the endpoint returns the total fee amount); the name is borrowed from the dry-run fee-calculation sub-document",
};

describe("the offline blind spot is inventoried and does not grow", () => {
  /**
   * The advertised tool list, read the way a client reads it. Going through
   * `tools/list` rather than the private `getTools()` keeps this honest about
   * what is actually exposed (read-only mode, for instance, withholds 14).
   */
  let allTools: string[] = [];

  beforeAll(async () => {
    const harness = await createHarness();
    allTools = (await harness.client.listTools()).tools.map((t) => t.name);
    await harness.close();
  });

  it("covers all 86 tools between the fixture corpus and the spec", () => {
    const blind = allTools
      .filter((t) => !RECORDED.includes(t))
      .filter((t) => {
        const meta = TOOL_METADATA[t];
        return !declaredNames(meta.outputSchema).some((n) => SPEC.has(n));
      })
      .sort();
    // Recording a payload for any of these, or documenting its fields, should
    // shorten this list — never lengthen it. A NEW tool landing here means it
    // shipped with an output contract nothing can check.
    expect(blind).toEqual(UNVERIFIABLE_OFFLINE);
  });

  it("names exactly the blind-spot tools that still constrain their payload", () => {
    // An unverified schema that constrains nothing cannot reject a real payload. Any
    // tool that grows `properties`/`required` without a fixture or a documented model
    // behind it is a guess being enforced against live data, so it is named here with
    // the guess spelled out.
    //
    // DECLARING an outputSchema is itself a constraint — the reference client throws
    // -32600 if structuredContent is absent — so a tool whose schema constrains nothing
    // still could not succeed on a 204 if the dispatcher withheld structuredContent for
    // a null payload. It emits `{}` instead (section 8). The remaining exception is a
    // non-null SCALAR payload, which no schema here could accept.
    const constrains = UNVERIFIABLE_OFFLINE.filter((tool) => {
      const schema = TOOL_METADATA[tool].outputSchema as Record<
        string,
        unknown
      >;
      return (
        schema.properties !== undefined ||
        schema.required !== undefined ||
        schema.additionalProperties === false
      );
    }).sort();
    expect(constrains).toEqual(Object.keys(CONSTRAINED_BLIND_SPOTS).sort());
  });

  it("names the fixture-backed tools so the corpus cannot silently shrink", () => {
    expect(RECORDED.filter((t) => allTools.includes(t))).toEqual(RECORDED);
    expect(RECORDED).toHaveLength(22);
  });
});

// ===========================================================================
// 6. Output-schema ENUMS — the class behind a discarded successful cancel
// ===========================================================================

/**
 * Why an output enum is a liability rather than a safety feature.
 *
 * An `enum` in an INPUT schema is a constraint this server enforces. In an OUTPUT
 * schema it is the mirror image: a rejection rule handed to the client and applied
 * to data the BROKER authors. `Client.callTool` compiles it during `tools/list` and
 * throws `-32602` on a payload outside it — on the client, after the server already
 * answered success, so the throw carries no `data.code`, no `retryable` and none of
 * api-client's unknown-outcome machinery. The agent sees a protocol error for an
 * operation that worked.
 *
 * That shipped three ways. Ten single-order tools advertised an 11-value `status`
 * enum missing `Cancel Requested`, which order-management.md documents as literally
 * the status a SUCCESSFUL cancel returns — so a working `tastytrade_cancel_order`
 * read as a protocol failure, on the one destructive tool with no confirmation token
 * whose whole job is reducing risk. `place_order` advertised `["Credit", "Debit"]`
 * for two `*-effect` fields while its own dry-run twin already allowed `"None"`, so
 * a flat or zero-fee order had its confirmation thrown away with the order already
 * routed. And thirteen sites declared `type: ["string", "null"]` under an enum that
 * omitted `null`, which rejects `null` outright: `enum` is checked independently of
 * `type`.
 *
 * The recorded corpus cannot catch any of this. A fixture only contains values that
 * DID validate, and every recorded order sits in a terminal state, so no transient
 * status appears in it. The guards below are sourced from the vendored documentation
 * and from the shape of the registry instead.
 *
 * WHERE THE LINE IS DRAWN. An enum survives only where the domain is closed by
 * something tastytrade cannot change unilaterally — an arithmetic sign, instrument
 * structure, or an external standard — AND no other vendored table names a different
 * set for the same field. Everything else is `type: "string"` with the known values
 * in the description.
 *
 * Order `status` is the clearest case for dropping rather than widening: order-flow.md
 * and open-api-spec/orders.md each name statuses the other omits, and `src/enums.ts`
 * is a third list again. Three sources, three answers, is not a closed domain. And
 * `Accept-Version` is today's UTC date computed per request, so the server floats
 * onto each new API revision at midnight while a hard-coded enum stays frozen at
 * build time — the gap can open with no deploy.
 */

interface EnumSite {
  tool: string;
  /** Schema path, e.g. `tastytrade_get_order.legs[].action`. */
  at: string;
  field: string;
  values: unknown[];
  types: string[];
}

/** Every `enum` reachable through the property walker, with its declared type. */
function enumSites(): EnumSite[] {
  const out: EnumSite[] = [];
  for (const [tool, meta] of Object.entries(TOOL_METADATA))
    eachProperty(meta.outputSchema, tool, (name, sub, at) => {
      if (Array.isArray(sub.enum))
        out.push({
          tool,
          at,
          field: name,
          values: sub.enum as unknown[],
          types: declaredTypes(sub),
        });
    });
  return out;
}

/**
 * Raw count of `enum` keys anywhere in any outputSchema. `eachProperty` only
 * visits named properties, so an enum declared on an array's `items` directly
 * would be invisible to every check below; this makes that silence impossible.
 */
function rawEnumCount(): number {
  let n = 0;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) n++;
      else walk(value);
    }
  };
  for (const meta of Object.values(TOOL_METADATA)) walk(meta.outputSchema);
  return n;
}

const ENUM_SITES = enumSites();

/** Order-insensitive, null-safe signature of an enum's member set. */
function valueKey(values: unknown[]): string {
  return JSON.stringify(
    values.map((v) => (v === null ? "\0null" : String(v))).sort(),
  );
}

/** The accounting-sign family: every `…-effect` plus the bare `effect`. */
const EFFECT_FIELD = /(^|-)effect$/;

/**
 * The one domain every effect field gets. `Credit`/`Debit` is the sign, `None`
 * is a zero amount (present in the recorded dry-run capture as
 * `"commission-effect": "None"` and seven `"effect": "None"`), and `null` is
 * the API publishing no direction at all — a Market order's `price-effect`,
 * which one sibling already allowed and eight others rejected.
 */
const EFFECT_DOMAIN = ["Credit", "Debit", "None", null];

/**
 * The ONLY field names allowed to carry an output enum, each with the authority
 * that closes its domain. A field absent from here — and not in the effect
 * family — must ship as an open string with its values in the description.
 *
 * What is deliberately NOT here, and why: order `status`, `instrument-type`,
 * `underlying-instrument-type`, `instrumentType`, `order-type`,
 * `time-in-force`, the complex-order strategy `type`, `instrument-collection`,
 * `exchange`, `lendability` and the quote-alert `field`. For each, either two
 * vendored tables name different members for the same field (status: 13 vs 11;
 * instrument-type: 5 vs 8 vs 14, one of them the sentinel `Unknown`;
 * order-type: 4 vs 6; time-in-force: 3 vs 8; exchange: 2 vs 4), or the set is
 * plainly a tastytrade product list that grows with the product.
 */
const CLOSED_VALUE_DOMAINS: Record<string, string> = {
  action:
    "the six order-leg actions, closed by open/close semantics the dispatcher already enforces on input (validateLegActions); orders.md:337",
  "exercise-style":
    "American or European exercise, closed by contract structure; instruments.md:420, instruments.md:529 (plus null, which the API does return)",
  "margin-or-cash":
    "the Reg-T account distinction, not a tastytrade taxonomy; accounts-and-customers.md:201",
  "option-chain-type":
    "OCC standard vs adjusted contracts; market-metrics.md:195",
  "option-type":
    "an option is a call or a put; instruments.md:415, instruments.md:523",
  operator:
    "the two comparison directions a threshold alert can have; quote-alerts.md:78",
  "quantity-direction":
    "the sign of a position: balances-and-positions.md:193 names Long and Short, src/enums.ts Direction adds Zero for flat",
  "ratio-price-comparator":
    "gte or lte, the two comparators a PAIRS ratio threshold can use; orders.md:391",
  "settlement-type":
    "AM or PM expiry timing on a market-metrics option-expiration row; market-metrics.md:194. NOT the same field as instruments.md's Physical/Cash delivery mode, which shares the name on a different model",
  "time-of-day":
    "a balance snapshot is taken at the beginning or the end of the day; balances-and-positions.md:81",
};

describe("outputSchema enums are advertised only where the domain is closed", () => {
  it("sees every enum in the registry", () => {
    // Non-vacuity: if the walker misses sites, every check below weakens
    // silently. Both numbers must move together.
    expect(ENUM_SITES).toHaveLength(rawEnumCount());
    expect(ENUM_SITES.length).toBeGreaterThan(50);
  });

  it("declares an enum only on a field tastytrade cannot widen unilaterally", () => {
    const offenders = ENUM_SITES.filter(
      (s) => !EFFECT_FIELD.test(s.field) && !CLOSED_VALUE_DOMAINS[s.field],
    )
      .map((s) => `${s.at}: ${JSON.stringify(s.values)}`)
      .sort();
    // A new tool that copies an old enum, or a well-meant narrowing of a
    // broker-controlled field, fails here rather than in a client that
    // validates structuredContent — where it costs a discarded success.
    expect(offenders).toEqual([]);
  });

  it("keeps the closed-domain list minimal — no dead entries", () => {
    const live = new Set(ENUM_SITES.map((s) => s.field));
    expect(
      Object.keys(CLOSED_VALUE_DOMAINS)
        .filter((f) => !live.has(f))
        .sort(),
    ).toEqual([]);
  });

  it("gives one field name exactly one enum, registry-wide", () => {
    // Divergent copies of the "same" enum are how four tools ended up stricter
    // than their twins: `status` was 11 values on the single-order tools and 12
    // on the complex-order tools, `instrument-type` 5 on positions and 8 on the
    // customer-order tools, `price-effect` null-tolerant on exactly one of nine
    // sites. Whichever copy is narrowest decides whether a payload survives, so
    // there is no such thing as a legitimate narrowing here.
    const byField = new Map<string, Map<string, string[]>>();
    for (const site of ENUM_SITES) {
      const variants = byField.get(site.field) ?? new Map<string, string[]>();
      const key = valueKey(site.values);
      variants.set(key, [...(variants.get(key) ?? []), site.at]);
      byField.set(site.field, variants);
    }
    const diverging = [...byField.entries()]
      .filter(([, variants]) => variants.size > 1)
      .map(
        ([field, variants]) =>
          `${field}: ${[...variants.entries()].map(([key, ats]) => `${key} @ ${ats.join(", ")}`).join(" VS ")}`,
      )
      .sort();
    expect(diverging).toEqual([]);
  });

  it("gives every effect field the Credit/Debit/None/null domain", () => {
    const wrong = ENUM_SITES.filter((s) => EFFECT_FIELD.test(s.field))
      .filter((s) => valueKey(s.values) !== valueKey(EFFECT_DOMAIN))
      .map((s) => `${s.at}: ${JSON.stringify(s.values)}`)
      .sort();
    expect(wrong).toEqual([]);
    // Non-vacuity: the family is large, and place_order's two members are the
    // exact sites that discarded a live order's confirmation.
    expect(
      ENUM_SITES.filter((s) => EFFECT_FIELD.test(s.field)).length,
    ).toBeGreaterThan(30);
    // One level down, under `upstream`, where the
    // broker's payload now lives.
    for (const at of [
      "tastytrade_place_order.upstream.buying-power-effect.change-in-buying-power-effect",
      "tastytrade_place_order.upstream.fee-calculation.total-fees-effect",
    ])
      expect(ENUM_SITES.map((s) => s.at)).toContain(at);
  });

  it("never forbids the null its own `type` admits", () => {
    // `enum` is validated independently of `type`, so
    // `{type: ["string","null"], enum: ["Debit","Credit"]}` accepts no null at
    // all — the nullability is decoration. Thirteen sites shipped that way.
    const contradictory = ENUM_SITES.filter(
      (s) => s.types.includes("null") && !s.values.includes(null),
    )
      .map(
        (s) => `${s.at}: type ${JSON.stringify(s.types)} vs enum without null`,
      )
      .sort();
    expect(contradictory).toEqual([]);
  });

  it("declares no enum on an order status, anywhere", () => {
    // The CRITICAL, named on its own so the reason survives a refactor of the
    // generic checks above.
    expect(
      ENUM_SITES.filter((s) => s.field === "status").map((s) => s.at),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6b. The order-status domain, read out of the vendored documentation
// ---------------------------------------------------------------------------

const DOCS_DIR = path.dirname(SPEC_DIR);

/**
 * The order-status table in order-flow.md: three tab-separated columns
 * (Status / Meaning / Terminal), no markdown pipes.
 */
function orderFlowStatuses(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const text = readFileSync(path.join(DOCS_DIR, "order-flow.md"), "utf8");
  for (const line of text.split("\n")) {
    const cells = line.split("\t");
    if (cells.length !== 3) continue;
    const terminal = cells[2].trim();
    if (terminal !== "Yes" && terminal !== "No") continue;
    out.set(cells[0].trim(), terminal === "Yes");
  }
  return out;
}

/** The `## Order Status Values` markdown table in open-api-spec/orders.md. */
function openApiStatuses(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const text = readFileSync(path.join(SPEC_DIR, "orders.md"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*(Yes|No)\s*\|/);
    if (m) out.set(m[1].trim(), m[2] === "Yes");
  }
  return out;
}

const ORDER_FLOW_STATUSES = orderFlowStatuses();
const OPEN_API_STATUSES = openApiStatuses();
const DOCUMENTED_STATUSES = new Map<string, boolean>([
  ...ORDER_FLOW_STATUSES,
  ...OPEN_API_STATUSES,
]);

/**
 * Parses `… non-terminal: A, B; terminal: C, D. …` out of a status
 * description. Returns null when the description does not carry both lists,
 * which is itself a failure below.
 */
function describedStatuses(
  description: string,
): { terminal: string[]; nonTerminal: string[] } | null {
  const m = description.match(
    /non-terminal:\s*([^;]+);\s*terminal:\s*([^.]+)\./i,
  );
  if (!m) return null;
  const split = (s: string): string[] =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  return { nonTerminal: split(m[1]), terminal: split(m[2]) };
}

/**
 * `status` properties that are NOT an order status, and so are not held to the
 * order-status domain.
 *
 * DELIBERATELY EMPTY, and that is the strong position: every `status` the
 * shipped surface declares is an order status, so every one of them is checked.
 * The three entries this map would carry were the backtest tools' run status
 * ('queued', 'running', 'completed'), a different vocabulary on an endpoint
 * whose swagger defined no values at all; those tools are gone and the
 * exemptions went with them. The map and the "no dead entries" guard below stay
 * because the next non-order `status` has to be added here EXPLICITLY, with a
 * reason, rather than quietly widening the domain the rest of this suite checks
 * against.
 */
const NON_ORDER_STATUS: Record<string, string> = {};

describe("the order-status domain comes from the vendored docs, not from memory", () => {
  it("parses both status tables, and they disagree — which is the point", () => {
    expect(ORDER_FLOW_STATUSES.size).toBe(13);
    expect(OPEN_API_STATUSES.size).toBe(11);
    expect(DOCUMENTED_STATUSES.size).toBe(15);
    // Each table names something the other omits, so neither is the domain and
    // a closed enum built from either one is wrong. If a future doc drop
    // reconciles them, this fails and the decision gets re-argued on the new
    // evidence instead of silently inheriting the old conclusion.
    const onlyFlow = [...ORDER_FLOW_STATUSES.keys()].filter(
      (s) => !OPEN_API_STATUSES.has(s),
    );
    const onlySpec = [...OPEN_API_STATUSES.keys()].filter(
      (s) => !ORDER_FLOW_STATUSES.has(s),
    );
    expect(onlyFlow.sort()).toEqual([
      "Cancel Requested",
      "Partially Removed",
      "Removed",
      "Replace Requested",
    ]);
    expect(onlySpec.sort()).toEqual(["Dead", "Remove Pending"]);
    // And where they overlap they agree, so the union's terminal flags are safe.
    for (const [status, terminal] of ORDER_FLOW_STATUSES)
      if (OPEN_API_STATUSES.has(status))
        expect(OPEN_API_STATUSES.get(status)).toBe(terminal);
  });

  it("covers everything src/enums.ts OrderStatus exports", () => {
    // The exported public enum is a third list again: it omits `Remove Pending`
    // and `Dead`, both of which the API returns. It is not this suite's file to
    // change, so the gap is pinned rather than papered over — reconciling
    // src/enums.ts should shrink this list, never grow it.
    const undocumented = Object.values(OrderStatus).filter(
      (s) => !DOCUMENTED_STATUSES.has(s),
    );
    expect(undocumented).toEqual([]);
    // The gap runs the other way too, and is asserted as a SUBSET rather than
    // an equality on purpose: reconciling src/enums.ts should be free to shrink
    // it to nothing without failing this file.
    const notExported = [...DOCUMENTED_STATUSES.keys()]
      .filter((s) => !Object.values(OrderStatus).includes(s as OrderStatus))
      .sort();
    expect(
      notExported.filter((s) => !["Dead", "Remove Pending"].includes(s)),
    ).toEqual([]);
  });

  it("names every documented status, with the right terminal flag, in every status description", () => {
    // With the enum gone, the description IS the contract the agent reads. A
    // status the broker can return and the description never mentions is the
    // same defect one indirection later.
    const problems: string[] = [];
    for (const [tool, meta] of Object.entries(TOOL_METADATA))
      eachProperty(meta.outputSchema, tool, (name, sub, at) => {
        if (name !== "status" || NON_ORDER_STATUS[at]) return;
        const described = describedStatuses(String(sub.description ?? ""));
        if (!described) {
          problems.push(
            `${at}: description lists no terminal/non-terminal set`,
          );
          return;
        }
        const expectedTerminal = [...DOCUMENTED_STATUSES.entries()]
          .filter(([, terminal]) => terminal)
          .map(([s]) => s)
          .sort();
        const expectedNonTerminal = [...DOCUMENTED_STATUSES.entries()]
          .filter(([, terminal]) => !terminal)
          .map(([s]) => s)
          .sort();
        if (
          JSON.stringify([...described.terminal].sort()) !==
          JSON.stringify(expectedTerminal)
        )
          problems.push(
            `${at}: terminal list is ${JSON.stringify([...described.terminal].sort())}`,
          );
        if (
          JSON.stringify([...described.nonTerminal].sort()) !==
          JSON.stringify(expectedNonTerminal)
        )
          problems.push(
            `${at}: non-terminal list is ${JSON.stringify([...described.nonTerminal].sort())}`,
          );
      });
    expect(problems).toEqual([]);
    // Non-vacuity: there really are order-status properties being checked.
    const checked: string[] = [];
    for (const [tool, meta] of Object.entries(TOOL_METADATA))
      eachProperty(meta.outputSchema, tool, (name, _sub, at) => {
        if (name === "status" && !NON_ORDER_STATUS[at]) checked.push(at);
      });
    expect(checked.length).toBeGreaterThan(10);
  });

  it("keeps the non-order-status list minimal — no dead entries", () => {
    const live: string[] = [];
    for (const [tool, meta] of Object.entries(TOOL_METADATA))
      eachProperty(meta.outputSchema, tool, (name, _sub, at) => {
        if (name === "status") live.push(at);
      });
    expect(
      Object.keys(NON_ORDER_STATUS)
        .filter((at) => !live.includes(at))
        .sort(),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6c. Every surviving enum is a superset of the evidence
// ---------------------------------------------------------------------------

/**
 * Values the vendored spec names for a field: every backticked token in the
 * description column of a `| \`field\` | … |` row, mapped to where it was read.
 * Deliberately greedy — a heuristic that guessed which backticked tokens are
 * "really" values would silently swallow a real one, so the noise is named
 * explicitly in SPEC_ENUM_NOISE below instead.
 */
function specEnumValues(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const file of readdirSync(SPEC_DIR).filter((f) => f.endsWith(".md"))) {
    const lines = readFileSync(path.join(SPEC_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/^\|\s*`([^`]+)`\s*\|(.*)$/);
      if (!m) return;
      const description = m[2].split("|").slice(1).join("|");
      for (const value of description.matchAll(/`([^`]+)`/g)) {
        const field = out.get(m[1].trim()) ?? new Map<string, string>();
        if (!field.has(value[1])) field.set(value[1], `${file}:${i + 1}`);
        out.set(m[1].trim(), field);
      }
    });
  }
  return out;
}

/** Every string (and null) the recorded corpus shows for each field name. */
function corpusValues(): Map<string, Set<unknown>> {
  const out = new Map<string, Set<unknown>>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" || value === null) {
        const seen = out.get(key) ?? new Set<unknown>();
        seen.add(value);
        out.set(key, seen);
      } else visit(value);
    }
  };
  for (const name of RECORDED) visit(loadFixture(name));
  return out;
}

const SPEC_ENUM_VALUES = specEnumValues();
const CORPUS_VALUES = corpusValues();

/**
 * `field:value` pairs the evidence associates with a field name that are NOT
 * values of the enum's field. Two kinds, both real:
 *
 *   - a cross-reference: the spec row backticks a SIBLING FIELD name inside its
 *     prose ("Required when `price` is specified");
 *   - a name collision: a different response model uses the same field name for
 *     a different domain. The name-level check cannot tell them apart, exactly
 *     as SPEC_IS_WRONG's `value` entry cannot.
 */
const SPEC_ENUM_NOISE: Record<string, string> = {
  "action:route":
    "orders.md:365 is the order-CONDITION action (route/cancel the order when triggered), not an order-leg action",
  "action:cancel": "orders.md:365, same condition-action row",
  "action:Allocate":
    "transactions.md:44 is a TRANSACTION action filter; no order leg can carry it",
  "price-effect:price":
    "cross-reference to the sibling `price` field — orders.md:315 reads '`Credit` or `Debit`. Required when `price` is specified.'",
  "value-effect:value": "the same cross-reference at orders.md:318",
  "ratio-price-comparator:PAIRS":
    "orders.md:391 names the strategy the field applies to ('For `PAIRS` trades: `gte` or `lte`'), not a comparator",
  "settlement-type:Physical":
    "instruments.md:632 is a CONTRACT's delivery mode; the enum here is market-metrics.md's AM/PM expiry timing on an option-expiration row",
  "settlement-type:Cash": "instruments.md:632, the same delivery-mode row",
  "settlement-type:Future":
    "the recorded futures-option chain carries settlement-type 'Future' — again the delivery mode, on a different model from the AM/PM expiry timing",
};

describe("every surviving enum covers the values the evidence shows", () => {
  /** One member set per field name — the previous section pins that it is one. */
  const domains = new Map<string, Set<unknown>>();
  for (const site of ENUM_SITES) {
    const seen = domains.get(site.field) ?? new Set<unknown>();
    for (const v of site.values) seen.add(v);
    domains.set(site.field, seen);
  }

  it("parses value lists out of the vendored spec", () => {
    // If the markdown is reformatted the parse empties and this section stops
    // asserting anything. Pin a few known rows.
    expect(SPEC_ENUM_VALUES.size).toBeGreaterThan(40);
    expect(
      [...(SPEC_ENUM_VALUES.get("option-type")?.keys() ?? [])].sort(),
    ).toEqual(["C", "P"]);
    expect(
      [...(SPEC_ENUM_VALUES.get("time-of-day")?.keys() ?? [])].sort(),
    ).toEqual(["BOD", "EOD"]);
  });

  it("covers every value the vendored spec names for that field", () => {
    const gaps: string[] = [];
    for (const [field, members] of domains) {
      for (const [value, where] of SPEC_ENUM_VALUES.get(field) ?? []) {
        if (members.has(value)) continue;
        if (SPEC_ENUM_NOISE[`${field}:${value}`]) continue;
        gaps.push(`${field}: spec names ${JSON.stringify(value)} (${where})`);
      }
    }
    expect(gaps.sort()).toEqual([]);
  });

  it("covers every value the recorded corpus shows for that field", () => {
    const gaps: string[] = [];
    for (const [field, members] of domains) {
      for (const value of CORPUS_VALUES.get(field) ?? []) {
        if (members.has(value)) continue;
        if (SPEC_ENUM_NOISE[`${field}:${String(value)}`]) continue;
        gaps.push(`${field}: corpus shows ${JSON.stringify(value)}`);
      }
    }
    expect(gaps.sort()).toEqual([]);
  });

  it("keeps the noise list minimal — every entry is still both real and excluded", () => {
    const dead: string[] = [];
    for (const key of Object.keys(SPEC_ENUM_NOISE)) {
      const at = key.indexOf(":");
      const field = key.slice(0, at);
      const value = key.slice(at + 1);
      const members = domains.get(field);
      if (!members) {
        dead.push(`${key}: no enum on that field any more`);
        continue;
      }
      if (members.has(value)) dead.push(`${key}: now a member of the enum`);
      const evidenced =
        SPEC_ENUM_VALUES.get(field)?.has(value) === true ||
        CORPUS_VALUES.get(field)?.has(value) === true;
      if (!evidenced) dead.push(`${key}: the evidence no longer names it`);
    }
    expect(dead.sort()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6e. `format` is the other keyword that rejects a successful response
// ---------------------------------------------------------------------------

/**
 * The enum sweep's nearest twin. The SDK's validator is built with
 * `validateFormats: true` and `ajv-formats` registered
 * (node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js),
 * so every `format` in an outputSchema is enforced against a live payload
 * exactly as an enum is: `format: "date"` on a field the API returns as a full
 * timestamp is a -32602 on a successful call, and vice versa.
 *
 * Two checks, both cheap. First, the vocabulary is closed to the three formats
 * actually in use — `email`, `hostname`, `regex`, `ipv4` and friends are all
 * strict enough to reject real broker data, and none of them belongs on a
 * financial payload. Second, where a recorded payload exists for a field name,
 * the declared format must accept what was actually recorded.
 */
const ALLOWED_FORMATS: Record<string, string> = {
  date: "YYYY-MM-DD calendar dates: expirations, settlement and snapshot dates",
  "date-time": "RFC 3339 timestamps, the API's `…-at` convention",
  uri: "the two streamer endpoints handed out by the quote-token tools",
};

/**
 * Paths where the field NAME collides across models and the corpus therefore
 * carries the other model's shape. market-metrics.md:193 types its
 * `expiration-date` `datetime` and its own example is
 * `"2026-04-17T00:00:00.000+00:00"`; the option-chain tools' `expiration-date`
 * is a bare calendar date. Both declarations are right for their own endpoint.
 */
const FORMAT_NAME_COLLISIONS: Record<string, string> = {
  "tastytrade_get_market_metrics.items[].option-expiration-implied-volatilities[].expiration-date":
    "market-metrics types this one `datetime` (spec :193, example :50); the date-only corpus values come from the option-chain models",
};

describe("`format` is no narrower than the payloads on record", () => {
  interface FormatSite {
    at: string;
    field: string;
    format: string;
  }
  const sites: FormatSite[] = [];
  for (const [tool, meta] of Object.entries(TOOL_METADATA))
    eachProperty(meta.outputSchema, tool, (name, sub, at) => {
      if (typeof sub.format === "string")
        sites.push({ at, field: name, format: sub.format });
    });

  it("uses only formats loose enough for broker data", () => {
    expect(sites.length).toBeGreaterThan(100);
    const unexpected = [
      ...new Set(sites.map((s) => s.format).filter((f) => !ALLOWED_FORMATS[f])),
    ].sort();
    expect(unexpected).toEqual([]);
  });

  it("declares no date format that the recorded corpus contradicts", () => {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    const problems: string[] = [];
    for (const site of sites) {
      if (FORMAT_NAME_COLLISIONS[site.at]) continue;
      for (const value of CORPUS_VALUES.get(site.field) ?? []) {
        if (typeof value !== "string" || value.length === 0) continue;
        if (site.format === "date" && !DATE_ONLY.test(value))
          problems.push(`${site.at}: format date, corpus has ${value}`);
        if (site.format === "date-time" && DATE_ONLY.test(value))
          problems.push(`${site.at}: format date-time, corpus has ${value}`);
      }
    }
    expect([...new Set(problems)].sort()).toEqual([]);
  });

  it("keeps the collision list minimal — no dead entries", () => {
    const live = new Set(sites.map((s) => s.at));
    expect(
      Object.keys(FORMAT_NAME_COLLISIONS)
        .filter((at) => !live.has(at))
        .sort(),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6d. The reproduction: a real Client/Server pair, validator armed
// ---------------------------------------------------------------------------

const CANCEL_ARGS = { account_number: ACCT, order_id: "1075264" };

describe("a validating client keeps the successful response", () => {
  it.each([...DOCUMENTED_STATUSES.keys()])(
    "cancel_order survives a DELETE answered %s",
    async (status) => {
      // The CRITICAL, end to end. order-management.md:321: "For successful
      // cancel requests, the order status will be Cancel Requested in the
      // response." With that value outside the advertised enum, the client threw
      // -32602 on a cancel that SUCCEEDED — carrying no code and no retryable,
      // so nothing downstream could tell it from a real failure.
      const harness = await armedClient({
        id: 1075264,
        "account-number": ACCT,
        status,
        cancellable: false,
      });
      const res = await harness.client.callTool({
        name: "tastytrade_cancel_order",
        arguments: CANCEL_ARGS,
      });
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as { status: string }).status).toBe(status);
    },
  );

  it.each(["Cancel Requested", "Replace Requested", "Partially Removed"])(
    "get_live_orders survives a row that is mid-%s",
    async (status) => {
      // The reconciliation read the in-doubt-write path instructs an agent to
      // perform. One mid-flight row would fail the whole list.
      const harness = await armedClient({
        items: [
          { id: 1, status: "Live" },
          { id: 2, status },
        ],
      });
      const res = await harness.client.callTool({
        name: "tastytrade_get_live_orders",
        arguments: { account_number: ACCT },
      });
      expect(res.isError).toBeFalsy();
      expect(
        (res.structuredContent as { items: Array<{ status: string }> }).items,
      ).toHaveLength(2);
    },
  );

  it("get_order survives an order whose price-effect is null", async () => {
    // `price-effect` was ["Credit", "Debit"] on eight order tools and
    // ["Credit", "Debit", null] on the ninth, so whether a null survived was
    // decided by which tool you happened to read the order through. `price`
    // itself is omitted rather than nulled here: the Market-order examples in
    // order-management.md leave both fields out, which the schema already
    // tolerates because neither is required.
    const harness = await armedClient({
      id: 1075264,
      status: "Live",
      "order-type": "Market",
      "price-effect": null,
    });
    const res = await harness.client.callTool({
      name: "tastytrade_get_order",
      arguments: { account_number: ACCT, order_id: "1075264" },
    });
    expect(res.isError).toBeFalsy();
  });

  it("get_equity_option survives a definition whose exercise-style is null", async () => {
    // The same endpoint, GET /instruments/equity-options/{sym}, behind two
    // tools: the deprecated alias tolerated null and the canonical tool did not.
    const payload = {
      symbol: "AAPL  260619C00200000",
      "instrument-type": "Equity Option",
      "underlying-symbol": "AAPL",
      "option-type": "C",
      "strike-price": "200.0",
      "expiration-date": "2026-06-19",
      "exercise-style": null,
    };
    for (const tool of [
      "tastytrade_get_equity_option",
      "tastytrade_get_equity_definition",
    ]) {
      const harness = await armedClient(payload);
      const res = await harness.client.callTool({
        name: tool,
        arguments: { symbol: payload.symbol },
      });
      expect(res.isError).toBeFalsy();
      await harness.close();
      h = undefined;
    }
  });

  it.each(["Event Contract", "Warrant", "Index", "Fixed Income Security"])(
    "get_positions survives a position in a %s",
    async (instrumentType) => {
      // instrument-type is REQUIRED on a position row, so one unlisted holding
      // made the whole positions read unusable.
      const harness = await armedClient({
        items: [
          {
            "account-number": ACCT,
            symbol: "XYZ",
            "instrument-type": instrumentType,
            quantity: 1,
            "quantity-direction": "Long",
          },
        ],
      });
      const res = await harness.client.callTool({
        name: "tastytrade_get_positions",
        arguments: { account_number: ACCT },
      });
      expect(res.isError).toBeFalsy();
    },
  );
});

describe("the money path keeps a live order's confirmation", () => {
  /**
   * dry_run_order -> token -> place_order against a fake transport, with the
   * output validator armed. The effects are `"None"`: a flat or closing order
   * whose buying power does not move, and an order with no fees. Both are real
   * — the recorded sandbox capture
   * test/e2e/_payloads/tastytrade_dry_run_complex_order.json contains
   * `"commission-effect": "None"` and seven `"effect": "None"` — and both used
   * to be rejected by the client AFTER the live POST had already been sent.
   *
   * The trace assertion is what makes this a money-path test rather than a
   * schema test: the POST is counted, so a passing run proves the order was
   * submitted and the confirmation still reached the caller.
   */
  const ORDER_ARGS = {
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

  const zeroEffect = {
    order: {
      "account-number": ACCT,
      status: "Received",
      "order-type": "Limit",
      price: "1.02",
      "price-effect": "Debit",
      legs: [
        {
          action: "Buy to Open",
          "instrument-type": "Equity",
          quantity: 1,
          symbol: "AAPL",
        },
      ],
    },
    "buying-power-effect": {
      "change-in-buying-power": "0.0",
      "change-in-buying-power-effect": "None",
      effect: "None",
    },
    "fee-calculation": { "total-fees": "0.0", "total-fees-effect": "None" },
    warnings: [],
    errors: [],
  };

  it("places the order and returns it, with both effects None", async () => {
    const placed = {
      ...zeroEffect,
      order: { ...zeroEffect.order, id: 1075999, status: "Routed" },
    };
    const harness = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/position-limit`,
          method: "GET",
          reply: {
            data: {
              "account-number": ACCT,
              "equity-order-size": 100,
              "equity-position-size": 100,
            },
          },
        },
        {
          matcher: `/accounts/${ACCT}/trading-status`,
          method: "GET",
          reply: {
            data: {
              "account-number": ACCT,
              "is-frozen": false,
              "is-closing-only": false,
              "is-in-margin-call": false,
            },
          },
        },
        {
          matcher: `/accounts/${ACCT}/orders/dry-run`,
          method: "POST",
          reply: { data: zeroEffect },
        },
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: { data: placed },
        },
      ],
    });
    h = harness;
    // Arm the validator, exactly as a real client's first round trip does.
    expect((await harness.client.listTools()).tools.length).toBeGreaterThan(0);

    const dry = (await callOk(
      harness,
      "tastytrade_dry_run_order",
      ORDER_ARGS,
    )) as {
      confirmation_token: string;
    };
    expect(typeof dry.confirmation_token).toBe("string");

    const result = (await callOk(harness, "tastytrade_place_order", {
      ...ORDER_ARGS,
      confirmation_token: dry.confirmation_token,
    })) as { upstream: { order: { id: number } } };

    // The live POST happened, and the confirmation came back anyway.
    expect(
      harness.requests.filter(
        (r) => r.method === "POST" && r.url === `/accounts/${ACCT}/orders`,
      ),
    ).toHaveLength(1);
    // The broker's payload is under `upstream`.
    expect(result.upstream.order.id).toBe(1075999);
  });
});

// ===========================================================================
// 8. An empty acknowledgement is a value, not an absent result
// ===========================================================================
//
// The fifth way a successful response gets rejected, and the only one that is not a
// keyword: declaring an outputSchema is itself the constraint. The reference client
// reads the spec as a MUST and throws `-32600 … did not return structured content`
// when it is absent. All 93 tools declare one.
//
// A dispatcher that skips a null payload therefore returns a spec-violating success
// for every tool whose payload comes back empty. Four are reachable on documented or
// code-sanctioned paths, all DELETEs: delete_quote_alert on the 204 that
// open-api-spec/quote-alerts.md documents, and cancel_order, cancel_complex_order
// and delete_watchlist on the empty body `assertReadableResponse` admits. On the two
// cancels that is the worst reading available: the order was cancelled, and the
// agent is told the protocol broke.
//
// Two existing tests drove delete_quote_alert with a 204 and both passed, for the
// reason this suite's header warns about: neither called listTools(), so the
// validator was never compiled. Both are armed now.

describe("a DELETE that succeeds with no body still satisfies the output contract", () => {
  /**
   * Boots a harness on explicit routes — not the blanket fallback the rest of
   * this file uses — because the SHAPE of the empty answer is the subject here,
   * and the fallback wraps everything as `{data: {}}`, which is exactly the
   * case that never reproduced the defect.
   */
  async function armedOn(routes: Route[]): Promise<Harness> {
    const harness = await createHarness({ routes });
    const listed = await harness.client.listTools();
    expect(listed.tools.every((t) => t.outputSchema !== undefined)).toBe(true);
    h = harness;
    return harness;
  }

  /** The four DELETE tools, their path, and the arguments that reach it. */
  const DELETES: ReadonlyArray<
    readonly [string, string, Record<string, unknown>]
  > = [
    [
      "tastytrade_delete_quote_alert",
      "/quote-alerts/12345",
      { alert_external_id: "12345" },
    ],
    [
      "tastytrade_cancel_order",
      `/accounts/${ACCT}/orders/1075264`,
      { account_number: ACCT, order_id: "1075264" },
    ],
    [
      "tastytrade_cancel_complex_order",
      `/accounts/${ACCT}/complex-orders/56544`,
      { account_number: ACCT, complex_order_id: "56544" },
    ],
    ["tastytrade_delete_watchlist", "/watchlists/Movers", { name: "Movers" }],
  ];

  // The three shapes an empty acknowledgement actually arrives as: axios
  // renders a 204 as the empty STRING, a bodyless reply as undefined, and an
  // intermediary or the API itself can answer 200 with `{data: null}`.
  const EMPTY_BODIES: ReadonlyArray<readonly [string, unknown, number]> = [
    ["a 204 with axios's empty-string body", "", 204],
    ["a 204 with no body at all", undefined, 204],
    ["a 200 carrying {data: null}", { data: null }, 200],
  ];

  for (const [bodyLabel, data, status] of EMPTY_BODIES) {
    it.each(DELETES)(
      `%s succeeds on ${bodyLabel}`,
      async (tool, path, args) => {
        const harness = await armedOn([
          {
            matcher: path,
            method: "DELETE",
            reply: { status, data, raw: true },
          },
        ]);

        // The client throws McpError here if structuredContent is missing or
        // does not validate, so reaching the assertions IS the contract.
        const res = (await harness.client.callTool({
          name: tool,
          arguments: args,
        })) as { isError?: boolean; structuredContent?: unknown };

        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toEqual({});
        // And it really did go out — a tool that quietly did nothing would
        // satisfy the contract too.
        expect(harness.lastRequest()?.method).toBe("DELETE");
        expect(harness.lastRequest()?.url).toBe(path);
      },
    );
  }

  it("still carries the entity when the broker sends one", async () => {
    // The complement. The empty-acknowledgement branch must not be swallowing
    // a real payload: a cancel that answers with the Order returns the Order.
    const harness = await armedOn([
      {
        matcher: `/accounts/${ACCT}/orders/1075264`,
        method: "DELETE",
        reply: { data: { id: 1075264, status: "Cancel Requested" } },
      },
    ]);

    const res = (await harness.client.callTool({
      name: "tastytrade_cancel_order",
      arguments: { account_number: ACCT, order_id: "1075264" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      id: 1075264,
      status: "Cancel Requested",
    });
  });
});

// ===========================================================================
// 7. `required` — the keyword the enum sweep did not walk
// ===========================================================================

/**
 * Why `required` belongs in the same argument as `enum`.
 *
 * It is the same constraint written with a different keyword, and it carries the
 * same blind spot: the money-moving tools have the narrow declarations because they
 * are the ones no fixture can be recorded for. The ONE dry-run tool with a recorded
 * sandbox fixture carries `required: []`; the three with no fixture required
 * `order`.
 *
 * The consequence is not symmetric with the enum one. A dry-run's 200 can carry a
 * populated `errors[]` and nothing else — the shape `isCleanDryRun` exists to
 * recognise, and the tool description tells the agent to "treat any non-empty
 * errors[] as 'do not proceed'". With `order` required, the client throws -32602 on
 * exactly that payload, so the one signal the agent was told to read is the one it
 * can never receive. Fail-safe and undiagnosable.
 *
 * THE RULE. A `required` entry is a promise about data the BROKER authors, made
 * from a document. It is safe only where something proves the field is always there:
 * a recorded fixture, the vendored spec marking it Required, or this server
 * constructing the field itself. Nothing proves any of the broker's own fields on
 * the money path, so the dry-runs promise nothing.
 *
 * WHAT THE RULE DOES NOT YET COVER. The destructive half still breaks it in six
 * places: `place_order` promises `order`; three tools promise `id` and `status`; two
 * promise `id`, `account-number`, `type` and `orders`. Every one is a
 * broker-authored field on a call that has already moved money by the time the
 * client judges it.
 *
 * They stay for now, because relaxing them WITHOUT the prerequisite is a regression
 * rather than a fix — see the tracked-exception block below, which names it and pins
 * the six. The distinction between the dry-runs and these is not read versus write:
 * a dry-run rejected for missing a field has cost nothing, and a placement accepted
 * despite missing one has already routed an order.
 */

describe("the dry-run schemas require only what this server appends", () => {
  /**
   * Named for the five tools it walks, and not for the money path.
   *
   * The first version of this block was called "`required` on the money path
   * names only what this server appends", which is a claim about eleven tools
   * and an assertion about five. The destructive half of the same path — the
   * cancels, the edits, the replace — promises broker-authored fields in six
   * places, and a reader who took the heading at face value would have
   * concluded the rule was enforced there too. Those six are enumerated in the
   * block below this one, with what each costs and what has to land before any
   * of them can be relaxed. A heading that overstates its coverage is the same
   * defect this whole section is about, one level up.
   */
  const DRY_RUN_TOOLS = [
    "tastytrade_dry_run_order",
    "tastytrade_dry_run_replace_order",
    "tastytrade_dry_run_edit_order",
    "tastytrade_dry_run_complex_order",
    "tastytrade_dry_run_edit_complex_order",
  ] as const;

  it.each(DRY_RUN_TOOLS)("%s requires only server-authored fields", (tool) => {
    // Nothing tastytrade authors is required here, and `upstreamRequired` below is
    // empty for all five. The root of these results is not the broker's namespace at
    // all: it is a wrapper this server builds, closed with
    // `additionalProperties: false`, and every field on it is written by this server on
    // every return path — so requiring them asserts a server-side invariant with no
    // broker in it, and it is worth asserting, because `sanity_warnings` being unwritten
    // on this route is exactly what lets an upstream supply it.
    expect(rootRequired(tool).sort()).toEqual(
      ["checks_not_run", "confirmation_token", "sanity_warnings"].filter((f) =>
        rootRequired(tool).includes(f),
      ),
    );
    for (const field of rootRequired(tool)) {
      expect([
        "checks_not_run",
        "confirmation_token",
        "sanity_warnings",
      ]).toContain(field);
    }
    // And the broker level promises nothing, which is the half that was always
    // the point.
    expect(upstreamRequired(tool)).toEqual([]);
  });
});

describe("every destructive schema that promises a broker field is a tracked exception", () => {
  /**
   * The residual, written down instead of described.
   *
   * A `required` entry naming a field tastytrade authors is a bet that the broker
   * always sends it, settled on the client, AFTER the money has moved. When it loses,
   * the SDK rejects the whole successful response with -32602 and the agent believes
   * a write failed that actually landed. On `tastytrade_edit_order` that is the worst
   * version: the PATCH is applied, the token is already spent, and the natural retry
   * comes back `dry_run_required`.
   *
   * Keeping them would trade a loud protocol error for a SILENT empty success unless
   * something refuses an unreadable entity on a state-changing 2xx. That prerequisite
   * exists: `writtenEntity` in src/api-client.ts refuses a 2xx whose `data` is null,
   * `{}`, an array or a scalar on all five order writes. That is why the two CANCELs
   * are not on this list — a cancel is the one write whose success can legitimately
   * carry no body.
   *
   * These four stay for a narrower reason: their `required` fields are ones the broker
   * sends on a body it does send, so relaxing them buys nothing an agent needs while
   * removing a constraint that has never fired wrongly. `orders` is the weakest — a
   * terminal complex order can legitimately answer `[]`, satisfying `required` while
   * guaranteeing nothing. If any of the four ever rejects a real success, drop it.
   *
   * An inventory, not an endorsement, derived from the annotation registry rather than
   * typed out, so a NEW destructive tool that promises a broker field cannot join
   * silently.
   */
  const TRACKED: Readonly<Record<string, readonly string[]>> = {
    // The one with a written refusal already: relaxing a placement's `order` is the
    // most expensive of the four to get wrong. `upstream_notes` and `checks_not_run`
    // join `sanity_warnings` as fields this server appends unconditionally, so they are
    // `required` here for the same reason and on the same two tools — an empty warning
    // list on a route that ran a subset of the checks is indistinguishable from a fully
    // checked pass, so the disclosure has to be present to be readable. Only the BROKER
    // field remains here; the three server-appended names moved to the root's
    // `required`, where they are not a bet on anything tastytrade sends.
    tastytrade_place_order: ["order"],
    // Cancel-replace: the round-one narrative, still live. The broker answers
    // with the updated Order; `status` in particular is the field a 200 can
    // omit while the PATCH or PUT has already landed.
    //
    // The two CANCELs would be here too and are not offenders any more: a
    // cancel is the one write whose success can legitimately carry no body at
    // all, and the empty-acknowledgement work removed `required` from both
    // schemas rather than tracking it as an accepted risk. Anything that puts
    // it back fails the check above rather than landing silently here.
    tastytrade_edit_order: ["id", "status"],
    tastytrade_replace_order: ["id", "status"],
    // `orders` is an array a terminal complex order can legitimately answer
    // with empty — and `[]` satisfies `required` while guaranteeing nothing
    // else about the schema.
    tastytrade_edit_complex_order: ["id", "account-number", "type", "orders"],
  };

  /** Fields this server appends itself, whatever the broker sends. */
  // `upstream_notes` is the second half of the
  // provenance split — broker-authored text relayed under an upstream name, so
  // `sanity_warnings` can be the server's own verdict and nothing else. This
  // server appends it on every one of the five destructive routes whether the
  // broker sent notes or not, which is exactly what qualifies a field here.
  const SERVER_APPENDED = new Set([
    "sanity_warnings",
    "upstream_notes",
    // Derived from what the route ran, authored here, and
    // emitted on every one of the five destructive submit routes.
    "checks_not_run",
    "confirmation_token",
  ]);

  /** Every destructive tool, straight off the annotation registry. */
  const destructiveTools = Object.keys(TOOL_METADATA).filter(
    (name) =>
      TOOL_ANNOTATIONS[name] !== undefined &&
      accessClassFor(TOOL_ANNOTATIONS[name]) === "destructive",
  );

  it("finds no destructive tool promising a broker field that is not tracked", () => {
    // A broker promise is now declared on the `upstream`
    // level, so the inventory reads BOTH — the root, where a broker field must
    // never appear at all any more, and the nested level, where the tracked
    // four still make the same bet they always did.
    const offenders = destructiveTools.filter(
      (name) =>
        rootRequired(name).some((field) => !SERVER_APPENDED.has(field)) ||
        upstreamRequired(name).length > 0,
    );
    expect(offenders.sort()).toEqual(Object.keys(TRACKED).sort());
  });

  it("keeps no broker-authored name in any destructive result's ROOT required", () => {
    // Added for , and the property that made the relocation worth
    // doing: the root of a destructive result promises only what this server
    // authors, so a client validating it is never judging the broker's shape at
    // the level where a broker key could pass for a server verdict.
    for (const name of destructiveTools) {
      for (const field of rootRequired(name)) {
        expect(SERVER_APPENDED.has(field)).toBe(true);
      }
    }
  });

  it.each(Object.entries(TRACKED))(
    "%s still promises exactly the fields it is tracked for",
    (tool, expected) => {
      // Read at `upstream`, where the broker's data is.
      // Pinned exactly, in both directions. Growing the list widens a known
      // rejection surface on the money path; shrinking it is the fix, and the
      // fix must arrive with the api-client entity check and an update here,
      // not on its own.
      expect(upstreamRequired(tool)).toEqual([...expected]);
    },
  );

  it("is not vacuous: some destructive tool promises only what we append", () => {
    // `tastytrade_place_complex_order` requires `sanity_warnings`,
    // `upstream_notes` and `checks_not_run` and nothing else, which is what the
    // rule looks like when it is satisfied on a destructive tool — and is why the four above read as
    // exceptions rather than as the norm.
    const compliant = destructiveTools.filter(
      (name) =>
        rootRequired(name).length > 0 &&
        rootRequired(name).every((field) => SERVER_APPENDED.has(field)),
    );
    expect(compliant).toContain("tastytrade_place_complex_order");
  });

  it("still requires `order` on place_order, and that is not an oversight", () => {
    // At `upstream`, unchanged in substance. A dry-run that returns no `order` costs
    // nothing — no token is minted, no money moves — so turning its -32602 into a
    // readable payload is pure gain. A PLACEMENT that returns no `order` has already
    // routed it, so dropping the constraint there converts a loud protocol error into a
    // silent empty success on the one call that moves money. The safe order is the
    // other way round: have the write methods refuse an unreadable entity on a
    // state-changing 2xx first, and only then loosen this.
    expect(upstreamRequired("tastytrade_place_order")).toContain("order");
  });
});

describe("a dry-run that says 'do not proceed' reaches the agent", () => {
  /**
   * The reproduction, through the SDK's own validator. The payload is a 200
   * whose only content is the blocking `errors[]` — no `order`, no
   * `buying-power-effect` — which is what the broker sends when it rejects the
   * shape of an order rather than the order itself.
   */
  const BLOCKED = {
    errors: [
      {
        code: "cant_buy_for_credit",
        message: "You cannot buy for a credit",
      },
    ],
    warnings: [],
  };

  it.each(DRY_RUNS)(
    "%s hands back the blocking errors instead of a -32602",
    async (tool, args) => {
      const harness = await armedClient(BLOCKED);

      // Resolving is half the assertion: a schema mismatch arrives as a
      // rejected promise from callTool, not as a value to inspect.
      const res = await harness.client.callTool({
        name: tool,
        arguments: args,
      });

      expect(res.isError).toBeFalsy();
      const out = res.structuredContent as {
        upstream?: { errors?: Array<{ code?: string }> };
        confirmation_token?: string | null;
      };
      // The signal the description tells the agent to read.
      // The broker's payload is under `upstream`.
      expect(out.upstream?.errors?.[0]?.code).toBe("cant_buy_for_credit");
      // And no token, because the dry-run was not clean.
      expect(out.confirmation_token).toBeNull();
    },
  );
});

describe("a dry-run that says nothing at all mints nothing at all", () => {
  /**
   * The other half of relaxing `required`, and why the relaxation alone is not the
   * whole fix.
   *
   * Dropping `required: ["order"]` lets the blocking `errors[]` through — but it lets
   * something else through with it. A 200 carrying no `order`, no `complex-order`, no
   * `buying-power-effect` and no `errors` — an empty body, a proxy's `{}`, an envelope
   * a gateway rewrote — mints a confirmation token, because `isCleanDryRun` asks only
   * "is this readable and free of errors?" and an empty object is both. With the
   * client discarding the response as -32602 the agent never saw the token;
   * afterwards it can read it, and follow it to a LIVE placement whose only sanity
   * report is "MAX_ORDER_NOTIONAL_USD could not be applied".
   *
   * So the constraint belongs at issuance rather than at the client: refusing on a
   * schema written from a document is accidental protection that also suppresses the
   * errors[] refusal, while refusing at issuance is deliberate, applies to every
   * client whether it validates or not, and costs an agent one repeated dry-run.
   *
   * The payloads below are the ones the broker never sends and an intermediary does.
   */
  const CONTENTLESS: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["an empty object", {}],
    ["warnings and nothing else", { warnings: [] }],
    ["an order key with nothing in it", { order: {} }],
    ["an errors key that is empty", { errors: [], warnings: [] }],
  ];

  const MATRIX = DRY_RUNS.flatMap(([tool, args]) =>
    CONTENTLESS.map(([label, payload]) => ({ tool, args, label, payload })),
  );

  it.each(MATRIX)(
    "$tool refuses to mint a token from $label",
    async ({ tool, args, payload }) => {
      const harness = await armedClient(payload);

      const res = await harness.client.callTool({
        name: tool,
        arguments: args,
      });

      // Still resolves — that part of the `required` relaxation stands. The
      // agent gets to SEE that the dry-run said nothing, which is the whole
      // point of not throwing -32602 at it.
      expect(res.isError).toBeFalsy();
      const out = res.structuredContent as {
        confirmation_token?: string | null;
      };
      expect(out.confirmation_token).toBeNull();
    },
  );

  it("still mints from a dry-run that carries only the buying-power effect", async () => {
    // The over-correction guard, and the reason the gate asks for evidence
    // rather than for `order` specifically. A complex-order dry-run answers
    // with `complex-order`, not `order` — the recorded capture in
    // test/e2e/_payloads proves it — and the vendored spec's
    // PlacedOrderResponse lists `order`, `complex-order` and
    // `buying-power-effect` as alternatives, not as a set. Demanding any one
    // named field would have made a whole order class untradeable, which is a
    // worse failure than the one being fixed.
    const harness = await armedClient({
      "buying-power-effect": { "change-in-buying-power": "102.0" },
    });

    const res = await harness.client.callTool({
      name: "tastytrade_dry_run_order",
      arguments: DRY_RUNS[0][1],
    });

    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { confirmation_token?: string | null };
    expect(typeof out.confirmation_token).toBe("string");
  });
});

describe("`additionalProperties: false` is set only on a wrapper we build", () => {
  /**
   * The sixth rejecting keyword, and the one that has stayed safe by accident
   * rather than by rule. Closing a root against unknown properties is a
   * promise that no field can ever appear that we did not declare — fine for an
   * object this server constructs, and a rejection surface on anything the
   * broker authors, since tastytrade adds fields without warning (that is the
   * whole argument in section 6 for opening the enums).
   */
  const SERVER_BUILT_WRAPPERS: Record<string, string> = {
    tastytrade_get_risk_free_rate:
      "The dispatcher builds {'risk-free-rate': n} at the MCP layer from a scalar it extracted; the object does not exist in the API. Its own schema description says so.",
    // The ten gated order routes now return a wrapper
    // this server builds — `{ upstream, confirmation_token, sanity_warnings,
    // … }` — and closing it is the POINT rather than an accident: the broker's
    // payload lives one level down under `upstream`, whose own
    // `additionalProperties` stays open exactly as the rule requires, so
    // tastytrade can still add fields without warning. What is closed is the
    // level where a broker key would be read as a server verdict.
    ...Object.fromEntries(
      [
        "tastytrade_dry_run_order",
        "tastytrade_dry_run_replace_order",
        "tastytrade_dry_run_edit_order",
        "tastytrade_dry_run_complex_order",
        "tastytrade_dry_run_edit_complex_order",
        "tastytrade_place_order",
        "tastytrade_replace_order",
        "tastytrade_edit_order",
        "tastytrade_place_complex_order",
        "tastytrade_edit_complex_order",
      ].map((tool) => [
        tool,
        "A gated order route: the server-owned wrapper is closed, the broker's payload under `upstream` is not.",
      ]),
    ),
  };

  it("closes only `{items: …}` wrappers, or a justified exception", () => {
    const closed = Object.keys(TOOL_METADATA).filter(
      (tool) =>
        (TOOL_METADATA[tool].outputSchema as Record<string, unknown>)
          .additionalProperties === false,
    );
    // Every list tool returns a bare array that the dispatcher wraps under
    // `items` before it can be valid structured output, so that root really is
    // ours and closing it is safe.
    const notItemsWrapper = closed
      .filter((tool) => {
        const props = Object.keys(
          (TOOL_METADATA[tool].outputSchema as { properties?: object })
            .properties ?? {},
        );
        return props.length !== 1 || props[0] !== "items";
      })
      .sort();
    expect(notItemsWrapper).toEqual(Object.keys(SERVER_BUILT_WRAPPERS).sort());
    // Not a vacuous rule: most of the registry is closed this way.
    expect(closed.length).toBeGreaterThan(30);
  });

  it("leaves the broker's own level open on every gated order route", () => {
    // Updated for , and the other half of the rule above: nesting the
    // broker payload would be a NEW rejection surface if the nested level were
    // closed too. It is not. tastytrade adds fields without warning, and under
    // `upstream` that stays harmless.
    const gated = Object.keys(TOOL_METADATA).filter((tool) =>
      Object.prototype.hasOwnProperty.call(
        (TOOL_METADATA[tool].outputSchema as { properties?: object })
          .properties ?? {},
        "upstream",
      ),
    );
    expect(gated).toHaveLength(10);
    for (const tool of gated) {
      const upstream = (
        TOOL_METADATA[tool].outputSchema as {
          properties: Record<string, { additionalProperties?: boolean }>;
        }
      ).properties.upstream;
      expect(upstream.additionalProperties).toBe(true);
    }
  });
});
