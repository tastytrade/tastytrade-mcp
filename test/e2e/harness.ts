/**
 * Shared end-to-end harness: the real MCP server, no credentials, no network.
 *
 * A real `TastytradeMCPServer` is paired with a real MCP `Client` over the SDK's
 * in-memory transport, so every call travels through the actual protocol handlers and
 * the genuine `CallTool` pre-flight — annotation lookup, rate-limit charge, dispatch,
 * and `adaptError()` envelope wrapping. Nothing is stubbed above the HTTP boundary.
 *
 * Only two things are injected, both via seams absent in production. `adapter`
 * replaces axios's transport so requests are answered from a route table; it sits
 * BELOW the request interceptor, so `Authorization`, `Accept-Version` and `User-Agent`
 * are all present on what it observes. `tokenProvider` supplies the bearer, because
 * the OAuth client posts through the module-level axios instance `adapter` cannot
 * reach.
 *
 * Importing one test file from another would otherwise be impossible: the production
 * `tsconfig.json` sets `rootDir: "./src"`, making any .ts outside `src/` an
 * out-of-rootDir input (TS6059). `test/tsconfig.json` widens it for tests only — if
 * you see TS6059, that config is what went missing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TastytradeMCPServer } from "../../src/mcp-server/index.js";
import type { HttpAdapter } from "../../src/api-client.js";

/** A single request the fake transport observed, captured for assertions. */
export interface RecordedRequest {
  method: string;
  /** Path with the baseURL stripped, e.g. `/accounts/5WX/balances`. */
  url: string;
  /** Query parameters as passed by the client. */
  params: Record<string, unknown>;
  /** Parsed request body, or undefined for bodyless methods. */
  body: unknown;
  headers: Record<string, string>;
}

/** How the fake transport should answer one request. */
export interface RouteReply {
  status?: number;
  /**
   * The payload the tastytrade API would return. Wrapped as `{ data: ... }`
   * automatically unless `raw` is set, because that envelope is what the client
   * unwraps.
   */
  data?: unknown;
  /** Set to send `data` verbatim, without the `{ data: ... }` envelope. */
  raw?: boolean;
  /** Simulate a transport-level failure (ECONNREFUSED, etc.) instead of a reply. */
  networkError?: string;
  /**
   * Hold the reply for this many milliseconds before settling it.
   *
   * For the tests that are about TIME rather than about content: a broker call
   * that is merely slow is what puts a submit past the MCP client's own request
   * timeout, and nothing else in this harness can express "still running". Kept
   * to the transport layer so the delay is observed exactly where a real one
   * would be — below the interceptor, above the client method.
   */
  delayMs?: number;
}

/** Matches a request. A string matches the path exactly; a RegExp tests it. */
export type RouteMatcher = string | RegExp;

export interface Route {
  matcher: RouteMatcher;
  /** Restrict to one HTTP verb. Case-insensitive. Defaults to any verb. */
  method?: string;
  reply: RouteReply | ((req: RecordedRequest) => RouteReply);
}

/**
 * The recorded sandbox payloads. They live next to this file — in the same
 * directory as their only readers — because they are a dependency of the
 * OFFLINE suite that `./build.sh` runs, not of the credentialed live sweep.
 * Filing them beside the credentialed live tooling would imply the opposite and make
 * them look like deletable reference data.
 */
const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "_payloads",
);

/**
 * Loads a recorded sandbox response by tool name, e.g.
 * `loadFixture("tastytrade_get_orders")`. These are real captures — scrubbed of
 * credentials and truncated to four items per array, but structurally identical
 * to what the API returned. See test/e2e/_payloads/README.md.
 */
export function loadFixture(toolName: string): unknown {
  const file = path.join(FIXTURE_DIR, `${toolName}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `No recorded fixture for "${toolName}" at ${file}. ` +
        `Available fixtures are listed in test/e2e/_payloads/. Either add ` +
        `one or supply an inline \`data\` payload for this route instead.`,
      { cause: err },
    );
  }
}

/** A harness instance: the connected client plus the traffic it generated. */
export interface Harness {
  client: Client;
  server: TastytradeMCPServer;
  /** Every request the fake transport saw, oldest first. */
  requests: RecordedRequest[];
  /** The most recent request, or undefined if none was made. */
  lastRequest(): RecordedRequest | undefined;
  /** Adds routes after construction, for per-test overrides. */
  route(...routes: Route[]): void;
  close(): Promise<void>;
}

