import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { createHarness, loadFixture } from "./harness.js";
import type { Harness, RecordedRequest } from "./harness.js";
import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
  matchResourceTemplate,
  matchTemplateIn,
  findStaticResource,
} from "../../src/mcp-server/resources.js";
import type { ResourceTemplate } from "../../src/mcp-server/resources.js";
import {
  MCP_ERROR_INVALID_PARAMS,
  MCP_ERROR_RESOURCE_NOT_FOUND,
  RESOURCE_RATE_KEYS,
  resourceRateKeys,
} from "../../src/mcp-server/index.js";
import { isToolErrorException } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import {
  GLOBAL_PER_SECOND,
  PER_SECOND_LIMITS,
  chargeRateLimit,
  _resetRateLimitsForTest,
} from "../../src/safety/rate-limit.js";

/**
 * End-to-end coverage of the MCP Resources surface, driven through the real protocol
 * against a routed fake transport.
 *
 * Two properties matter and neither is visible from the registry alone. The three
 * static bundles are assembled at MODULE LOAD from the vendored docs tree, and a
 * header-only bundle would still list and still read — so every static assertion
 * reaches for a string that exists only in the sourced doc. And every template is
 * API-backed, so a template read is only correct if the OUTBOUND request is correct.
 */

let h: Harness | undefined;

// The rate limiter is module-global and several templates now spend a 1/sec
// per-endpoint ceiling (RESOURCE_RATE_KEYS), so each test starts with full
// buckets or the second read of `positions` in this file would be refused.
beforeEach(() => {
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  _resetRateLimitsForTest();
});

/** Reads a resource over the protocol and returns the single content entry. */
async function readResource(
  harness: Harness,
  uri: string,
): Promise<{ uri: string; mimeType?: string; text: string }> {
  const res = await harness.client.readResource({ uri });
  expect(res.contents).toHaveLength(1);
  const entry = res.contents[0] as {
    uri: string;
    mimeType?: string;
    text?: string;
  };
  return { uri: entry.uri, mimeType: entry.mimeType, text: entry.text ?? "" };
}

/** Reads a resource and parses the JSON body templates return. */
async function readJson(harness: Harness, uri: string): Promise<unknown> {
  const { text } = await readResource(harness, uri);
  return JSON.parse(text);
}

/** The URL of the one request matching a predicate, asserting it is unique. */
function onlyRequest(
  harness: Harness,
  predicate: (r: RecordedRequest) => boolean,
): RecordedRequest {
  const hits = harness.requests.filter(predicate);
  expect(hits).toHaveLength(1);
  return hits[0];
}

// ---------------------------------------------------------------------------
// resources/list + the static bundles
// ---------------------------------------------------------------------------

describe("resources/list", () => {
  it("lists exactly the static registry, with metadata intact", async () => {
    h = await createHarness();
    const { resources } = await h.client.listResources();

    expect(resources).toHaveLength(STATIC_RESOURCES.length);
    expect(resources.map((r) => r.uri).sort()).toEqual(
      [
        "tastytrade://order-flow-reference",
        "tastytrade://streaming-reference",
        "tastytrade://symbology-reference",
      ].sort(),
    );
    for (const r of resources) {
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
      expect(r.mimeType).toBe("text/markdown");
    }
    // Templates are a separate listing; a parameterized URI must never leak
    // into resources/list, where a client would try to fetch it literally.
    expect(resources.some((r) => r.uri.includes("{"))).toBe(false);
  });

  it("advertises no static resource that a template would shadow", async () => {
    // ReadResource resolves static-before-template, so a template pattern that
    // also matched a static URI would silently become unreachable. Today none
    // does; this asserts the registries stay disjoint if either grows.
    for (const r of STATIC_RESOURCES) {
      expect(matchResourceTemplate(r.uri)).toBeNull();
    }
  });
});

describe("resources/read on the static bundles", () => {
  it.each(STATIC_RESOURCES.map((r) => [r.uri] as const))(
    "%s returns a non-empty markdown body and issues no HTTP call",
    async (uri) => {
      h = await createHarness();
      const { uri: echoed, mimeType, text } = await readResource(h, uri);

      expect(echoed).toBe(uri);
      expect(mimeType).toBe("text/markdown");
      expect(text.length).toBeGreaterThan(1000);
      // Static-before-template is observable here: a static hit short-circuits
      // before the template walk, so no request is ever dispatched.
      expect(h.requests).toHaveLength(0);
    },
  );

  it("assembles the streaming bundle from BOTH vendored streamer docs", async () => {
    h = await createHarness();
    const { text } = await readResource(h, "tastytrade://streaming-reference");

    // Locally authored header — present even if the vendored read collapsed.
    expect(text).toContain("# tastytrade Streaming Reference");
    expect(text).toContain("## 1. DXLink Streaming Market Data");
    expect(text).toContain("## 2. Account Streamer");

    // Sourced from streaming-market-data.md, not from the header.
    expect(text).toContain(
      "The GET /api-quote-tokens endpoint will return an api quote token",
    );
    // Sourced from streaming-account-data.md.
    expect(text).toContain(
      'We refer to this one-directional websocket as our "Account Streamer"',
    );

    // The header is a small fraction of the bundle: prove the doc bodies are
    // really concatenated in, not just their section titles.
    const headerEnd = text.indexOf("## 1. DXLink Streaming Market Data");
    expect(headerEnd).toBeGreaterThan(0);
    expect(text.length - headerEnd).toBeGreaterThan(10_000);
  });

  it("assembles the symbology bundle from api-overview.md", async () => {
    h = await createHarness();
    const { text } = await readResource(h, "tastytrade://symbology-reference");

    expect(text).toContain("# tastytrade Symbology + API Reference");
    // Sourced content: the User-Agent rule and the dasherized-keys convention
    // both live in api-overview.md, not in the wrapper.
    expect(text).toContain("All requests must include a User-Agent header");
    expect(text).toContain('"this-key-is-dasherized"');
    expect(text).toContain("Json keys are dasherized");
  });

  it("assembles the order-flow bundle from order-flow.md", async () => {
    h = await createHarness();
    const { text } = await readResource(h, "tastytrade://order-flow-reference");

    expect(text).toContain("# tastytrade Order Flow Reference");
    // Sourced content: the three-phase grouping and the submission-phase
    // status list are the doc's own words.
    expect(text).toContain("Submission phase");
    expect(text).toContain(
      "Order statuses in the submission phase: Received, Routed, Contingent, In Flight",
    );
  });
});

// ---------------------------------------------------------------------------
// resources/templates/list + per-template regex behaviour
// ---------------------------------------------------------------------------

describe("resources/templates/list", () => {
  it("lists every template with its parameterized URI", async () => {
    h = await createHarness();
    const { resourceTemplates } = await h.client.listResourceTemplates();

    expect(resourceTemplates).toHaveLength(RESOURCE_TEMPLATES.length);
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "tastytrade://accounts",
      "tastytrade://accounts/{account_number}/summary",
      "tastytrade://accounts/{account_number}/positions",
      "tastytrade://accounts/{account_number}/orders/live",
      "tastytrade://accounts/{account_number}/pnl-today",
      "tastytrade://accounts/{account_number}/nlv-history/{range}",
      "tastytrade://watchlists",
      "tastytrade://watchlists/{name}",
      "tastytrade://public-watchlists",
      "tastytrade://public-watchlists/{name}",
      "tastytrade://market/session",
      "tastytrade://market/holidays",
    ]);
    for (const t of resourceTemplates) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.mimeType).toBe("application/json");
    }
  });

  it("keys match the placeholders in each uriTemplate, in order", () => {
    for (const t of RESOURCE_TEMPLATES) {
      const declared = [...t.uriTemplate.matchAll(/\{([^}]+)\}/g)].map(
        (m) => m[1],
      );
      expect(t.keys).toEqual(declared);
    }
  });
});

