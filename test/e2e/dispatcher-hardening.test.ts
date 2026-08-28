/**
 * Dispatcher hardening: four holes an adversarial review opened up, each pinned end to
 * end through the real protocol handlers.
 *
 *  1. `resources/read` was outside the rate limiter entirely — `chargeRateLimit` had
 *     one call site, the CallTool pre-flight — so a client using resources instead of
 *     tools reached the broker with no budget, and the account-summary template
 *     multiplied each read into three upstream calls on top. A read is now billed once
 *     per upstream call AND against every published endpoint ceiling it reaches, the
 *     second half closing the follow-on hole where a resource was a 50x cheaper route
 *     to a 1/sec endpoint than its own tool.
 *  2. The hand-built error envelopes bypassed `sanitizeToolError`, the redaction gate
 *     declared mandatory for anything handed to an agent.
 *  3. `TOOL_ANNOTATIONS[name]` is not a membership test: `toString`, `constructor` and
 *     `__proto__` answered with an `Object.prototype` member and walked past the
 *     unknown-tool branch.
 *  4. The live-trading banner printed `TASTYTRADE_API_URL` verbatim, so a password in
 *     the URL's userinfo went to stderr.
 *
 * Two mechanics before editing: the token buckets are MODULE state shared by every
 * server in the process, so each test starts from an explicit reset; and the clock is
 * frozen with `setSystemTime` rather than advanced, which stops the buckets refilling
 * mid-test without firing the MCP SDK's per-request timeout timers, so every token count
 * here is exact.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { createHarness, type Harness } from "./harness.js";
import {
  chargeRateLimit,
  _resetRateLimitsForTest,
  GLOBAL_PER_SECOND,
  PER_SECOND_LIMITS,
  type RateKey,
} from "../../src/safety/rate-limit.js";
import { RESOURCE_TEMPLATES } from "../../src/mcp-server/resources.js";
import {
  TastytradeMCPServer,
  TOOL_ANNOTATIONS,
  RESOURCE_UPSTREAM_CALLS,
  MCP_ERROR_INTERNAL,
  PRODUCTION_API_URL,
  SANDBOX_API_URL,
  READ_ONLY_ENV_VAR,
  apiEndpointForDisplay,
  lookupRegistered,
  resourceReadCost,
  RESOURCE_RATE_KEYS,
  resourceRateKeys,
  warnIfProductionApi,
} from "../../src/mcp-server/index.js";
import {
  ALLOW_UNKNOWN_API_HOST_ENV_VAR,
  MAX_ECHOED_URL_CHARS,
} from "../../src/credential-target.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCOUNT = "5WX00001";

/**
 * The internal order cap. Restated rather than imported: it is a safety
 * backstop mirroring the upstream API, not part of the published policy, and
 * src/safety/rate-limit.ts deliberately does not export it.
 */
const ORDER_CAP_PER_SECOND = 20;

/** The shape the SDK client rejects with when a handler throws. */
interface RpcError {
  code?: number;
  message: string;
  data?: {
    code?: string;
    retryable?: boolean;
    retry_after_ms?: number;
    hint?: string;
  };
}

/** Spends a bucket dry and returns how many charges it still admitted. */
function drain(opts: Parameters<typeof chargeRateLimit>[0]): number {
  let left = 0;
  for (;;) {
    try {
      chargeRateLimit(opts);
      left += 1;
    } catch {
      return left;
    }
  }
}

/**
 * How many global tokens have been charged since the last reset — the count of
 * upstream calls this server has admitted, whatever endpoint they went to.
 *
 * Destructive, and destructive of everything: an unkeyed charge only debits the
 * global bucket, but once global is empty no other bucket can be measured,
 * because a charge is admitted only if EVERY bucket it draws on can pay. Call
 * this once, last.
 */
function spentGlobal(): number {
  return GLOBAL_PER_SECOND - drain({});
}

/**
 * How many tokens have been charged against one endpoint bucket. Spends that
 * bucket, and the global tokens the measurement itself costs, so run it before
 * `spentGlobal()` and account for the difference.
 */
function spentOn(key: RateKey): number {
  return PER_SECOND_LIMITS[key] - drain({ rateKey: key });
}

