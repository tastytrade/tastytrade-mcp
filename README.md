# tastytrade MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[tastytrade open API](https://developer.tastytrade.com/), giving an LLM agent
access to quotes, instruments, option chains, balances, positions, transactions,
watchlists, and order entry.

**This server can place, edit, replace and cancel real orders.** Every
money-moving tool is gated behind a dry-run-first confirmation flow, and the
default endpoint is the sandbox. Read [Safety model](#safety-model) before you
point it at production.

> No tool, resource, prompt or example here is a recommendation to buy or sell
> anything. Nothing in this repository is financial advice.

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

## Credentials

Authentication is **environment-only**. There is no interactive login flow: a
server an agent can make bind a listening socket, and that then prints a
long-lived refresh token into a transcript, is not defensible.

Create an OAuth client and refresh token out of band — see tastytrade's
[OAuth2 guide](https://developer.tastytrade.com/oauth/), or
**my.tastytrade.com → Manage → My Profile → API** — then supply four variables:

| Variable                   | Required | Default                                     |
| -------------------------- | -------- | ------------------------------------------- |
| `TASTYTRADE_API_URL`       | no       | `https://api.cert.tastyworks.com` (sandbox) |
| `TASTYTRADE_CLIENT_ID`     | yes      | —                                           |
| `TASTYTRADE_CLIENT_SECRET` | yes      | —                                           |
| `TASTYTRADE_REFRESH_TOKEN` | yes      | —                                           |

Nothing in this repository auto-loads a `.env` file. Export the variables
yourself, or hand them to the server through your MCP client's `env` block.
`.env.sample` documents the same set.

### Optional configuration

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

The server speaks MCP over stdio and is normally launched by a client. Add it to
your client's configuration:

```json
{
  "mcpServers": {
    "tastytrade": {
      "command": "node",
      "args": ["/absolute/path/to/tastytrade-mcp/dist/index.js"],
      "env": {
        "TASTYTRADE_API_URL": "https://api.cert.tastyworks.com",
        "TASTYTRADE_CLIENT_ID": "…",
        "TASTYTRADE_CLIENT_SECRET": "…",
        "TASTYTRADE_REFRESH_TOKEN": "…"
      }
    }
  }
}
```

To run it directly for debugging: `node dist/index.js`. Startup diagnostics go to
**stderr**; stdout carries the MCP protocol and nothing else.

## Check your setup first

When credentials are wrong, every tool call fails the same way. The bundled
preflight tells you which of the four things is broken, in dependency order, and
three of its checks need no network at all:

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

## Tool surface

**86 tools**: 72 read-only, 2 write, 12 destructive. The server also exposes MCP
Resources (documentation bundles and computed account views) and Prompts
(pre-composed tool-call plans).

Every destructive tool requires a single-use `confirmation_token` issued by its
matching `dry_run_*` tool. A token is valid for 60 seconds and is bound to a hash
of the submitted arguments and of the request target.

## Safety model

The reason this project exists. In order of how much they protect you:

1. **Dry-run-first confirmation.** A destructive order tool will not act without
   a token from its own dry-run. The token is single-use, expires in 60 seconds,
   and is bound to the arguments _and_ the endpoint the dry-run covered — so you
   cannot dry-run one share and submit a thousand, or pre-flight one order and
   submit a different one.
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

### What it does not do

- **It does not authenticate the caller.** On stdio there is one caller per
  process and no second principal to distinguish. Adding an HTTP or SSE
  transport would make caller authentication a prerequisite.
- **The confirmation token is not human approval.** The same agent mints it and
  redeems it. It proves recency and identity of arguments, not intent.
- **A cancel is not automatically safe.** Cancelling a protective stop or a
  working hedge changes your risk immediately, and cancels carry no token.
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

`tastytrade-llms-txt-docs/` is a copy of tastytrade's own public API
documentation. Four of those files are a **runtime dependency** — the static MCP
resources read them at module load — and the rest are the API reference the test
suite validates the tool schemas against. That material is tastytrade's, not
covered by this repository's licence, and carries no licence notice of its own.

## Licence

MIT — see [LICENSE](LICENSE).