/**
 * The accounts the fake broker reports at `GET /customers/me/accounts` unless a test
 * says otherwise.
 *
 * The dispatcher's fifth pre-flight step asks the credential which accounts it holds
 * and refuses any call naming one it does not, so an offline test that never answers
 * that request has a credential holding NOTHING and every account-scoped call is
 * refused. A test using a number outside this list gets `auth_failed`, which names the
 * reason.
 *
 * Deliberately a LIST rather than a wildcard: the harness must not be able to express
 * a permission the server cannot, or a suite could go green against a control that
 * does not exist in production.
 */
export const HARNESS_HELD_ACCOUNTS: readonly string[] = [
  "5XX00000",
  "5WX00001",
  "5WX00002",
  "5WX34382",
  "5WX99999",
  "5WT00001",
  "5WT00002",
];

export interface HarnessOptions {
  routes?: Route[];
  /**
   * The accounts `GET /customers/me/accounts` reports, i.e. the accounts this
   * server's credential is allowed to act on. Defaults to
   * {@link HARNESS_HELD_ACCOUNTS}.
   *
   * Pass a list to test the account-scope refusal, `[]` for a credential that
   * holds nothing, or route `/customers/me/accounts` explicitly for a malformed
   * or failing answer — an explicit route always wins over this default.
   */
  heldAccounts?: readonly string[];
  /** Overrides forwarded to the server config. */
  config?: Record<string, unknown>;
  /**
   * A reply used for any request no route matched. Defaults to an empty
   * `{ data: {} }` with status 200, which keeps a test focused on the one thing
   * it is asserting instead of forcing every incidental call to be routed.
   */
  fallback?: RouteReply;
  /**
   * Replaces the stub bearer-token source.
   *
   * The default hands back a constant, which is what keeps every other test in
   * this directory focused on the request rather than on the grant. Override it
   * to fail the grant instead: `TastytradeOAuthClient` classifies a refused or
   * unreachable token endpoint itself and throws a finished `ToolError`, and
   * that error surfaces from the SAME seam a tool's own request failure does —
   * the api-client request interceptor awaits the token, so the rejection
   * travels the response interceptor's error path. Making it injectable is the
   * only way an offline test can reach the "the tool call never happened
   * because the credential exchange did not" branch.
   */
  tokenProvider?: () => string | Promise<string>;
}

/** Where the server asks which accounts its credential holds. */
const ACCOUNT_DIRECTORY_PATH = "/customers/me/accounts";

/**
 * Does this route claim the account-directory path SPECIFICALLY, as opposed to
 * sweeping it up in a catch-all?
 *
 * A string matcher claims it by being it. A RegExp claims it if it matches the
 * directory path and does NOT match an arbitrary unrelated one — which is what
 * separates `/customers\/me\/accounts/` from `/.*­/`. The distinction matters
 * because the two mean opposite things: a suite that routes the directory is
 * testing what happens when the answer is empty, malformed or a 503, and must
 * win; a suite that ends with a catch-all is saying "answer everything I did
 * not name", and did not mean to define the credential's reach.
 */
function claimsAccountDirectory(route: Route): boolean {
  if (typeof route.matcher === "string") {
    return route.matcher === ACCOUNT_DIRECTORY_PATH;
  }
  return (
    route.matcher.test(ACCOUNT_DIRECTORY_PATH) &&
    !route.matcher.test("/an-unrelated-path-no-suite-routes")
  );
}