/** Reads a resource, returning the rejection instead of throwing it. */
async function readOrError(
  h: Harness,
  uri: string,
): Promise<{ ok: boolean; error?: RpcError }> {
  return h.client.readResource({ uri }).then(
    () => ({ ok: true }),
    (e: unknown) => ({ ok: false, error: e as RpcError }),
  );
}

/** Reads a resource, asserting it succeeded. */
async function readOk(h: Harness, uri: string): Promise<string> {
  const res = await h.client.readResource({ uri });
  expect(res.contents).toHaveLength(1);
  return String((res.contents[0] as { text?: string }).text ?? "");
}

/** Reads a resource, asserting it was refused, and returns the RPC error. */
async function readRefused(h: Harness, uri: string): Promise<RpcError> {
  const outcome = await readOrError(h, uri);
  if (outcome.ok) throw new Error(`Expected ${uri} to be refused`);
  return outcome.error!;
}

/** Calls a tool and returns the envelope without asserting on success. */
async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; payload: any }> {
  const res = (await h.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = res.content?.[0]?.text ?? "";
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { isError: res.isError === true, payload };
}

/** Run fn with the console captured, so startup output can be asserted on. */
function captureConsole<T>(fn: () => T): {
  result: T;
  stderr: string[];
  stdoutWrites: number;
  logs: number;
} {
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const outSpy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((() => true) as any);
  try {
    const result = fn();
    return {
      result,
      stderr: errSpy.mock.calls.map((c) => String(c[0])),
      stdoutWrites: outSpy.mock.calls.length,
      logs: logSpy.mock.calls.length,
    };
  } finally {
    outSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/**
 * One concrete URI per registered template. An invariant test below asserts
 * this covers the registry, so adding a template forces a decision about what
 * a read of it costs.
 */
const TEMPLATE_URIS: Record<string, string> = {
  "tastytrade://accounts": "tastytrade://accounts",
  "tastytrade://accounts/{account_number}/summary": `tastytrade://accounts/${ACCOUNT}/summary`,
  "tastytrade://accounts/{account_number}/positions": `tastytrade://accounts/${ACCOUNT}/positions`,
  "tastytrade://accounts/{account_number}/orders/live": `tastytrade://accounts/${ACCOUNT}/orders/live`,
  "tastytrade://accounts/{account_number}/pnl-today": `tastytrade://accounts/${ACCOUNT}/pnl-today`,
  "tastytrade://accounts/{account_number}/nlv-history/{range}": `tastytrade://accounts/${ACCOUNT}/nlv-history/1m`,
  "tastytrade://watchlists": "tastytrade://watchlists",
  "tastytrade://watchlists/{name}": "tastytrade://watchlists/Core",
  "tastytrade://public-watchlists": "tastytrade://public-watchlists",
  "tastytrade://public-watchlists/{name}":
    "tastytrade://public-watchlists/Ideas",
  "tastytrade://market/session": "tastytrade://market/session",
  "tastytrade://market/holidays": "tastytrade://market/holidays",
};

const SUMMARY_URI = `tastytrade://accounts/${ACCOUNT}/summary`;

let h: Harness;
let previousReadOnly: string | undefined;

beforeEach(async () => {
  previousReadOnly = process.env[READ_ONLY_ENV_VAR];
  delete process.env[READ_ONLY_ENV_VAR];

  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-03-14T15:00:00.000Z"));

  // Every unrouted request answers `{ data: { items: [] } }`, which is a shape
  // every template can read, so each read succeeds and the token count is not
  // confused by an incidental refusal.
  h = await createHarness({ fallback: { data: { items: [] } } });

  // The reset moved BELOW createHarness. The harness now
  // resolves the credential's account set at construction (see its warm-up),
  // and that lookup is a real broker request which carries a real global-bucket
  // debt — so a reset above it left every `spentGlobal()` figure in this file
  // one token high. After the clock is frozen either way, which is what
  // makeBucket()'s Date.now() stamp needs.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h.close();
  jest.useRealTimers();
  _resetRateLimitsForTest();
  if (previousReadOnly === undefined) delete process.env[READ_ONLY_ENV_VAR];
  else process.env[READ_ONLY_ENV_VAR] = previousReadOnly;
});

// ---------------------------------------------------------------------------
// 1. resources/read is inside the rate limiter
// ---------------------------------------------------------------------------

describe("resources/read is metered, by fan-out and by endpoint", () => {
  it("declares a cost for every registered template, and only for real ones", () => {
    const registered = RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
    // The URI corpus below must cover the registry, or a new template would
    // silently escape every cost assertion in this file.
    expect(Object.keys(TEMPLATE_URIS).sort()).toEqual([...registered].sort());
    // The cost table names only real templates: a typo or a rename there would
    // otherwise mean a fan-out template quietly billed as one call.
    for (const uriTemplate of Object.keys(RESOURCE_UPSTREAM_CALLS)) {
      expect(registered).toContain(uriTemplate);
      // An entry of 1 is the default; listing it would just be noise.
      expect(resourceReadCost(uriTemplate)).toBeGreaterThan(1);
    }
  });

  it.each(Object.entries(TEMPLATE_URIS))(
    "charges %s exactly as many tokens as it makes upstream calls",
    async (uriTemplate, uri) => {
      await readOk(h, uri);

      const calls = h.requests.length;
      expect(calls).toBeGreaterThan(0);
      // The declared cost is what the template really does, measured rather
      // than asserted from the table — so a template that grows a second
      // upstream call fails here instead of under-charging in production.
      expect(resourceReadCost(uriTemplate)).toBe(calls);
      expect(spentGlobal()).toBe(calls);
    },
  );

  it("charges the fan-out template three tokens, because it makes three calls", async () => {
    await readOk(h, SUMMARY_URI);

    expect(h.requests.map((r) => r.url).sort()).toEqual([
      `/accounts/${ACCOUNT}/balances`,
      `/accounts/${ACCOUNT}/positions`,
      `/accounts/${ACCOUNT}/trading-status`,
    ]);
    expect(spentGlobal()).toBe(3);
  });

  it("charges every published endpoint ceiling the template actually reaches", async () => {
    // Billing a resource read to the global cap ALONE was the honest hole left
    // by the first pass. The summary read is one GET each of balances,
    // positions and trading-status, and all three have a published 1/sec
    // ceiling — so "no single endpoint to bill it to" came out as "no endpoint
    // ceiling applies at all", and the resource surface became a 50x cheaper
    // route to those GETs than the tools the ceilings were written for.
    // RESOURCE_RATE_KEYS declares what a template spends; this pins that the
    // declaration is actually charged.
    await readOk(h, SUMMARY_URI);

    expect(spentOn("positions")).toBe(1);
    expect(spentOn("balances")).toBe(1);
    expect(spentOn("trading_status")).toBe(1);
    // An endpoint the template never reaches stays untouched.
    expect(spentOn("market_data")).toBe(0);
  });

  it("makes a resource no cheaper a route to a 1/sec endpoint than its tool", async () => {
    // The finding stated as the property that closes it. GET
    // /accounts/{n}/positions is published at 1/sec and
    // `tastytrade_get_positions` is keyed to it; the resource would serve
    // fifty reads of the same GET inside the same second.
    let succeeded = 0;
    for (let i = 0; i < 20; i++) {
      const uri = `tastytrade://accounts/${ACCOUNT}/positions`;
      if ((await readOrError(h, uri)).ok) succeeded += 1;
    }

    expect(succeeded).toBe(PER_SECOND_LIMITS.positions);
    expect(h.requests).toHaveLength(PER_SECOND_LIMITS.positions);
  });

  it("declares a rate key only for templates that reach a published ceiling", () => {
    const registered = RESOURCE_TEMPLATES.map((t) => t.uriTemplate);
    for (const uriTemplate of Object.keys(RESOURCE_RATE_KEYS)) {
      // A typo or a rename here silently stops a template paying its endpoint
      // ceiling, which is the regression this whole section exists to catch.
      expect(registered).toContain(uriTemplate);
      expect(resourceRateKeys(uriTemplate).length).toBeGreaterThan(0);
    }
    // A template can never declare more ceilings than it makes upstream calls:
    // that would charge for a request it does not issue.
    for (const uriTemplate of registered) {
      expect(resourceRateKeys(uriTemplate).length).toBeLessThanOrEqual(
        resourceReadCost(uriTemplate),
      );
    }
  });

  it("bounds broker traffic through resources, amplification included", async () => {
    // The review drove 130 upstream calls in seconds by reading resources in a
    // loop against a budget that did not apply to them. Sixty attempts at the
    // 3x template inside one second now buy ONE read and three upstream calls:
    // admission charges `positions`, the tightest ceiling the template spends,
    // and that bucket holds one token per second.
    let succeeded = 0;
    let refused = 0;
    for (let i = 0; i < 60; i++) {
      const outcome = await readOrError(h, SUMMARY_URI);
      if (outcome.ok) succeeded += 1;
      else {
        refused += 1;
        expect(outcome.error?.data?.code).toBe("rate_limit_exceeded");
      }
    }

    expect(succeeded).toBe(PER_SECOND_LIMITS.positions);
    expect(refused).toBe(60 - succeeded);
    expect(h.requests).toHaveLength(succeeded * 3);
    // Far under the global cap, because the endpoint ceiling binds first —
    // which is the entire point of charging it.
    expect(h.requests.length).toBeLessThan(GLOBAL_PER_SECOND);
  });

  it("bounds a one-call template at the global cap exactly", async () => {
    // Unmetered, this loop reached the broker sixty times.
    let succeeded = 0;
    for (let i = 0; i < 60; i++) {
      if ((await readOrError(h, "tastytrade://watchlists")).ok) succeeded += 1;
    }

    expect(succeeded).toBe(GLOBAL_PER_SECOND);
    expect(h.requests).toHaveLength(GLOBAL_PER_SECOND);
  });

  it("refuses once the budget is empty, with the real taxonomy on the JSON-RPC error", async () => {
    // Drained without any resource read at all, so this is unambiguously the
    // same budget the tool path spends.
    for (let i = 0; i < GLOBAL_PER_SECOND; i++) chargeRateLimit({});

    const err = await readRefused(
      h,
      `tastytrade://accounts/${ACCOUNT}/orders/live`,
    );

    // rate_limit_exceeded has no numeric MCP code, so it lands on the spec's
    // InternalError fallback with the taxonomy in `data` — the same treatment
    // auth_failed gets on this path.
    expect(err.code).toBe(MCP_ERROR_INTERNAL);
    expect(err.data?.code).toBe("rate_limit_exceeded");
    expect(err.data?.retryable).toBe(true);
    expect(err.data?.retry_after_ms).toBe(20); // 50/sec = one token per 20ms
    expect(err.message).toContain('"global"');
    // A refusal that still hit the broker would be pointless.
    expect(h.requests).toHaveLength(0);
  });

  it("refuses cleanly rather than crashing the session", async () => {
    for (let i = 0; i < GLOBAL_PER_SECOND; i++) chargeRateLimit({});
    await readRefused(h, SUMMARY_URI);

    // A protocol error, not a broken transport: the same client keeps working.
    expect(await readOk(h, "tastytrade://streaming-reference")).toContain(
      "DXLink",
    );
    const tools = await h.client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it("does not consume a token when it refuses, so the refusal is not self-worsening", async () => {
    for (let i = 0; i < GLOBAL_PER_SECOND; i++) chargeRateLimit({});

    for (let i = 0; i < 10; i++) {
      const err = await readRefused(h, SUMMARY_URI);
      // Unchanged across ten refusals: the clock is frozen and nothing was
      // charged, so the backoff counts down on the wall clock alone.
      expect(err.data?.retry_after_ms).toBe(20);
    }
  });

  it("forgives the remaining fan-out debt rather than refusing an admitted read", async () => {
    // One global token left, and a read that costs three. Admission is a
    // single charge, so the read is allowed; the two it cannot pay are
    // dropped, and the next read is the one that gets refused. The
    // alternative — charging three in a loop — would drain the last token AND
    // refuse, livelocking a client that retries.
    for (let i = 0; i < GLOBAL_PER_SECOND - 1; i++) chargeRateLimit({});

    await readOk(h, SUMMARY_URI);
    expect(h.requests).toHaveLength(3);

    // The overrun is bounded: the bucket is empty, so nothing else gets in.
    await readRefused(h, SUMMARY_URI);
    expect(h.requests).toHaveLength(3);
    expect(drain({})).toBe(0);
  });

  it("leaves the order budget alone", async () => {
    await readOk(h, SUMMARY_URI);

    // A resource read is a GET. It must never spend the backstop an agent
    // needs in order to cancel a working order.
    expect(drain({ destructive: true })).toBe(ORDER_CAP_PER_SECOND);
  });

  it("does not meter the static markdown bundles, which cost the broker nothing", async () => {
    for (let i = 0; i < GLOBAL_PER_SECOND; i++) chargeRateLimit({});

    for (const uri of [
      "tastytrade://streaming-reference",
      "tastytrade://symbology-reference",
      "tastytrade://order-flow-reference",
    ]) {
      expect((await readOk(h, uri)).length).toBeGreaterThan(100);
    }
    expect(h.requests).toHaveLength(0);
  });

  it("charges nothing for a URI that matches no template", async () => {
    for (let i = 0; i < 100; i++) {
      const err = await readRefused(h, `tastytrade://nope-${i}`);
      expect(err.data?.code).toBe("not_found");
    }

    // A hundred misses is twice the global budget; none of them reached the
    // limiter, because nothing upstream was ever going to be called.
    expect(spentGlobal()).toBe(0);
    expect(h.requests).toHaveLength(0);
  });

  it("still charges a read whose upstream call fails, so failure is not a free ride", async () => {
    h.route({
      matcher: `/accounts/${ACCOUNT}/orders/live`,
      reply: { status: 500 },
    });

    const err = await readRefused(
      h,
      `tastytrade://accounts/${ACCOUNT}/orders/live`,
    );
    expect(err.data?.code).toBe("upstream_error");
    expect(spentGlobal()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Hand-built error envelopes go through the redaction gate
// ---------------------------------------------------------------------------

describe("every error envelope passes the redaction gate", () => {
  const SECRET = "cs-live-NOT-A-REAL-CLIENT-SECRET-FIXTURE";
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.TASTYTRADE_CLIENT_SECRET;
    process.env.TASTYTRADE_CLIENT_SECRET = SECRET;
  });

  afterEach(() => {
    if (previousSecret === undefined)
      delete process.env.TASTYTRADE_CLIENT_SECRET;
    else process.env.TASTYTRADE_CLIENT_SECRET = previousSecret;
  });

  it("redacts a credential echoed into a hand-built envelope", async () => {
    // tastytrade_get_position builds its not_found envelope directly, quoting
    // the symbol it was given. That envelope never went through
    // sanitizeToolError, so a caller-supplied argument reached the agent (and
    // its transcript) unfiltered — here the configured client secret, passed as
    // a symbol by a confused or prompt-injected agent.
    h.route({
      matcher: `/accounts/${ACCOUNT}/positions`,
      reply: { data: { items: [] } },
    });

    const { isError, payload } = await call(h, "tastytrade_get_position", {
      account_number: ACCOUNT,
      symbol: SECRET,
    });

    expect(isError).toBe(true);
    const err = payload as ToolError;
    expect(err.code).toBe("not_found");
    expect(JSON.stringify(err)).not.toContain(SECRET);
    // Scrubbed, not dropped: the envelope still explains itself.
    expect(err.message).toContain("[redacted]");
    expect(err.message).toContain(ACCOUNT);
  });
});

describe("the sanitized path is not sanitized twice", () => {
  it("leaves a redacted upstream body reading [redacted], not [redacted]]", async () => {
    // adaptError already applies the gate, so the dispatcher's catch-all must
    // not apply it again: redaction is not idempotent — a second pass rewrites
    // `client_secret=[redacted]` to `client_secret=[redacted]]`.
    h.route({
      matcher: `/accounts/${ACCOUNT}/balances`,
      reply: {
        status: 422,
        raw: true,
        data: {
          error: { detail: "client_secret=NOT_A_REAL_CLIENT_SECRET_FIXTURE" },
        },
      },
    });

    const { isError, payload } = await call(h, "tastytrade_get_balances", {
      account_number: ACCOUNT,
    });

    expect(isError).toBe(true);
    const body = (payload as ToolError).upstream?.body as any;
    expect(body.error.detail).toBe("client_secret=[redacted]");
    expect(JSON.stringify(payload)).not.toContain("[redacted]]");
  });
});

// ---------------------------------------------------------------------------
// 3. Object.prototype members are not tools
// ---------------------------------------------------------------------------

const PROTOTYPE_NAMES = [
  "constructor",
  "__proto__",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
] as const;

describe("a prototype member is not a tool", () => {
  it("answers a bare index but not a guarded lookup", () => {
    for (const name of PROTOTYPE_NAMES) {
      // The hazard itself, stated: a plain object literal answers every one of
      // these, which is why the dispatcher cannot use `TABLE[name]` as a
      // membership test on a name that arrived over the wire.
      expect((TOOL_ANNOTATIONS as Record<string, unknown>)[name]).toBeDefined();
      expect(lookupRegistered(TOOL_ANNOTATIONS, name)).toBeUndefined();
    }
    // The guard is not simply "always undefined".
    expect(
      lookupRegistered(TOOL_ANNOTATIONS, "tastytrade_get_accounts"),
    ).toBeDefined();
  });

  it.each(PROTOTYPE_NAMES)(
    "refuses tools/call for %s as not_found",
    async (name) => {
      const { isError, payload } = await call(h, name);

      expect(isError).toBe(true);
      const err = payload as ToolError;
      expect(err.code).toBe("not_found");
      expect(err.message).toContain("Unknown tool");
      expect(err.message).toContain(name);
      expect(err.retryable).toBe(false);
      // The pre-flight's unknown-tool refusal, which carries a hint, and NOT the
      // bare `default:` at the end of handleToolCall — reaching that one means the
      // name passed the annotation guard and was billed to a bucket on the way.
      expect(err.hint).toMatch(/tools\/list/);
      expect(h.requests).toHaveLength(0);
    },
  );

  it("refuses them before the limiter, so they cannot drain a budget", async () => {
    // The access classifier saw no hints on the impostor and read it as a
    // WRITE, so twenty of these would empty a budget a real order needs.
    for (let round = 0; round < 10; round++) {
      for (const name of PROTOTYPE_NAMES) {
        expect((await call(h, name)).isError).toBe(true);
      }
    }

    // Eighty impostor calls, and the order backstop and every endpoint budget
    // are untouched — measured before the global probe, which spends them.
    expect(drain({ destructive: true })).toBe(ORDER_CAP_PER_SECOND);
    expect(spentOn("positions")).toBe(0);
    expect(spentOn("market_data")).toBe(0);
    // The global measurement now has to account for the probes above.
    expect(spentGlobal()).toBe(
      ORDER_CAP_PER_SECOND +
        PER_SECOND_LIMITS.positions +
        PER_SECOND_LIMITS.market_data,
    );
  });

  it("refuses them as not_found in read-only mode, not as a disabled tool", async () => {
    // The misclassification was load-bearing here: an impostor read as a write
    // tool, so read-only mode answered "that tool is disabled" — telling a
    // caller a nonexistent tool exists.
    process.env[READ_ONLY_ENV_VAR] = "1";
    // The constructor announces read-only mode on stderr; silenced so the
    // suite's output stays readable.
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let ro: Harness;
    try {
      ro = await createHarness();
    } finally {
      errSpy.mockRestore();
    }

    try {
      for (const name of PROTOTYPE_NAMES) {
        const { payload } = await call(ro, name);
        expect((payload as ToolError).code).toBe("not_found");
      }
      // Read-only mode really is on — otherwise the assertions above would
      // pass for the wrong reason.
      const real = await call(ro, "tastytrade_place_order", {
        account_number: ACCOUNT,
      });
      expect((real.payload as ToolError).code).toBe("read_only_mode");
    } finally {
      await ro.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The production banner never echoes URL userinfo
// ---------------------------------------------------------------------------

describe("the live-trading banner prints an origin, not a credential", () => {
  const PASSWORD = "NOT-A-REAL-PASSWORD-FIXTURE-000000";
  const WITH_USERINFO = `https://apiuser:${PASSWORD}@api.tastyworks.com`;

  it("reduces a configured URL to scheme, host and port", () => {
    expect(apiEndpointForDisplay(PRODUCTION_API_URL)).toBe(PRODUCTION_API_URL);
    expect(apiEndpointForDisplay(SANDBOX_API_URL)).toBe(SANDBOX_API_URL);
    expect(apiEndpointForDisplay(WITH_USERINFO)).toBe(PRODUCTION_API_URL);
    // A password may legally contain `@`; the authority splits at the last one.
    expect(
      apiEndpointForDisplay("https://apiuser:p@ss@api.tastyworks.com"),
    ).toBe(PRODUCTION_API_URL);
    // Port kept (it identifies the environment); path, query and fragment
    // dropped, because any of them can carry a token too.
    expect(
      apiEndpointForDisplay(
        "https://u:p@api.tastyworks.com:8443/v1?token=abc#frag",
      ),
    ).toBe("https://api.tastyworks.com:8443");
    expect(apiEndpointForDisplay(undefined)).toBe("");
    expect(apiEndpointForDisplay("")).toBe("");
  });

  it("strips userinfo from a value it cannot parse as a URL", () => {
    // isProductionApiUrl has a substring fallback precisely so a malformed but
    // production-looking value still trips the banner, so this path is live.
    expect(apiEndpointForDisplay("api.tastyworks.com")).toBe(
      "api.tastyworks.com",
    );
    expect(
      apiEndpointForDisplay(
        `ht tp://apiuser:${PASSWORD}@api.tastyworks.com/v1?x#y`,
      ),
    ).toBe("ht tp://api.tastyworks.com");
    // Parses, but as an opaque path — scheme `apiuser:`, no host at all.
    expect(
      apiEndpointForDisplay(`apiuser:${PASSWORD}@api.tastyworks.com`),
    ).toBe("api.tastyworks.com");
  });

  it("keeps a password embedded in the URL off stderr", () => {
    const cap = captureConsole(() => warnIfProductionApi(WITH_USERINFO));

    expect(cap.result).toBe(true);
    expect(cap.stderr).toHaveLength(1);
    const banner = cap.stderr[0];
    expect(banner).not.toContain(PASSWORD);
    expect(banner).not.toContain("apiuser");
    // Still useful: the operator can see which environment this is.
    expect(banner).toContain(`API endpoint: ${PRODUCTION_API_URL}`);
    expect(banner).toMatch(/REAL MONEY/i);
  });

  it("keeps it off stderr at startup too, which is where the banner actually fires", () => {
    const cap = captureConsole(
      () => new TastytradeMCPServer({ apiUrl: WITH_USERINFO }),
    );

    const banners = cap.stderr.filter((line) => /REAL MONEY/i.test(line));
    expect(banners).toHaveLength(1);
    for (const line of cap.stderr) {
      expect(line).not.toContain(PASSWORD);
    }
    // stdout is the MCP protocol channel; a stray byte there corrupts it.
    expect(cap.stdoutWrites).toBe(0);
    expect(cap.logs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The live-trading banner survives the fully-qualified spelling
// ---------------------------------------------------------------------------

describe("the live-trading banner fires for the FQDN spelling too", () => {
  /**
   * `api.tastyworks.com.` is the same host — the trailing dot is the DNS root
   * label, and it is what every `dig`, `nslookup` and zone file prints, so it
   * is a value that gets copy-pasted into a config. The credential guard used
   * to refuse it as unrecognised, which hid this: acknowledge that one host by
   * name and the server would then trade real money with no banner at all,
   * because the money predicate compared the string exactly.
   */
  it("prints REAL MONEY at startup for a trailing-dot production URL", () => {
    const cap = captureConsole(
      () => new TastytradeMCPServer({ apiUrl: "https://api.tastyworks.com." }),
    );

    expect(cap.stderr.filter((l) => /REAL MONEY/i.test(l))).toHaveLength(1);
    expect(cap.stdoutWrites).toBe(0);
    expect(cap.logs).toBe(0);
  });

  it("does not fire it for the sandbox written the same way", () => {
    const cap = captureConsole(
      () =>
        new TastytradeMCPServer({ apiUrl: "https://api.cert.tastyworks.com." }),
    );
    expect(cap.stderr.filter((l) => /REAL MONEY/i.test(l))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. A hostile TASTYTRADE_API_URL cannot flood the log the client keeps
// ---------------------------------------------------------------------------

describe("startup output stays bounded for an over-long host", () => {
  /**
   * WHATWG URL imposes no DNS length limit, so a 200 KB hostname parses
   * perfectly and every banner that quotes it echoes 200 KB. The refusal path
   * was capped and the ALLOWED path was not — and the allowed path is the one
   * that matters, because it keeps running and re-prints on every restart into
   * the file the MCP client persists. Measured before the cap reached here:
   * 400 KB of stderr per launch, 600 KB once a proxy variable was also set,
   * because the channel banner added a third uncapped echo of the same value.
   *
   * The host is acknowledged by name, so this is a server that STARTS.
   */
  const LONG_HOST = `${"a".repeat(200_000)}.example.test`;
  const OVER_CAP = "a".repeat(MAX_ECHOED_URL_CHARS + 1);

  /**
   * `run()` is the only consumer of the endpoint label and it connects a real
   * StdioServerTransport, so the field is read directly rather than by standing
   * up a stdio session inside this process — the same reason
   * test/e2e/configuration.test.ts pins the banner through the pure
   * `startupBanner` rather than through `run()`.
   */
  function endpointLabelOf(server: TastytradeMCPServer): string {
    return (server as unknown as { apiEndpointLabel: string }).apiEndpointLabel;
  }

  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of [ALLOW_UNKNOWN_API_HOST_ENV_VAR, "HTTPS_PROXY"]) {
      saved[key] = process.env[key];
    }
    process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] = LONG_HOST;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("bounds every banner the acknowledged host prints", () => {
    const cap = captureConsole(
      () => new TastytradeMCPServer({ apiUrl: `https://${LONG_HOST}` }),
    );
    const printed = cap.stderr.join("\n");
    expect(printed).not.toContain(OVER_CAP);
    // The banner fired — this is not passing because nothing was printed.
    expect(printed).toContain("UNRECOGNISED API HOST");
    expect(printed.length).toBeLessThan(10_000);
  });

  it("bounds it with a proxy variable set too, which added a third echo", () => {
    process.env.HTTPS_PROXY = "http://gw.corp.example:3128";
    const cap = captureConsole(
      () => new TastytradeMCPServer({ apiUrl: `https://${LONG_HOST}` }),
    );
    const printed = cap.stderr.join("\n");
    expect(printed).not.toContain(OVER_CAP);
    expect(printed).toContain("CREDENTIAL PATH");
    expect(printed.length).toBeLessThan(10_000);
  });

  it("bounds the live-trading banner, which quotes the same value", () => {
    // Reached through isProductionApiUrl's substring fallback: a value that
    // does not parse but reads as production still trips the banner, and a
    // 200 KB one of those is no harder to write than a short one.
    const cap = captureConsole(() =>
      warnIfProductionApi(`ht tp://${"a".repeat(200_000)}.api.tastyworks.com`),
    );
    expect(cap.result).toBe(true);
    expect(cap.stderr.join("\n")).not.toContain(OVER_CAP);
    expect(cap.stderr.join("\n").length).toBeLessThan(10_000);
  });

  it("bounds the endpoint label the session's startup line carries", () => {
    // Written once at construction and printed on every `run()`. It is the one
    // echo that outlives the banners.
    const server = captureConsole(
      () => new TastytradeMCPServer({ apiUrl: `https://${LONG_HOST}` }),
    ).result;
    expect(endpointLabelOf(server).length).toBeLessThanOrEqual(
      MAX_ECHOED_URL_CHARS + 40,
    );
    expect(endpointLabelOf(server)).not.toContain(OVER_CAP);
  });
});
