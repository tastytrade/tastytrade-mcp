/**
 * The 1 MiB cap through the real dispatcher and the real resource handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { MCP_ERROR_INVALID_PARAMS } from "../../src/mcp-server/index.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCT = "5WX00001";
const MIB = 1_048_576;

let h: Harness | undefined;

beforeEach(() => {
  _resetRateLimitsForTest();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  _resetRateLimitsForTest();
});

type Result = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};

/**
 * `count` records, each carrying one string of `width` characters. Under the
 * per-leaf bound (2,048 characters) so the existing bounds leave it alone and
 * only the new cap can refuse it.
 */
const records = (count: number, width: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: i,
    description: "x".repeat(width),
  }));

const textBytes = (res: Result): number =>
  Buffer.byteLength(res.content?.[0]?.text ?? "", "utf8");

describe("a read tool result over 1 MiB", () => {
  const TRANSACTIONS = `/accounts/${ACCT}/transactions`;

  it("is refused with result_too_large when text plus the structured mirror pass the cap", async () => {
    // About 0.6 MiB of text: under the cap on its own, over it once the
    // structured copy of the same payload is counted.
    h = await createHarness({
      routes: [
        {
          matcher: TRANSACTIONS,
          method: "GET",
          reply: { data: { items: records(400, 1500) } },
        },
      ],
    });
    const res = (await h.client.callTool({
      name: "tastytrade_get_transactions",
      arguments: { account_number: ACCT },
    })) as Result;

    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content?.[0]?.text ?? "{}") as ToolError;
    expect(err.code).toBe("result_too_large");
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(
      /^The result is 1\.\d\d MiB, over the 1\.00 MiB/,
    );
    expect(err.hint).toContain("per_page");
    expect(err.hint).toContain("start_date");
    expect(res.structuredContent).toBeUndefined();
  });

  it("is returned when it is under the cap, with the same shape of request", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: TRANSACTIONS,
          method: "GET",
          reply: { data: { items: records(40, 1500) } },
        },
      ],
    });
    const res = (await h.client.callTool({
      name: "tastytrade_get_transactions",
      arguments: { account_number: ACCT },
    })) as Result;
    expect(res.isError).toBeFalsy();
    expect(textBytes(res)).toBeGreaterThan(50_000);
  });

  it("fixture check: the refused payload's text alone is under the cap, so only the mirror tips it", () => {
    // Guards the test above against a fixture that would be refused on text alone,
    // which would stop it telling a text-only measure from the real one.
    const payload = records(400, 1500);
    const text = Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8");
    const structured = Buffer.byteLength(
      JSON.stringify({ items: payload }),
      "utf8",
    );
    expect(text).toBeLessThan(MIB);
    expect(text + structured).toBeGreaterThan(MIB);
  });
});

describe("a write tool result over 1 MiB", () => {
  it("is returned whole: the change has happened, and it must not look failed", async () => {
    const big = { name: "big", "watchlist-entries": records(800, 1800) };
    h = await createHarness({
      routes: [
        { matcher: "/watchlists", method: "POST", reply: { data: big } },
      ],
    });
    const res = (await h.client.callTool({
      name: "tastytrade_create_watchlist",
      arguments: { name: "big", symbols: ["AAPL"] },
    })) as Result;
    expect(res.isError).toBeFalsy();
    expect(textBytes(res)).toBeGreaterThan(MIB);
    expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});

describe("resources/read over 1 MiB", () => {
  const URI = `tastytrade://accounts/${ACCT}/positions`;

  it("rejects with -32602 and data.code result_too_large", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/positions`,
          method: "GET",
          reply: { data: { items: records(800, 1800) } },
        },
      ],
    });
    const failure = await h.client.readResource({ uri: URI }).then(
      () => undefined,
      (e: unknown) => e as { code?: number; data?: ToolError },
    );
    expect(failure?.code).toBe(MCP_ERROR_INVALID_PARAMS);
    expect(failure?.data?.code).toBe("result_too_large");
    expect(failure?.data?.retryable).toBe(false);
    expect(failure?.data?.message).toContain("1.00 MiB");
  });

  it("reads a small one", async () => {
    h = await createHarness({
      routes: [
        {
          matcher: `/accounts/${ACCT}/positions`,
          method: "GET",
          reply: { data: { items: records(3, 100) } },
        },
      ],
    });
    const res = await h.client.readResource({ uri: URI });
    expect(res.contents).toHaveLength(1);
    expect((res.contents[0] as { text: string }).text).toContain("xxxx");
  });
});
