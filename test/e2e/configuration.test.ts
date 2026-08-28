/**
 * Configuration, startup and read-only mode — end to end.
 *
 * These are the behaviours that protect a careless operator: the default endpoint is
 * the sandbox, pointing at production announces itself on stderr (never stdout, which
 * is the protocol channel), and read-only mode is a startup decision that withholds
 * AND refuses every money-moving tool. All asserted through the real protocol and the
 * real outbound request.
 *
 * Two boot paths deliberately: `createHarness` wherever the API base URL is
 * irrelevant, and `bootFromEnv` for the URL-resolution tests — the shared harness
 * always passes an explicit `config`, which bypasses `resolveApiUrl()` and strips the
 * baseURL off the recorded URL, so the host it dialled is not observable.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { AxiosRequestConfig, AxiosResponse } from "axios";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHarness, callOk, callError, loadFixture } from "./harness.js";
import type { Harness, HarnessOptions } from "./harness.js";
import {
  TastytradeMCPServer,
  TOOL_ANNOTATIONS,
  SANDBOX_API_URL,
  PRODUCTION_API_URL,
  READ_ONLY_ENV_VAR,
  ALLOW_UNKNOWN_API_HOST_ENV_VAR,
  KNOWN_API_HOSTS,
  inspectCredentialTarget,
  apiEndpointForDisplay,
  startupBanner,
} from "../../src/mcp-server/index.js";
import { classifyApiHost } from "../../src/doctor.js";
import { TOOL_METADATA } from "../../src/mcp-server/tool-metadata.js";
import { bucketFor } from "../../src/mcp-server/annotations.js";
import { PACKAGE_VERSION, DEFAULT_USER_AGENT } from "../../src/version.js";
import type { HttpAdapter } from "../../src/api-client.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";

// ---------------------------------------------------------------------------
// package.json — the single source of truth the version tests pin against.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const PKG = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as { name: string; version: string };

/** The `serverInfo.name` reported in the MCP handshake. */
const SERVER_NAME = "tastytrade-mcp-server";

// ---------------------------------------------------------------------------
// The 14 tools read-only mode must withhold. Spelled out rather than derived,
// so a change to TOOL_ANNOTATIONS shows up here as a failing list instead of a
// silently smaller loop. A dedicated test cross-checks this list against the
// set derived from TOOL_ANNOTATIONS, so neither side can drift alone.
// ---------------------------------------------------------------------------

const WRITE_TOOLS = [
  "tastytrade_create_quote_alert",
  "tastytrade_create_watchlist",
  "tastytrade_update_watchlist",
  "tastytrade_add_watchlist_symbol",
  "tastytrade_remove_watchlist_symbol",
] as const;

const DESTRUCTIVE_TOOLS = [
  "tastytrade_place_order",
  "tastytrade_cancel_order",
  "tastytrade_edit_order",
  "tastytrade_replace_order",
  "tastytrade_place_complex_order",
  "tastytrade_cancel_complex_order",
  "tastytrade_edit_complex_order",
  "tastytrade_delete_quote_alert",
  "tastytrade_delete_watchlist",
] as const;

const WITHHELD_TOOLS: string[] = [...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS];

/** Every dry-run preview tool. All annotated READ_ONLY — see the suite below. */
const DRY_RUN_TOOLS = [
  "tastytrade_dry_run_order",
  "tastytrade_dry_run_replace_order",
  "tastytrade_dry_run_edit_order",
  "tastytrade_dry_run_complex_order",
  "tastytrade_dry_run_edit_complex_order",
  "tastytrade_dry_run_margin_impact",
] as const;

// ---------------------------------------------------------------------------
// Environment isolation. Every variable the server reads is cleared before each
// test and restored afterwards, so a developer's exported shell config cannot
// change an outcome and nothing leaks into the next test.
// ---------------------------------------------------------------------------

const MANAGED_ENV = [
  "TASTYTRADE_API_URL",
  READ_ONLY_ENV_VAR,
  ALLOW_UNKNOWN_API_HOST_ENV_VAR,
  "TASTYTRADE_USER_AGENT",
  "TASTYTRADE_ACCEPT_VERSION",
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
] as const;

let savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Token buckets are module-level state shared by every test in this file.
  // Resetting keeps each test independent of how many calls its neighbours made.
  _resetRateLimitsForTest();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  for (const key of MANAGED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Console/stream capture.
// ---------------------------------------------------------------------------

interface Capture<T> {
  result: T;
  /** Every console.error argument list, joined — i.e. all of stderr. */
  stderr: string[];
  /** Raw process.stdout.write payloads. Must be empty: stdout is the protocol. */
  stdoutWrites: string[];
  /** console.log calls, which also land on stdout. Must be empty. */
  logs: number;
}

/**
 * Runs `fn` with console.error, console.log and process.stdout.write captured.
 * The capture spans the whole callback, so it can cover construction *and* the
 * tool calls that follow — which is how "warns once, not per request" is
 * checked.
 */
async function captureOutput<T>(fn: () => Promise<T> | T): Promise<Capture<T>> {
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const outSpy = jest
    .spyOn(process.stdout, "write")
    .mockImplementation((() => true) as any);
  try {
    const result = await fn();
    return {
      result,
      stderr: errSpy.mock.calls.map((call) => call.map(String).join(" ")),
      stdoutWrites: outSpy.mock.calls.map((call) => String(call[0])),
      logs: logSpy.mock.calls.length,
    };
  } finally {
    outSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

/** Startup lines that announce a real-money configuration. */
function liveMoneyBanners(stderr: string[]): string[] {
  return stderr.filter((line) => /REAL MONEY/i.test(line));
}

/**
 * Boots the shared harness with startup output swallowed. Read-only mode logs a
 * notice at construction; capturing it keeps the gate's output readable.
 */
async function quietHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { result } = await captureOutput(() => createHarness(options));
  cleanups.push(() => result.close());
  return result;
}

// ---------------------------------------------------------------------------
// bootFromEnv: the server constructed with NO explicit config, so the API base
// URL comes from the environment through resolveApiUrl(), and the fully
// resolved outbound URL is recorded.
// ---------------------------------------------------------------------------

interface EnvRequest {
  method: string;
  /** Absolute URL, baseURL included — the host actually dialled. */
  url: string;
  headers: Record<string, string>;
}

interface EnvBoot {
  client: Client;
  requests: EnvRequest[];
}

async function bootFromEnv(): Promise<EnvBoot> {
  const requests: EnvRequest[] = [];

  const adapter: HttpAdapter = async (config: AxiosRequestConfig) => {
    const base = (config.baseURL ?? "").replace(/\/$/, "");
    const relative = config.url ?? "";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (config.headers ?? {}) as Record<string, unknown>,
    )) {
      if (value !== undefined && value !== null && typeof value !== "object") {
        headers[key.toLowerCase()] = String(value);
      }
    }
    requests.push({
      method: (config.method ?? "get").toUpperCase(),
      url: /^https?:\/\//i.test(relative) ? relative : `${base}${relative}`,
      headers,
    });
    return {
      data: { data: { items: [] } },
      status: 200,
      statusText: "200",
      headers: {},
      config,
    } as AxiosResponse;
  };

  // No `config` argument: the constructor falls through to resolveApiUrl() and
  // the TASTYTRADE_* credential vars, which is the production code path.
  const server = new TastytradeMCPServer(undefined, {
    adapter,
    tokenProvider: () => "test-access-token",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "config-e2e", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(() => client.close());
  return { client, requests };
}

/** The host a recorded outbound request was actually sent to. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

/** Reads the ToolError out of a low-level CallTool envelope. */
async function callToolRaw(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  return { isError: res.isError, text: res.content?.[0]?.text ?? "" };
}

// ===========================================================================
// 1. Sandbox default
// ===========================================================================

describe("sandbox is the default target, at the transport", () => {
  it("dials the sandbox host when TASTYTRADE_API_URL is unset", async () => {
    const boot = await bootFromEnv();
    await callToolRaw(boot.client, "tastytrade_get_accounts");

    expect(boot.requests).toHaveLength(1);
    const [req] = boot.requests;
    // The property that matters: an operator who configured nothing cannot be
    // spending real money — the host dialled is the cert sandbox, not
    // PRODUCTION_API_URL's api.tastyworks.com.
    expect(req.url).toBe(`${SANDBOX_API_URL}/customers/me/accounts`);
    expect(hostOf(req.url)).toBe("api.cert.tastyworks.com");
  });

  it("treats a whitespace-only TASTYTRADE_API_URL as unset", async () => {
    process.env.TASTYTRADE_API_URL = "   ";
    const boot = await bootFromEnv();
    await callToolRaw(boot.client, "tastytrade_get_accounts");

    expect(hostOf(boot.requests[0].url)).toBe("api.cert.tastyworks.com");
  });

  it("starts up silently on the default config, and writes nothing to stdout", async () => {
    const cap = await captureOutput(() => bootFromEnv());
    expect(liveMoneyBanners(cap.stderr)).toEqual([]);
    expect(cap.stdoutWrites).toEqual([]);
    expect(cap.logs).toBe(0);
  });
});

// ===========================================================================
// 2 + 3. Production opt-in and the warning banner
// ===========================================================================

describe("production is opt-in and announces itself on stderr", () => {
  it("dials production and warns, without touching stdout", async () => {
    process.env.TASTYTRADE_API_URL = PRODUCTION_API_URL;

    const cap = await captureOutput(async () => {
      const boot = await bootFromEnv();
      await callToolRaw(boot.client, "tastytrade_get_accounts");
      return boot;
    });

    expect(hostOf(cap.result.requests[0].url)).toBe("api.tastyworks.com");
    expect(liveMoneyBanners(cap.stderr)).toHaveLength(1);
    // stdout is the MCP protocol channel: one stray byte corrupts the session
    // for every client, so the budget is zero — not "small".
    expect(cap.stdoutWrites).toEqual([]);
    expect(cap.logs).toBe(0);
  });

  it("gives the operator a next step: the read-only switch and the README", async () => {
    process.env.TASTYTRADE_API_URL = PRODUCTION_API_URL;
    const cap = await captureOutput(() => bootFromEnv());

    const [banner] = liveMoneyBanners(cap.stderr);
    expect(banner).toBeDefined();
    expect(banner).toMatch(/WARNING/);
    expect(banner).toMatch(/LIVE TRADING/i);
    expect(banner).toContain(PRODUCTION_API_URL);
    // The two escape hatches, both actionable without reading the source.
    expect(banner).toContain(`${READ_ONLY_ENV_VAR}=1`);
    expect(banner).toContain(SANDBOX_API_URL);
    expect(banner).toContain("README");
  });

  it("warns exactly once at startup, not once per request", async () => {
    process.env.TASTYTRADE_API_URL = PRODUCTION_API_URL;

    const cap = await captureOutput(async () => {
      const boot = await bootFromEnv();
      // Driven with a tool that carries no per-endpoint ceiling, so all five
      // calls reach the transport. tastytrade_get_accounts is capped at 1
      // request/second and four of the five would be refused before dispatch —
      // which would make this pass for the wrong reason, by never generating the
      // traffic the banner is supposed to survive.
      for (let i = 0; i < 5; i += 1) {
        await callToolRaw(boot.client, "tastytrade_get_watchlists");
      }
      return boot;
    });

    expect(cap.result.requests).toHaveLength(5);
    // Five live-money requests, one banner. A per-request banner would drown
    // the log and train the operator to ignore it.
    expect(liveMoneyBanners(cap.stderr)).toHaveLength(1);
    expect(cap.stdoutWrites).toEqual([]);
  });

  it("stays silent for a sandbox server even after traffic", async () => {
    const cap = await captureOutput(async () => {
      const boot = await bootFromEnv();
      await callToolRaw(boot.client, "tastytrade_get_accounts");
      return boot;
    });
    expect(liveMoneyBanners(cap.stderr)).toEqual([]);
  });
});

// ===========================================================================
// 4. Read-only mode: which env values enable it, judged by behaviour
// ===========================================================================

describe("read-only mode is enabled only by an affirmative value", () => {
  /** Truthy: "1"/"true", case-insensitive, surrounding whitespace tolerated. */
  const TRUTHY = ["1", "true", "TRUE", " true ", "  1  ", "True"];
  /**
   * The DOCUMENTED off switches, and only those. A blank value counts as off
   * because the variable is then indistinguishable from unset.
   */
  const FALSY = ["0", "false", "FALSE", "", "  "];
  /**
   * Anything else. These USED to leave the full write surface live — an
   * operator who wrote `TASTYTRADE_READ_ONLY=yes` got 86 tools and every
   * money-moving path enabled while believing they were off. That is a
   * fail-open on a safety control, so an unrecognised value now enables
   * read-only mode and says so on stderr.
   */
  const UNRECOGNISED = ["yes", "on", "enabled", "Y", "no", "off", "2", "ture"];

  it.each(TRUTHY)("%p enables it: 72 tools, writes refused", async (value) => {
    process.env[READ_ONLY_ENV_VAR] = value;
    const h = await quietHarness();

    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(72);
    const err = await callError(h, "tastytrade_place_order", {
      account_number: "5WX00001",
    });
    expect(err.code).toBe("read_only_mode");
  });

  it.each(FALSY)("%p leaves the full surface enabled", async (value) => {
    process.env[READ_ONLY_ENV_VAR] = value;
    const h = await quietHarness();

    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(86);

    // The write surface is reachable. place_order still fails — it needs a
    // confirmation token — but with dry_run_required, which proves the call got
    // past the read-only gate into the real safety layer.
    const err = await callError(h, "tastytrade_place_order", {
      account_number: "5WX00001",
      legs: [],
    });
    expect(err.code).toBe("dry_run_required");
  });

  it.each(UNRECOGNISED)(
    "%p is unrecognised, so it FAILS CLOSED: 72 tools, writes refused",
    async (value) => {
      process.env[READ_ONLY_ENV_VAR] = value;
      const h = await quietHarness();

      const { tools } = await h.client.listTools();
      expect(tools).toHaveLength(72);
      const err = await callError(h, "tastytrade_place_order", {
        account_number: "5WX00001",
      });
      expect(err.code).toBe("read_only_mode");
    },
  );

  it.each(UNRECOGNISED)(
    "%p warns on stderr, naming the value it could not read",
    async (value) => {
      process.env[READ_ONLY_ENV_VAR] = value;
      const cap = await captureOutput(() => createHarness());
      cleanups.push(() => cap.result.close());

      const warning = cap.stderr.find((line) =>
        /UNRECOGNISED READ-ONLY SETTING/.test(line),
      );
      expect(warning).toBeDefined();
      // Naming the value is the whole point: an operator scanning the log has
      // to see their own typo, not a generic complaint.
      expect(warning).toContain(JSON.stringify(value));
      expect(warning).toContain(READ_ONLY_ENV_VAR);
      // And it must say which way it failed, plus how to undo it.
      expect(warning).toMatch(/FAILING CLOSED/);
      expect(warning).toContain(`${READ_ONLY_ENV_VAR}=0`);
      // stderr only — stdout is the protocol channel.
      expect(cap.stdoutWrites).toEqual([]);
      expect(cap.logs).toBe(0);
    },
  );

  it.each([...TRUTHY, ...FALSY])(
    "%p is recognised, so it warns about nothing",
    async (value) => {
      process.env[READ_ONLY_ENV_VAR] = value;
      const cap = await captureOutput(() => createHarness());
      cleanups.push(() => cap.result.close());

      expect(
        cap.stderr.filter((line) => /UNRECOGNISED/.test(line)),
      ).toHaveLength(0);
    },
  );

  it("is off when the variable is absent entirely", async () => {
    expect(process.env[READ_ONLY_ENV_VAR]).toBeUndefined();
    const cap = await captureOutput(() => createHarness());
    cleanups.push(() => cap.result.close());

    const { tools } = await cap.result.client.listTools();
    expect(tools).toHaveLength(86);
    // Unset is not "unrecognised": the default must be silent.
    expect(cap.stderr.filter((line) => /UNRECOGNISED/.test(line))).toEqual([]);
  });

  it("keeps a fail-closed boot read-only even after the bad value is cleared", async () => {
    process.env[READ_ONLY_ENV_VAR] = "yes";
    const h = await quietHarness();
    // Booted read-only by the fail-closed path; clearing the variable now must
    // not re-open the write surface on a running server.
    delete process.env[READ_ONLY_ENV_VAR];

    const { tools } = await h.client.listTools();
    expect(tools).toHaveLength(72);
    const err = await callError(h, "tastytrade_place_order", {
      account_number: "5WX00001",
      legs: [],
    });
    expect(err.code).toBe("read_only_mode");
  });
});

// ===========================================================================
// 5. Read-only refusal is complete, and free
// ===========================================================================

describe("read-only mode withholds and refuses all 14 non-read tools", () => {
  it("advertises exactly 72 tools and hides every write and destructive one", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness();

    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(72);
    expect(names.filter((n) => WITHHELD_TOOLS.includes(n))).toEqual([]);
    // Every advertised tool really is in the read bucket.
    expect(
      names.filter((n) => bucketFor(TOOL_ANNOTATIONS[n]) !== "read"),
    ).toEqual([]);
  });

  it("refuses each withheld tool BY NAME, with no HTTP request at all", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness();

    expect(WITHHELD_TOOLS).toHaveLength(14);
    for (const name of WITHHELD_TOOLS) {
      const err = await callError(h, name, { account_number: "5WX00001" });
      expect(err.code).toBe("read_only_mode");
      expect(err.retryable).toBe(false);
      // The message must name the switch, so an operator can undo it.
      expect(err.message).toContain(READ_ONLY_ENV_VAR);
      expect(err.message).toContain(name);
    }

    // The whole point: the refusal happens in the dispatcher pre-flight, so a
    // hardcoded tool name never reaches the brokerage at all.
    expect(h.requests).toEqual([]);
  });

  it("keeps the hardcoded withheld list in step with TOOL_ANNOTATIONS", async () => {
    const derived = Object.keys(TOOL_ANNOTATIONS).filter(
      (name) => bucketFor(TOOL_ANNOTATIONS[name]) !== "read",
    );
    expect(derived.sort()).toEqual([...WITHHELD_TOOLS].sort());
  });

  it("still serves read tools, which do reach the API", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness({
      routes: [
        {
          matcher: "/customers/me/accounts",
          reply: {
            data: { items: [{ account: { "account-number": "5WX1" } }] },
          },
        },
      ],
    });

    const accounts = (await callOk(h, "tastytrade_get_accounts")) as unknown[];
    expect(accounts).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.method).toBe("GET");
  });
});

