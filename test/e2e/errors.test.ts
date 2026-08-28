/**
 * End-to-end error taxonomy.
 *
 * Agents branch on `code`, never on message text, so every upstream condition →
 * `ToolErrorCode` mapping is a public contract. The unit tests call `adaptError()`
 * directly; this suite drives the same mappings through the real server — a genuine
 * `tools/call`, the real pre-flight, a real axios instance whose transport is a route
 * table, and the real `catch` that wraps whatever was thrown.
 *
 * What that adds: it proves the shape survives the whole path — that an axios
 * rejection raised inside `TastytradeClient` reaches `adaptError` with
 * `response`/`code` intact, that the envelope is serialized into a single `isError`
 * text block, and that no field of the axios error (above all the request config,
 * which carries the bearer token) is copied along the way.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callError } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import type { ToolError, ToolErrorCode } from "../../src/safety/errors.js";

const ACCT = "5WX00001";
const BALANCES = /\/accounts\/[^/]+\/balances$/;

/**
 * `callError` narrows its return type to the three fields it guarantees; the
 * taxonomy contract covers the optional ones too.
 */
async function envelope(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolError> {
  return (await callError(h, name, args)) as unknown as ToolError;
}

/**
 * The complete field set a ToolError may carry. Asserted on every envelope so a
 * future change that spreads a raw axios error into the envelope — `config`,
 * `request`, `stack`, `response` — fails here instead of leaking in production.
 */
const ALLOWED_KEYS = new Set([
  "code",
  "message",
  "retryable",
  "retry_after_ms",
  "upstream",
  "hint",
]);

let h: Harness | undefined;

beforeEach(() => {
  // Buckets are module-level state shared by every harness in this file, and
  // `rate_limit_exceeded` is itself one of the codes under test — a bucket
  // drained by an earlier case would silently rewrite a later assertion.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
});

// ---------------------------------------------------------------------------
// HTTP status → code, table-driven
// ---------------------------------------------------------------------------

interface HttpCase {
  status: number;
  code: ToolErrorCode;
  retryable: boolean;
  /** Why this row exists, when the status alone does not say it. */
  note?: string;
}

const HTTP_CASES: HttpCase[] = [
  { status: 401, code: "auth_failed", retryable: false },
  { status: 403, code: "auth_failed", retryable: false },
  { status: 404, code: "not_found", retryable: false },
  { status: 422, code: "validation", retryable: false },
  { status: 429, code: "rate_limit_exceeded", retryable: true },
  { status: 500, code: "upstream_error", retryable: true },
  { status: 502, code: "upstream_error", retryable: true },
  { status: 503, code: "upstream_error", retryable: true },
  // Not called out in the taxonomy: everything unrecognised lands on
  // upstream_error, but a 4xx is the caller's fault so it is NOT retryable —
  // the same code with the opposite retry verdict as the 5xx rows above.
  {
    status: 409,
    code: "upstream_error",
    retryable: false,
    note: "unmapped 4xx is not retryable",
  },
  { status: 400, code: "upstream_error", retryable: false },
];

describe("error taxonomy: HTTP status → ToolError code", () => {
  for (const c of HTTP_CASES) {
    const label = c.note ? `${c.status} (${c.note})` : String(c.status);
    it(`maps ${label} → ${c.code}, retryable=${c.retryable}`, async () => {
      const body = { error: { code: "upstream-said-no", message: "detail" } };
      h = await createHarness({
        routes: [
          {
            matcher: BALANCES,
            method: "GET",
            reply: { status: c.status, data: body, raw: true },
          },
        ],
      });

      const err = await envelope(h, "tastytrade_get_balances", {
        account_number: ACCT,
      });

      expect(err.code).toBe(c.code);
      expect(err.retryable).toBe(c.retryable);
      // The status is preserved so an agent can log it, and the upstream body is
      // handed back intact for diagnosis.
      expect(err.upstream?.status).toBe(c.status);
      expect(err.upstream?.body).toEqual(body);
      for (const key of Object.keys(err)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    });
  }
});

describe("error taxonomy: transport failure → network", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"] as const) {
    it(`maps ${code} → network (retryable)`, async () => {
      h = await createHarness({
        routes: [{ matcher: BALANCES, reply: { networkError: code } }],
      });

      const err = await envelope(h, "tastytrade_get_balances", {
        account_number: ACCT,
      });

      expect(err.code).toBe("network");
      expect(err.retryable).toBe(true);
      // A connection failure produced no HTTP response, so inventing an
      // `upstream.status` of 0 would tell the agent the broker answered.
      expect(err.upstream).toBeUndefined();
      expect(err.message).toContain(code);
      for (const key of Object.keys(err)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Per-code details that agents act on
// ---------------------------------------------------------------------------

describe("error taxonomy: retry metadata", () => {
  it("carries retry_after_ms on an upstream 429", async () => {
    h = await createHarness({
      routes: [{ matcher: BALANCES, reply: { status: 429 } }],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.retry_after_ms).toBe(1000);
    // Distinguishable from the LOCAL limiter below: this one reports a status.
    expect(err.upstream?.status).toBe(429);
  });

  it("carries retry_after_ms on the local limiter, with no upstream status", async () => {
    // The order cap is 20/sec and cancel_order is destructive, so the
    // twenty-first call is refused locally and never reaches the transport.
    h = await createHarness({
      routes: [{ matcher: /\/orders\//, reply: { data: {} } }],
    });

    for (let i = 0; i < 20; i++) {
      await h.client.callTool({
        name: "tastytrade_cancel_order",
        arguments: { account_number: ACCT, order_id: `${i}` },
      });
    }
    const err = await envelope(h, "tastytrade_cancel_order", {
      account_number: ACCT,
      order_id: "20",
    });

    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.retryable).toBe(true);
    expect(err.retry_after_ms).toBeGreaterThan(0);
    expect(err.upstream).toBeUndefined();
    // The refusal deliberately names no bucket and quotes no figure — the cap
    // that stops an order burst is an internal backstop, so this pins the shape
    // of a local refusal rather than its wording.
    // Refused before dispatch: the cap went out, the next one did not.
    expect(h.requests).toHaveLength(20);
  });

  it("gives a 401 a credential-configuration hint and a 422 a field-level one", async () => {
    h = await createHarness({
      routes: [{ matcher: BALANCES, reply: { status: 401 } }],
    });
    const authErr = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });
    expect(authErr.hint).toMatch(/TASTYTRADE_REFRESH_TOKEN/);
    await h.close();

    // /accounts/{n}/balances is capped at 1 request/second and both halves of
    // this test call it. Reset the limiter rather than sleeping: the subject
    // here is the hint text, not the rate policy.
    _resetRateLimitsForTest();

    h = await createHarness({
      routes: [{ matcher: BALANCES, reply: { status: 422 } }],
    });
    const validationErr = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });
    expect(validationErr.hint).toMatch(/upstream\.body/);
  });
});

describe("error taxonomy: the mapping is central, not per-tool", () => {
  it("wraps a write tool's failure identically to a read tool's", async () => {
    h = await createHarness({
      routes: [
        { matcher: "/watchlists", method: "POST", reply: { status: 422 } },
        { matcher: BALANCES, method: "GET", reply: { status: 422 } },
      ],
    });

    const write = await envelope(h, "tastytrade_create_watchlist", {
      name: "e2e",
      symbols: ["AAPL"],
    });
    const read = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    expect(write.code).toBe("validation");
    expect(write.retryable).toBe(false);
    expect(read.code).toBe(write.code);
    expect(read.retryable).toBe(write.retryable);
  });

  it("returns not_found for an unknown tool name, without any HTTP traffic", async () => {
    h = await createHarness();

    const err = await envelope(h, "tastytrade_no_such_tool", { foo: 1 });

    expect(err.code).toBe("not_found");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("tastytrade_no_such_tool");
    expect(err.hint).toMatch(/tools\/list/);
    // Rejected at the annotation lookup, before rate-limit or dispatch.
    expect(h.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The envelope is a data-egress path
// ---------------------------------------------------------------------------

describe("error taxonomy: the envelope never leaks a credential", () => {
  // Long, distinctive, and never a substring of anything else in the payload.
  const CLIENT_SECRET = "cs_live_NOT_A_REAL_CLIENT_SECRET_FIXTURE_1111";
  const REFRESH_TOKEN = "rt_NOT_A_REAL_REFRESH_TOKEN_FIXTURE_1111";
  const COOKIE = "tt_session=eyJhbGciOiJIUzI1NiJ9.NOT_A_REAL_SESSION_FIXTURE";
  /** The bearer the harness injects — see harness.ts `tokenProvider`. */
  const BEARER = "test-access-token";

  const prevSecret = process.env.TASTYTRADE_CLIENT_SECRET;
  const prevRefresh = process.env.TASTYTRADE_REFRESH_TOKEN;

  beforeEach(() => {
    // `configuredSecrets()` reads these at redaction time. Setting them is what
    // lets the scrubber catch a bare credential that carries no key name.
    process.env.TASTYTRADE_CLIENT_SECRET = CLIENT_SECRET;
    process.env.TASTYTRADE_REFRESH_TOKEN = REFRESH_TOKEN;
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.TASTYTRADE_CLIENT_SECRET;
    else process.env.TASTYTRADE_CLIENT_SECRET = prevSecret;
    if (prevRefresh === undefined) delete process.env.TASTYTRADE_REFRESH_TOKEN;
    else process.env.TASTYTRADE_REFRESH_TOKEN = prevRefresh;
  });

  /** An upstream failure body that echoes every credential it was sent. */
  const hostileBody = {
    error: {
      code: "invalid_request",
      message: `Rejected request with Authorization: Bearer ${BEARER}`,
      errors: [
        { domain: "auth", detail: `client_secret=${CLIENT_SECRET}` },
        { domain: "auth", detail: `"refresh_token": "${REFRESH_TOKEN}"` },
      ],
      echoed_request: {
        headers: {
          authorization: `Bearer ${BEARER}`,
          cookie: COOKIE,
          "accept-version": "20260815",
        },
        body: {
          grant_type: "refresh_token",
          client_secret: CLIENT_SECRET,
          refresh_token: REFRESH_TOKEN,
        },
      },
      // No key name at all — only the configured-literal pass can catch these,
      // which is why the env vars above are set.
      note: `operator pasted ${CLIENT_SECRET} and ${REFRESH_TOKEN} into a log line`,
    },
  };

  it("scrubs every credential out of the serialized envelope", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          reply: { status: 422, data: hostileBody, raw: true },
        },
      ],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });
    const serialized = JSON.stringify(err);

    for (const secret of [CLIENT_SECRET, REFRESH_TOKEN, COOKIE, BEARER]) {
      expect(serialized).not.toContain(secret);
    }
    // Scrubbed, not silently dropped: the diagnostic value must survive.
    expect(serialized).toContain("[redacted]");
    expect(err.code).toBe("validation");
    const body = err.upstream?.body as any;
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.echoed_request.headers["accept-version"]).toBe(
      "20260815",
    );
    expect(body.error.errors).toHaveLength(2);
  });

  it("never copies the axios request config, which carries the live bearer", async () => {
    h = await createHarness({
      routes: [{ matcher: BALANCES, reply: { status: 500 } }],
    });

    const err = await envelope(h, "tastytrade_get_balances", {
      account_number: ACCT,
    });

    // The header WAS on the outbound request the adapter saw…
    expect(h.lastRequest()?.headers.authorization).toBe(`Bearer ${BEARER}`);
    // …and none of the axios error's own fields came back with the envelope.
    for (const key of Object.keys(err)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
    expect(JSON.stringify(err)).not.toContain(BEARER);
  });

  // Redaction happens in one place today, but every classification branch builds
  // its own `upstream` object. Sweeping the taxonomy means a future branch that
  // adds a field the scrubber does not know about cannot leak through it.
  //
  // One status per branch, and no more: `classifyError` tests
  // `status === 401 || status === 403` and `status >= 500`, so 403 and 503 would
  // re-enter branches 401 and 500 already cover — the same envelope assembled by
  // the same code. The full status→code contract, 403 and 503 included, is the
  // HTTP_CASES table at the top of this file.
  for (const status of [401, 404, 422, 429, 500, 409]) {
    it(`leaks nothing through the ${status} branch`, async () => {
      h = await createHarness({
        routes: [
          {
            matcher: BALANCES,
            reply: { status, data: hostileBody, raw: true },
          },
        ],
      });

      const serialized = JSON.stringify(
        await envelope(h, "tastytrade_get_balances", { account_number: ACCT }),
      );

      for (const secret of [CLIENT_SECRET, REFRESH_TOKEN, COOKIE, BEARER]) {
        expect(serialized).not.toContain(secret);
      }
    });
  }
});