/**
 * One row per template: a well-formed example URI, the params it must yield,
 * and URIs that must NOT match. The near-misses are the interesting half —
 * `{placeholder}` compiles to `([^/]+)`, so an empty segment, an extra
 * segment, or a truncated tail all have to be rejected.
 */
const TEMPLATE_CASES: Array<{
  uriTemplate: string;
  uri: string;
  params: Record<string, string>;
  nearMisses: string[];
}> = [
  {
    uriTemplate: "tastytrade://accounts",
    uri: "tastytrade://accounts",
    params: {},
    nearMisses: [
      "tastytrade://accounts/",
      "tastytrade://account",
      "tastytrade://accountsx",
      "http://accounts",
    ],
  },
  {
    uriTemplate: "tastytrade://accounts/{account_number}/summary",
    uri: "tastytrade://accounts/5WX00001/summary",
    params: { account_number: "5WX00001" },
    nearMisses: [
      "tastytrade://accounts//summary",
      "tastytrade://accounts/5WX00001/summary/extra",
      "tastytrade://accounts/5WX00001/Summary",
      "tastytrade://accounts/5WX/00001/summary",
    ],
  },
  {
    uriTemplate: "tastytrade://accounts/{account_number}/positions",
    uri: "tastytrade://accounts/5WX00001/positions",
    params: { account_number: "5WX00001" },
    nearMisses: [
      "tastytrade://accounts/5WX00001/position",
      "tastytrade://accounts/5WX00001/positions/AAPL",
    ],
  },
  {
    uriTemplate: "tastytrade://accounts/{account_number}/orders/live",
    uri: "tastytrade://accounts/5WX00001/orders/live",
    params: { account_number: "5WX00001" },
    nearMisses: [
      "tastytrade://accounts/5WX00001/orders",
      "tastytrade://accounts/5WX00001/orders/live/1",
      "tastytrade://accounts/5WX00001/orders/123",
    ],
  },
  {
    uriTemplate: "tastytrade://accounts/{account_number}/pnl-today",
    uri: "tastytrade://accounts/5WX00001/pnl-today",
    params: { account_number: "5WX00001" },
    nearMisses: [
      "tastytrade://accounts/5WX00001/pnl",
      "tastytrade://accounts/5WX00001/pnl-today/detail",
    ],
  },
  {
    uriTemplate: "tastytrade://accounts/{account_number}/nlv-history/{range}",
    uri: "tastytrade://accounts/5WX00001/nlv-history/1m",
    params: { account_number: "5WX00001", range: "1m" },
    nearMisses: [
      "tastytrade://accounts/5WX00001/nlv-history",
      "tastytrade://accounts/5WX00001/nlv-history/",
      "tastytrade://accounts/5WX00001/nlv-history/1m/extra",
    ],
  },
  {
    uriTemplate: "tastytrade://watchlists",
    uri: "tastytrade://watchlists",
    params: {},
    nearMisses: ["tastytrade://watchlists/", "tastytrade://public-watchlists"],
  },
  {
    uriTemplate: "tastytrade://watchlists/{name}",
    uri: "tastytrade://watchlists/Core%20Holdings",
    params: { name: "Core Holdings" },
    nearMisses: [
      "tastytrade://watchlists//",
      "tastytrade://watchlists/Core/Holdings",
      "tastytrade://public-watchlists/Core",
    ],
  },
  {
    uriTemplate: "tastytrade://public-watchlists",
    uri: "tastytrade://public-watchlists",
    params: {},
    nearMisses: [
      "tastytrade://public-watchlists/",
      "tastytrade://public-watchlist",
    ],
  },
  {
    uriTemplate: "tastytrade://public-watchlists/{name}",
    uri: "tastytrade://public-watchlists/tasty%20Ideas",
    params: { name: "tasty Ideas" },
    nearMisses: [
      "tastytrade://public-watchlists/",
      "tastytrade://public-watchlists/a/b",
    ],
  },
  {
    uriTemplate: "tastytrade://market/session",
    uri: "tastytrade://market/session",
    params: {},
    nearMisses: [
      "tastytrade://market/sessions",
      "tastytrade://market/session/current",
      "tastytrade://market",
    ],
  },
  {
    uriTemplate: "tastytrade://market/holidays",
    uri: "tastytrade://market/holidays",
    params: {},
    nearMisses: [
      "tastytrade://market/holiday",
      "tastytrade://market/holidays/CME",
    ],
  },
];

/**
 * Could these two URI templates both match some URI?
 *
 * Read off the template strings rather than by intersecting two compiled
 * regexes, and deliberately OVER-approximate: two segments count as capable of
 * matching the same text unless they are literals that differ. `{placeholder}`
 * compiles to `([^/]+)`, so it matches any non-empty literal segment, and a
 * segment mixing literal text with a placeholder is treated as a placeholder
 * too — which can only make the answer stricter, never laxer. A false alarm
 * costs a developer one rename; a missed overlap costs a resource that quietly
 * stops resolving.
 */
function couldOverlap(a: string, b: string): boolean {
  const left = a.split("/");
  const right = b.split("/");
  if (left.length !== right.length) return false;
  return left.every((segment, i) => {
    const other = right[i];
    if (segment.includes("{") || other.includes("{")) return true;
    return segment === other;
  });
}

