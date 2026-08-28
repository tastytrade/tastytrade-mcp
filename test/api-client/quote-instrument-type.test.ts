/**
 * `instrument_type` SELECTS a query parameter; it never NAMES one.
 *
 * `/market-data/by-type` takes the symbol list under a parameter named after the
 * instrument class — `equity=SPY` — so the caller's value lands in a KEY position.
 * Derived by `instrumentType.toLowerCase().replace(/ /g, "-")` it makes a well-formed
 * API parameter name out of anything, so it cannot fail and therefore cannot validate.
 * Measured on the wire:
 *
 *     instrument_type: "X Injected Key"     -> ?x-injected-key=SPY
 *     instrument_type: "PER-PAGE"           -> ?per-page=SPY
 *     instrument_type: "Include Instrument" -> ?include-instrument=SPY
 *
 * The third is the sharpest: it collides with this tool's OTHER parameter, so the
 * request the agent believes is a symbol query carries no symbol filter at all — and
 * is reported as an ordinary success.
 *
 * TypeScript does not help: the parameter is typed `InstrumentType`, types are erased
 * at build time, and the MCP SDK does not validate `tools/call` arguments against
 * `inputSchema`.
 *
 * The sibling `get_quote_snapshot` reaches the SAME endpoint on the SAME dimension and
 * already refuses an off-enum value with no request at all, because it looks the value
 * up in a closed map. That map is now the single source both surfaces read: the key
 * space becomes the map's server-authored value set, so no caller string can appear as
 * a query-parameter name.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { AxiosError, AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TastytradeClient, serializeParams } from "../../src/api-client.js";
import type { HttpAdapter } from "../../src/api-client.js";
import * as enums from "../../src/enums.js";
import { InstrumentType } from "../../src/enums.js";
import { adaptError } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";
import { createHarness } from "../e2e/harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

// Module-level buckets are shared by every harness in this file, and this suite
// makes more market-data reads than one bucket holds.
beforeEach(() => {
  _resetRateLimitsForTest();
});

const API_URL = "https://api.cert.tastyworks.com";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/**
 * The map, read off the enums module namespace rather than imported by name, so
 * this file compiles against the revision that has not moved it there yet.
 */
const MARKET_DATA_TYPE_PARAMS = (enums as unknown as Record<string, unknown>)[
  "MARKET_DATA_TYPE_PARAMS"
] as Record<string, string> | undefined;

// ============================================================================
// Fake transport — see ./README.md for why it is copied.
// ============================================================================

interface RecordedRequest {
  method: string;
  url: string;
  params: Record<string, unknown>;
  /** The query string the instance serializer would actually emit. */
  query: string;
}

interface FakeHttp {
  adapter: HttpAdapter;
  requests: RecordedRequest[];
  reply(data: unknown, init?: { status?: number }): void;
}

function createFakeHttp(): FakeHttp {
  const requests: RecordedRequest[] = [];
  const queue: { status: number; data: unknown }[] = [];

  const adapter: HttpAdapter = (config: InternalAxiosRequestConfig) => {
    const params = (config.params ?? {}) as Record<string, unknown>;
    requests.push({
      method: (config.method ?? "get").toUpperCase(),
      url: config.url ?? "",
      params,
      query: serializeParams(params),
    });

    const stub = queue.shift() ?? {
      status: 200,
      data: { data: { items: [] } },
    };
    const response: AxiosResponse = {
      data: stub.data,
      status: stub.status,
      statusText: String(stub.status),
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      request: {},
    };
    const validateStatus = config.validateStatus;
    if (!validateStatus || validateStatus(response.status)) {
      return Promise.resolve(response);
    }
    return Promise.reject(
      new AxiosError(
        `Request failed with status code ${response.status}`,
        AxiosError.ERR_BAD_REQUEST,
        config,
        {},
        response,
      ),
    );
  };

  return {
    adapter,
    requests,
    reply(data, init) {
      queue.push({ status: init?.status ?? 200, data });
    },
  };
}

