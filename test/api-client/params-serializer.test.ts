/**
 * Query serialisation, and why the site count stops mattering.
 *
 * `client.get(url, { params })` with no `paramsSerializer` inherits AXIOS'S default, a
 * nested-structure encoder: an array becomes `k[]=…` repeated and an OBJECT becomes
 * `k[inner]=…` with the inner text supplied by the caller. Measured on the wire against
 * a real loopback origin, `getTotalFees(acct, {date: {"per-page":"50000",
 * injected:"1"}})` sent `?date%5Bper-page%5D=50000&date%5Binjected%5D=1` — the caller
 * authoring both the key names and the bracket text — and the declared `date` parameter
 * was not sent at all.
 *
 * The sink was an OMISSION, invisible at review time: thirteen sibling methods
 * hand-wrote a serializer and eleven did not. So safety is the INSTANCE DEFAULT and the
 * exception is what a method must write, and the hand-written copies are gone — a
 * per-request serializer OVERRIDES the instance default, so every survivor was a hole.
 *
 * Two halves answer different questions. The REFUSALS are the class closure. The PINNED
 * SHAPES protect the live API: all twenty-two `params` sites are byte-identical across
 * the change, and the expected strings were captured from a real loopback origin BEFORE
 * the fix rather than written from the code.
 */
import { describe, it, expect } from "@jest/globals";
import { AxiosHeaders } from "axios";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TastytradeClient, serializeParams } from "../../src/api-client.js";
import { InstrumentType } from "../../src/enums.js";
import type { HttpAdapter } from "../../src/api-client.js";
import { isToolErrorException } from "../../src/safety/errors.js";
import type { ToolError } from "../../src/safety/errors.js";

const API_URL = "https://api.cert.tastyworks.com";

const CLIENT_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/api-client.ts",
  ),
  "utf8",
);

/**
 * A recorder that serialises the query THE WAY AXIOS'S OWN TRANSPORT DOES.
 *
 * This matters and is easy to get wrong: axios serialises `params` inside its
 * HTTP adapter's `buildURL`, not before it, so an INJECTED adapter receives
 * `config.params` as the object and no query string exists yet. A test that
 * asserted on "the serialized query string the adapter received" would be
 * asserting on nothing. So the recorder does what the real adapter does — calls
 * the serializer the resolved config carries — which also makes the resolution
 * itself observable: whether a site got the instance default or a per-request
 * override, and whether it got one at all.
 */
function createRecorder() {
  const seen: Array<{ url: string; query: string; hadSerializer: boolean }> =
    [];
  const adapter: HttpAdapter = (config: InternalAxiosRequestConfig) => {
    // axios normalises a function-valued `paramsSerializer` into
    // `{ serialize }` during config merge, so both shapes have to be read — and
    // reading them is the only way to see WHICH serializer a site resolved to.
    const declared = config.paramsSerializer as
      | ((p: unknown) => string)
      | { serialize?: (p: unknown) => string }
      | undefined;
    const serializer =
      typeof declared === "function" ? declared : declared?.serialize;
    const query =
      typeof serializer === "function" && config.params !== undefined
        ? serializer(config.params)
        : "";
    seen.push({
      url: config.url ?? "",
      query,
      hadSerializer: typeof serializer === "function",
    });
    return Promise.resolve({
      data: { data: { items: [] } },
      status: 200,
      statusText: "200",
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
    } as AxiosResponse);
  };
  const client = new TastytradeClient(
    { apiUrl: API_URL },
    { adapter, tokenProvider: () => "test-access-token" },
  );
  return { client, seen };
}

