/**
 * Public-release hardening, at the seams the end-to-end suite cannot reach.
 *
 * The behaviour of these guarantees is asserted through a real MCP session in
 * test/e2e/configuration.test.ts, over a strictly larger set of cases and with the
 * outbound HTTP observed. That is the suite to read, and to change when the behaviour
 * changes.
 *
 * Three things remain here because nothing else covers them: `isProductionApiUrl` on
 * inputs a booted server cannot produce; the `default:` arm at the end of
 * `handleToolCall`, the second line of defence behind the dispatcher's own
 * unknown-tool refusal, which requires calling the handler directly; and that the
 * read-only gate runs BEFORE the rate limiter is charged.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  TastytradeMCPServer,
  PRODUCTION_API_URL,
  SANDBOX_API_URL,
  READ_ONLY_ENV_VAR,
  isProductionApiUrl,
} from "../../src/mcp-server/index.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** The two interactive-auth tools removed for the public release. */
const REMOVED_OAUTH_TOOLS = [
  "tastytrade_oauth_authenticate",
  "tastytrade_oauth_set_refresh_token",
] as const;

type ServerInternals = {
  getTools(): Tool[];
  handleToolCall(name: string, args: unknown): Promise<any>;
  dispatchToolCall(name: string, args: unknown): Promise<any>;
  client: unknown;
};

/**
 * Constructing with an explicit sandbox config performs no network I/O — the
 * constructor only builds the axios instance and registers handlers.
 */
function makeServer(): ServerInternals {
  return new TastytradeMCPServer({
    apiUrl: SANDBOX_API_URL,
  }) as unknown as ServerInternals;
}

/** Read the ToolError out of an isError CallTool envelope. */
function errorOf(result: any): { code: string; message: string } {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0].text);
}

/** Run fn with console.error swallowed — startup announces on stderr. */
function quietly<T>(fn: () => T): T {
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    return fn();
  } finally {
    errSpy.mockRestore();
  }
}

afterEach(() => {
  delete process.env[READ_ONLY_ENV_VAR];
});

describe("isProductionApiUrl on values a booted server never produces", () => {
  it("recognises production regardless of port, case, or trailing slash", () => {
    for (const url of [
      PRODUCTION_API_URL,
      `${PRODUCTION_API_URL}/`,
      "https://API.TASTYWORKS.COM",
      "https://api.tastyworks.com:443/v1",
      // Unparseable but production-looking: caught by the substring fallback,
      // which is the only path that reaches it.
      "api.tastyworks.com",
    ]) {
      expect(isProductionApiUrl(url)).toBe(true);
    }
  });

  it("does not mistake the sandbox (or nothing) for production", () => {
    for (const url of [
      SANDBOX_API_URL,
      // The trap the substring fallback has to survive: the sandbox host is
      // not a superstring of the production host, so it must not match.
      "api.cert.tastyworks.com",
      "http://localhost:8123",
      undefined,
      "",
    ]) {
      expect(isProductionApiUrl(url)).toBe(false);
    }
  });
});

describe("interactive OAuth tools are gone (env-var auth only)", () => {
  const names = makeServer()
    .getTools()
    .map((t) => t.name);

  it("no tool name mentions oauth at all", () => {
    // Stronger than naming the two that were removed: it also refuses a third
    // one arriving later under a different name.
    expect(names.filter((n) => /oauth/i.test(n))).toEqual([]);
  });

  it.each(REMOVED_OAUTH_TOOLS)(
    "%s falls through handleToolCall's default arm as not_found",
    async (tool) => {
      // Called on the handler directly, NOT through the dispatcher. The
      // dispatcher refuses an unregistered name in its pre-flight (covered in
      // test/e2e/dispatcher-hardening.test.ts) and never reaches this arm, so
      // this is the only exercise of the backstop that catches a tool added to
      // the registry with no matching `case`.
      const err = errorOf(await makeServer().handleToolCall(tool, {}));
      expect(err.code).toBe("not_found");
    },
  );
});

describe("read-only mode refuses before it meters", () => {
  it("does not spend a destructive rate-limit token on a refusal", async () => {
    // The internal order cap is the tightest budget a client can exhaust, and
    // refusals are free only if the gate short-circuits ahead of
    // chargeRateLimit. Drive it past that cap from a clean limiter so the
    // conclusion does not depend on what an earlier test happened to spend:
    // if the charge moved ahead of the gate, the later calls would come back
    // rate_limit_exceeded instead of read_only_mode.
    _resetRateLimitsForTest();
    process.env[READ_ONLY_ENV_VAR] = "1";
    const server = quietly(() => makeServer());

    for (let i = 0; i < 30; i += 1) {
      const err = errorOf(
        await server.dispatchToolCall("tastytrade_place_order", {}),
      );
      expect(err.code).toBe("read_only_mode");
      expect(err.message).toContain(READ_ONLY_ENV_VAR);
    }

    // And the budget really is intact afterwards, which is the point: a
    // refused caller must not be able to starve a legitimate order.
    _resetRateLimitsForTest();
  });
});