// ===========================================================================
// 6. Dry-run tools in read-only mode — documenting the actual behaviour
// ===========================================================================

describe("dry-run previews stay available in read-only mode", () => {
  // Actual behaviour, verified here rather than assumed: all six dry_run_*
  // tools are annotated READ_ONLY, so bucketFor() puts them in the "read"
  // bucket and the read-only gate lets them through. They POST to a /dry-run
  // endpoint, which prices and validates an order without routing it.
  it("advertises all six dry_run_* tools", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness();

    const names = (await h.client.listTools()).tools.map((t) => t.name);
    for (const tool of DRY_RUN_TOOLS) {
      expect(names).toContain(tool);
      expect(bucketFor(TOOL_ANNOTATIONS[tool])).toBe("read");
    }
  });

  it("runs a single-leg dry-run, translating snake_case to kebab-case", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/orders/dry-run",
          method: "POST",
          reply: {
            data: {
              "buying-power-effect": { "change-in-buying-power": "150.0" },
              warnings: [],
            },
          },
        },
      ],
    });

    const result = (await callOk(h, "tastytrade_dry_run_order", {
      account_number: "5WX00001",
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.50",
      price_effect: "Debit",
      legs: [
        {
          instrument_type: "Equity",
          symbol: "AAPL",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    })) as { confirmation_token: string | null };

    expect(h.requests).toHaveLength(1);
    const req = h.lastRequest()!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/accounts/5WX00001/orders/dry-run");
    // The translation seam: the agent said snake_case, the wire says kebab-case.
    expect(req.body).toEqual({
      "order-type": "Limit",
      "time-in-force": "Day",
      source: "tastytrade-mcp/1.0",
      price: "1.50",
      "price-effect": "Debit",
      legs: [
        {
          "instrument-type": "Equity",
          symbol: "AAPL",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    });
    // A clean dry-run still mints a confirmation token in read-only mode.
    expect(typeof result.confirmation_token).toBe("string");
  });

  it("mints a token that cannot be redeemed while read-only mode is on", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness({
      routes: [
        {
          matcher: /\/orders\/dry-run$/,
          method: "POST",
          reply: { data: { "buying-power-effect": {}, warnings: [] } },
        },
      ],
    });

    const args = {
      account_number: "5WX00001",
      order_type: "Limit",
      time_in_force: "Day",
      price: "1.50",
      price_effect: "Debit",
      legs: [
        {
          instrument_type: "Equity",
          symbol: "AAPL",
          action: "Buy to Open",
          quantity: 1,
        },
      ],
    };
    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string;
    };

    const err = await callError(h, "tastytrade_place_order", {
      ...args,
      confirmation_token: dry.confirmation_token,
    });
    // Refused at the gate, before consumeToken and before any POST — so the
    // token is inert: exactly one request (the dry-run) ever left the process.
    expect(err.code).toBe("read_only_mode");
    expect(h.requests).toHaveLength(1);
  });

  it("runs a complex-order dry-run against a recorded sandbox payload", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness({
      routes: [
        {
          matcher: "/accounts/5WX00001/complex-orders/dry-run",
          method: "POST",
          reply: { data: loadFixture("tastytrade_dry_run_complex_order") },
        },
      ],
    });

    const result = (await callOk(h, "tastytrade_dry_run_complex_order", {
      account_number: "5WX00001",
      type: "OCO",
      orders: [
        {
          order_type: "Limit",
          time_in_force: "GTC",
          price: "99999.0",
          price_effect: "Credit",
          legs: [
            {
              instrument_type: "Equity",
              symbol: "AAPL",
              action: "Sell to Close",
              quantity: 1,
            },
          ],
        },
      ],
    })) as Record<string, unknown>;

    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.url).toBe(
      "/accounts/5WX00001/complex-orders/dry-run",
    );
    // The broker's projection is boxed under `upstream`;
    // `confirmation_token` is the server's and stays at the top level.
    expect(
      (result.upstream as Record<string, unknown>)["buying-power-effect"],
    ).toBeDefined();
    expect(typeof result.confirmation_token).toBe("string");
  });
});

