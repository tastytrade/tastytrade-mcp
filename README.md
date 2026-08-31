# tastytrade MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[tastytrade open API](https://developer.tastytrade.com/), giving an LLM agent
access to quotes, instruments, option chains, balances, positions, transactions,
watchlists, and order entry.

> [!WARNING]
>
> **The default endpoint is PRODUCTION. Production is real.**
>
> With no environment configured, this server connects to the tastytrade
> **production** API. Every account the supplied credentials can reach is a
> **real brokerage account**, and every order this server places, edits,
> replaces or cancels moves **real money** in it. Those actions take effect
> immediately and cannot be undone.
>
> **For an environment with no real money in it, set `TASTYTRADE_ENV=sandbox`.**
> **To withhold every write and destructive tool, set `TASTYTRADE_READ_ONLY=1`.**
>
> Read [Choosing an environment](#choosing-an-environment) and
> [Safety model](#safety-model) before you point this at an account you care
> about, and [Disclaimer](#disclaimer) and [Notice](#notice) for what this
> software does and does not promise.

Production is the default because the sandbox does not serve market data: a
server pointed there cannot quote, and a default that cannot do the job is not a
safe default — it is one that teaches an operator to override it without reading
why. The switch is one word either way, and the environment in use is stated in
three places: a startup banner on stderr, the `instructions` the MCP client
receives when it connects, and an `environment` member on every order result.

> No tool, resource, prompt or example here is a recommendation to buy or sell
> anything. Nothing in this repository is financial advice. See
> [Disclaimer](#disclaimer).

---

## Requirements

- Node.js 22 or newer (see `.node-version`)
- A tastytrade OAuth client and refresh token

## Install

```bash
git clone https://github.com/tastytrade/tastytrade-mcp.git
cd tastytrade-mcp
npm ci
npm run build
```

Clone-and-build is the supported install: nothing here is published to npm and
there is no published container image. The included `Dockerfile` builds one
locally if you would rather run the server in a container — read its header
first, because a stdio server has to be started with `docker run -i`, and
without that the container exits immediately and looks exactly like a crash.

## Credentials

Authentication is **environment-only**. There is no interactive login flow: a
server an agent can make bind a listening socket, and that then prints a
long-lived refresh token into a transcript, is not defensible.

Create an OAuth client and refresh token out of band — see tastytrade's
[OAuth2 guide](https://developer.tastytrade.com/oauth/), or
**my.tastytrade.com → Manage → My Profile → API** — then supply three variables:

| Variable                   | Required | Default |
| -------------------------- | -------- | ------- |
| `TASTYTRADE_CLIENT_ID`     | yes      | —       |
| `TASTYTRADE_CLIENT_SECRET` | yes      | —       |
| `TASTYTRADE_REFRESH_TOKEN` | yes      | —       |

Which endpoint those credentials are sent to is a separate decision, and its
default is production — see [Choosing an environment](#choosing-an-environment)
below.

**Sandbox credentials are a separate OAuth application, and the two sets are not
interchangeable.** my.tastytrade.com issues production credentials; a sandbox
client id, secret and refresh token are created under a sandbox user, with the
tools on tastytrade's own sandbox page. A sandbox refresh token cannot mint an
access token against production, and a production one cannot against the
sandbox. That is worth knowing in advance because the failure is uninformative
on its own: every tool call returns `auth_failed` and nothing says why. The
preflight below names it outright, by comparing the issuer claim inside your
refresh token against the endpoint you configured.

Nothing in this repository auto-loads a `.env` file. Export the variables
yourself, or hand them to the server through your MCP client's `env` block.
`.env.sample` documents the same set.

## Choosing an environment

**The default is production.** With nothing set, this server talks to
`https://api.tastyworks.com`, and every order it places, edits, replaces or
cancels is real and cannot be undone.

| Variable             | Effect                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASTYTRADE_ENV`     | `production` (also `prod`, `live`) or `sandbox` (also `cert`, `staging`, `sbx`). Case-insensitive, surrounding whitespace tolerated. Unset means production.         |
| `TASTYTRADE_API_URL` | An explicit base URL. Wins over `TASTYTRADE_ENV`, and is the only way to reach a host that is not one of tastytrade's own — a gateway, a proxy, a local test double. |

A `TASTYTRADE_ENV` this server cannot read — a typo like `sandbx` — resolves to
the **sandbox**, and says so in a stderr banner that names the value. Unset is a
default; a typo is a failed instruction, and the two must not land in the same
place: an operator who tried to name an environment and misspelled it has not
thereby granted permission to trade live funds. `TASTYTRADE_READ_ONLY` fails
closed the same way, for the same reason — a value it cannot read enables
read-only mode rather than disabling it.

Three surfaces announce the environment, so it is not something anyone has to
hold in their head:

- **The stderr startup banner**, which therefore fires by default. It names the
  endpoint, says that this is the default endpoint, and gives both switches:
  `TASTYTRADE_ENV=sandbox` to move off it, and `TASTYTRADE_READ_ONLY=1` to
  disable every write.
- **`instructions` in the MCP initialize result** — the only environment signal
  the agent itself can read, because stderr is a log file and `instructions` is
  context. On production it says so in those terms: real money, real account
  control, order actions that cannot be undone, and say which environment you
  are in before acting. On the sandbox it says there is no real money and that
  market data does not work. An endpoint this server does not recognise is
  described as unrecognised and to be treated as production.
- **An `environment` member on every order-submitting and dry-run result**, valued `production`,
  `sandbox` or `other`, on all ten order routes — the five dry-runs and the five
  submit/edit routes. Server-authored, never copied from upstream, so a
  transcript is evidence of which environment an order actually went to.

### What the sandbox cannot do

The sandbox does not currently serve market data: `/market-data` and
`/market-metrics` answer HTTP 502 on every route. So on the sandbox
`tastytrade_get_quote`, `tastytrade_get_quote_snapshot`,
`tastytrade_get_market_metrics`, `tastytrade_get_historical_dividends` and
`tastytrade_get_earnings_reports` all fail — the last two sit under the same
market-metrics prefix. Everything else works: instruments, option chains,
futures, accounts, balances, positions, transactions, orders, and the dry-run
and order-submission paths. tastytrade's own sandbox guide additionally lists
market metrics and net-liquidating-value history
(`tastytrade_get_net_liq_history`) as live-only, and notes that the sandbox
resets every 24 hours, clearing trades, transactions and positions while leaving
users and accounts intact.

That is the whole reason production is the default. Quoting is the first thing
anyone asks this server to do, and a default endpoint that cannot quote teaches
an operator to override it without reading why.

## Optional configuration

Endpoint selection is [above](#choosing-an-environment); these are the remaining
knobs, and every one of them has a working default.

| Variable                            | Effect                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `TASTYTRADE_READ_ONLY`              | `1` withholds **and refuses** all 14 write and destructive tools             |
| `MAX_ORDER_NOTIONAL_USD`            | Ceiling on an order's buying-power impact (default `50000`)                  |
| `TASTYTRADE_ALLOW_UNKNOWN_API_HOST` | Hostname to permit when `TASTYTRADE_API_URL` is not a tastytrade host        |
| `TASTYTRADE_CREDENTIAL_CHANNEL`     | `strict` refuses to start when a proxy or a modified trust store is detected |
| `TASTYTRADE_ALLOW_PROXY`            | Hostname of a proxy to permit under `strict`                                 |
| `TASTYTRADE_HTTP_TIMEOUT_MS`        | Per-request socket timeout (default `30000`)                                 |
| `TASTYTRADE_HTTP_WALL_CLOCK_MS`     | Per-request wall-clock ceiling (default: 3× the socket timeout)              |
| `TASTYTRADE_MAX_RESPONSE_BYTES`     | Largest response body accepted (default 32 MiB)                              |
| `TASTYTRADE_ACCEPT_VERSION`         | Override the `Accept-Version` header (default: today's UTC date)             |
| `TASTYTRADE_USER_AGENT`             | Override the `User-Agent` header                                             |

## Run it

The server speaks MCP over stdio: a client launches it as a subprocess, talks
JSON-RPC over stdin and stdout, and passes the credentials in from its own
configuration. What is the same in every client is the command (`node`), the
absolute path to `dist/index.js`, and the environment variables. What differs is
the file that configuration lives in and the key it sits under — the `mcpServers`
object below is what Claude Desktop and Claude Code read, while other clients
(Cursor, Zed and Continue among them) keep their own file and do not all use the
same key, so check your client's own documentation if it is not one of these
two.

**Claude Desktop** reads a file named `claude_desktop_config.json`. Its own
Settings → Developer pane opens that file, which is the reliable way to find it;
on macOS it sits in `~/Library/Application Support/Claude/`, and on Windows in
`%APPDATA%\Claude\`.

```json
{
  "mcpServers": {
    "tastytrade": {
      "command": "node",
      "args": ["/absolute/path/to/tastytrade-mcp/dist/index.js"],
      "env": {
        "TASTYTRADE_ENV": "production",
        "TASTYTRADE_CLIENT_ID": "…",
        "TASTYTRADE_CLIENT_SECRET": "…",
        "TASTYTRADE_REFRESH_TOKEN": "…"
      }
    }
  }
}
```

That block is **production**: real funds, real accounts. The environment is named
explicitly rather than left to the default, so the block cannot mean something
different from what it says — change it to `"sandbox"` for an environment with no
real money in it, and add `"TASTYTRADE_READ_ONLY": "1"` to withhold every write
and destructive tool. Every value in that object is a string, `"1"` included.

On Windows the path is a JSON string like any other, so each backslash has to be
doubled:

```json
{
  "command": "node",
  "args": ["C:\\Users\\you\\tastytrade-mcp\\dist\\index.js"]
}
```

**Claude Code** takes the same server from the command line and writes the file
for you:

```bash
claude mcp add tastytrade \
  -e TASTYTRADE_CLIENT_ID=… \
  -e TASTYTRADE_CLIENT_SECRET=… \
  -e TASTYTRADE_REFRESH_TOKEN=… \
  -- node /absolute/path/to/tastytrade-mcp/dist/index.js
```

Everything after `--` is the command to launch, so flags meant for the server
are not read as flags for the CLI. That writes to your own configuration by
default; `-s project` writes a `.mcp.json` into whatever project directory you
run it from instead. That file carries the same `mcpServers` shape shown above
and is meant to be committed and shared, which makes it the wrong place for a
client secret or a refresh token.

### Verify it works

Two JSON-RPC lines on stdin are enough to prove the server starts and lists its
tools. Neither call reaches tastytrade, so this works before the credentials are
right:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/index.js | cut -c1-200
```

The first reply is the `initialize` result, whose `instructions` field names the
environment; the second is the tool list, which is large enough to be worth
truncating (see [Tool surface](#tool-surface)). The MCP Inspector
(`npx @modelcontextprotocol/inspector node dist/index.js`) does the same thing
with a UI. For the credentials themselves, use the preflight below.

Startup diagnostics — the production banner, the read-only banner, the
credential-channel notes — go to **stderr**, because stdout carries the MCP
protocol and nothing else. A client does not show you stderr in its chat window;
it writes it to its own server log, and that log is where to look when a client
reports that the server failed to start. Running `node dist/index.js` directly
puts the same output on your terminal.

## Check your setup first

When credentials are wrong, every tool call fails the same way. The bundled
preflight tells you which of the four things is broken, in dependency order, and
six of its eleven checks need no network at all:

```bash
npm run doctor          # or: node dist/doctor.js
node dist/doctor.js --json
```

It never prints your client secret or refresh token — only their presence and
length — and it masks account numbers by default so the output is safe to paste
into an issue.

Exit codes:

- `0` — every check passed; the configuration is verified
- `1` — a check failed; the failing check is named on the last line
- `2` — bad usage
- `3` — a check warned or was skipped, so the run is **not verified** even though
  nothing failed. Gate on `0` if you care; treat `0` and `3` alike if you do not.

**A production deployment exits `3` on every run.** The endpoint check treats
production as a warning — real money is at risk, and that is worth saying every
time — and one warning is what exit `3` reports. Since production is the default,
`3` is what a default configuration returns, and it means exactly what it says
above: nothing failed, and nothing was certified either. So the advice in that
last bullet needs one qualification — gating a production deployment on `0` alone
will never pass. Read the report, and keep the hard stop for `1`.

## Tool surface

**84 tools**: 70 read-only, 2 write, 12 destructive. The server also exposes MCP
Resources (documentation bundles and computed account views) and Prompts
(pre-composed tool-call plans).

**Five tools require a confirmation token**, and they are the five that submit
or change an order: `tastytrade_place_order`, `tastytrade_edit_order`,
`tastytrade_replace_order`, `tastytrade_place_complex_order` and
`tastytrade_edit_complex_order`. Each takes a single-use `confirmation_token`
minted by its own `dry_run_*` tool, valid for 60 seconds and bound to a hash of
the submitted arguments and of the request target.

**The other seven destructive tools carry no token and have no dry-run.** They
are `tastytrade_cancel_order` and `tastytrade_cancel_complex_order`,
`tastytrade_delete_quote_alert`, and the four watchlist mutators
`tastytrade_update_watchlist`, `tastytrade_delete_watchlist`,
`tastytrade_add_watchlist_symbol` and `tastytrade_remove_watchlist_symbol`. Of
those seven, only the two cancels touch orders; the other five move no money.
They act on the first call, and each one says so in its own description.

### Context cost

The tool list is large, and it is worth knowing the number before you meet it.
`tools/list` measures about 445 KB with all 84 tools, and about 349 KB with
`TASTYTRADE_READ_ONLY=1`, which withholds 14 of them. Every tool carries a full
`outputSchema`, and the descriptions are long deliberately — they are what the
agent reads instead of this file, and they are where the order semantics and the
failure modes are written down. That payload lands in the model's context at the
start of every session, and the figures move with every schema change.

Read-only mode is the only lever this server has over that today; there is no
tool-filtering variable. Most work needs a handful of tools:
`tastytrade_get_accounts`, `tastytrade_get_balances`, `tastytrade_get_positions`,
`tastytrade_get_quote`, `tastytrade_get_option_chain_compact` and
`tastytrade_get_live_orders`, and then `tastytrade_dry_run_order` followed by
`tastytrade_place_order`. If your client lets you enable tools individually per
server, that list is a reasonable place to start.

## Safety model

The reason this project exists. In order of how much they protect you:

1. **Dry-run-first confirmation.** The five order-submitting tools will not act
   without a token from their own dry-run. The token is single-use, expires in
   60 seconds, and is bound to the arguments _and_ the endpoint the dry-run
   covered — so you cannot dry-run one share and submit a thousand, or pre-flight
   one order and submit a different one. It covers those five and none of the
   other destructive tools; [Tool surface](#tool-surface) names both groups.
2. **Pre-submit sanity checks.** Per-leg quantities against the account's own
   published order-size ceilings, a notional cap on buying-power impact, and a
   refusal to send orders into frozen or closing-only accounts. Every result
   names the checks that did **not** run, so an empty warning list can never be
   mistaken for a completed check.
3. **Credential-destination guard.** The refresh token and client secret are only
   sent to a recognised tastytrade host, over a channel that encrypts them. An
   unrecognised host stops the server rather than warning it.
4. **Rate limiting.** tastytrade's own published per-second, per-endpoint
   ceilings plus a 50/sec global cap, charged once per call.
5. **Bounded, attributed output.** Everything the broker wrote is nested under an
   `upstream` member and marked as untrusted external content, bounded in size
   and stripped of display-hostile codepoints, so it cannot impersonate this
   server's own fields.

### Order attribution

Every order this server submits is tagged, server-side, with `source`, a field
from tastytrade's order API:

- **`source`** — `tastytrade-mcp/<version>`, so an order placed through this
  server is distinguishable from one entered by hand or by another integration.
  tastytrade echoes `source` back on order reads, so it is visible in order
  history; there is no `source` query filter, so filter on it client-side.
  `source` is written by the server and cannot be set, forged or suppressed by the
  caller — it is not an input property on any tool. An attribution a caller can
  switch off is not an attribution.

The one exception is the PAIRS ratio-threshold edit, which is left unstamped
deliberately: tastytrade documents that request body as exactly
`ratio-price-comparator` plus `ratio-price-threshold`, so an extra field there is
unverified against the spec. It creates no order and changes no leg.

### What it does not do

- **It does not authenticate the caller.** On stdio there is one caller per
  process and no second principal to distinguish. Adding an HTTP or SSE
  transport would make caller authentication a prerequisite.
- **The confirmation token is not human approval.** The same agent mints it and
  redeems it. It proves recency and identity of arguments, not intent.
- **A cancel is not automatically safe.** Cancelling a protective stop or a
  working hedge changes your risk immediately, and cancels carry no token.
- **Seven destructive tools act on the first call.** The two cancels, the
  quote-alert delete, and the four watchlist mutators have no dry-run and take
  no confirmation token. Nothing in that set moves money except the cancels, but
  a watchlist this server overwrites or deletes cannot be restored by it.
- **Safety state is in-memory and single-process.** Correct for one stdio
  session; a multi-replica deployment would need a shared store.

## Development

```bash
./build.sh          # the full gate: install, format, lint, typecheck, build, test, audit, secrets
npm test            # Jest battery
npm run typecheck
npm run lint
```

`./build.sh` is the single source of truth for whether the code is shippable, and
CI runs the identical script. `SKIP_INSTALL=1 ./build.sh` reuses `node_modules`
for a faster local re-run.

Always run tests through `npm test`, never a bare `npx jest`: the package script
supplies `--experimental-vm-modules`, and without it any suite that reaches an
`import.meta` source fails to compile.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and
[SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Third-party documentation

`tastytrade-llms-txt-docs/` is a point-in-time copy of tastytrade's own public
API documentation. Four of those files are a **runtime dependency** — the static
MCP resources read them at module load, so the directory has to ship alongside
the built server or it does not start — and the rest are the API reference the
test suite validates the tool schemas against.

That material is tastytrade's and is **not** under this repository's MIT licence.
It carries its own licence in [NOTICE](NOTICE), which grants the right to
reproduce and redistribute it for the purpose of using, building or distributing
this software. That grant exists because without it the MIT licence on the code
would not be usable: you could lawfully fork the repository and still not be able
to ship anything that runs. Keep `NOTICE` with any copy you distribute.

## Disclaimer

This software is provided **as is, without warranty of any kind**, as set out in
[LICENSE](LICENSE).

**You are responsible for what you connect this server to, and for everything it
does on your behalf.** This server hands order entry to an LLM agent. Language
models are non-deterministic: they misread instructions, act on content injected
into their context by a third party, and take actions their operator did not
intend. The dry-run-first confirmation flow, the pre-submit sanity checks and the
rate limits described above reduce how much damage that can do. They do not
eliminate it, and nothing in this repository is a guarantee about what a model
will do with the tools it is given.

Neither tastytrade nor any contributor to this repository accepts responsibility
or liability for any action taken — or not taken — by an LLM, an MCP client, or
any other software interacting with this server. That includes any order placed,
modified or cancelled, any position opened or closed, any account state changed,
and any financial loss arising from any of it, on any account the configured
credentials can reach.

If you are not prepared to accept that, run with `TASTYTRADE_ENV=sandbox`, or
with `TASTYTRADE_READ_ONLY=1`, or do not supply production credentials.

No tool, resource, prompt or example in this repository is a recommendation to
buy or sell anything, and nothing here is financial advice.

See also [Notice](#notice), tastytrade's own statement on third-party AI systems
connected through this server.

## Licence

MIT — see [LICENSE](LICENSE) for the software, and [NOTICE](NOTICE) for the
vendored tastytrade documentation under `tastytrade-llms-txt-docs/`, which is
licensed separately.

## Notice

<!-- The paragraph below is supplied by tastytrade compliance and is reproduced
     verbatim. Do not reword, abridge, or reformat it. Raise any change with
     compliance first. -->

tastytrade does not endorse or recommend any third-party AI System connected via
the MCP server, and tastytrade is not responsible for any information, output, or
trading activity generated by or through your connected AI System. You are solely
responsible for any actions taken in reliance on information generated by your AI
System and for any investment or trading decisions made using it. tastytrade does
not guarantee the accuracy, completeness, or suitability of any of your AI
generated output.
