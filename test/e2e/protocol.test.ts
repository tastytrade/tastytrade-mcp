import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createHarness, callOk } from "./harness.js";
import type { Harness } from "./harness.js";
import {
  MCP_ERROR_INTERNAL,
  MCP_ERROR_INVALID_PARAMS,
  MCP_ERROR_RESOURCE_NOT_FOUND,
  TOOL_ANNOTATIONS,
} from "../../src/mcp-server/index.js";
import { bucketFor } from "../../src/mcp-server/annotations.js";
import { PACKAGE_VERSION } from "../../src/version.js";

import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

// Per-endpoint ceilings are per-SECOND, so two calls to the same endpoint in
// one millisecond now collide. Reset between cases: the subject of this suite
// is the protocol surface, not the rate policy.
beforeEach(() => {
  _resetRateLimitsForTest();
});

/**
 * The protocol surface a client sees the moment it connects: the handshake,
 * `tools/list`, the JSON-RPC error numbers, and the registry invariants that make the
 * tool surface loadable at all.
 *
 * Everything goes through the real MCP handlers over the in-memory transport — no
 * handler is called directly, because the point is to catch a break in what a CLIENT
 * observes. A tool missing from TOOL_ANNOTATIONS, or an inputSchema whose `required`
 * names a property that does not exist, is invisible to the type checker and fatal at
 * runtime.
 *
 * The expected counts (84 tools; 70 read / 12 destructive / 2 write) are asserted as
 * literals on purpose. They are the shipped contract, so adding or reclassifying a
 * tool should require touching this file deliberately — a self-derived count would
 * agree with any regression.
 *
 * The resources and prompts surfaces are NOT re-tested here: they run over this same
 * client and transport in their own suites, which assert strictly more.
 */

const READ_ONLY_ENV_VAR = "TASTYTRADE_READ_ONLY";

/** Total tools this server advertises. */
const EXPECTED_TOOL_COUNT = 84;
/** Rate-limit bucket split, by annotation. */
const EXPECTED_READ_TOOLS = 70;
const EXPECTED_DESTRUCTIVE_TOOLS = 12;
const EXPECTED_WRITE_TOOLS = 2;

/**
 * A destructive tool must name a mutation. The rate-limit bucket is chosen
 * purely from `destructiveHint`, so a read tool marked destructive (or the
 * reverse) silently lands in the wrong bucket — cheap to do, expensive to
 * notice. This pins the naming/annotation agreement in both directions.
 */
// `update`, `add` and `remove` join the list. The three
// watchlist mutators are destructive because of the verb they ISSUE — a
// full-replacement PUT — and this regex is about the verb they are NAMED with,
// so it had to learn the three names that now qualify. No read tool is named
// with any of them (asserted by the complement test below, which fails if one
// ever is).
const MUTATION_VERB =
  /^tastytrade_(place|cancel|edit|replace|delete|update|add|remove)_/;

const PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);

function manifestVersion(): string {
  const parsed = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") {
    throw new Error(`package.json at ${PACKAGE_JSON_PATH} has no version.`);
  }
  return parsed.version;
}

function inputSchemaOf(tool: Tool): {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
} {
  return tool.inputSchema as {
    type?: unknown;
    properties?: Record<string, unknown>;
    required?: unknown;
  };
}

/* -------------------------------------------------------------------------
 * Enum descriptions that contradict their own enum.
 *
 * A description is the only part of a schema an agent reasons with, and the one part
 * nothing validates. `place_order.order_type` shipped an enum containing "Marketable
 * Limit" under a description saying Marketable Limit was NOT in the enum — an
 * order-entry tool spending its description talking an agent out of a value it
 * accepts. Hand-edits are the symptom; these rules fail on the next one.
 *
 * Three rules, all derived from the property's own `enum`. LISTED: a description that
 * explicitly enumerates the allowed values must name exactly the enum, in neither
 * direction short. QUOTED: a 'single-quoted' value outside a parenthetical aside must
 * be a member. EXCLUDED: the description must not claim a value the enum CONTAINS is
 * unsupported or to be avoided.
 *
 * Parenthetical asides are stripped before LISTED and QUOTED: they carry glosses and
 * worked examples, which are about something other than the accepted set.
 * ---------------------------------------------------------------------- */

/** Phrases that introduce an explicit list of a property's accepted values. */
const VALUE_LIST_INTRO =
  /\b(?:one of|allowed values|valid values|accepted values)\b\s*:?\s*/i;