// ===========================================================================
// 7. Version coherence
// ===========================================================================

describe("one version, reported identically everywhere", () => {
  it("reads the package.json version, not the unknown sentinel", () => {
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(PACKAGE_VERSION).toBe(PKG.version);
    expect(PACKAGE_VERSION).not.toBe("0.0.0-unknown");
    expect(DEFAULT_USER_AGENT).toBe(`${SERVER_NAME}/${PKG.version}`);
  });

  it("advertises it in the MCP handshake", async () => {
    const h = await quietHarness();
    const info = h.client.getServerVersion();
    expect(info?.name).toBe(SERVER_NAME);
    expect(info?.version).toBe(PKG.version);
  });

  it("sends it as the default User-Agent on every request", async () => {
    const h = await quietHarness({
      routes: [
        { matcher: "/customers/me/accounts", reply: { data: { items: [] } } },
      ],
    });
    await callOk(h, "tastytrade_get_accounts");

    // The three observable reports of the version must agree; they drifted once
    // because each carried its own literal.
    expect(h.lastRequest()?.headers["user-agent"]).toBe(
      `${SERVER_NAME}/${PKG.version}`,
    );
    expect(h.lastRequest()?.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(h.client.getServerVersion()?.version).toBe(PKG.version);
  });

  it("lets TASTYTRADE_USER_AGENT override the header", async () => {
    process.env.TASTYTRADE_USER_AGENT = "my-client/9.9.9";
    const h = await quietHarness({
      routes: [
        { matcher: "/customers/me/accounts", reply: { data: { items: [] } } },
      ],
    });
    await callOk(h, "tastytrade_get_accounts");

    expect(h.lastRequest()?.headers["user-agent"]).toBe("my-client/9.9.9");
    // The override is transport-only: the handshake still reports the build.
    expect(h.client.getServerVersion()?.version).toBe(PKG.version);
  });
});

// ===========================================================================
// 8. Read-only mode is fixed at construction
// ===========================================================================

describe("read-only mode is captured at construction", () => {
  it("cannot be switched OFF by mutating the environment afterwards", async () => {
    process.env[READ_ONLY_ENV_VAR] = "1";
    const h = await quietHarness();
    expect((await h.client.listTools()).tools).toHaveLength(72);

    // The security-relevant direction: a caller who can influence the process
    // environment mid-session must not be able to unlock the write surface.
    delete process.env[READ_ONLY_ENV_VAR];

    expect((await h.client.listTools()).tools).toHaveLength(72);
    const err = await callError(h, "tastytrade_place_order", {
      account_number: "5WX00001",
    });
    expect(err.code).toBe("read_only_mode");
    expect(h.requests).toEqual([]);
  });

  it("cannot be switched ON by mutating the environment afterwards", async () => {
    // The reply must satisfy the tool's declared outputSchema — the MCP client
    // validates structuredContent, so a bare {} is rejected before the test can
    // assert anything.
    const created = {
      name: "e2e",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    };
    const h = await quietHarness({
      routes: [
        { matcher: "/watchlists", method: "POST", reply: { data: created } },
      ],
    });
    expect((await h.client.listTools()).tools).toHaveLength(86);

    process.env[READ_ONLY_ENV_VAR] = "1";

    // Still 86, and a write still executes: read-only is a startup decision, so
    // tightening it requires a restart. Documented, not incidental.
    expect((await h.client.listTools()).tools).toHaveLength(86);
    expect(
      await callOk(h, "tastytrade_create_watchlist", {
        name: "e2e",
        symbols: ["AAPL"],
      }),
    ).toEqual(created);
    expect(h.requests).toHaveLength(1);
    expect(h.lastRequest()?.method).toBe("POST");
    expect(h.lastRequest()?.body).toEqual({
      name: "e2e",
      "watchlist-entries": [{ symbol: "AAPL", "instrument-type": "Equity" }],
    });
  });
});

// ===========================================================================
// The credential destination: an unrecognised host never receives the token
// ===========================================================================

describe("the OAuth credentials go only where the server can vouch for", () => {
  /**
   * The worst finding in the review, and the reason this section exists.
   *
   * With no host allowlist and no scheme check on `TASTYTRADE_API_URL`, the server
   * accepts ANY value and warns only when the hostname is exactly `api.tastyworks.com`
   * — so `http://evil.example` produces no banner, no warning and no refusal, and the
   * first tool call POSTs `{grant_type, refresh_token, client_id, client_secret}` there
   * in cleartext. A tastytrade refresh token is long-lived and non-rotating, so one
   * leak is durable access to a funded brokerage account.
   *
   * The realistic vector is a poisoned or copy-pasted MCP client config — README.md and
   * server.json both ship paste-ready blocks setting this variable — which is why the
   * answer is a REFUSAL rather than a warning: the operator who pasted the config is not
   * reading stderr, and by the time anyone does the token is gone.
   *
   * Every test here asserts the same property from a different angle: for a host this
   * server does not recognise, no client is constructed, no request is made, and the
   * process does not start.
   */

  /** Constructs the server from the environment, capturing startup output. */
  async function boot(): Promise<Capture<{ threw: boolean; message: string }>> {
    return captureOutput(() => {
      try {
        // No `config`: the constructor falls through to resolveApiUrl() and the
        // TASTYTRADE_* credential vars, which is the production code path.
        new TastytradeMCPServer(undefined, {
          adapter: async () => {
            throw new Error(
              "the transport must never be reached for a refused host",
            );
          },
          tokenProvider: () => "test-access-token",
        });
        return { threw: false, message: "" };
      } catch (e) {
        return { threw: true, message: (e as Error).message };
      }
    });
  }

  const REFUSAL = /REFUSING TO START/;

  it.each([
    ["a plain attacker host", "https://evil.example.com"],
    ["a look-alike suffix", "https://api.tastyworks.com.evil.example"],
    [
      "the production host as a PATH on another origin",
      "https://evil.example/api.tastyworks.com",
    ],
    [
      "the production host as USERINFO on another origin",
      "https://api.tastyworks.com@evil.example",
    ],
    ["a loopback listener", "http://127.0.0.1:9999"],
    [
      "a sandbox name on the wrong domain",
      "https://api.sandbox.tastyworks.com",
    ],
    ["the other swapped domain", "https://api.cert.tastytrade.com"],
  ])("refuses to start for %s", async (_label, url) => {
    process.env.TASTYTRADE_API_URL = url;
    process.env.TASTYTRADE_CLIENT_ID = "real-client-id";
    process.env.TASTYTRADE_CLIENT_SECRET = "REAL-CLIENT-SECRET";
    process.env.TASTYTRADE_REFRESH_TOKEN = "REAL-REFRESH-TOKEN";

    const cap = await boot();

    expect(cap.result.threw).toBe(true);
    expect(cap.result.message).toMatch(/Refusing to start/);
    expect(cap.stderr.filter((l) => REFUSAL.test(l))).toHaveLength(1);
    // stdout is the MCP protocol channel; a refusal must not corrupt it either.
    expect(cap.stdoutWrites).toEqual([]);
    expect(cap.logs).toBe(0);
    // And nothing about the credentials reached stderr along the way.
    for (const line of cap.stderr) {
      expect(line).not.toContain("REAL-CLIENT-SECRET");
      expect(line).not.toContain("REAL-REFRESH-TOKEN");
    }
  });

  it("names the two swapped sandbox domains when that is the mistake", async () => {
    process.env.TASTYTRADE_API_URL = "https://api.sandbox.tastyworks.com";
    const cap = await boot();
    const banner = cap.stderr.find((l) => REFUSAL.test(l))!;
    expect(banner).toMatch(/api\.cert on tastyworks\.com/);
    expect(banner).toMatch(/api\.sandbox on tastytrade\.com/);
  });

  it.each([
    ["production", PRODUCTION_API_URL],
    ["the cert sandbox", SANDBOX_API_URL],
    ["the other sandbox", "https://api.sandbox.tastytrade.com"],
  ])("starts normally for %s", async (_label, url) => {
    process.env.TASTYTRADE_API_URL = url;
    const cap = await boot();
    expect(cap.result.threw).toBe(false);
    expect(cap.stderr.filter((l) => REFUSAL.test(l))).toHaveLength(0);
    expect(cap.stderr.filter((l) => /UNRECOGNISED API HOST/.test(l))).toEqual(
      [],
    );
  });

  it("proves it by driving a tool call: an unrecognised host gets no request", async () => {
    // The review's exploit, run in reverse. A local listener stands in for the
    // attacker; the assertion is that the adapter is never invoked at all, so
    // neither the token POST nor the API GET can happen.
    process.env.TASTYTRADE_API_URL = "http://127.0.0.1:9999";
    process.env.TASTYTRADE_CLIENT_ID = "real-client-id";
    process.env.TASTYTRADE_CLIENT_SECRET = "REAL-CLIENT-SECRET";
    process.env.TASTYTRADE_REFRESH_TOKEN = "REAL-REFRESH-TOKEN";

    let adapterCalls = 0;
    const cap = await captureOutput(() => {
      try {
        new TastytradeMCPServer(undefined, {
          adapter: async () => {
            adapterCalls += 1;
            throw new Error("unreachable");
          },
          tokenProvider: () => "test-access-token",
        });
        return true;
      } catch {
        return false;
      }
    });

    expect(cap.result).toBe(false);
    expect(adapterCalls).toBe(0);
  });

  it("refuses plain http to a non-loopback host even when the host is acknowledged", async () => {
    // The one rule with no escape hatch. `TASTYTRADE_ALLOW_UNKNOWN_API_HOST`
    // acknowledges a HOST; it says nothing about an unencrypted channel, and
    // the credentials would cross the network in clear text.
    process.env.TASTYTRADE_API_URL = "http://proxy.internal";
    process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] = "proxy.internal";

    const cap = await boot();
    expect(cap.result.threw).toBe(true);
    const banner = cap.stderr.find((l) => REFUSAL.test(l))!;
    expect(banner).toMatch(/clear text/);
  });

  it("refuses plain http to a RECOGNISED host: the downgrade is the attack", async () => {
    process.env.TASTYTRADE_API_URL = "http://api.tastyworks.com";
    const cap = await boot();
    expect(cap.result.threw).toBe(true);
    expect(cap.stderr.find((l) => REFUSAL.test(l))).toMatch(/clear text/);
  });

  it.each([
    ["an unparseable value", "not a url"],
    ["a scheme the client cannot speak", "ftp://api.tastyworks.com"],
    ["a bare host with no scheme", "api.tastyworks.com"],
  ])("refuses %s", async (_label, url) => {
    process.env.TASTYTRADE_API_URL = url;
    const cap = await boot();
    expect(cap.result.threw).toBe(true);
    expect(cap.stderr.filter((l) => REFUSAL.test(l))).toHaveLength(1);
  });

  describe("the escape hatch names the host, so it cannot bless a later change", () => {
    it("admits an acknowledged host over https, with a banner nobody can miss", async () => {
      process.env.TASTYTRADE_API_URL = "https://proxy.internal:8443";
      process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] = "proxy.internal";

      const cap = await boot();
      expect(cap.result.threw).toBe(false);

      const banner = cap.stderr.find((l) => /UNRECOGNISED API HOST/.test(l))!;
      expect(banner).toBeDefined();
      expect(banner).toContain("proxy.internal");
      expect(banner).toMatch(/refresh token and client secret will be sent/i);
      expect(banner).toMatch(/rotate the credential/i);
      // Origin only, as everywhere else — the port is identity, the path is not.
      expect(banner).toContain("https://proxy.internal:8443");
      expect(cap.stdoutWrites).toEqual([]);
    });

    it("admits plain http on loopback, because that request never leaves the machine", async () => {
      process.env.TASTYTRADE_API_URL = "http://localhost:8080";
      process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] = "localhost";
      const cap = await boot();
      expect(cap.result.threw).toBe(false);
      expect(
        cap.stderr.filter((l) => /UNRECOGNISED API HOST/.test(l)),
      ).toHaveLength(1);
    });

    it("does NOT admit a host the acknowledgement does not name", async () => {
      // This is the whole reason the hatch takes hostnames instead of a
      // boolean: a config that later retargets the URL fails closed again
      // rather than inheriting a blanket "yes".
      process.env.TASTYTRADE_API_URL = "https://evil.example";
      process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] = "proxy.internal";

      const cap = await boot();
      expect(cap.result.threw).toBe(true);
      expect(cap.stderr.find((l) => REFUSAL.test(l))).toContain("evil.example");
    });

    it.each([["1"], ["true"], ["yes"], ["*"], [""]])(
      "does not treat the boolean-ish value %p as blanket permission",
      async (value) => {
        process.env.TASTYTRADE_API_URL = "https://evil.example";
        process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] = value;
        const cap = await boot();
        expect(cap.result.threw).toBe(true);
      },
    );

    it("accepts a comma-separated list, case-insensitively", async () => {
      process.env.TASTYTRADE_API_URL = "https://Proxy.Internal";
      process.env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] =
        " gateway.example , PROXY.INTERNAL ";
      const cap = await boot();
      expect(cap.result.threw).toBe(false);
    });

    it("tells a refused operator the exact variable and value to set", async () => {
      process.env.TASTYTRADE_API_URL = "https://proxy.internal";
      const cap = await boot();
      const banner = cap.stderr.find((l) => REFUSAL.test(l))!;
      expect(banner).toContain(
        `${ALLOW_UNKNOWN_API_HOST_ENV_VAR}=proxy.internal`,
      );
      expect(banner).toContain(KNOWN_API_HOSTS.join(", "));
    });
  });

  describe("inspectCredentialTarget, directly", () => {
    // The banner tests above prove the wiring; these pin the decision itself,
    // which is the part a future edit is most likely to get subtly wrong.
    const env = (ack?: string): NodeJS.ProcessEnv =>
      ack === undefined ? {} : { [ALLOW_UNKNOWN_API_HOST_ENV_VAR]: ack };

    it("compares on the parsed hostname, never on a substring", () => {
      for (const host of KNOWN_API_HOSTS) {
        expect(inspectCredentialTarget(`https://${host}`, env()).allowed).toBe(
          true,
        );
      }
      // Every way of putting a recognised name into a URL that dials elsewhere:
      // the host it really dials is `evil.example`, and that is what decides.
      for (const url of [
        "https://evil.example/api.tastyworks.com",
        "https://api.tastyworks.com@evil.example",
        "https://evil.example?h=api.tastyworks.com",
        "https://evil.example#api.tastyworks.com",
      ]) {
        const d = inspectCredentialTarget(url, env());
        expect(d.allowed).toBe(false);
        expect(d.hostname).toBe("evil.example");
      }
      // And a suffix is not a match: `api.tastyworks.com.evil.example` is a
      // registrable domain the attacker owns, which a substring probe accepts.
      const suffix = inspectCredentialTarget(
        "https://api.tastyworks.com.evil.example",
        env(),
      );
      expect(suffix.allowed).toBe(false);
      expect(suffix.hostname).toBe("api.tastyworks.com.evil.example");
    });

    it("treats the whole 127.0.0.0/8 block and ::1 as loopback", () => {
      for (const host of ["127.0.0.1", "127.1.2.3", "[::1]", "localhost"]) {
        const d = inspectCredentialTarget(`http://${host}:8080`, env(host));
        expect(d.allowed).toBe(true);
      }
      // `new URL()` normalises the short, octal and integer spellings, so the
      // dotted-quad check sees a canonical address in every case.
      for (const url of [
        "http://127.1:8080",
        "http://0177.0.0.1:8080",
        "http://2130706433:8080",
      ]) {
        const d = inspectCredentialTarget(url, env("127.0.0.1"));
        expect(d.hostname).toBe("127.0.0.1");
        expect(d.allowed).toBe(true);
      }
      // Not loopback, despite the resemblance. `127.999.1.1` is the one worth
      // naming: it has the SHAPE of a dotted quad but 999 is not an octet, so
      // `new URL()` keeps it as a domain name that could resolve anywhere.
      for (const host of [
        "127.example.com",
        "127.999.1.1",
        "127.0.0.1.evil.example",
        "10.0.0.1",
        "0.0.0.0",
      ]) {
        expect(
          inspectCredentialTarget(`http://${host}`, env(host)).allowed,
        ).toBe(false);
      }
    });

    it("reports an absent URL as a refusal rather than silently allowing it", () => {
      for (const value of [undefined, "", "   "]) {
        const d = inspectCredentialTarget(value, env());
        expect(d.allowed).toBe(false);
        expect(d.refusal).toBeDefined();
      }
    });

    it("distinguishes 'recognised' from 'allowed'", () => {
      const proxy = inspectCredentialTarget(
        "https://proxy.internal",
        env("proxy.internal"),
      );
      expect(proxy.allowed).toBe(true);
      expect(proxy.recognised).toBe(false);
      expect(proxy.acknowledged).toBe(true);

      const prod = inspectCredentialTarget(PRODUCTION_API_URL, env());
      expect(prod.allowed).toBe(true);
      expect(prod.recognised).toBe(true);
      expect(prod.acknowledged).toBe(false);
    });

    it("keeps the allowlist in step with the doctor's", () => {
      // src/doctor.ts implements the same classification for the preflight CLI.
      // Two allowlists that disagree are worse than one, so this pins them
      // together: every host the server accepts must be one the doctor calls
      // production or sandbox, and vice versa.
      for (const host of KNOWN_API_HOSTS) {
        expect(["production", "sandbox"]).toContain(
          classifyApiHost(host).environment,
        );
      }
      for (const host of [
        "api.sandbox.tastyworks.com",
        "api.cert.tastytrade.com",
        "evil.example",
      ]) {
        expect(["production", "sandbox"]).not.toContain(
          classifyApiHost(host).environment,
        );
        expect(KNOWN_API_HOSTS).not.toContain(host);
      }
    });
  });
});

