/**
 * The 1 MiB cap through the real dispatcher and the real resource handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createHarness } from "./harness.js";
import type { Harness } from "./harness.js";
import { _resetRateLimitsForTest } from "../../src/safety/rate-limit.js";
import { MCP_ERROR_INVALID_PARAMS } from "../../src/mcp-server/index.js";
import type { ToolError } from "../../src/safety/errors.js";
import {
  RESULT_LIMIT_BYTES,
  measureToolResult,
} from "../../src/mcp-server/result-cap.js";

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
      /^The result is 1,\d{3},\d{3} bytes, over the 1,048,576-byte \(1 MiB\) limit/,
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

describe("the limit counts the provenance notice", () => {
  const TRANSACTIONS = `/accounts/${ACCT}/transactions`;

  /**
   * 400 full records, `chunks` records of 1,500 characters, and a last record
   * of `padChars` characters. Every string stays under the 2,048-character
   * per-leaf bound, so only the size cap can refuse it.
   */
  const build = (chunks: number, padChars: number) => [
    ...records(300, 1270),
    ...Array.from({ length: chunks }, (_, i) => ({
      id: 900000 + i,
      d: "y".repeat(1500),
    })),
    { id: 999999, d: "y".repeat(padChars) },
  ];

  /** Text plus structured mirror, before the provenance block is appended. */
  const preProvenanceBytes = (payload: unknown[]): number =>
    Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8") +
    Buffer.byteLength(JSON.stringify({ items: payload }), "utf8");

  /**
   * A payload whose pre-provenance size is `target` or one byte under it (each
   * padding character counts twice, once in the text and once in the mirror).
   */
  const payloadFor = (target: number): unknown[] => {
    for (let chunks = 0; chunks < 1000; chunks++) {
      const pad = Math.floor(
        (target - preProvenanceBytes(build(chunks, 0))) / 2,
      );
      if (pad >= 0 && pad <= 2000) return build(chunks, pad);
    }
    throw new Error("no payload fits the target");
  };

  const call = async (payload: unknown[]): Promise<Result> => {
    h = await createHarness({
      routes: [
        {
          matcher: TRANSACTIONS,
          method: "GET",
          reply: { data: { items: payload } },
        },
      ],
    });
    return (await h.client.callTool({
      name: "tastytrade_get_transactions",
      arguments: { account_number: ACCT },
    })) as Result;
  };

  const lastBlockBytes = (res: Result): number =>
    Buffer.byteLength(
      res.content?.[res.content.length - 1]?.text ?? "",
      "utf8",
    );

  it("delivers a result that fits only once the notice is counted, and never one over the limit", async () => {
    const payload = payloadFor(RESULT_LIMIT_BYTES - 5_000);
    const res = await call(payload);
    expect(res.isError).toBeFalsy();
    // What was delivered, notice included, is what was measured, and is under.
    const delivered = measureToolResult(res);
    expect(delivered).toBeLessThanOrEqual(RESULT_LIMIT_BYTES);
    expect(delivered).toBe(preProvenanceBytes(payload) + lastBlockBytes(res));
  });

  it("refuses a result that is at or under the limit until the notice is added, then over it", async () => {
    // Learn the notice's size from a delivered call, then aim 10 bytes under the limit.
    const first = await call(payloadFor(RESULT_LIMIT_BYTES - 5_000));
    const notice = lastBlockBytes(first);
    expect(notice).toBeGreaterThan(100);
    await h?.close();

    const payload = payloadFor(RESULT_LIMIT_BYTES - 10);
    // Fixture guard: the payload passes without the notice and fails with it, so only
    // the order of measuring and appending tells the two apart.
    expect(preProvenanceBytes(payload)).toBeLessThanOrEqual(RESULT_LIMIT_BYTES);
    expect(preProvenanceBytes(payload) + notice).toBeGreaterThan(
      RESULT_LIMIT_BYTES,
    );

    const res = await call(payload);
    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content?.[0]?.text ?? "{}") as ToolError;
    expect(err.code).toBe("result_too_large");
    expect(err.message).toContain(
      `${(preProvenanceBytes(payload) + notice).toLocaleString("en-US")} bytes`,
    );
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
    expect(failure?.data?.message).toContain("1,048,576-byte (1 MiB) limit");
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
