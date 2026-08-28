# Offline tests for `TastytradeClient`

## The seam

`TastytradeClient` takes an optional second constructor argument,
`TastytradeClientOptions` (exported from `src/api-client.ts`), with two hooks:

| Option          | Type                              | Replaces                                        |
| --------------- | --------------------------------- | ----------------------------------------------- |
| `adapter`       | `HttpAdapter` (axios's own type)  | the HTTP transport — no socket is opened        |
| `tokenProvider` | `() => string \| Promise<string>` | the bearer-token source — no OAuth call is made |

Both default to production behavior when omitted. With `adapter` omitted the key
never reaches `axios.create`, so axios resolves its own default transport
exactly as before the seam existed.

You need **both** hooks for a fully offline test. `adapter` only replaces the
transport on the client's own axios instance; `TastytradeOAuthClient` posts to
the token endpoint through the module-level `axios`, which `adapter` cannot
reach. A `tokenProvider` short-circuits that entirely — and it takes precedence
over both the OAuth client and the legacy `sessionToken`.

**The adapter sits below the request interceptor.** Whatever it receives is the
real outbound request: `Authorization`, `Accept-Version` and `User-Agent` are
already applied, and the body has already been through axios's
`transformRequest`, i.e. it is the serialized wire payload rather than the
object the caller handed in.

## The 10-line version

```ts
const http = createFakeHttp(); // see "The fake transport" below
const client = new TastytradeClient(
  { apiUrl: "https://api.cert.tastyworks.com" }, // no OAuth creds at all
  { adapter: http.adapter, tokenProvider: () => "test-access-token" },
);

http.reply({ data: { "cash-balance": "1000.0" } }); // queue the raw envelope
const result = await client.getBalances("5WV12345");

expect(result).toEqual({ "cash-balance": "1000.0" }); // unwrapped .data.data
expect(http.last().method).toBe("GET");
expect(http.last().url).toBe("/accounts/5WV12345/balances");
expect(http.last().headers.authorization).toBe("Bearer test-access-token");
```

## The fake transport

Copy the block headed
`// Fake transport — copy this block into any new offline client test.` out of
`injection-seam.test.ts` — it runs from the `RecordedRequest` interface down to
`createTestClient`, about 140 lines including its doc comments. It cannot be a
shared module — see
[Why the harness is copied, not imported](#why-the-harness-is-copied-not-imported).

It gives you `createFakeHttp()` and, on top of it, `createTestClient(token?)`,
which returns `{ client, http }` already wired to a recording adapter and a stub
token.

`FakeHttp` members:

- `adapter` — pass as `{ adapter: http.adapter }`.
- `reply(data, { status? })` — queue one reply, FIFO. `data` is the
  **raw payload including the tastytrade envelope** (`{ data: {...} }` or
  `{ data: { items: [...] } }`); the client does the unwrapping. Queue one
  `reply()` per expected request — a request with nothing queued rejects with a
  named error rather than silently passing.
- `replyError(status, data?)` — queue a non-2xx reply. Reproduces axios's
  `settle()`, so the call rejects with a real `AxiosError` carrying `.response`,
  which is what `adaptError()` in `src/safety/errors.ts` branches on. Use this
  for the 401/403/404/422/429/5xx → `ToolError` mappings.
- `requests` — every `RecordedRequest`, oldest first.
- `last()` — the most recent `RecordedRequest`.

`RecordedRequest` fields:

- `method` — upper-cased, e.g. `"GET"`.
- `url` — the path as the client asked for it, e.g. `"/accounts/5WV1234/orders"`.
- `fullUrl` — `baseURL` + `url`, no query string appended.
- `params` — query params un-serialized, as the object the client passed.
- `headers` — **keys lower-cased** (axios normalizes them), values stringified.
  So `headers.authorization`, `headers["accept-version"]`, `headers["user-agent"]`.
- `body` — the serialized body parsed back into a value, or `undefined` when
  there was no body. Assert kebab-case here: the snake_case → kebab-case
  translation is the dispatcher's job, and the client must never emit a
  snake_case key.
- `config` — escape hatch to the untouched axios config.

## Why the harness is copied, not imported

A test file here **cannot import another file under `test/`**. `tsconfig.json`
sets `rootDir: "./src"`, which makes any `.ts` outside `src/` an out-of-rootDir
program input (TS6059). ts-jest normally suppresses that code, but its ESM path
(`ts-jest-transformer.js`) throws raw diagnostics without applying the ignore
list, and this repo runs Jest in ESM mode — so the import fails the suite with:

```
error TS6059: File '.../test/api-client/harness.ts' is not under 'rootDir' '.../src'.
```

Importing from `src/` is fine (that is inside `rootDir`); only test-to-test
imports break. The available workarounds were all worse than copying:

- `// @ts-ignore` — banned by `@typescript-eslint/ban-ts-comment`, and
  `@ts-expect-error` would become an _unused_ directive on the non-ESM path
  (`npx jest`, where ts-jest does filter TS6059), failing with TS2578.
- A `harness.js` + hand-written `harness.d.ts` pair does work (declaration files
  are exempt from the check), but the types would drift from the implementation
  with nothing to catch it.
- Relaxing `rootDir` would restructure the committed `dist/` tree.

So: keep a whole client suite in one file where you can, and copy the block when
you need a second file. If a shared harness becomes worth the config change, the
fix is a `test/tsconfig.json` (without `rootDir`) referenced from
`jest.config.mjs` as `transform: [..., { tsconfig: "<rootDir>/test/tsconfig.json" }]`.

## Gotchas

- **Env-var overrides leak.** `TASTYTRADE_ACCEPT_VERSION` is read from
  `process.env` per request and `TASTYTRADE_USER_AGENT` at construction. Save and
  restore them around any test that sets them; see `withEnv()` in
  `injection-seam.test.ts`.
- **`Accept-Version` is computed per request**, so a hard-coded date will rot.
  Either compute the expected UTC `YYYYMMDD` in the test, pin it with
  `TASTYTRADE_ACCEPT_VERSION`, or use `jest.setSystemTime()`.
- **`placeOrder` writes the order body to `console.error`.** Spy on it
  (`jest.spyOn(console, "error").mockImplementation(() => {})`) to keep the
  output readable. Never expect anything on stdout — it belongs to the MCP
  protocol.
- **Coverage thresholds do not apply here.** `collectCoverageFrom` is scoped to
  `src/safety/**` and `src/mcp-server/annotations.ts`, so client tests neither
  help nor hurt the gate's coverage numbers.