// ===========================================================================
// What a session's log actually says
// ===========================================================================

describe("the startup line", () => {
  /**
   * A real stdio session's ENTIRE stderr would be one line, "tastytrade MCP
   * Server running on stdio" — which answers neither "which build is running"
   * nor "what is it pointed at", on a server that places real orders, with MCP
   * clients as the thing that collects and persists that log.
   *
   * Pinned through `startupBanner`, the pure function `run()` writes, because
   * asserting it any other way would mean connecting a real StdioServerTransport
   * inside the test process.
   */

  it("names the build, the endpoint and the mode", () => {
    const line = startupBanner("https://api.cert.tastyworks.com", false);
    expect(line).toContain(`tastytrade-mcp-server/${PACKAGE_VERSION}`);
    expect(line).toContain("https://api.cert.tastyworks.com");
    expect(line).toContain("read-write");
    // The one substring the barrel test uses to prove an import starts nothing.
    expect(line).toContain("on stdio");
  });

  it("says read-only when read-only mode is on", () => {
    const line = startupBanner(SANDBOX_API_URL, true);
    expect(line).toContain("read-only");
    expect(line).not.toContain("read-write");
  });

  it("distinguishes production from the sandbox at a glance", () => {
    expect(startupBanner(PRODUCTION_API_URL, false)).toContain(
      "api.tastyworks.com",
    );
    expect(startupBanner(PRODUCTION_API_URL, false)).not.toContain("cert");
  });

  it("cannot carry a credential, because it takes the display form", () => {
    // TASTYTRADE_API_URL is operator-supplied and a URL may embed credentials
    // in its userinfo, which axios turns into a Basic auth header. The banner
    // is fed apiEndpointForDisplay's output for exactly this reason — stderr is
    // where MCP clients keep server logs.
    const withSecret =
      "https://apiuser:s3cret@api.cert.tastyworks.com/v1?t=xyz";
    const line = startupBanner(apiEndpointForDisplay(withSecret), false);
    expect(line).not.toContain("s3cret");
    expect(line).not.toContain("apiuser");
    expect(line).not.toContain("xyz");
    expect(line).toContain("https://api.cert.tastyworks.com");
  });
});