describe("template URI matching", () => {
  it("has one case per registered template", () => {
    expect(TEMPLATE_CASES.map((c) => c.uriTemplate)).toEqual(
      RESOURCE_TEMPLATES.map((t) => t.uriTemplate),
    );
  });

  it.each(TEMPLATE_CASES)(
    "$uriTemplate matches $uri and extracts its params",
    ({ uriTemplate, uri, params }) => {
      const hit = matchResourceTemplate(uri);
      expect(hit).not.toBeNull();
      expect(hit!.template.uriTemplate).toBe(uriTemplate);
      expect(hit!.params).toEqual(params);
    },
  );

  it.each(TEMPLATE_CASES)(
    "$uriTemplate rejects its near-miss URIs",
    ({ uriTemplate, nearMisses }) => {
      const pattern = RESOURCE_TEMPLATES.find(
        (t) => t.uriTemplate === uriTemplate,
      )!.pattern;
      expect(nearMisses.length).toBeGreaterThan(0);
      for (const miss of nearMisses) {
        expect(pattern.test(miss)).toBe(false);
      }
    },
  );

  it("leaves every near-miss either unroutable or owned by one other template", () => {
    // A near-miss for one template may legitimately belong to a different one
    // (tastytrade://public-watchlists/Core is a near-miss for the user-watchlist
    // template and a real hit for the public one). Whatever the case, exactly
    // zero or one template may claim it, and nothing may resolve to a static
    // resource.
    const misses = [...new Set(TEMPLATE_CASES.flatMap((c) => c.nearMisses))];
    for (const uri of misses) {
      const claimedBy = RESOURCE_TEMPLATES.filter((t) =>
        t.pattern.test(uri),
      ).map((t) => t.uriTemplate);
      expect(claimedBy.length).toBeLessThanOrEqual(1);
      expect(findStaticResource(uri)).toBeUndefined();
      if (claimedBy.length === 0) {
        expect(matchResourceTemplate(uri)).toBeNull();
      }
    }
    // Sanity-check the corpus itself: most of these must be fully unroutable,
    // otherwise the assertion above could pass on an empty set of real misses.
    const unroutable = misses.filter((u) => matchResourceTemplate(u) === null);
    expect(unroutable.length).toBeGreaterThanOrEqual(misses.length - 3);
  });

  it("lets exactly ONE template claim each example URI", () => {
    // An overlap would leave one of the two templates unreachable for the URIs
    // they share. `matchTemplateIn` refuses an ambiguous URI rather than
    // arbitrating one (pinned below), so an overlap cannot serve the
    // wrong resource — but it would still break a URI that works today, which
    // is what this pins.
    for (const c of TEMPLATE_CASES) {
      const claimants = RESOURCE_TEMPLATES.filter((t) =>
        t.pattern.test(c.uri),
      ).map((t) => t.uriTemplate);
      expect(claimants).toEqual([c.uriTemplate]);
    }
  });

  it("registers no two templates that could ever claim the same URI", () => {
    // The test above is only as good as its corpus: it proves uniqueness for
    // twelve hand-written URIs, one per template. This is the general claim,
    // read off the uriTemplate strings rather than off examples, so a new
    // template that overlaps an existing one fails here even if nobody thought
    // to write a URI that lands in the overlap.
    const overlaps: string[] = [];
    for (let i = 0; i < RESOURCE_TEMPLATES.length; i++) {
      for (let j = i + 1; j < RESOURCE_TEMPLATES.length; j++) {
        const a = RESOURCE_TEMPLATES[i].uriTemplate;
        const b = RESOURCE_TEMPLATES[j].uriTemplate;
        if (couldOverlap(a, b)) overlaps.push(`${a}  <->  ${b}`);
      }
    }
    expect(overlaps).toEqual([]);

    // And the detector is not vacuous: it fires on a real overlap, stays quiet
    // on distinct literals, and does not confuse two different path depths.
    expect(couldOverlap("tastytrade://a/{x}", "tastytrade://a/b")).toBe(true);
    expect(couldOverlap("tastytrade://a/{x}", "tastytrade://a/{y}")).toBe(true);
    expect(couldOverlap("tastytrade://a/b", "tastytrade://a/c")).toBe(false);
    expect(couldOverlap("tastytrade://a", "tastytrade://a/b")).toBe(false);
  });

  it("resolves every example URI identically whatever order the registry is in", () => {
    // "Array position decides nothing", written down as an executable claim.
    // Reversing the iteration order would be an equivalent mutation by
    // accident — equivalent only while no two patterns happened to overlap,
    // which is a property of the DATA, not of the code. It is an equivalent
    // mutation on purpose now, and the refusal pinned in the next test is what
    // makes it so.
    const reversed = [...RESOURCE_TEMPLATES].reverse();
    for (const c of TEMPLATE_CASES) {
      const forward = matchTemplateIn(RESOURCE_TEMPLATES, c.uri);
      const backward = matchTemplateIn(reversed, c.uri);
      expect(forward!.template.uriTemplate).toBe(c.uriTemplate);
      expect(backward!.template.uriTemplate).toBe(c.uriTemplate);
      expect(backward!.params).toEqual(forward!.params);
    }
  });

  it("refuses an ambiguous URI instead of letting array position pick a winner", () => {
    // Reachable only with an injected registry, because the real one has no
    // overlap — which is the point: the branch that makes order irrelevant has
    // to be exercised somewhere, or "order-independent" is an unverified claim
    // about code nothing runs.
    const overlapping = (uriTemplate: string, name: string): ResourceTemplate =>
      ({
        uriTemplate,
        name,
        description: "",
        mimeType: "application/json",
        // Every template declares its access class now,
        // so `resources/read` can ask the operator's read-only posture the same
        // question `tools/call` asks. Required rather than defaulted, which is
        // why this synthetic one has to say it too.
        accessClass: "read" as const,
        pattern: /^tastytrade:\/\/ambiguous\/([^/]+)$/,
        keys: ["id"],
        read: async () => ({}),
      }) satisfies ResourceTemplate;

    const first = overlapping("tastytrade://ambiguous/{id}", "First");
    const second = overlapping("tastytrade://ambiguous/{other}", "Second");
    const uri = "tastytrade://ambiguous/7";

    // One claimant resolves normally, params and all.
    const single = matchTemplateIn([first], uri);
    expect(single!.template.name).toBe("First");
    expect(single!.params).toEqual({ id: "7" });

    // Two claimants are refused — in BOTH orders. A first-match matcher answers
    // "First" for one ordering and "Second" for the other, so this pair of
    // assertions is what tells the two implementations apart.
    for (const registry of [
      [first, second],
      [second, first],
    ]) {
      let thrown: unknown;
      try {
        matchTemplateIn(registry, uri);
      } catch (e) {
        thrown = e;
      }
      expect(isToolErrorException(thrown)).toBe(true);
      const err = (thrown as { toolError: ToolError }).toolError;
      // Not retryable: an ambiguous registry is a defect in this server, and
      // sending the same URI again cannot resolve it.
      expect(err.retryable).toBe(false);
      // Both culprits are named, because "something overlaps" is not a bug
      // report anyone can act on.
      expect(err.message).toContain("tastytrade://ambiguous/{id}");
      expect(err.message).toContain("tastytrade://ambiguous/{other}");
      expect(err.hint ?? "").toMatch(/registry|overlapping/i);
    }
  });

  it("matches its own URI shape and nothing wrapped around it", () => {
    // Both anchors, stated as behaviour rather than as an assertion about
    // `pattern.source`, so the property survives a change of matching mechanism. Neither
    // hole is covered by the hand-written near-misses above: without `^`,
    // `evil://xtastytrade://accounts` routes to the accounts template, letting a caller
    // reach any resource from a foreign scheme; without `$`, every template swallows
    // arbitrary deeper paths. Appending a whole SEGMENT rather than characters is what
    // makes the tail half work for templates ending in a `{placeholder}`, since the
    // compiled group is `[^/]+` and cannot absorb the slash.
    for (const c of TEMPLATE_CASES) {
      const own = RESOURCE_TEMPLATES.find(
        (t) => t.uriTemplate === c.uriTemplate,
      )!;
      expect(own.pattern.test(`x${c.uri}`)).toBe(false);
      expect(own.pattern.test(`${c.uri}/ZZZ`)).toBe(false);
    }
  });
});