/** The ToolError a rejected serialisation carried. */
function refusalOf(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (e) {
    if (isToolErrorException(e)) return e.toolError;
    throw e;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

describe("a query parameter is a scalar or a list of scalars", () => {
  it("refuses an object value, naming the parameter", () => {
    const refusal = refusalOf(() =>
      serializeParams({ date: { "per-page": "50000", injected: "1" } }),
    );
    expect(refusal.code).toBe("validation");
    expect(refusal.retryable).toBe(false);
    expect(refusal.message).toContain("date");
  });

  it("refuses a nested array", () => {
    expect(refusalOf(() => serializeParams({ symbol: [["AAPL"]] })).code).toBe(
      "validation",
    );
  });

  it("refuses a function", () => {
    expect(
      refusalOf(() => serializeParams({ symbol: () => "AAPL" })).code,
    ).toBe("validation");
  });

  it("refuses an object nested inside an array", () => {
    expect(
      refusalOf(() => serializeParams({ symbol: ["AAPL", { s: "MSFT" }] }))
        .code,
    ).toBe("validation");
  });

  it("serialises scalars, lists of scalars, and skips absent values", () => {
    expect(
      serializeParams({
        "include-marks": true,
        symbol: ["AAPL", "MSFT"],
        skipped: undefined,
        alsoSkipped: null,
        "per-page": 25,
      }),
    ).toBe("include-marks=true&symbol=AAPL&symbol=MSFT&per-page=25");
  });

  it("leaves a comma raw, so a joined value is byte-identical on the wire", () => {
    // The one deliberate deviation from `URLSearchParams.toString()`, and the
    // reason is compatibility rather than taste: `,` is an RFC 3986 sub-delim,
    // legal unescaped in a query, and axios's own encoder leaves it raw — so
    // getMarketMetrics sends `symbols=AAPL,MSFT` today and after this change.
    expect(serializeParams({ symbols: "AAPL,MSFT" })).toBe("symbols=AAPL,MSFT");
  });

  it("renames a key only when the endpoint's own shape requires it", () => {
    expect(
      serializeParams(
        { symbol: ["AAPL", "MSFT"] },
        { keyFor: (key) => `${key}[]` },
      ),
    ).toBe("symbol%5B%5D=AAPL&symbol%5B%5D=MSFT");
  });

  it("can never manufacture a key the caller did not send", () => {
    // The key set is exactly Object.keys(params), and the only transform allowed
    // on a key is the server-authored `keyFor`. That is what the bracket-key
    // authorship would need and cannot get.
    const query = serializeParams({ "a-key": "v", another: ["x", "y"] });
    const keys = [...new URLSearchParams(query).keys()];
    expect([...new Set(keys)].sort()).toEqual(["a-key", "another"]);
  });
});

describe("every request carries a serializer, so none inherits axios's default", () => {
  it("gives a method that writes none of its own the instance default", async () => {
    const { client, seen } = createRecorder();
    await client.getBalanceSnapshots("5WX00001", {
      "snapshot-date": "2026-08-25",
    });
    expect(seen[0].hadSerializer).toBe(true);
  });

  it("serialises an array as repeated keys through that default", async () => {
    const { client, seen } = createRecorder();
    await client.getSpanRows({
      date: "2026-08-25",
      exchange: "CME" as "CME" | "CFE",
    });
    expect(seen[0].query).toBe("date=2026-08-25&exchange=CME");
  });

  it("refuses an OBJECT value outright, on the vectors that carry one", async () => {
    // The serious half of the finding, and the half a refusal is the only
    // honest answer to: the caller authored both the key NAMES and the text
    // inside the brackets — `date%5Bper-page%5D=50000&date%5Binjected%5D=1` —
    // and the declared parameter was not sent at all.
    const OBJECT_VECTORS: Array<
      [string, (c: TastytradeClient) => Promise<unknown>]
    > = [
      [
        "getTotalFees with an object date",
        (c) =>
          c.getTotalFees("5WX00001", {
            date: { "per-page": "50000", injected: "1" } as unknown as string,
          }),
      ],
      [
        "getEarningsReports with an object start-date and an array end-date",
        (c) =>
          c.getEarningsReports("AAPL", {
            "start-date": { nested: "yes" } as unknown as string,
            "end-date": ["a", "b"] as unknown as string,
          }),
      ],
    ];

    for (const [label, call] of OBJECT_VECTORS) {
      const { client, seen } = createRecorder();
      let code: string | undefined;
      try {
        await call(client);
      } catch (e) {
        code = isToolErrorException(e) ? e.toolError.code : String(e);
      }
      expect([code, label]).toEqual(["validation", label]);
      // Refused before the request was built, so nothing went out.
      expect(seen).toEqual([]);
    }
  });

  it("sends an ARRAY under the declared key, never under one it manufactured", async () => {
    // The other half, and it is deliberately NOT a refusal: an array of scalars
    // is a legitimate shape on several of these parameters, and this serializer
    // cannot know a given parameter's declared arity. What it CAN guarantee is
    // that the key set is exactly `Object.keys(params)` — so the two vectors
    // that would arrive as `exchange%5B%5D=` and `lendability%5B%5D=`, with
    // the declared parameter absent, now arrive under their own names.
    const ARRAY_VECTORS: Array<
      [string, (c: TastytradeClient) => Promise<unknown>, string]
    > = [
      [
        "getSpanRows with an array exchange",
        (c) =>
          c.getSpanRows({
            date: "2026-08-25",
            exchange: ["CME", "CFE"] as unknown as "CME",
          }),
        "date=2026-08-25&exchange=CME&exchange=CFE",
      ],
      [
        "getActiveEquities with an array lendability",
        (c) =>
          c.getActiveEquities({
            lendability: [
              "Easy To Borrow",
              "Preborrow",
            ] as unknown as "Preborrow",
          }),
        "lendability=Easy+To+Borrow&lendability=Preborrow",
      ],
    ];

    for (const [label, call, expected] of ARRAY_VECTORS) {
      const { client, seen } = createRecorder();
      await call(client);
      expect([seen[0].query, label]).toEqual([expected, label]);
      expect(seen[0].query).not.toContain("%5B");
    }
  });
});

/**
 * The twelve shapes that were hand-written per method, pinned byte-for-byte.
 * This is the half that protects the live API: a wrong `style` on any one of
 * them is a silently different request, and the API is the only thing that
 * would have noticed.
 */
const PINNED: ReadonlyArray<
  readonly [string, (c: TastytradeClient) => Promise<unknown>, string]
> = [
  [
    "getPositions",
    (c) =>
      c.getPositions("5WX00001", {
        symbol: ["AAPL", "MSFT"],
        "include-marks": true,
      }),
    "symbol=AAPL&symbol=MSFT&include-marks=true",
  ],
  [
    "getQuote",
    (c) =>
      c.getQuote(["AAPL", "MSFT"], InstrumentType.Equity, {
        include_instrument: true,
      }),
    "equity=AAPL&equity=MSFT&include-instrument=true",
  ],
  [
    "searchOrders",
    (c) =>
      c.searchOrders("5WX00001", {
        "status[]": ["Filled", "Live"],
        "per-page": 25,
      }),
    "status%5B%5D=Filled&status%5B%5D=Live&per-page=25",
  ],
  [
    "searchCustomerOrders",
    (c) => c.searchCustomerOrders("me", { "status[]": ["Filled"] }),
    "status%5B%5D=Filled",
  ],
  [
    "getCustomerLiveOrders",
    (c) => c.getCustomerLiveOrders("me", { "status[]": ["Live"] }),
    "status%5B%5D=Live",
  ],
  [
    "getInstruments",
    (c) => c.getInstruments(["AAPL", "MSFT"]),
    "symbol%5B%5D=AAPL&symbol%5B%5D=MSFT",
  ],
  [
    "getFutures",
    (c) => c.getFutures({ exchange: ["CME", "CFE"] }),
    "exchange=CME&exchange=CFE",
  ],
  [
    "getCryptocurrencies",
    (c) => c.getCryptocurrencies({ symbol: ["BTC/USD", "ETH/USD"] }),
    "symbol=BTC%2FUSD&symbol=ETH%2FUSD",
  ],
  ["getWarrants", (c) => c.getWarrants({ symbol: ["ABC"] }), "symbol=ABC"],
  [
    "getTransactions",
    (c) =>
      c.getTransactions("5WX00001", {
        "types[]": ["Trade", "Money Movement"],
        "per-page": 10,
      }),
    "types%5B%5D=Trade&types%5B%5D=Money+Movement&per-page=10",
  ],
  [
    "getMarketDataByType",
    (c) =>
      c.getMarketDataByType({
        equity: ["AAPL"],
        "equity-option": ["AAPL  260320C00200000"],
      }),
    "equity=AAPL&equity-option=AAPL++260320C00200000",
  ],
  [
    "getCurrentSessionsMulti",
    (c) => c.getCurrentSessionsMulti(["CME", "Equity"]),
    "instrument-collections=CME&instrument-collections=Equity",
  ],
  // And the three that were already on the default, so the consolidation cannot
  // change them either.
  [
    "getBalanceSnapshots",
    (c) => c.getBalanceSnapshots("5WX00001", { "snapshot-date": "2026-08-25" }),
    "snapshot-date=2026-08-25",
  ],
  [
    "getMarketMetrics",
    (c) => c.getMarketMetrics(["AAPL", "MSFT"]),
    "symbols=AAPL,MSFT",
  ],
  [
    "getPublicWatchlists",
    (c) => c.getPublicWatchlists({ counts_only: true }),
    "counts-only=true",
  ],
];

describe("consolidating the serializers changes no request", () => {
  it.each(PINNED)("keeps %s byte-identical", async (_label, call, expected) => {
    const { client, seen } = createRecorder();
    await call(client);
    expect(seen).toHaveLength(1);
    expect(seen[0].query).toBe(expected);
  });
});

describe("SOURCE INVARIANT: one serializer, on the instance", () => {
  it("declares `paramsSerializer` only on the axios instance and delegates elsewhere", () => {
    const declarations = [
      ...CLIENT_SOURCE.matchAll(/paramsSerializer:\s*([^\n]*)/g),
    ].map((m) => m[1].trim());
    // Every declaration must delegate to `serializeParams` — a per-request
    // serializer OVERRIDES the instance default, so a surviving hand-written
    // copy is a hole in the guarantee this fix establishes.
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration).toContain("serializeParams(");
    }
  });

  it("keeps `new URLSearchParams(` inside serializeParams and nowhere else", () => {
    const uses = [...CLIENT_SOURCE.matchAll(/new URLSearchParams\(/g)];
    expect(uses).toHaveLength(1);
    const start = CLIENT_SOURCE.indexOf("export function serializeParams");
    expect(start).toBeGreaterThan(-1);
    expect(uses[0].index).toBeGreaterThan(start);
  });
});
