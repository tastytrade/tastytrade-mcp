/**
 * Shutdown through the real dispatcher: once the server is told to stop it starts
 * no new call, finishes the ones running, and sends no order that has not yet gone
 * out.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness, callOk } from "./harness.js";
import type { Harness, Route } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { _resetTokensForTest } from "../../src/safety/confirmation.js";
import type { ToolError } from "../../src/safety/errors.js";
import { installShutdownHandlers } from "../../src/shutdown.js";
import type { ShutdownSignal } from "../../src/shutdown.js";

const ACCT = "5WX00001";
const BALANCES = `/accounts/${ACCT}/balances`;
const POSITIONS = `/accounts/${ACCT}/positions`;
const POSITION_LIMIT = `/accounts/${ACCT}/position-limit`;

let h: Harness | undefined;

beforeEach(() => {
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  _resetRateLimitsForTest();
  _resetTokensForTest();
});

type Result = { isError?: boolean; content?: Array<{ text?: string }> };

const errorOf = (res: Result): ToolError =>
  JSON.parse(res.content?.[0]?.text ?? "{}") as ToolError;

/** Wait until `count` tool calls are running, so a test shuts down mid-call. */
async function untilRunning(harness: Harness, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (harness.server.running < count) {
    if (Date.now() > deadline) throw new Error("the call never started");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Wait until the fake broker has seen a request whose path ends `suffix`. */
async function untilRequested(harness: Harness, suffix: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!harness.requests.some((r) => r.url.endsWith(suffix))) {
    if (Date.now() > deadline) throw new Error(`never requested ${suffix}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("a call that arrives after shutdown has begun", () => {
  it("is refused with request_cancelled and sends nothing, while the running call finishes", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { data: { "net-liquidating-value": "1.00" }, delayMs: 300 },
        },
        { matcher: POSITIONS, method: "GET", reply: { data: { items: [] } } },
      ],
    });

    const first = h.client.callTool({
      name: "tastytrade_get_balances",
      arguments: { account_number: ACCT },
    });
    await untilRunning(h, 1);
    const drain = h.server.beginShutdown(5000);

    const second = (await h.client.callTool({
      name: "tastytrade_get_positions",
      arguments: { account_number: ACCT },
    })) as Result;
    expect(second.isError).toBe(true);
    const err = errorOf(second);
    expect(err.code).toBe("request_cancelled");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("shutting down");
    expect(h.requests.some((r) => r.url.endsWith("/positions"))).toBe(false);

    const firstResult = (await first) as Result;
    expect(firstResult.isError).toBeFalsy();
    expect(firstResult.content?.[0]?.text).toContain("net-liquidating-value");
    await expect(drain).resolves.toEqual({ drained: true });
    expect(h.server.running).toBe(0);
  });

  it("is refused before any rate-limit charge or account lookup", async () => {
    h = await createHarness();
    await h.server.beginShutdown(1000);
    const res = (await h.client.callTool({
      name: "tastytrade_get_positions",
      arguments: { account_number: "5ZZ00000" },
    })) as Result;
    // A foreign account would be `auth_failed` if the call got as far as the
    // account check; the shutdown refusal comes first.
    expect(errorOf(res).code).toBe("request_cancelled");
    expect(h.requests).toEqual([]);
  });
});

describe("a submit that has not yet been sent when shutdown begins", () => {
  const ARGS = {
    account_number: ACCT,
    order_type: "Limit",
    time_in_force: "Day",
    price: "10.00",
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
  const DRY_RUN = {
    order: { id: 1, status: "Received" },
    warnings: [],
    "buying-power-effect": {
      "change-in-buying-power": "100.00",
      "change-in-buying-power-effect": "Debit",
    },
  };
  const routes = (): Route[] => [
    {
      matcher: POSITION_LIMIT,
      method: "GET",
      reply: { data: {}, delayMs: 300 },
    },
    {
      matcher: `/accounts/${ACCT}/trading-status`,
      method: "GET",
      reply: { data: {} },
    },
    {
      matcher: `/accounts/${ACCT}/orders/dry-run`,
      method: "POST",
      reply: { data: DRY_RUN },
    },
    {
      matcher: `/accounts/${ACCT}/orders`,
      method: "POST",
      reply: { data: { order: { id: 9001, status: "Received" } } },
    },
  ];
  const posts = (harness: Harness): string[] =>
    harness.requests
      .filter(
        (r) => r.method === "POST" && r.url === `/accounts/${ACCT}/orders`,
      )
      .map((r) => r.url);

  it("is not sent: place_order refuses with request_cancelled", async () => {
    h = await createHarness({ routes: routes() });
    const dry = (await callOk(h, "tastytrade_dry_run_order", ARGS)) as {
      confirmation_token: string;
    };
    expect(typeof dry.confirmation_token).toBe("string");

    const placing = h.client.callTool({
      name: "tastytrade_place_order",
      arguments: { ...ARGS, confirmation_token: dry.confirmation_token },
    });
    // The call is past its token and into the slow pre-submit read.
    await untilRequested(h, "/position-limit");
    const drain = h.server.beginShutdown(5000);

    const res = (await placing) as Result;
    expect(res.isError).toBe(true);
    const err = errorOf(res);
    expect(err.code).toBe("request_cancelled");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("shutting down");
    expect(posts(h)).toEqual([]);
    await expect(drain).resolves.toEqual({ drained: true });
  });

  it("is sent when no shutdown happens (the same flow, undisturbed)", async () => {
    h = await createHarness({ routes: routes() });
    const dry = (await callOk(h, "tastytrade_dry_run_order", ARGS)) as {
      confirmation_token: string;
    };
    const res = (await h.client.callTool({
      name: "tastytrade_place_order",
      arguments: { ...ARGS, confirmation_token: dry.confirmation_token },
    })) as Result;
    expect(res.isError).toBeFalsy();
    expect(posts(h)).toEqual([`/accounts/${ACCT}/orders`]);
  });
});

/**
 * The production shutdown sequence (signal, drain, close, exit) against a real
 * server, with only the process faked. `exited` resolves with the exit code, and
 * `signal` delivers a signal as the process would.
 */
function realShutdown(target: Harness["server"]): {
  signal(name: ShutdownSignal): void;
  exited: Promise<number>;
  log: string[];
} {
  const listeners = new Map<ShutdownSignal, () => void>();
  const log: string[] = [];
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  installShutdownHandlers(target, {
    on: (name, listener) => listeners.set(name, listener),
    exit: (code) => exit(code),
    log: (line) => log.push(line),
  });
  return { signal: (name) => listeners.get(name)?.(), exited, log };
}

describe("a call that is running when the signal arrives, through close()", () => {
  it("is answered with its result, not a closed connection", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { data: { "net-liquidating-value": "1.00" }, delayMs: 300 },
        },
      ],
    });
    const shutdown = realShutdown(h.server);

    const running = h.client.callTool({
      name: "tastytrade_get_balances",
      arguments: { account_number: ACCT },
    });
    await untilRunning(h, 1);
    shutdown.signal("SIGTERM");

    // Rejects with "MCP error -32000: Connection closed" if close() ran first.
    const res = (await running) as Result;
    expect(res.isError).toBeFalsy();
    expect(res.content?.[0]?.text).toContain("net-liquidating-value");
    await expect(shutdown.exited).resolves.toBe(0);
    expect(h.server.running).toBe(0);
  });

  it("answers a placed order that was already sent to the broker", async () => {
    const args = {
      account_number: ACCT,
      order_type: "Limit",
      time_in_force: "Day",
      price: "10.00",
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
    h = await createHarness({
      routes: [
        { matcher: POSITION_LIMIT, method: "GET", reply: { data: {} } },
        {
          matcher: `/accounts/${ACCT}/trading-status`,
          method: "GET",
          reply: { data: {} },
        },
        {
          matcher: `/accounts/${ACCT}/orders/dry-run`,
          method: "POST",
          reply: {
            data: {
              order: { id: 1, status: "Received" },
              warnings: [],
              "buying-power-effect": {
                "change-in-buying-power": "100.00",
                "change-in-buying-power-effect": "Debit",
              },
            },
          },
        },
        {
          matcher: `/accounts/${ACCT}/orders`,
          method: "POST",
          reply: {
            data: { order: { id: 9001, status: "Received" } },
            delayMs: 300,
          },
        },
      ],
    });
    const dry = (await callOk(h, "tastytrade_dry_run_order", args)) as {
      confirmation_token: string;
    };
    const shutdown = realShutdown(h.server);

    const placing = h.client.callTool({
      name: "tastytrade_place_order",
      arguments: { ...args, confirmation_token: dry.confirmation_token },
    });
    // The order is on the wire: it will reach the broker whatever happens next.
    await untilRequested(h, `/accounts/${ACCT}/orders`);
    shutdown.signal("SIGTERM");

    const res = (await placing) as Result;
    expect(res.isError).toBeFalsy();
    expect(res.content?.[0]?.text).toContain("9001");
    await expect(shutdown.exited).resolves.toBe(0);
  });

  it("still exits 1 on a second signal, and refuses new calls while draining", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: BALANCES,
          method: "GET",
          reply: { data: {}, delayMs: 600 },
        },
      ],
    });
    const shutdown = realShutdown(h.server);
    const running = h.client
      .callTool({
        name: "tastytrade_get_balances",
        arguments: { account_number: ACCT },
      })
      .catch(() => undefined);
    await untilRunning(h, 1);
    shutdown.signal("SIGTERM");
    const late = (await h.client.callTool({
      name: "tastytrade_get_positions",
      arguments: { account_number: ACCT },
    })) as Result;
    expect(errorOf(late).code).toBe("request_cancelled");
    shutdown.signal("SIGINT");
    await expect(shutdown.exited).resolves.toBe(1);
    await h.close();
    h = undefined;
    await running;
  });
});