function normalizeHeaders(config: AxiosRequestConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = (config.headers ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null && typeof v !== "object") {
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

function parseBody(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function matches(route: Route, req: RecordedRequest): boolean {
  if (route.method && route.method.toUpperCase() !== req.method) return false;
  return typeof route.matcher === "string"
    ? req.url === route.matcher
    : route.matcher.test(req.url);
}

/**
 * Boots a real server wired to a fake transport and returns a connected client.
 *
 * ```ts
 * const h = await createHarness({
 *   routes: [{ matcher: "/customers/me/accounts", reply: { data: { items: [] } } }],
 * });
 * const res = await h.client.callTool({ name: "tastytrade_get_accounts", arguments: {} });
 * expect(h.lastRequest()?.headers["accept-version"]).toMatch(/^\d{8}$/);
 * await h.close();
 * ```
 */
export async function createHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const routes: Route[] = [...(options.routes ?? [])];
  if (!routes.some(claimsAccountDirectory)) {
    // UNSHIFTED, not appended, and that ordering is load-bearing: many suites
    // end their route list with a catch-all (`matcher: /.*/`) that would
    // otherwise answer the account-directory lookup with a payload naming no
    // accounts at all — a credential holding nothing, and every account-scoped
    // call in the suite refused. A route that specifically CLAIMS the directory
    // path still wins, because this default is not installed at all when one is
    // present.
    routes.unshift({
      matcher: ACCOUNT_DIRECTORY_PATH,
      method: "GET",
      reply: {
        data: {
          items: (options.heldAccounts ?? HARNESS_HELD_ACCOUNTS).map((n) => ({
            account: { "account-number": n },
          })),
        },
      },
    });
  }
  const requests: RecordedRequest[] = [];
  const fallback: RouteReply = options.fallback ?? { status: 200, data: {} };

  const adapter: HttpAdapter = async (config: AxiosRequestConfig) => {
    const base = config.baseURL ?? "";
    const full = config.url ?? "";
    const req: RecordedRequest = {
      method: (config.method ?? "get").toUpperCase(),
      url: full.startsWith(base) ? full.slice(base.length) : full,
      params: (config.params ?? {}) as Record<string, unknown>,
      body: parseBody(config.data),
      headers: normalizeHeaders(config),
    };
    requests.push(req);

    const hit = routes.find((r) => matches(r, req));
    const reply: RouteReply = hit
      ? typeof hit.reply === "function"
        ? hit.reply(req)
        : hit.reply
      : fallback;

    if (reply.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    }

    if (reply.networkError) {
      // Must match a REAL axios transport failure, which carries `code` and
      // `isAxiosError: true` but no `response` — axios's http adapter builds it
      // with AxiosError.from(). Omitting `isAxiosError` makes the error fall
      // outside adaptError's HTTP classification block entirely and misclassify
      // as `upstream_error`, so this flag is load-bearing, not decoration.
      const err = new Error(reply.networkError) as Error & {
        code: string;
        isAxiosError: boolean;
        config: AxiosRequestConfig;
      };
      err.code = reply.networkError;
      err.isAxiosError = true;
      err.config = config;
      throw err;
    }

    const status = reply.status ?? 200;
    const payload = reply.raw ? reply.data : { data: reply.data ?? {} };
    const response = {
      data: payload,
      status,
      statusText: String(status),
      headers: {},
      config,
    } as AxiosResponse;

    // A custom adapter must settle non-2xx itself — axios's own settle() is not
    // applied to adapter results. Without this, a 404 route would resolve as a
    // success and every error-taxonomy assertion would be meaningless.
    if (status < 200 || status >= 300) {
      const err = new Error(
        `Request failed with status code ${status}`,
      ) as Error & {
        response: AxiosResponse;
        isAxiosError: boolean;
        config: AxiosRequestConfig;
      };
      err.response = response;
      err.isAxiosError = true;
      err.config = config;
      throw err;
    }

    return response;
  };

  const server = new TastytradeMCPServer(
    {
      apiUrl: "https://api.cert.tastyworks.com",
      ...(options.config ?? {}),
    },
    {
      adapter,
      tokenProvider: options.tokenProvider ?? (() => "test-access-token"),
    },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-harness", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  // Resolve the credential's account set NOW, and forget the request.
  //
  // The dispatcher's fifth pre-flight step asks the credential which accounts it holds —
  // once per process, cached — and refuses any call naming one it does not. In production
  // that lookup happens on the first account-scoped call; here it is pulled forward to
  // construction so a test's `requests` list contains exactly the requests the TEST
  // caused. Reached through the same private-field cast
  // test/mcp-server/public-surface.test.ts uses, so no test-only seam is added.
  //
  // The refusal is swallowed: a suite that deliberately answers the lookup with a
  // failure or an empty set is testing that, and the rejection belongs to the call under
  // test rather than to construction.
  const warmed = (
    server as unknown as {
      accountScope: {
        assertPermitted(
          named: readonly string[],
          subject: string,
        ): Promise<void>;
      };
    }
  ).accountScope.assertPermitted(
    [(options.heldAccounts ?? HARNESS_HELD_ACCOUNTS)[0] ?? "5XX00000"],
    "harness warm-up",
  );
  await warmed.catch(() => undefined);
  requests.length = 0;

  return {
    client,
    server,
    requests,
    lastRequest: () => requests[requests.length - 1],
    route: (...added: Route[]) => routes.unshift(...added),
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Calls a tool and returns the parsed result, asserting it did NOT error.
 * Tool results carry errors in-band, so a failure otherwise surfaces as a
 * confusing shape mismatch rather than a clear failure.
 */
export async function callOk(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = (await h.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) {
    throw new Error(`Tool ${name} returned an error envelope: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Calls a tool expecting the structured error envelope, and returns the parsed
 * `ToolError`. Fails if the call unexpectedly succeeded.
 */
export async function callError(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string; retryable?: boolean }> {
  const res = (await h.client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = res.content?.[0]?.text ?? "";
  if (!res.isError) {
    throw new Error(`Expected ${name} to error, but it succeeded: ${text}`);
  }
  return JSON.parse(text);
}