describe("every registered template is readable over the protocol", () => {
  it("serves parseable JSON for each one, derived from the registry", async () => {
    // The per-template read tests below are hand-written one at a time, so a
    // NEW template is forced to declare a routing case (by "has one case per
    // registered template") but not to be read at all. This loop walks
    // TEMPLATE_CASES, which that guard keeps in step with the registry, so it
    // extends itself: a template whose `read()` throws, or resolves to
    // undefined and trips the fail-closed refusal, fails here the day it lands.
    //
    // The fallback carries `items` because most of these run through client
    // methods that unwrap `.data.data.items` with no default. A bare `{}` is
    // the undefined-body case, pinned on its own further down.
    h = await createHarness({ fallback: { data: { items: [] } } });

    for (const t of TEMPLATE_CASES) {
      // Full buckets per iteration. Several of these templates spend the same
      // 1/sec `positions` ceiling (RESOURCE_RATE_KEYS), so reading the whole
      // registry inside one second would otherwise be refused halfway through
      // — which is the metering working, not the readability this loop is for.
      _resetRateLimitsForTest();
      const { uri, mimeType, text } = await readResource(h, t.uri);
      expect(uri).toBe(t.uri);
      expect(mimeType).toBe("application/json");
      // Serialized JSON, not a raw object — the handler stringifies.
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Driving each template through resources/read with routed HTTP
// ---------------------------------------------------------------------------

describe("resources/read: tastytrade://accounts", () => {
  it("proxies GET /customers/me/accounts and unwraps items", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/accounts",
          method: "GET",
          reply: {
            data: {
              items: [
                { account: { "account-number": "5WX00001" } },
                { account: { "account-number": "5WX00002" } },
              ],
            },
          },
        },
      ],
    });

    const body = (await readJson(h, "tastytrade://accounts")) as unknown[];
    expect(body).toHaveLength(2);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()).toMatchObject({
      method: "GET",
      url: "/customers/me/accounts",
    });
  });

  it("returns application/json and the echoed request URI", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/customers/me/accounts", reply: { data: { items: [] } } },
      ],
    });
    const { uri, mimeType } = await readResource(h, "tastytrade://accounts");
    expect(uri).toBe("tastytrade://accounts");
    expect(mimeType).toBe("application/json");
  });
});

describe("resources/read: account summary (computed)", () => {
  it("fans out to balances + positions + trading-status and aggregates", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/balances",
          reply: { data: { "net-liquidating-value": "12345.67" } },
        },
        {
          matcher: "/accounts/5WX00001/positions",
          reply: {
            data: {
              items: [
                { symbol: "AAPL", quantity: 10 },
                { symbol: "MSFT", quantity: 5 },
                // A malformed row must not corrupt the symbol list.
                { quantity: 1 },
              ],
            },
          },
        },
        {
          matcher: "/accounts/5WX00001/trading-status",
          reply: { data: { "is-frozen": false, "is-in-margin-call": false } },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://accounts/5WX00001/summary",
    )) as Record<string, unknown>;

    expect(body["account-number"]).toBe("5WX00001");
    expect(body.balances).toEqual({ "net-liquidating-value": "12345.67" });
    expect(body["trading-status"]).toEqual({
      "is-frozen": false,
      "is-in-margin-call": false,
    });
    expect(body["position-count"]).toBe(3);
    // Non-string symbols are filtered out of the symbol list but still counted.
    expect(body["open-position-symbols"]).toEqual(["AAPL", "MSFT"]);

    // Exactly three outbound calls, each kebab-case and account-scoped.
    expect(h.requests.map((r) => r.url).sort()).toEqual([
      "/accounts/5WX00001/balances",
      "/accounts/5WX00001/positions",
      "/accounts/5WX00001/trading-status",
    ]);
    // The computed view always asks for marks, per the client's documented
    // include-marks default.
    expect(onlyRequest(h, (r) => r.url.endsWith("/positions")).params).toEqual({
      "include-marks": true,
    });
  });

  it("keeps the fetches that worked when balances fails, and names the one that did not", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/accounts/5WX00001/balances", reply: { status: 500 } },
        {
          matcher: "/accounts/5WX00001/positions",
          reply: { data: { items: [{ symbol: "AAPL" }] } },
        },
        {
          matcher: "/accounts/5WX00001/trading-status",
          reply: { data: { "is-frozen": true } },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://accounts/5WX00001/summary",
    )) as Record<string, any>;

    // computeAccountSummary settles per-branch, so a dead balances endpoint
    // still yields a usable page — but the dead branch is null and declared,
    // never an object that could pass for a balance sheet.
    expect(body.balances).toBeNull();
    expect(body["partial-read"]).toBe(true);
    expect(body["unavailable-fields"]).toEqual([
      {
        field: "balances",
        code: "upstream_error",
        message: expect.stringMatching(/500/),
        retryable: true,
        "upstream-status": 500,
      },
    ]);
    expect(body["trading-status"]).toEqual({ "is-frozen": true });
    expect(body["position-count"]).toBe(1);
  });

  // An unreadable POSITION list — the case where a fabricated `0` would read as
  // "this account is flat" — is covered against four different upstream
  // failures, with the full taxonomy, in test/e2e/resources-fail-open.test.ts.

  it("passes the account number through verbatim, including URL-escaped input", async () => {
    // `5WX-1` has to be declared as an account this
    // credential holds, or the account-scope gate refuses the read before the
    // path is built and this test measures that instead of the decode.
    h = await createHarness({ heldAccounts: ["5WX-1"] });
    await readResource(h, "tastytrade://accounts/5WX%2D1/summary");
    // %2D decodes to "-" before the client builds the path.
    expect(h.requests.map((r) => r.url)).toEqual(
      expect.arrayContaining(["/accounts/5WX-1/balances"]),
    );
  });
});

describe("resources/read: account positions", () => {
  it("requests marks and returns the unwrapped item list", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/positions",
          method: "GET",
          reply: {
            data: {
              items: [{ symbol: "AAPL", quantity: 10, "mark-price": "190.00" }],
            },
          },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://accounts/5WX00001/positions",
    )) as Array<Record<string, unknown>>;

    expect(body).toHaveLength(1);
    expect(body[0].symbol).toBe("AAPL");
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()).toMatchObject({
      method: "GET",
      url: "/accounts/5WX00001/positions",
      params: { "include-marks": true },
    });
  });
});

describe("resources/read: today's orders", () => {
  it("proxies GET /accounts/{n}/orders/live against a recorded payload", async () => {
    const fixture = loadFixture("tastytrade_get_live_orders") as {
      items: Array<Record<string, unknown>>;
    };
    h = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/orders/live",
          method: "GET",
          reply: { data: fixture },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://accounts/5WX00001/orders/live",
    )) as Array<Record<string, unknown>>;

    expect(body).toHaveLength(fixture.items.length);
    expect(body[0]["order-type"]).toBe(fixture.items[0]["order-type"]);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.url).toBe("/accounts/5WX00001/orders/live");
  });
});

