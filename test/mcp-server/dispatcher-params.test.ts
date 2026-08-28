/**
 * What the dispatcher hands the API client — the snake→kebab seam, one call
 * argument at a time.
 *
 * The client is replaced with a recorder, so these assert the dispatcher's own
 * contract rather than axios's behaviour: which query parameters it builds, and
 * which it leaves out. That distinction matters because "left out" and "present
 * but undefined" look identical once axios has serialized them — axios happens to
 * drop undefined values today, which is exactly why an unguarded params object
 * can sit in the tree unnoticed until a paramsSerializer or a different
 * transport starts emitting `?time-back=undefined`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  TastytradeMCPServer,
  SANDBOX_API_URL,
  decorateTool,
} from "../../src/mcp-server/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

type ServerInternals = {
  getTools(): Tool[];
  handleToolCall(name: string, args: unknown): Promise<any>;
  client: Record<string, (...args: unknown[]) => unknown>;
};

/** A recorded client call: the method name and the arguments it received. */
interface Call {
  method: string;
  args: unknown[];
}

/**
 * A server whose client records every call and answers with `reply`. Nothing
 * network-facing is constructed beyond the axios instance the constructor makes.
 */
function serverWithRecorder(reply: unknown = { items: [] }): {
  server: ServerInternals;
  calls: Call[];
} {
  const calls: Call[] = [];
  const server = new TastytradeMCPServer({
    apiUrl: SANDBOX_API_URL,
  }) as unknown as ServerInternals;
  server.client = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (...args: unknown[]) => {
          calls.push({ method, args });
          return Promise.resolve(reply);
        },
    },
  ) as ServerInternals["client"];
  return { server, calls };
}

function schemaOf(name: string): {
  properties: Record<string, unknown>;
  required?: string[];
} {
  const server = new TastytradeMCPServer({
    apiUrl: SANDBOX_API_URL,
  }) as unknown as ServerInternals;
  const tool = server
    .getTools()
    .map(decorateTool)
    .find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!.inputSchema as {
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// tastytrade_get_earnings_reports — start-date is REQUIRED by the endpoint
// ---------------------------------------------------------------------------

describe("tastytrade_get_earnings_reports carries the required date range", () => {
  it("declares start_date as a required input property", () => {
    // open-api-spec/market-metrics.md marks `start-date` Required on
    // GET /market-metrics/historic-corporate-events/earnings-reports/{symbol}.
    // The schema would expose `symbol` alone, and decorateTool closes every
    // input object with additionalProperties:false — so a schema-validating
    // client could not even pass start_date and every live call was rejected.
    const schema = schemaOf("tastytrade_get_earnings_reports");
    expect(schema.properties.start_date).toBeDefined();
    expect(schema.properties.end_date).toBeDefined();
    expect(schema.required).toEqual(["symbol", "start_date"]);
  });

  it("carries the paramDescriptions its metadata already wrote for them", () => {
    // The metadata described start_date/end_date all along; with no matching
    // properties those descriptions were silently dropped by decorateTool.
    const schema = schemaOf("tastytrade_get_earnings_reports");
    expect(
      (schema.properties.start_date as { description?: string }).description,
    ).toMatch(/Required/);
    expect(
      (schema.properties.end_date as { description?: string }).description,
    ).toMatch(/Optional/);
  });

  it("forwards start_date and end_date as kebab-case query params", async () => {
    const { server, calls } = serverWithRecorder([]);
    await server.handleToolCall("tastytrade_get_earnings_reports", {
      symbol: "AAPL",
      start_date: "2024-01-01",
      end_date: "2026-01-01",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("getEarningsReports");
    expect(calls[0].args[0]).toBe("AAPL");
    expect(calls[0].args[1]).toEqual({
      "start-date": "2024-01-01",
      "end-date": "2026-01-01",
    });
  });

  it("omits end_date when the agent leaves it out", async () => {
    const { server, calls } = serverWithRecorder([]);
    await server.handleToolCall("tastytrade_get_earnings_reports", {
      symbol: "AAPL",
      start_date: "2024-01-01",
    });

    expect(calls[0].args[1]).toEqual({ "start-date": "2024-01-01" });
    expect(Object.keys(calls[0].args[1] as object)).not.toContain("end-date");
  });
});

// ---------------------------------------------------------------------------
// Optional query parameters are omitted, not sent as undefined
// ---------------------------------------------------------------------------

describe("optional query parameters are omitted when absent", () => {
  it("get_net_liq_history sends no params at all with no filters", async () => {
    const { server, calls } = serverWithRecorder([]);
    await server.handleToolCall("tastytrade_get_net_liq_history", {
      account_number: "5WX00001",
    });

    expect(calls[0].method).toBe("getNetLiquidatingValueHistory");
    expect(calls[0].args[0]).toBe("5WX00001");
    // Previously `{ "time-back": undefined, "start-time": undefined,
    // "end-time": undefined, interval: undefined }` on every single call.
    expect(calls[0].args[1]).toEqual({});
    expect(Object.keys(calls[0].args[1] as object)).toEqual([]);
  });

  it("get_net_liq_history forwards only the filters that were set", async () => {
    const { server, calls } = serverWithRecorder([]);
    await server.handleToolCall("tastytrade_get_net_liq_history", {
      account_number: "5WX00001",
      time_back: "1m",
    });
    expect(calls[0].args[1]).toEqual({ "time-back": "1m" });

    await server.handleToolCall("tastytrade_get_net_liq_history", {
      account_number: "5WX00001",
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2026-02-01T00:00:00Z",
      interval: "1d",
    });
    expect(calls[1].args[1]).toEqual({
      "start-time": "2026-01-01T00:00:00Z",
      "end-time": "2026-02-01T00:00:00Z",
      interval: "1d",
    });
  });

  it("get_total_fees omits `date` rather than sending it undefined", async () => {
    const { server, calls } = serverWithRecorder({});
    await server.handleToolCall("tastytrade_get_total_fees", {
      account_number: "5WX00001",
    });
    expect(calls[0].method).toBe("getTotalFees");
    expect(calls[0].args[1]).toEqual({});

    await server.handleToolCall("tastytrade_get_total_fees", {
      account_number: "5WX00001",
      date: "2026-08-14",
    });
    expect(calls[1].args[1]).toEqual({ date: "2026-08-14" });
  });

  it("no query-param object the dispatcher builds carries an undefined value", async () => {
    // A sweep rather than a per-tool case: every read tool that takes only an
    // account number is called with nothing else, and any params object handed
    // to the client must have no undefined-valued key. This is the invariant
    // the two fixes above restore, asserted where a new tool would trip it.
    const paramTools: Array<[string, Record<string, unknown>]> = [
      ["tastytrade_get_net_liq_history", { account_number: "5WX00001" }],
      ["tastytrade_get_total_fees", { account_number: "5WX00001" }],
      ["tastytrade_get_balance_snapshots", { account_number: "5WX00001" }],
      ["tastytrade_get_active_equities", {}],
      ["tastytrade_get_transactions", { account_number: "5WX00001" }],
      ["tastytrade_get_positions", { account_number: "5WX00001" }],
      ["tastytrade_get_earnings_reports", { symbol: "AAPL" }],
    ];

    const { server, calls } = serverWithRecorder([]);
    for (const [name, args] of paramTools) {
      await server.handleToolCall(name, args);
    }
    expect(calls).toHaveLength(paramTools.length);

    const offenders: string[] = [];
    for (const call of calls) {
      for (const arg of call.args) {
        if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;
        for (const [key, value] of Object.entries(arg)) {
          if (value === undefined) offenders.push(`${call.method}.${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