function createTestClient() {
  const http = createFakeHttp();
  const client = new TastytradeClient(
    { apiUrl: API_URL },
    { adapter: http.adapter, tokenProvider: () => "test-access-token" },
  );
  return { client, http };
}

async function envelopeOf(call: Promise<unknown>): Promise<ToolError> {
  try {
    await call;
  } catch (error) {
    return adaptError(error);
  }
  throw new Error("expected the call to reject");
}

// ===========================================================================
// 1. Refusal, with no request sent
// ===========================================================================

describe("an off-enum instrument_type is refused before anything is dialled", () => {
  it.each([
    ["X Injected Key", "would have become ?x-injected-key=SPY"],
    ["PER-PAGE", "a key belonging to a different API dimension"],
    [
      "Include Instrument",
      "collides with this tool's own parameter, so no symbol filter is sent",
    ],
    ["toString", "an Object.prototype member, not an own property of the map"],
    ["constructor", "likewise"],
    ["", "an empty key"],
    ["equity", "the WIRE name, not the agent-facing one"],
  ])("refuses %p — %s", async (value) => {
    const { client, http } = createTestClient();
    const err = await envelopeOf(
      client.getQuote(["SPY"], value as InstrumentType),
    );

    expect(err.code).toBe("validation");
    expect(err.retryable).toBe(false);
    // Nothing was read and nothing was changed, which is what makes the refusal
    // safe to report as the caller's fault.
    expect(http.requests).toHaveLength(0);
    // The message names what IS accepted, so an agent can fix the call.
    expect(err.message).toMatch(/Equity Option/);
  });
});

// ===========================================================================
// 2. Non-regression: the six declared values still produce the same wire
// ===========================================================================

describe("every declared value still reaches the wire unchanged", () => {
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ["Equity", "equity"],
    ["Equity Option", "equity-option"],
    ["Index", "index"],
    ["Future", "future"],
    ["Future Option", "future-option"],
    ["Cryptocurrency", "cryptocurrency"],
  ];

  it.each(EXPECTED)("%s -> %s", async (declared, param) => {
    const { client, http } = createTestClient();
    await client.getQuote(["SPY", "QQQ"], declared as InstrumentType);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe("/market-data/by-type");
    expect(http.requests[0]!.query).toBe(`${param}=SPY&${param}=QQQ`);
  });

  it("still adds include-instrument alongside rather than colliding", async () => {
    const { client, http } = createTestClient();
    await client.getQuote(["SPY"], InstrumentType.Equity, {
      include_instrument: true,
    });
    expect(http.requests[0]!.query).toBe("equity=SPY&include-instrument=true");
  });

  it("defaults to Equity when the caller says nothing", async () => {
    const { client, http } = createTestClient();
    await client.getQuote("SPY");
    expect(http.requests[0]!.query).toBe("equity=SPY");
  });
});

// ===========================================================================
// 3. ONE map, for both surfaces
// ===========================================================================

