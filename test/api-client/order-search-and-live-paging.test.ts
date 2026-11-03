/**
 * order-api's API version 20261012 (mounted 2026-10-12) requires `start-date`
 * or `start-at` on order searches and paginates `/customers/{id}/orders/live`.
 * This server sends today's date as Accept-Version, so it is on that version.
 *
 * - Order searches that name no start get one DEFAULT_ORDER_SEARCH_DAYS back,
 *   anchored on the end the caller gave. `start-at` is derived from `end-at`
 *   because order-api ignores `end-at` once `start-date` is present.
 * - Both live-orders reads walk every page at per-page=200. They are the
 *   reconciliation read after an in-doubt write, so a malformed page or a
 *   runaway walk is an upstream_error, never a partial or empty list.
 */

import { describe, it, expect } from "@jest/globals";
import type { InternalAxiosRequestConfig } from "axios";
import {
  TastytradeClient,
  DEFAULT_ORDER_SEARCH_DAYS,
} from "../../src/api-client.js";
import type { HttpAdapter } from "../../src/api-client.js";
import { adaptError } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";

const ACCOUNT = "5WX00001";
const LIVE_PATH = `/accounts/${ACCOUNT}/orders/live`;

/** A client whose adapter answers each request from `reply` and records it. */
function recordingClient(
  reply: (config: InternalAxiosRequestConfig) => unknown,
): { client: TastytradeClient; seen: InternalAxiosRequestConfig[] } {
  const seen: InternalAxiosRequestConfig[] = [];
  const adapter: HttpAdapter = (config) => {
    seen.push(config);
    return Promise.resolve({
      data: reply(config),
      status: 200,
      statusText: "200",
      headers: {},
      config,
    } as never);
  };
  const client = new TastytradeClient(
    { apiUrl: "https://api.cert.tastyworks.com" },
    { adapter, tokenProvider: () => "t" },
  );
  return { client, seen };
}

function params(config: InternalAxiosRequestConfig): Record<string, unknown> {
  return (config.params ?? {}) as Record<string, unknown>;
}

async function errorOf(call: Promise<unknown>): Promise<ToolError> {
  try {
    await call;
  } catch (error) {
    return adaptError(error);
  }
  throw new Error("expected the call to reject");
}

const emptySearch = () => ({ data: { items: [] } });

describe("order search default start", () => {
  it("anchors start-date on end-date when only end-date is given", async () => {
    const { client, seen } = recordingClient(emptySearch);
    await client.searchOrders(ACCOUNT, { "end-date": "2026-03-31" });
    expect(params(seen[0])).toEqual({
      "end-date": "2026-03-31",
      "start-date": "2026-03-01",
    });
  });

  it("anchors start-at on end-at, and adds no start-date that would make order-api ignore end-at", async () => {
    const { client, seen } = recordingClient(emptySearch);
    await client.searchCustomerOrders("me", {
      "end-at": "2026-03-31T20:00:00Z",
    });
    expect(params(seen[0])).toEqual({
      "end-at": "2026-03-31T20:00:00Z",
      "start-at": "2026-03-01T20:00:00.000Z",
    });
  });

  it("defaults to DEFAULT_ORDER_SEARCH_DAYS before today, treating a null start as absent", async () => {
    const { client, seen } = recordingClient(emptySearch);
    await client.searchOrders(ACCOUNT, { "start-date": null });
    const expected = new Date(
      Date.now() - DEFAULT_ORDER_SEARCH_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    expect(params(seen[0])["start-date"]).toBe(expected);
  });

  it("leaves a search that already names a start alone", async () => {
    const { client, seen } = recordingClient(emptySearch);
    await client.searchOrders(ACCOUNT, { "start-at": "2026-01-01T00:00:00Z" });
    expect(params(seen[0])).toEqual({ "start-at": "2026-01-01T00:00:00Z" });
  });
});

describe("live orders paging", () => {
  it("fetches every page at per-page=200 and concatenates them", async () => {
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]];
    const { client, seen } = recordingClient((config) => ({
      data: { items: pages[params(config)["page-offset"] as number] },
      pagination: { "total-pages": 2 },
    }));
    expect(await client.getLiveOrders(ACCOUNT)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(seen.map((c) => params(c))).toEqual([
      { "per-page": 200, "page-offset": 0 },
      { "per-page": 200, "page-offset": 1 },
    ]);
    expect(seen[0].url).toBe(LIVE_PATH);
  });

  it("treats a response without pagination as the only page", async () => {
    const { client, seen } = recordingClient(() => ({
      data: { items: [{ id: 1 }] },
    }));
    expect(await client.getCustomerLiveOrders("me")).toEqual([{ id: 1 }]);
    expect(seen).toHaveLength(1);
  });

  it("stops on an empty page and dedupes a row shifted across the page boundary", async () => {
    // An order placed mid-walk pushes id 2 from page 0 onto page 1.
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], []];
    const { client, seen } = recordingClient((config) => ({
      data: { items: pages[params(config)["page-offset"] as number] },
      pagination: { "total-pages": 5 },
    }));
    expect(await client.getLiveOrders(ACCOUNT)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(seen).toHaveLength(3);
  });

  it("is an upstream_error, not an empty list, when a page has no items array", async () => {
    const { client } = recordingClient(() => ({ data: { items: { id: 1 } } }));
    const err = await errorOf(client.getLiveOrders(ACCOUNT));
    expect(err.code).toBe("upstream_error");
    expect(err.retryable).toBe(false);
  });

  it("refuses to return a partial list past the page cap", async () => {
    const { client, seen } = recordingClient(() => ({
      data: { items: [{ id: 1 }] },
      pagination: { "total-pages": 1000 },
    }));
    const err = await errorOf(client.getLiveOrders(ACCOUNT));
    expect(err.code).toBe("upstream_error");
    expect(seen).toHaveLength(50);
  });
});