describe("resources/read: today's P&L (computed)", () => {
  // Date.now() is the only nondeterminism in the computed view; freeze it
  // rather than assert loosely. Only Date is faked — the SDK arms a real
  // setTimeout per request and the in-memory transport must stay live.
  const FROZEN = "2026-03-04T14:30:00.000Z";
  const REAL_TIMERS: Array<
    | "setTimeout"
    | "clearTimeout"
    | "setInterval"
    | "clearInterval"
    | "setImmediate"
    | "clearImmediate"
    | "nextTick"
    | "queueMicrotask"
    | "performance"
    | "hrtime"
  > = [
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "setImmediate",
    "clearImmediate",
    "nextTick",
    "queueMicrotask",
    "performance",
    "hrtime",
  ];

  afterEach(() => {
    jest.useRealTimers();
  });

  it("signs realized and estimates unrealized P&L per position", async () => {
    jest.useFakeTimers({ doNotFake: REAL_TIMERS });
    jest.setSystemTime(new Date(FROZEN));

    h = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/positions",
          reply: {
            data: {
              items: [
                {
                  symbol: "AAPL",
                  "instrument-type": "Equity",
                  quantity: 10,
                  multiplier: 1,
                  "quantity-direction": "Long",
                  "close-price": "100.00",
                  "mark-price": "105.00",
                  "realized-day-gain": "25.00",
                  "realized-day-gain-effect": "Credit",
                },
                {
                  symbol: "MSFT",
                  "instrument-type": "Equity",
                  quantity: 4,
                  multiplier: 1,
                  "quantity-direction": "Short",
                  "close-price": "50.00",
                  "mark-price": "52.00",
                  "realized-day-gain": "10.00",
                  "realized-day-gain-effect": "Debit",
                },
              ],
            },
          },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://accounts/5WX00001/pnl-today",
    )) as {
      "account-number": string;
      "computed-at": string;
      "realized-day-pnl": number;
      "estimated-unrealized-day-pnl": number;
      "estimated-total-day-pnl": number;
      note: string;
      positions: Array<Record<string, number | string>>;
    };

    expect(body["account-number"]).toBe("5WX00001");
    expect(body["computed-at"]).toBe(FROZEN);

    // AAPL long: (105 - 100) * 10 * 1 = +50 unrealized, +25 realized (Credit).
    // MSFT short: -1 * (52 - 50) * 4 * 1 = -8 unrealized, -10 realized (Debit).
    expect(body["realized-day-pnl"]).toBe(15);
    expect(body["estimated-unrealized-day-pnl"]).toBe(42);
    expect(body["estimated-total-day-pnl"]).toBe(57);

    expect(body.positions).toHaveLength(2);
    expect(body.positions[0]).toMatchObject({
      symbol: "AAPL",
      "quantity-direction": "Long",
      "realized-day-gain": 25,
      "estimated-unrealized-day-pnl": 50,
      "estimated-total-day-pnl": 75,
    });
    expect(body.positions[1]).toMatchObject({
      symbol: "MSFT",
      "quantity-direction": "Short",
      "realized-day-gain": -10,
      "estimated-unrealized-day-pnl": -8,
      "estimated-total-day-pnl": -18,
    });
    expect(body.note).toMatch(/estimate/i);

    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()).toMatchObject({
      method: "GET",
      url: "/accounts/5WX00001/positions",
      params: { "include-marks": true },
    });
  });

  it("applies the option multiplier to the unrealized estimate", async () => {
    jest.useFakeTimers({ doNotFake: REAL_TIMERS });
    jest.setSystemTime(new Date(FROZEN));

    h = await createHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/positions",
          reply: {
            data: {
              items: [
                {
                  symbol: "AAPL  260320C00200000",
                  "instrument-type": "Equity Option",
                  quantity: 2,
                  multiplier: 100,
                  "quantity-direction": "Long",
                  "close-price": "1.00",
                  "mark-price": "1.50",
                },
              ],
            },
          },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://accounts/5WX00001/pnl-today",
    )) as { "estimated-unrealized-day-pnl": number };

    // (1.50 - 1.00) * 2 * 100 = 100
    expect(body["estimated-unrealized-day-pnl"]).toBe(100);
  });

  // Every figure in this view derives from the one positions fetch, so there is
  // no partial answer to give and the read must fail closed. That contract is
  // pinned against five different upstream failures, with the JSON-RPC code and
  // the "treat as UNKNOWN, not zero" hint, in
  // test/e2e/resources-fail-open.test.ts.
});

describe("resources/read: NLV history", () => {
  it.each(["1d", "1w", "1m", "3m", "6m", "1y", "all"])(
    "maps range %s onto the time-back query parameter",
    async (range) => {
      h = await createHarness({
        routes: [
          {
            matcher: "/accounts/5WX00001/net-liq/history",
            method: "GET",
            reply: { data: { items: [{ "close-total-value": "1000.0" }] } },
          },
        ],
      });

      const body = (await readJson(
        h,
        `tastytrade://accounts/5WX00001/nlv-history/${range}`,
      )) as unknown[];

      expect(body).toHaveLength(1);
      expect(h.requests).toHaveLength(1);
      expect(h.lastRequest()).toMatchObject({
        method: "GET",
        url: "/accounts/5WX00001/net-liq/history",
        params: { "time-back": range },
      });
    },
  );

  it("rejects an unsupported range before making any request", async () => {
    h = await createHarness();
    await expect(
      h.client.readResource({
        uri: "tastytrade://accounts/5WX00001/nlv-history/7y",
      }),
    ).rejects.toThrow(/Unsupported NLV range "7y"/);
    // The guard runs inside the read fn, ahead of the client call.
    expect(h.requests).toHaveLength(0);
  });

  it("names the supported ranges in the rejection", async () => {
    h = await createHarness();
    await expect(
      h.client.readResource({
        uri: "tastytrade://accounts/5WX00001/nlv-history/1D",
      }),
    ).rejects.toThrow(/1d, 1w, 1m, 3m, 6m, 1y, all/);
  });
});

describe("resources/read: watchlists", () => {
  it("lists user watchlists from GET /watchlists", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/watchlists",
          method: "GET",
          reply: { data: { items: [{ name: "Core Holdings" }] } },
        },
      ],
    });

    const body = (await readJson(h, "tastytrade://watchlists")) as Array<{
      name: string;
    }>;
    expect(body).toEqual([{ name: "Core Holdings" }]);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.url).toBe("/watchlists");
  });

  it("fetches a single user watchlist by decoded name", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /^\/watchlists\//,
          method: "GET",
          reply: {
            data: { name: "Core Holdings", "watchlist-entries": [] },
          },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://watchlists/Core%20Holdings",
    )) as { name: string };
    expect(body.name).toBe("Core Holdings");
    expect(h.requests).toHaveLength(1);
    // getWatchlist() re-encodes the decoded name, so the %20 that arrived on
    // the resource URI survives to the wire — matching getPublicWatchlist()
    // below, which always did.
    expect(h.lastRequest()?.url).toBe("/watchlists/Core%20Holdings");
  });

  it("an escaped slash in a watchlist name cannot escape the path", async () => {
    h = await createHarness({
      routes: [{ matcher: /.*/, method: "GET", reply: { data: {} } }],
    });

    // The chain: `([^/]+)` accepts the percent-encoded form, then
    // matchResourceTemplate decodeURIComponent's it into a real "../../".
    // getWatchlist() would interpolate that into the path un-encoded (unlike
    // getPublicWatchlist, which always called encodeURIComponent), and axios's
    // http adapter resolves the result through `new URL()`, which collapses
    // the dot segments — so the request left for GET /customers/me rather than
    // for any watchlist. Encoded, the traversal stays inert inside one segment.
    await readJson(h, "tastytrade://watchlists/..%2F..%2Fcustomers%2Fme");
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.url).toBe("/watchlists/..%2F..%2Fcustomers%2Fme");
    expect(
      new URL("https://api.cert.tastyworks.com" + h.lastRequest()!.url)
        .pathname,
    ).toBe("/watchlists/..%2F..%2Fcustomers%2Fme");
  });

  it("lists public watchlists from GET /public-watchlists", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/public-watchlists",
          method: "GET",
          reply: { data: { items: [{ name: "tasty Ideas" }] } },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://public-watchlists",
    )) as Array<{
      name: string;
    }>;
    expect(body).toEqual([{ name: "tasty Ideas" }]);
    expect(h.lastRequest()).toMatchObject({
      method: "GET",
      url: "/public-watchlists",
      params: {},
    });
  });

  it("re-encodes the name when fetching a single public watchlist", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: /^\/public-watchlists\//,
          method: "GET",
          reply: { data: { name: "tasty Ideas" } },
        },
      ],
    });

    const body = (await readJson(
      h,
      "tastytrade://public-watchlists/tasty%20Ideas",
    )) as { name: string };
    expect(body.name).toBe("tasty Ideas");
    // getPublicWatchlist() encodeURIComponent's the name, so the %20 that
    // arrived on the resource URI survives to the wire. This path always did;
    // the user-watchlist path above was fixed to match it, so the two are
    // symmetric now and the pair is asserted to keep them that way.
    expect(h.lastRequest()?.url).toBe("/public-watchlists/tasty%20Ideas");
  });
});