describe("both surfaces on this dimension read one map", () => {
  it("exports the map from the module that owns the wire values", () => {
    expect(MARKET_DATA_TYPE_PARAMS).toBeDefined();
    expect(typeof MARKET_DATA_TYPE_PARAMS).toBe("object");
  });

  it("derives the parameter name from a closed map, not the caller's text", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src", "api-client.ts"),
      "utf8",
    );
    // Bounded at the next method declaration, not at the first `\n  }`: the
    // method's own nested blocks close at that indentation too, so the naive
    // split ran past the end and picked up a neighbour's `toLowerCase()`.
    const from = source.indexOf("  async getQuote(");
    expect(from).toBeGreaterThan(-1);
    const body = source
      .slice(from)
      .split(/\n {2}(?:async |private |\/\*\*)/)[0];
    expect(body).toContain("MARKET_DATA_TYPE_PARAMS");
    // Comments stripped first: the doc comment QUOTES the deleted derivation, and
    // a scan a comment can satisfy is a scan that says nothing.
    const code = body.replace(/^\s*\/\/[^\n]*$/gm, "");
    // The normalizer that could not fail, and therefore could not validate.
    expect(code).not.toMatch(/toLowerCase\(\)/);
    expect(code).not.toMatch(/\.replace\(/);
    // And the lookup is guarded, because the value crosses the trust boundary
    // and a bare index answers `toString` with an Object.prototype member.
    expect(body).toMatch(/hasOwnProperty/);
  });

  it("keeps exactly one copy of the map in src/", () => {
    // Two maps for one dimension is how they drift, and this repository has
    // already paid that bill once (see credential-target.ts's header).
    const files = ["api-client.ts", "mcp-server/index.ts", "enums.ts"];
    const declaring = files.filter((file) =>
      /"Equity Option":\s*"equity-option"/.test(
        readFileSync(path.join(REPO_ROOT, "src", file), "utf8"),
      ),
    );
    expect(declaring).toEqual(["enums.ts"]);
  });

  it("agrees with the tool schema's declared enum, both ways", async () => {
    if (!MARKET_DATA_TYPE_PARAMS) throw new Error("map not exported");
    // Read off the live tools/list, which is what an agent sees, so a schema
    // edit cannot silently outrun the map in either direction.
    const h = await createHarness();
    try {
      const listed = await h.client.listTools();
      const tool = listed.tools.find((t) => t.name === "tastytrade_get_quote");
      const declared = (
        tool!.inputSchema as unknown as {
          properties: { instrument_type: { enum: string[] } };
        }
      ).properties.instrument_type.enum;
      expect(Object.keys(MARKET_DATA_TYPE_PARAMS).sort()).toEqual(
        [...declared].sort(),
      );
    } finally {
      await h.close();
    }
  });

  it("produces the same parameter name as the sibling snapshot tool", async () => {
    if (!MARKET_DATA_TYPE_PARAMS) throw new Error("map not exported");
    for (const declared of Object.keys(MARKET_DATA_TYPE_PARAMS)) {
      // Per iteration: /market-data/by-type carries its own published ceiling,
      // and six calls in one test exhaust it.
      _resetRateLimitsForTest();
      const h = await createHarness({
        routes: [
          {
            matcher: "/market-data/by-type",
            method: "GET",
            reply: { data: { items: [] } },
          },
        ],
      });
      try {
        await h.client.callTool({
          name: "tastytrade_get_quote_snapshot",
          arguments: {
            symbols: [{ symbol: "SPY", instrument_type: declared }],
          },
        });
        expect(h.requests).toHaveLength(1);
        expect(Object.keys(h.requests[0]!.params)).toEqual([
          MARKET_DATA_TYPE_PARAMS[declared],
        ]);
      } finally {
        await h.close();
      }
    }
  });
});

// ===========================================================================
// 4. The allowlist is a CLOSED set on the tool surface too
// ===========================================================================

/**
 * Section 1 proves the refusal at the client method with two prototype keys. This
 * proves it through the TOOL — the second surface on this dimension — and over the
 * whole Object.prototype own-property set rather than a sample.
 *
 * That map is the only runtime enforcement of the declared enum: the low-level MCP
 * server does not validate `tools/call` arguments against `inputSchema`. A bare index
 * would double-check nothing — it is not a membership test on an object literal,
 * because every `Object.prototype` member answers it: eleven functions, and
 * `Object.prototype` itself for `__proto__`. `if (!param)` admits all of them, and each
 * becomes a live authenticated request whose query KEY is a stringified function or
 * `[object Object]=SPY`.
 *
 * The guard is present and has been since the map moved into src/enums.ts. Nothing
 * measured it on this surface, which is the gap these close: the sweep fails if the
 * guard is reverted to a bare index (verified by reverting it), and the counterweight
 * below fails if it is ever tightened into refusing a value the map declares.
 */