// ===========================================================================
// Importing the package must not start a server on the importer's stdio
// ===========================================================================

describe("the library barrel is not an entrypoint", () => {
  /**
   * `package.json` sets `main: dist/index.js` and the top half of that file is a
   * deliberate public API re-export, so importing it as a library is invited.
   * Module scope nevertheless ran `new TastytradeMCPServer(); server.run()`
   * unconditionally, under a comment — "Start server if run directly" —
   * describing a guard that had never been written. A consumer who imported the
   * barrel got JSON-RPC frames on THEIR stdout, an event loop held open forever,
   * and an application whose own stdin was now a remote control for
   * `tastytrade_place_order` against a funded account.
   */

  it("attaches nothing to stdin and writes nothing when imported", async () => {
    const before = {
      data: process.stdin.listenerCount("data"),
      readable: process.stdin.listenerCount("readable"),
    };

    const cap = await captureOutput(async () => import("../../src/index.js"));

    // The barrel's public API is there...
    expect(typeof cap.result.TastytradeMCPServer).toBe("function");
    expect(typeof cap.result.TastytradeClient).toBe("function");
    expect(typeof cap.result.TastytradeOAuthClient).toBe("function");
    // ...and nothing else happened. A connected StdioServerTransport subscribes
    // to stdin and announces itself on stderr; neither is true here.
    expect(process.stdin.listenerCount("data")).toBe(before.data);
    expect(process.stdin.listenerCount("readable")).toBe(before.readable);
    expect(cap.stdoutWrites).toEqual([]);
    expect(cap.logs).toBe(0);
    expect(cap.stderr.filter((l) => /running on stdio/.test(l))).toEqual([]);
  });

  it("recognises the entry module only when argv[1] resolves to it", async () => {
    const { isEntryModule } = await import("../../src/index.js");
    const self = fileURLToPath(import.meta.url);

    // argv[1] is a filesystem path, so the comparison has to normalise it —
    // a raw string compare against `import.meta.url` never matches.
    expect(isEntryModule(pathToFileURL(self).href, self)).toBe(true);
    expect(isEntryModule(pathToFileURL(self).href, `${self}.other`)).toBe(
      false,
    );
    // No argv[1] at all: `node -e`, a REPL, or an import from a worker.
    expect(isEntryModule(pathToFileURL(self).href, undefined)).toBe(false);
    expect(isEntryModule(pathToFileURL(self).href, "")).toBe(false);
  });

  it("still recognises the entry module when it is launched through a symlink", async () => {
    // Node resolves an ESM specifier to the real path, so `import.meta.url` is
    // dereferenced while argv[1] is whatever the caller typed. An npm `bin`
    // shim, a /usr/local/bin link or a container layer makes those two
    // spellings differ, and treating that as "imported" would silently start
    // nothing — the quietest possible failure for an entrypoint.
    const { isEntryModule } = await import("../../src/index.js");
    const real = fileURLToPath(import.meta.url);
    const link = path.join(
      mkdtempSync(path.join(tmpdir(), "tt-entry-")),
      "linked.js",
    );
    symlinkSync(real, link);
    try {
      expect(isEntryModule(pathToFileURL(real).href, link)).toBe(true);
    } finally {
      rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  it("never throws out of the guard, whatever argv[1] holds", async () => {
    const { isEntryModule } = await import("../../src/index.js");
    // A barrel import must not be able to fail here: the guard is the first
    // thing that runs at module scope.
    for (const argv1 of ["\u0000", "://", "\\\\?\\C:\\x", "-"]) {
      expect(() => isEntryModule("file:///x.js", argv1)).not.toThrow();
    }
  });
});

// ===========================================================================
// The risk briefing carried by the tool registry
// ===========================================================================

describe("destructive tool descriptions do not undersell the risk", () => {
  /**
   * These strings are a risk briefing, and three said the opposite of what the
   * safety layer actually promises, on the two questions that matter most.
   *
   *   - place_order ended "The dry-run-then-confirm flow is the human-in-the-loop
   *     checkpoint that gates live submission." The token proves recency and
   *     identity of arguments, not intent — it is not a human approval, because the
   *     same agent mints it and redeems it milliseconds later.
   *   - cancel_complex_order said "cancels reduce risk", when cancelling a
   *     protective stop or a working hedge changes risk immediately.
   *   - cancel_order, the most direct route to raising a funded account's risk with no
   *     token and no sanity check, said only "Cancel a working order".
   *
   * WHICH DESCRIPTION THESE ARE: `decorateTool` OVERRIDES a tool's description with
   * `TOOL_METADATA[name]`'s whenever one exists, and one exists for all 93 tools — so
   * these are the registry's own strings, NOT what reaches `tools/list`. They are still
   * the definitions a maintainer reads and the fallback if a metadata entry is dropped.
   *
   * `getTools()` is private, reached the way test/mcp-server/public-surface.test.ts
   * reaches other internals: the alternative is asserting on file contents, which pins
   * the source text rather than the registry.
   */

  interface RegistryInternals {
    getTools(): Array<{ name: string; description?: string }>;
  }

  function registryDescription(name: string): string {
    const server = new TastytradeMCPServer({
      apiUrl: SANDBOX_API_URL,
    }) as unknown as RegistryInternals;
    const tool = server.getTools().find((t) => t.name === name);
    expect(tool).toBeDefined();
    return tool!.description ?? "";
  }

  it("place_order does not claim a human checkpoint gates submission", () => {
    const description = registryDescription("tastytrade_place_order");

    expect(description).not.toMatch(/human-in-the-loop/i);
    // What is actually true, and the one place a human gate can come from.
    expect(description).toMatch(/NOT a human approval/i);
    expect(description).toMatch(/60 seconds/);
    expect(description).toMatch(/tool-approval UI/i);
    // Still says the token is required, which is the operative instruction.
    expect(description).toMatch(/confirmation_token/);
  });

  it.each([["tastytrade_cancel_order"], ["tastytrade_cancel_complex_order"]])(
    "%s says a cancel can raise risk, not lower it",
    (name) => {
      const description = registryDescription(name);

      expect(description).not.toMatch(/reduce risk/i);
      expect(description).toMatch(/protective stop|hedge/i);
      expect(description).toMatch(/cannot be undone/i);
      // The true half is kept: this is why no token is required.
      expect(description).toMatch(/cannot create an obligation/i);
    },
  );

  it("gives cancel_order more than four words to hesitate over", () => {
    // It shipped as the literal string "Cancel a working order" — the shortest
    // description in the registry, on the most consequential ungated tool in it.
    expect(
      registryDescription("tastytrade_cancel_order").length,
    ).toBeGreaterThan(120);
  });

  it("records that TOOL_METADATA shadows every one of these", async () => {
    // Not decoration: it is the reason the assertions above are on the registry
    // rather than on the wire, and it is the thing a reader gets wrong. If a
    // metadata description is ever dropped, the registry string below becomes
    // the live one — which is the other reason it has to be correct.
    const h = await quietHarness();
    const { tools } = await h.client.listTools();
    for (const tool of tools) {
      const meta = TOOL_METADATA[tool.name];
      expect(meta?.description).toBeDefined();
      expect(tool.description).toBe(meta!.description);
    }
  });
});