describe("resources/read: market session and holidays", () => {
  it("asks for all three instrument collections in one call", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/sessions/current",
          method: "GET",
          reply: {
            data: [
              { "instrument-collection": "Equity", state: "Open" },
              { "instrument-collection": "CME", state: "Open" },
              { "instrument-collection": "CFE", state: "Closed" },
            ],
          },
        },
      ],
    });

    const body = (await readJson(h, "tastytrade://market/session")) as Array<{
      "instrument-collection": string;
    }>;
    expect(body.map((s) => s["instrument-collection"])).toEqual([
      "Equity",
      "CME",
      "CFE",
    ]);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()).toMatchObject({
      method: "GET",
      url: "/market-time/sessions/current",
      params: { "instrument-collections": ["Equity", "CME", "CFE"] },
    });
  });

  it("proxies the equity holiday calendar", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: "/market-time/equities/holidays",
          method: "GET",
          reply: { data: { "holidays-and-half-days": ["2026-01-01"] } },
        },
      ],
    });

    const body = (await readJson(h, "tastytrade://market/holidays")) as Record<
      string,
      unknown
    >;
    expect(body["holidays-and-half-days"]).toEqual(["2026-01-01"]);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.url).toBe("/market-time/equities/holidays");
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("resources/read failures", () => {
  it("reports an unknown URI as not found, naming the URI", async () => {
    h = await createHarness();
    await expect(
      h.client.readResource({ uri: "tastytrade://not-a-resource" }),
    ).rejects.toThrow(/Resource not found: tastytrade:\/\/not-a-resource/);
    expect(h.requests).toHaveLength(0);
  });

  it("rejects a URI in a foreign scheme rather than guessing", async () => {
    h = await createHarness();
    await expect(
      h.client.readResource({ uri: "https://api.tastyworks.com/accounts" }),
    ).rejects.toThrow(/Resource not found/);
    expect(h.requests).toHaveLength(0);
  });

  it("carries the real error taxonomy on the JSON-RPC error", async () => {
    // `resources/read` has no adaptError wrapper (that is CallTool's, and it
    // returns errors in-band), so the handler attaches the taxonomy itself. It
    // would throw a bare Error with a decorative `response.status = 404` that
    // the SDK does not read, so every failure reached the client as -32603
    // InternalError — "no such resource" was indistinguishable from "the server
    // broke". Now the numeric code is the spec's -32002 and `data` carries the
    // full ToolError, so a client branches on data.code.
    h = await createHarness();
    const err = await h.client.readResource({ uri: "tastytrade://nope" }).then(
      () => null,
      (e: unknown) =>
        e as {
          code?: number;
          message: string;
          data?: { code?: string; retryable?: boolean; hint?: string };
        },
    );

    expect(err).not.toBeNull();
    expect(err!.code).toBe(MCP_ERROR_RESOURCE_NOT_FOUND);
    expect(err!.code).not.toBe(-32603);
    expect(err!.message).toContain("Resource not found");
    expect(err!.data?.code).toBe("not_found");
    expect(err!.data?.retryable).toBe(false);
    expect(err!.data?.hint).toMatch(/resources\/list/);
  });

  it("refuses rather than emit an unreadable body when a read resolves to undefined", async () => {
    // Reachable with NO API error: four client methods unwrap `.data.data.items` with no
    // fallback, so a 200 whose payload omits `items` resolves to undefined —
    // `JSON.stringify(undefined)` returns `undefined` rather than a string, producing a
    // content block with neither `text` nor `blob`, malformed per MCP's ResourceContents
    // schema.
    //
    // The replacement is a refusal, not an empty body: "null" or "[]" would be
    // indistinguishable from a genuine "you hold nothing", which an agent could act on.
    // The accounts endpoint is routed explicitly here with the payload that resolves to
    // undefined, since the harness otherwise answers it with a real account list.
    h = await createHarness({
      routes: [{ matcher: "/customers/me/accounts", reply: { data: {} } }],
    });
    const err = await h.client
      .readResource({ uri: "tastytrade://accounts" })
      .then(
        () => null,
        (e: unknown) =>
          e as { code?: number; message: string; data?: { code?: string } },
      );

    expect(err).not.toBeNull();
    expect(err!.code).toBe(MCP_ERROR_RESOURCE_NOT_FOUND);
    expect(err!.data?.code).toBe("not_found");
    expect(err!.message).toMatch(/produced no content/);
    // The request really was made and really did succeed — this is not an HTTP
    // failure being relabelled.
    expect(h.requests.map((r) => r.url)).toEqual(["/customers/me/accounts"]);

    // And the same URI works the moment the payload carries `items`, which
    // localises the refusal to the empty body rather than the routing. The
    // reset is because `tastytrade://accounts` spends the 1/sec `accounts`
    // ceiling, and this is the second read of it in one test.
    _resetRateLimitsForTest();
    h.route({
      matcher: "/customers/me/accounts",
      reply: { data: { items: [] } },
    });
    expect(await readJson(h, "tastytrade://accounts")).toEqual([]);
  });

  it("still serves a legitimately empty body — null is content, undefined is not", async () => {
    // `JSON.stringify(null)` is the string "null", a well-formed body, so a read
    // that genuinely resolves to null must NOT be swept into the refusal above.
    // getAccounts reads `.data.data.items` with no fallback, so an explicit
    // `items: null` reaches the handler as null rather than undefined — the one
    // distinction the guard turns on.
    h = await createHarness({
      routes: [
        {
          matcher: "/customers/me/accounts",
          method: "GET",
          reply: { raw: true, data: { data: { items: null } } },
        },
      ],
    });
    const { text } = await readResource(h, "tastytrade://accounts");
    expect(text).toBe("null");
  });

  it("classifies an upstream HTTP failure from a template read", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/accounts/5WX00001/orders/live", reply: { status: 401 } },
      ],
    });
    // The API-side half of the same fix: a resource read that fails upstream now
    // carries the identical taxonomy a tool call would return for a 401, so an
    // agent can tell "your credentials expired" from "the server broke" without
    // parsing axios prose.
    const err = await h.client
      .readResource({ uri: "tastytrade://accounts/5WX00001/orders/live" })
      .then(
        () => null,
        (e: unknown) =>
          e as {
            code?: number;
            message: string;
            data?: { code?: string; upstream?: { status?: number } };
          },
      );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/status code 401/);
    expect(err!.data?.code).toBe("auth_failed");
    expect(err!.data?.upstream?.status).toBe(401);
  });

  it("classifies a 404 from a template read as not_found", async () => {
    h = await createHarness({
      routes: [{ matcher: "/watchlists/nope", reply: { status: 404 } }],
    });
    const err = await h.client
      .readResource({ uri: "tastytrade://watchlists/nope" })
      .then(
        () => null,
        (e: unknown) => e as { code?: number; data?: { code?: string } },
      );

    expect(err!.data?.code).toBe("not_found");
    // A 404 is the one upstream status that maps onto a real MCP code.
    expect(err!.code).toBe(MCP_ERROR_RESOURCE_NOT_FOUND);
  });

  it("still serves resources in read-only mode", async () => {
    const prev = process.env.TASTYTRADE_READ_ONLY;
    process.env.TASTYTRADE_READ_ONLY = "1";
    try {
      h = await createHarness({
        routes: [
          { matcher: "/customers/me/accounts", reply: { data: { items: [] } } },
        ],
      });
      // Resources are reads by construction, so read-only mode must not
      // withhold them the way it withholds write tools.
      const { resources } = await h.client.listResources();
      expect(resources).toHaveLength(STATIC_RESOURCES.length);
      expect(await readJson(h, "tastytrade://accounts")).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TASTYTRADE_READ_ONLY;
      else process.env.TASTYTRADE_READ_ONLY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// A malformed URI is a caller fault, and every failure carries the taxonomy
// ---------------------------------------------------------------------------

describe("resources/read on a malformed percent-escape", () => {
  /**
   * `decodeURIComponent` is not total, and the call that percent-decodes a captured
   * template segment sat on the one line of the ReadResource path no try/catch covered.
   * A bare `%`, or a truncated escape, throws a `URIError` that escapes untouched: the
   * SDK sees a non-numeric `code`, falls back to InternalError, and the client gets
   * `{code: -32603, message: "URI malformed"}` with no `data` at all.
   *
   * Three things are wrong with that, each pinned below: the client cannot branch on
   * `data.code` (the single contract the error layer exists to keep), the envelope never
   * passes through `sanitizeToolError` (the one agent-facing egress that skipped the
   * redaction gate), and "the server broke" is the wrong diagnosis for a URI the caller
   * mis-built.
   */
  const MALFORMED = [
    ["a bare percent", "%"],
    ["a truncated two-digit escape", "%z"],
    ["a non-hex escape", "%zz"],
    ["a truncated multi-byte sequence", "%E0%A4%A"],
  ] as const;

  it.each(MALFORMED)(
    "classifies %s as validation, not as an internal error",
    async (_label, segment) => {
      h = await createHarness();
      const err = await h.client
        .readResource({
          uri: `tastytrade://accounts/${segment}/positions`,
        })
        .then(
          () => null,
          (e: unknown) =>
            e as {
              code?: number;
              message: string;
              data?: { code?: string; retryable?: boolean; hint?: string };
            },
        );

      expect(err).not.toBeNull();
      // -32602 InvalidParams, the code the taxonomy maps `validation` onto —
      // and specifically NOT the InternalError this would fall back to.
      expect(err!.code).toBe(MCP_ERROR_INVALID_PARAMS);
      expect(err!.code).not.toBe(-32603);
      // The contract every other failure on this surface keeps.
      expect(err!.data?.code).toBe("validation");
      expect(err!.data?.retryable).toBe(false);
      expect(err!.data?.hint).toBeDefined();
      // It names the segment that was wrong, so the caller can fix it.
      expect(err!.message).toContain("account_number");
      // And no request was made: the URI never resolved to a template read.
      expect(h.requests).toHaveLength(0);
    },
  );

  it("does not leak the raw V8 message in place of the taxonomy", async () => {
    h = await createHarness();
    const err = await h.client
      .readResource({ uri: "tastytrade://watchlists/%" })
      .then(
        () => null,
        (e: unknown) => e as { message: string; data?: { code?: string } },
      );

    expect(err!.data?.code).toBe("validation");
    // "URI malformed" is a fixed V8 constant with no diagnostic value; the
    // replacement says which segment and what to do about it.
    expect(err!.message).not.toBe("URI malformed");
    expect(err!.message).toContain("name");
  });

  it("clips a hostile segment before echoing it into the refusal", async () => {
    h = await createHarness();
    const long = `${"A".repeat(400)}%`;
    const err = await h.client
      .readResource({ uri: `tastytrade://watchlists/${long}` })
      .then(
        () => null,
        (e: unknown) => e as { message: string },
      );

    // clipParam bounds every URI-derived value at 32 characters plus an
    // ellipsis, so a 400-character segment cannot size the reply.
    expect(err!.message).not.toContain("A".repeat(64));
    expect(err!.message).toContain("…");
  });

  it("still reads a legitimately percent-encoded segment", async () => {
    // The guard must reject only what `decodeURIComponent` cannot decode. A
    // properly encoded space decodes to "Core Holdings", which the api-client
    // then re-encodes for the path — so the round trip is lossless and the
    // resource reads exactly as it did before the guard existed.
    h = await createHarness({
      routes: [
        {
          matcher: /^\/watchlists\/Core(%20| )Holdings$/,
          reply: { data: { name: "Core Holdings" } },
        },
      ],
    });
    const body = await readJson(h, "tastytrade://watchlists/Core%20Holdings");
    expect(body).toEqual({ name: "Core Holdings" });
    expect(h.lastRequest()?.url).toMatch(/^\/watchlists\/Core(%20| )Holdings$/);
  });
});

// ---------------------------------------------------------------------------
// A resource is not a cheaper route to a metered endpoint than its tool
// ---------------------------------------------------------------------------

describe("resources/read pays the per-endpoint ceiling it reaches", () => {
  /**
   * The README tells the operator flatly that resources are not a way around
   * the budget". Before RESOURCE_RATE_KEYS that was true only of the global cap:
   * `chargeResourceRead` charged nothing per-endpoint, so
   * `tastytrade://accounts/{n}/positions` served fifty reads a second of GET
   * /accounts/{n}/positions while `tastytrade_get_positions` served one, against
   * a published upstream ceiling of one. These pin the claim.
   */
  const templatesWithKeys = Object.keys(RESOURCE_RATE_KEYS);

  it("declares a key for every 1:1 proxy of a ceilinged endpoint", () => {
    // Named explicitly rather than derived: a template dropped from the table
    // silently stops paying, and that is the regression worth catching.
    expect(templatesWithKeys.sort()).toEqual(
      [
        "tastytrade://accounts",
        "tastytrade://accounts/{account_number}/pnl-today",
        "tastytrade://accounts/{account_number}/positions",
        "tastytrade://accounts/{account_number}/summary",
      ].sort(),
    );
    expect(resourceRateKeys("tastytrade://accounts")).toEqual(["accounts"]);
    // The tightest, most-contended ceiling is charged at admission, so it is
    // declared first — see chargeResourceRead.
    expect(
      resourceRateKeys("tastytrade://accounts/{account_number}/summary")[0],
    ).toBe("positions");
  });

  it.each([
    ["tastytrade://accounts", "accounts"],
    [`tastytrade://accounts/5WX00001/positions`, "positions"],
    [`tastytrade://accounts/5WX00001/pnl-today`, "positions"],
    [`tastytrade://accounts/5WX00001/summary`, "positions"],
  ] as const)(
    "refuses a second read of %s inside one second, at the %s ceiling",
    async (uri, key) => {
      expect(PER_SECOND_LIMITS[key]).toBe(1);
      h = await createHarness({ fallback: { data: { items: [] } } });

      const first = await h.client.readResource({ uri }).then(
        () => ({ ok: true }) as const,
        () => ({ ok: false }) as const,
      );
      expect(first.ok).toBe(true);

      const second = await h.client.readResource({ uri }).then(
        () => null,
        (e: unknown) =>
          e as { data?: { code?: string; retry_after_ms?: number } },
      );
      expect(second).not.toBeNull();
      expect(second!.data?.code).toBe("rate_limit_exceeded");
      expect(second!.data?.retry_after_ms).toBeGreaterThan(0);
    },
  );

  it("leaves a template that reaches no published ceiling on the global cap", async () => {
    // The endpoint keys are an addition, not a replacement: a template with no
    // published ceiling must still read freely up to the global budget.
    h = await createHarness({ fallback: { data: { items: [] } } });
    for (let i = 0; i < 5; i++) {
      expect(await readJson(h, "tastytrade://watchlists")).toEqual([]);
    }
    expect(h.requests).toHaveLength(5);
  });

  /**
   * A fan-out debt is a record of requests that HAPPENED, so an exhausted
   * per-endpoint bucket cannot cancel the rest of it.
   *
   * `chargeResourceRead` would pay its post-admission debt with
   * `chargeRateLimit` in a try/catch that `break`s on the first refusal — the
   * exact shape `chargeUpstreamCallDebt` was written to eliminate. Because an
   * admitting charge is all-or-nothing, a debt that hit an empty per-endpoint
   * bucket never reached `global` either, and the `break` then forgave every
   * remaining key too. So one empty bucket in the middle of a template's key
   * list made the global cap under-count the very burst it exists to bound,
   * under a docstring in rate-limit.ts claiming this call site had already been
   * fixed.
   */
  it("still bills the global cap for a debt whose endpoint bucket is empty", async () => {
    // The summary template makes three requests and declares three keys, in
    // charge order: positions (admission), then balances and trading_status as
    // debt. Emptying `balances` puts the exhausted bucket in the MIDDLE, where
    // the old `break` swallowed trading_status along with it.
    expect(
      resourceRateKeys("tastytrade://accounts/{account_number}/summary"),
    ).toEqual(["positions", "balances", "trading_status"]);
    expect(PER_SECOND_LIMITS.balances).toBe(1);

    h = await createHarness({ fallback: { data: {} } });
    // The harness resolves the credential's account set at
    // construction and that lookup carries a global-bucket debt, so the budget
    // is re-zeroed here — what is counted below is this test's own spending.
    _resetRateLimitsForTest();
    chargeRateLimit({ rateKey: "balances" }); // 1 global token
    await readJson(h, "tastytrade://accounts/5WX00001/summary");
    expect(h.requests).toHaveLength(3);

    // 1 (the drain) + 3 (one admission + two debts) global tokens spent. Before
    // the fix this was 2: the balances debt refused and took trading_status's
    // and its own global token with it.
    let spent = 0;
    for (;;) {
      try {
        chargeRateLimit({});
        spent += 1;
      } catch {
        break;
      }
    }
    expect(spent).toBe(GLOBAL_PER_SECOND - 4);
  });

  it("charges the whole key list, not just up to the first empty bucket", async () => {
    // The same regression seen from the per-endpoint side: trading_status is
    // charged only as non-refusing debt, so the only way to observe whether it
    // was charged at all is that its 1/sec bucket is now empty.
    h = await createHarness({ fallback: { data: {} } });
    chargeRateLimit({ rateKey: "balances" });
    await readJson(h, "tastytrade://accounts/5WX00001/summary");

    let refused: ToolError | undefined;
    try {
      chargeRateLimit({ rateKey: "trading_status" });
    } catch (e) {
      refused = (e as { toolError: ToolError }).toolError;
    }
    expect(refused?.code).toBe("rate_limit_exceeded");
  });
});

// ---------------------------------------------------------------------------
// The resources/read transport is a SECOND front door into path construction, and its
// three apparent validators are not one.
//
//   1. `compileTemplate` turns `{account_number}` into `([^/]+)` — a FORMAT check, and
//      `..` contains no slash, so it matches.
//   2. `decodeSegment` calls `decodeURIComponent` on the capture, turning `%2e%2e`
//      back into `..`. Percent-encoding the payload is an ADDITIONAL entrance, not a
//      mitigation.
//   3. The client re-encodes it, and before `apiPath` the URL layer collapsed it:
//      `tastytrade://accounts/../positions` dialled `GET /positions?include-marks=true`.
//
// So this surface needs its own row rather than a line on the client's: the refusal has
// to hold for a value that arrived through a URI template and a decode.
// ---------------------------------------------------------------------------

/** Every request that reached the transport, as METHOD + path. */
function transportWire(): string[] {
  return (h as Harness).requests.map((r) => `${r.method} ${r.url}`);
}

const DOT_SEGMENT_URIS: ReadonlyArray<readonly [string, string]> = [
  [
    "a captured `..` on the positions template",
    "tastytrade://accounts/../positions",
  ],
  [
    "a captured `.` on the positions template",
    "tastytrade://accounts/./positions",
  ],
  [
    "the percent-encoded entrance decodeSegment turns back into `..`",
    "tastytrade://watchlists/%2e%2e",
  ],
];

describe("the resources/read transport cannot splice a path either", () => {
  beforeEach(async () => {
    h = await createHarness({
      routes: [{ matcher: /.*/, reply: { data: { items: [] } } }],
      // `.` and `..` are declared as accounts this
      // credential holds. That is a deliberately absurd account list, and it is
      // the point: the account-scope gate now refuses an unheld account BEFORE
      // the path is built, so without this every row below would pass because
      // the gate refused rather than because path construction did — the
      // control this file exists to pin would be measured by nothing.
      heldAccounts: [".", "..", "5WX00001"],
    });
  });

  it.each(DOT_SEGMENT_URIS)("refuses %s", async (_label, uri) => {
    let threw: unknown;
    let body = "";
    try {
      const res = (await (h as Harness).client.readResource({ uri })) as {
        contents?: Array<{ text?: string }>;
      };
      body = res.contents?.[0]?.text ?? "";
    } catch (e) {
      threw = e;
    }
    // Either the read is refused outright or it fails open with a diagnostic —
    // what must hold is that no request went out addressed to a path the URI
    // did not name.
    const dialled = transportWire();
    for (const line of dialled) {
      expect(line).not.toMatch(/\s\/$/);
      expect(line).not.toBe("GET /positions?include-marks=true");
      expect(line).not.toContain("/..");
      expect(line).not.toMatch(/\/\.($|\?)/);
    }
    // And it is visible as a failure rather than reported as data.
    const failed = threw !== undefined || body.includes("unavailable");
    expect(failed).toBe(true);
  });

  it("still reads an ordinary account's positions", async () => {
    const res = (await (h as Harness).client.readResource({
      uri: "tastytrade://accounts/5WX00001/positions",
    })) as { contents?: Array<{ text?: string }> };
    expect(res.contents?.[0]?.text).toBeDefined();
    expect(transportWire()).toContain("GET /accounts/5WX00001/positions");
  });

  it("still reads an ordinary watchlist", async () => {
    await (h as Harness).client.readResource({
      uri: "tastytrade://watchlists/Movers",
    });
    expect(transportWire()).toContain("GET /watchlists/Movers");
  });
});
