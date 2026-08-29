# Security policy

This server holds a long-lived brokerage credential and can place, edit, replace
and cancel real orders. Its default endpoint is **production**, so a deployment
that supplies nothing but credentials is pointed at real funds. Security reports
are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). If that is unavailable to you, open an
issue asking for a private channel and omit all detail.

Include, as far as you can: what an attacker can do, the smallest sequence of
tool calls or configuration that demonstrates it, and which files are involved.
A proof of concept against the **sandbox** endpoint (`TASTYTRADE_ENV=sandbox`,
`https://api.cert.tastyworks.com`) is always preferred over one against
production.

The sandbox does not serve market data: every `/market-data/*` and
`/market-metrics/*` route currently answers HTTP 502 there, so the quote and
market-metrics tools cannot be driven on the sandbox at all. If your finding
depends on one of those responses, describe the step and the payload it needs
rather than reproducing it against production, and say which part you could not
run. A described step is worth more than a live proof against a funded account.

Please redact credentials, account numbers and order IDs from anything you send.

## In scope

- Anything that causes a money-moving request to be sent without a valid,
  argument-bound confirmation token from the matching dry-run.
- Any path that sends the refresh token or client secret to a host other than
  the configured, recognised tastytrade endpoint.
- Any way to make a credential appear in a tool result, an error envelope, a
  resource body, a rendered prompt, the startup banner, or the preflight output.
- Any way to make upstream-supplied text occupy a field this server authors —
  the confirmation token, the sanity warnings, the error taxonomy, or the
  `environment` member of an order result — or to make it render as something
  other than what its bytes say.
- Any way to bypass the rate limiter, the read-only mode, or the account-scope
  check.
- Any way to make a successful money-moving call report as a failure, or a
  failed one report as a success.
- Any way to make the server name an environment other than the one its requests
  actually reach — in the startup banner, in the `instructions` it returns on
  initialize, or in the `environment` member on an order result. An agent told
  `sandbox` while its orders reach production is the failure those three
  surfaces exist to prevent.

## Out of scope

- A compromised host. If an attacker can read the process environment they
  already hold the credential.
- The absence of caller authentication on the stdio transport. There is one
  caller per process by design; this is documented in the README.
- The confirmation token not being a human approval. Also documented, and not a
  defect.
- Anything requiring the operator to deliberately disable a control
  (`TASTYTRADE_ALLOW_UNKNOWN_API_HOST`, `NODE_TLS_REJECT_UNAUTHORIZED=0`), where
  the server already names the risk on startup.
- Production being the default endpoint. It is deliberate and announced on three
  surfaces — see the hardening list below for how to point elsewhere.
- Vulnerabilities in tastytrade's API itself — report those to tastytrade.

## Supported versions

The default branch. There are no tagged releases, no published package and no
backported fixes: a fix lands on the default branch, and an operator updates by
pulling and rebuilding.

## Hardening for operators

- Set `TASTYTRADE_ENV=sandbox` to stay off production. **Unset means
  production** — that is the default, because the sandbox serves no market data
  and a server that cannot quote is not a usable default. A value the server
  cannot read (`sandbx`) resolves to the sandbox and says so loudly on stderr,
  so a typo cannot be read as permission to trade live funds.
- `TASTYTRADE_API_URL` still wins over `TASTYTRADE_ENV`. If you set both, the
  URL is the endpoint; it remains the only way to reach a gateway, a proxy or a
  test double.
- Set `TASTYTRADE_READ_ONLY=1` unless you intend the agent to move money. Any
  value the server cannot read also enables read-only mode, for the same reason.
- Lower `MAX_ORDER_NOTIONAL_USD` to the largest order you would accept.
- Set `TASTYTRADE_CREDENTIAL_CHANNEL=strict` to refuse to start when a proxy or
  a modified certificate trust store is detected.
- Run `node dist/doctor.js` after any configuration change. Exit `1` is a failed
  check and always worth reading. Note that a production endpoint is a **warn**,
  so a production deployment exits `3` — "nothing failed, nothing verified" —
  on every run; gate on `0` only where you expect the sandbox, and read the
  named checks otherwise.
- Confirm the environment from the server itself rather than from your config:
  the startup banner names the endpoint on stderr, and the `instructions` in the
  initialize result name it to the agent.
- Container hardening flags are documented in the `Dockerfile` header.