/** Drop parenthetical asides — glosses and examples, not the accepted set. */
function withoutAsides(text: string): string {
  return text.replace(/\([^)]*\)/g, " ");
}

function unquote(token: string): string {
  return token
    .trim()
    .replace(/^['"`]+/, "")
    .replace(/['"`]+$/, "")
    .replace(/[.,;:]+$/, "")
    .trim();
}

/**
 * The values a description explicitly enumerates, or null when it enumerates
 * none. The list runs from the introducing phrase to the end of that sentence.
 */
function enumeratedValues(description: string): string[] | null {
  const body = withoutAsides(description);
  const intro = VALUE_LIST_INTRO.exec(body);
  if (!intro) return null;
  let list = body.slice(intro.index + intro[0].length);
  const sentenceEnd = list.search(/\.(\s|$)/);
  if (sentenceEnd !== -1) list = list.slice(0, sentenceEnd);
  return list
    .split(/,|;|\bor\b|\band\b|\//)
    .map(unquote)
    .filter((token) => token.length > 0);
}

/**
 * Single-quoted tokens outside asides. The lookarounds keep an apostrophe
 * inside a word ("the order's price") from opening a quotation.
 */
function quotedValues(description: string): string[] {
  return [
    ...withoutAsides(description).matchAll(/(?<!\w)'([^']{1,40})'(?!\w)/g),
  ]
    .map((match) => match[1])
    .filter((token) => token.trim().length > 0);
}

/** "… <value> is not supported", "… <value> is deprecated" — value precedes. */
const EXCLUSION_AFTER_VALUE =
  /\s(?:is|are)\s+(?:currently\s+)?(?:not\b|un(?:supported|available|usable)\b|deprecated\b|excluded\b|rejected\b)/gi;
/** "avoid <value>", "do not submit <value>" — value follows. */
const EXCLUSION_BEFORE_VALUE =
  /\b(?:avoid|do not (?:use|submit|pass|send)|don't use|never use|never pass)\s+/gi;

/**
 * Does this token read as (part of) a value name? Quoted, or capitalised, or
 * numeric — the shapes the enums in this registry actually take. Deliberately
 * greedy about neighbours: "Notional Market is not usable" must resolve to the
 * whole phrase "Notional Market" and NOT to the enum member "Market", or the
 * rule would flag a sentence about a value the tool does not offer.
 */
function isValueToken(token: string): boolean {
  const bare = token.replace(/^[^\w'"`]+/, "").replace(/[^\w'"`]+$/, "");
  if (bare.length === 0) return false;
  if (/^['"`].*['"`]$/.test(bare)) return true;
  return /^[A-Z0-9]/.test(bare);
}

function valueRun(tokens: string[], reverse: boolean): string | null {
  const ordered = reverse ? [...tokens].reverse() : tokens;
  const run: string[] = [];
  for (const token of ordered) {
    if (!isValueToken(token)) break;
    run.push(token.replace(/[.,;:)]+$/, "").replace(/^[(]+/, ""));
  }
  if (run.length === 0) return null;
  return unquote((reverse ? run.reverse() : run).join(" "));
}

/** Enum members the description claims are unavailable. */
function excludedValues(description: string, enumValues: string[]): string[] {
  const named = new Set<string>();
  for (const match of description.matchAll(EXCLUSION_AFTER_VALUE)) {
    const before = description.slice(0, match.index).trim().split(/\s+/);
    const value = valueRun(before, true);
    if (value !== null) named.add(value);
  }
  for (const match of description.matchAll(EXCLUSION_BEFORE_VALUE)) {
    const after = description
      .slice(match.index + match[0].length)
      .trim()
      .split(/\s+/);
    const value = valueRun(after, false);
    if (value !== null) named.add(value);
  }
  return enumValues.filter((value) => named.has(value));
}

/** Every way this description disagrees with `enumValues`, in plain English. */
function enumDescriptionContradictions(
  enumValues: string[],
  description: string,
): string[] {
  const problems: string[] = [];
  const listed = enumeratedValues(description);
  if (listed) {
    const unknown = listed.filter((value) => !enumValues.includes(value));
    const unlisted = enumValues.filter((value) => !listed.includes(value));
    if (unknown.length > 0) {
      problems.push(`lists non-enum value(s) ${JSON.stringify(unknown)}`);
    }
    if (unlisted.length > 0) {
      problems.push(`omits enum value(s) ${JSON.stringify(unlisted)}`);
    }
  }
  const strayQuotes = quotedValues(description).filter(
    (value) => !enumValues.includes(value),
  );
  if (strayQuotes.length > 0) {
    problems.push(`quotes non-enum value(s) ${JSON.stringify(strayQuotes)}`);
  }
  const excluded = excludedValues(description, enumValues);
  if (excluded.length > 0) {
    problems.push(
      `calls enum value(s) ${JSON.stringify(excluded)} unavailable`,
    );
  }
  return problems;
}

interface EnumSite {
  path: string;
  enumValues: string[];
  description: string;
}

/**
 * Every described enum in a schema, nested ones included. An array property
 * whose `items` carry the enum is reported under the array's own description,
 * because that is the text the agent reads for it.
 */
function enumSites(node: unknown, path: string, acc: EnumSite[]): EnumSite[] {
  if (!node || typeof node !== "object") return acc;
  const schema = node as Record<string, any>;
  const isStringEnum = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) && candidate.every((v) => typeof v === "string");
  const own = isStringEnum(schema.enum) ? schema.enum : undefined;
  const viaItems =
    schema.type === "array" && isStringEnum(schema.items?.enum)
      ? (schema.items.enum as string[])
      : undefined;
  const enumValues = own ?? viaItems;
  if (enumValues && typeof schema.description === "string") {
    acc.push({ path, enumValues, description: schema.description });
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, child] of Object.entries(schema.properties)) {
      enumSites(child, `${path}.${key}`, acc);
    }
  }
  if (schema.items) enumSites(schema.items, `${path}[]`, acc);
  return acc;
}

// Read-only mode is read from the environment at construction and withholds 14
// of the 84 tools, so a leaked env var from another suite would turn every
// count here into a confusing failure. Neutralise it for this file.
let savedReadOnly: string | undefined;
beforeAll(() => {
  savedReadOnly = process.env[READ_ONLY_ENV_VAR];
  delete process.env[READ_ONLY_ENV_VAR];
});
afterAll(() => {
  if (savedReadOnly === undefined) delete process.env[READ_ONLY_ENV_VAR];
  else process.env[READ_ONLY_ENV_VAR] = savedReadOnly;
});

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe("protocol: initialize handshake", () => {
  it("reports serverInfo whose version matches package.json", () => {
    // The client only exposes this once initialize has completed, so reading a
    // name off it at all is proof the handshake succeeded.
    const info = h.client.getServerVersion();
    expect(info?.name).toBe("tastytrade-mcp-server");

    // These two drifted apart before: the handshake carried a hardcoded
    // string while package.json moved on. src/version.ts now reads the
    // manifest, and this asserts all three agree.
    expect(info?.version).toBe(PACKAGE_VERSION);
    expect(PACKAGE_VERSION).toBe(manifestVersion());
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("advertises tools, resources and prompts capabilities", () => {
    const caps = h.client.getServerCapabilities();
    // A capability the server never registered a handler for is absent here,
    // and a client that reads the absence will not call the method at all.
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();
  });
});

describe("protocol: the JSON-RPC error numbers on the wire", () => {
  it("pins the codes every other suite refers to only by name", () => {
    // resources.test.ts, resources-fail-open.test.ts and prompts.test.ts all
    // assert failures through these exported constants, so the constants are
    // the single point where the wire contract could drift without any suite
    // noticing. A client branches on the NUMBER before it ever reaches
    // `data.code`: -32603 means "the server broke", and the taxonomy codes
    // exist precisely so that failures which are not server bugs do not land
    // there.
    expect(MCP_ERROR_INVALID_PARAMS).toBe(ErrorCode.InvalidParams);
    expect(MCP_ERROR_INTERNAL).toBe(ErrorCode.InternalError);
    // The SDK's ErrorCode enum has no entry for resource-not-found; -32002 is
    // the MCP specification's own value, in the server-defined band.
    expect(MCP_ERROR_RESOURCE_NOT_FOUND).toBe(-32002);
  });
});

describe("protocol: tools/list", () => {
  it("advertises exactly the shipped tool count with no duplicates", async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);

    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names every tool with the documented prefix", async () => {
    const { tools } = await h.client.listTools();
    const offenders = tools
      .map((t) => t.name)
      .filter((n) => !n.startsWith("tastytrade_"));
    expect(offenders).toEqual([]);
  });

  it("gives every tool a description and an object inputSchema", async () => {
    const { tools } = await h.client.listTools();

    const withoutDescription: string[] = [];
    const badSchema: string[] = [];
    for (const tool of tools) {
      if (
        typeof tool.description !== "string" ||
        tool.description.trim().length === 0
      ) {
        withoutDescription.push(tool.name);
      }
      const schema = inputSchemaOf(tool);
      const properties = schema.properties;
      if (
        schema.type !== "object" ||
        typeof properties !== "object" ||
        properties === null ||
        Array.isArray(properties)
      ) {
        badSchema.push(tool.name);
      }
    }

    expect(withoutDescription).toEqual([]);
    expect(badSchema).toEqual([]);
  });
});

describe("protocol: registry bijection", () => {
  it("matches TOOL_ANNOTATIONS to the advertised tools as an exact set", async () => {
    const { tools } = await h.client.listTools();
    const advertised = tools.map((t) => t.name).sort();
    const registered = Object.keys(TOOL_ANNOTATIONS).sort();

    // Both directions, spelled out separately: a missing annotation makes
    // ListTools throw, and a stale annotation entry advertises rate-limit
    // policy for a tool nobody can call.
    const unannotated = advertised.filter(
      (n) => TOOL_ANNOTATIONS[n] === undefined,
    );
    const orphaned = registered.filter((n) => !advertised.includes(n));
    expect(unannotated).toEqual([]);
    expect(orphaned).toEqual([]);
    expect(advertised).toEqual(registered);
  });

  it("splits the surface into the expected rate-limit buckets", async () => {
    const { tools } = await h.client.listTools();

    const buckets = { read: 0, write: 0, destructive: 0 };
    for (const tool of tools) {
      buckets[bucketFor(TOOL_ANNOTATIONS[tool.name])] += 1;
    }

    expect(buckets).toEqual({
      read: EXPECTED_READ_TOOLS,
      write: EXPECTED_WRITE_TOOLS,
      destructive: EXPECTED_DESTRUCTIVE_TOOLS,
    });
    expect(buckets.read + buckets.write + buckets.destructive).toBe(
      EXPECTED_TOOL_COUNT,
    );
  });

  it("ships each tool's registered annotation verbatim to the client", async () => {
    const { tools } = await h.client.listTools();
    const mismatched = tools
      .filter(
        (t) =>
          JSON.stringify(t.annotations) !==
          JSON.stringify(TOOL_ANNOTATIONS[t.name]),
      )
      .map((t) => t.name);
    expect(mismatched).toEqual([]);
  });
});

describe("protocol: annotation coherence", () => {
  it("never marks a tool both read-only and destructive", async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
    const contradictory = tools
      .filter(
        (t) => t.annotations?.readOnlyHint && t.annotations?.destructiveHint,
      )
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it("names every destructive tool as a mutation", async () => {
    const { tools } = await h.client.listTools();
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint)
      .map((t) => t.name);

    expect(destructive).toHaveLength(EXPECTED_DESTRUCTIVE_TOOLS);
    expect(destructive.filter((n) => !MUTATION_VERB.test(n))).toEqual([]);
  });

  it("never marks a mutation-named tool read-only", async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);
    const misfiled = tools
      .filter((t) => t.annotations?.readOnlyHint && MUTATION_VERB.test(t.name))
      .map((t) => t.name);
    expect(misfiled).toEqual([]);
  });
});

describe("protocol: inputSchema sanity across every tool", () => {
  it("names only existing properties in `required`", async () => {
    const { tools } = await h.client.listTools();
    // Guards the loop below against passing vacuously on an empty list.
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);

    const dangling: string[] = [];
    let requiredEntriesChecked = 0;
    for (const tool of tools) {
      const schema = inputSchemaOf(tool);
      const required = schema.required;
      if (required === undefined) continue;

      expect(Array.isArray(required)).toBe(true);
      const properties = Object.keys(schema.properties ?? {});
      for (const name of required as unknown[]) {
        expect(typeof name).toBe("string");
        requiredEntriesChecked += 1;
        // A `required` entry with no matching property makes the tool
        // permanently uncallable: the client can never satisfy it.
        if (!properties.includes(String(name))) {
          dangling.push(`${tool.name}.${String(name)}`);
        }
      }
    }

    expect(dangling).toEqual([]);
    expect(requiredEntriesChecked).toBeGreaterThan(50);
  });

  it("keeps every property name snake_case", async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);

    // The agent-facing contract is snake_case; kebab-case belongs only below
    // the translation seam, inside api-client.ts. An uppercase letter or a
    // hyphen here means a kebab/camel key leaked into a public schema.
    const offenders: string[] = [];
    let propertiesChecked = 0;
    for (const tool of tools) {
      for (const property of Object.keys(
        inputSchemaOf(tool).properties ?? {},
      )) {
        propertiesChecked += 1;
        if (/[A-Z-]/.test(property)) {
          offenders.push(`${tool.name}.${property}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    expect(propertiesChecked).toBeGreaterThan(100);
  });
});

describe("protocol: no description contradicts its own enum", () => {
  it("agrees with every enum it describes, across every shipped tool", async () => {
    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_COUNT);

    const offences: string[] = [];
    let sitesChecked = 0;
    let listedValuesChecked = 0;
    let quotedSites = 0;
    for (const tool of tools) {
      for (const site of enumSites(tool.inputSchema, "", [])) {
        sitesChecked += 1;
        listedValuesChecked += enumeratedValues(site.description)?.length ?? 0;
        if (quotedValues(site.description).length > 0) quotedSites += 1;
        for (const problem of enumDescriptionContradictions(
          site.enumValues,
          site.description,
        )) {
          offences.push(`${tool.name}${site.path}: ${problem}`);
        }
      }
    }

    expect(offences).toEqual([]);
    // A guard that walks nothing passes everything. These floors are the
    // observed counts rounded down; they fail if a refactor stops the walk
    // reaching the described enums (the money-path order_type/time_in_force
    // properties are the bulk of the listed values).
    expect(sitesChecked).toBeGreaterThanOrEqual(50);
    expect(listedValuesChecked).toBeGreaterThanOrEqual(90);
    expect(quotedSites).toBeGreaterThanOrEqual(25);
  });

  // The rules themselves, on synthetic input: without these, a mistake that
  // made enumDescriptionContradictions always return [] would leave the sweep
  // above green forever.
  it.each<[string, string[], string, RegExp]>([
    [
      "a listed value the enum rejects",
      ["Market", "Limit"],
      "Order type. One of Market, Limit, Notional Market.",
      /lists non-enum value/,
    ],
    [
      "an enum value the list leaves out",
      ["Market", "Limit", "Marketable Limit"],
      "Order type. One of Market, Limit.",
      /omits enum value/,
    ],
    [
      "the shipped bug: an enum value the description says is not in the enum",
      ["Market", "Limit", "Stop", "Stop Limit", "Marketable Limit"],
      "Order type. One of Market, Limit, Stop, Stop Limit (Marketable Limit " +
        "and Notional Market are accepted by the API but Marketable Limit is " +
        "not in this tool's enum and Notional Market is not usable here, see " +
        "description).",
      /calls enum value/,
    ],
    [
      "a quoted value the enum rejects",
      ["Credit", "Debit"],
      "Direction of price: 'Credit', 'Debit' or 'None'.",
      /quotes non-enum value/,
    ],
    [
      "an enum value the description tells the agent to avoid",
      ["OTO", "OCO", "BLAST"],
      "Strategy type. OTO = one-triggers-other; OCO = one-cancels-other. " +
        "(BLAST is deprecated/unsupported - do not use.)",
      /calls enum value/,
    ],
  ])("flags %s", (_label, enumValues, description, expected) => {
    const problems = enumDescriptionContradictions(enumValues, description);
    expect(problems.join(" | ")).toMatch(expected);
  });

  it.each<[string, string[], string]>([
    [
      "a gloss naming the wire form of a value",
      ["Equity", "Equity Option"],
      "The instrument type. Agent-facing PascalCase (e.g. 'Equity Option'); " +
        "the client hyphenates it to the query-param name (e.g. " +
        "'equity-option'). Defaults to 'Equity'.",
    ],
    [
      "a negation that is about a neighbouring field, not the value",
      ["Day", "GTC", "GTD"],
      "Time-in-force. One of Day, GTC, GTD. For GTD the API expects a " +
        "gtc-date (not currently exposed on this tool).",
    ],
    [
      "an apostrophe inside a word",
      ["Credit", "Debit"],
      "Whether the order's price results in a 'Credit' or a 'Debit'.",
    ],
    [
      "a value the enum genuinely rejects, named as rejected",
      ["OTO", "OCO"],
      "Strategy type. One of OTO, OCO. (BLAST is deprecated - do not use.)",
    ],
    [
      "a longer value name that merely ends in an enum member",
      ["Market", "Limit"],
      "Order type. One of Market, Limit. Notional Market is not usable here.",
    ],
  ])("does not flag %s", (_label, enumValues, description) => {
    expect(enumDescriptionContradictions(enumValues, description)).toEqual([]);
  });
});

describe("protocol: instrument_type maps to one query param, not two", () => {
  /**
   * The same instrument_type -> /market-data/by-type param rule is written
   * twice: QUOTE_SNAPSHOT_PARAM_MAP, a hand-written table in the dispatcher
   * (tastytrade_get_quote_snapshot), and `toLowerCase().replace(/ /g,"-")` in
   * api-client.getQuote (tastytrade_get_quote). Each side has its own test, and
   * both stay green if the two drift apart — an agent would then get `future`
   * from one tool and something else from the other for the same instrument.
   * This drives BOTH paths for BOTH tools and compares the param that actually
   * goes on the wire, so it fails the moment either side changes alone.
   */
  const QUOTE_INSTRUMENT_TYPES = [
    "Equity",
    "Equity Option",
    "Index",
    "Future",
    "Future Option",
    "Cryptocurrency",
  ];

  it("offers the same instrument_type set on both quote tools", async () => {
    const { tools } = await h.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const single = (
      inputSchemaOf(byName["tastytrade_get_quote"]).properties as any
    ).instrument_type.enum as string[];
    const bulk = (
      inputSchemaOf(byName["tastytrade_get_quote_snapshot"]).properties as any
    ).symbols.items.properties.instrument_type.enum as string[];

    expect([...single].sort()).toEqual([...QUOTE_INSTRUMENT_TYPES].sort());
    expect([...bulk].sort()).toEqual([...QUOTE_INSTRUMENT_TYPES].sort());
  });

  it.each(QUOTE_INSTRUMENT_TYPES)(
    "sends %s under the same query param from both tools",
    async (instrumentType) => {
      const quotes = await createHarness({
        routes: [
          { matcher: "/market-data/by-type", reply: { data: { items: [] } } },
        ],
      });
      try {
        // /market-data/by-type is capped at 2 requests/second; reset between
        // the two calls so the ceiling never decides this assertion.
        _resetRateLimitsForTest();
        await callOk(quotes, "tastytrade_get_quote", {
          symbols: ["X"],
          instrument_type: instrumentType,
        });
        const derived = Object.keys(quotes.lastRequest()!.params);

        _resetRateLimitsForTest();
        await callOk(quotes, "tastytrade_get_quote_snapshot", {
          symbols: [{ symbol: "X", instrument_type: instrumentType }],
        });
        const tabled = Object.keys(quotes.lastRequest()!.params);

        expect(derived).toHaveLength(1);
        expect(tabled).toEqual(derived);
      } finally {
        await quotes.close();
      }
    },
  );
});

describe("protocol: get_balances validates whichever envelope the API sends", () => {
  // tastytrade_get_balances hands back `.data.data` verbatim, and the vendored
  // spec and the sibling single-currency endpoint disagree about whether that is
  // a collection or a bare AccountBalance. Calling tools/list first is
  // load-bearing: the SDK caches the outputSchema and validates
  // structuredContent against it, rejecting a mismatch with McpError -32602
  // before the agent sees anything. Both shapes must survive that, because
  // whichever one the live endpoint uses, the payload is legitimate.
  const BALANCE = {
    "account-number": "5WX00001",
    currency: "USD",
    "cash-balance": "10000.0",
    "net-liquidating-value": "25000.0",
  };

  it.each<[string, Record<string, unknown>]>([
    ["the { items: [...] } collection envelope", { items: [BALANCE] }],
    ["a single bare AccountBalance", BALANCE],
  ])("accepts %s", async (_label, payload) => {
    const balances = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/balances",
          method: "GET",
          reply: { data: payload },
        },
      ],
    });
    try {
      await balances.client.listTools();
      const res = (await balances.client.callTool({
        name: "tastytrade_get_balances",
        arguments: { account_number: "5WX00001" },
      })) as { isError?: boolean; structuredContent?: unknown };

      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual(payload);
    } finally {
      await balances.close();
    }
  });

  it("still rejects structured content that is neither shape", async () => {
    // The widened schema must not become a rubber stamp: a payload with neither
    // `items` nor the AccountBalance identity fields fails both branches.
    const balances = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/balances",
          method: "GET",
          reply: { data: { unrelated: true } },
        },
      ],
    });
    try {
      await balances.client.listTools();
      await expect(
        balances.client.callTool({
          name: "tastytrade_get_balances",
          arguments: { account_number: "5WX00001" },
        }),
      ).rejects.toThrow(/output schema/i);
    } finally {
      await balances.close();
    }
  });
});