describe("the snapshot tool's allowlist is a closed set", () => {
  /** Every own property of Object.prototype, derived rather than listed. */
  const PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype);

  /** The ToolError envelope a refused `tools/call` carries. */
  function snapshotEnvelope(res: unknown): { code?: string } {
    const text =
      (res as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    try {
      return JSON.parse(text) as { code?: string };
    } catch {
      return {};
    }
  }

  it("refuses every own property of Object.prototype with an empty wire", async () => {
    // Derived, not listed: the set has grown across V8 versions, and a test that
    // restates it stops covering whichever member is added next.
    expect(PROTO_KEYS.length).toBeGreaterThanOrEqual(12);
    expect(PROTO_KEYS).toContain("constructor");
    expect(PROTO_KEYS).toContain("__proto__");
    expect(PROTO_KEYS).toContain("toString");

    const h = await createHarness({
      routes: [
        {
          matcher: "/market-data/by-type",
          method: "GET",
          reply: { data: { items: [] } },
        },
      ],
    });
    try {
      for (const key of PROTO_KEYS) {
        // /market-data/by-type publishes its own per-second ceiling and the
        // pre-flight charges it whether or not the call goes on to dispatch.
        _resetRateLimitsForTest();
        const res = await h.client.callTool({
          name: "tastytrade_get_quote_snapshot",
          arguments: { symbols: [{ symbol: "SPY", instrument_type: key }] },
        });
        // Keyed so a failure names the member that got through.
        expect({ key, code: snapshotEnvelope(res).code }).toEqual({
          key,
          code: "validation",
        });
      }
      // Not one of them reached the wire — asserted over the whole sweep rather
      // than per iteration, so a single leak anywhere fails the test.
      expect(h.requests).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("still dispatches every value the map declares", async () => {
    // The counterweight: a guard that refused everything would satisfy the
    // sweep above.
    if (!MARKET_DATA_TYPE_PARAMS) throw new Error("map not exported");
    for (const declared of Object.keys(MARKET_DATA_TYPE_PARAMS)) {
      _resetRateLimitsForTest();
      const h = await createHarness({
        routes: [
          {
            matcher: "/market-data/by-type",
            method: "GET",
            reply: { data: { items: [] } },
          },
        ],
      });
      try {
        const res = await h.client.callTool({
          name: "tastytrade_get_quote_snapshot",
          arguments: {
            symbols: [{ symbol: "SPY", instrument_type: declared }],
          },
        });
        expect(res.isError).not.toBe(true);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0]!.params).toEqual({
          [MARKET_DATA_TYPE_PARAMS[declared]!]: ["SPY"],
        });
      } finally {
        await h.close();
      }
    }
  });

  it("leaves Object.prototype unpolluted", async () => {
    // The bound the finding's PoC established, kept measured: the resolved value
    // is stringified into a bucket KEY, and nothing is ever assigned to the
    // prototype. True before the guard and after it — a bound, not a detector.
    _resetRateLimitsForTest();
    const h = await createHarness();
    try {
      await h.client.callTool({
        name: "tastytrade_get_quote_snapshot",
        arguments: {
          symbols: [{ symbol: "SPY", instrument_type: "__proto__" }],
        },
      });
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).SPY).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  it("reads the map through an own-property guard and accumulates without a prototype", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src", "mcp-server", "index.ts"),
      "utf8",
    );
    const from = source.indexOf("function buildQuoteSnapshotBuckets(");
    expect(from).toBeGreaterThan(-1);
    const body = source.slice(from).split("\n}\n")[0]!;
    // Comments stripped first: the prose beside both guards NAMES the bare index
    // and the plain-object accumulator they replaced, so a scan a comment can
    // satisfy is a scan that says nothing.
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*$/gm, "");
    // Non-vacuity: the stripped body still contains the lookup, so the
    // assertions below are about live code.
    expect(code).toMatch(/MARKET_DATA_TYPE_PARAMS/);
    expect(code).toMatch(/hasOwnProperty/);
    // The accumulator's prototype is asserted structurally on purpose, and the
    // reason is worth writing down: the resolved parameter name comes from the
    // map's server-authored VALUE set, so no behavioural test can tell `{}` from
    // `Object.create(null)` here today. An assertion on the outbound params
    // object would pass either way, because the client builds `{ ...buckets }`
    // and a spread copies only own enumerable keys. So the claim is made where
    // it can be checked rather than somewhere it would look checked.
    expect(code).toMatch(/Object\.create\(null\)/);
    expect(code).not.toMatch(/buckets[^\n]*=\s*\{\}/);
  });
});
