# Security policy

This server holds a long-lived brokerage credential and can place, edit, replace
and cancel real orders. Security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). If that is unavailable to you, open an
issue asking for a private channel and omit all detail.

Include, as far as you can: what an attacker can do, the smallest sequence of
tool calls or configuration that demonstrates it, and which files are involved.
A proof of concept against the **sandbox** endpoint
(`https://api.cert.tastyworks.com`) is always preferred over one against
production.

Please redact credentials, account numbers and order IDs from anything you send.

## In scope

- Anything that causes a money-moving request to be sent without a valid,
  argument-bound confirmation token from the matching dry-run.
- Any path that sends the refresh token or client secret to a host other than
  the configured, recognised tastytrade endpoint.
- Any way to make a credential appear in a tool result, an error envelope, a
  resource body, a rendered prompt, the startup banner, or the preflight output.
- Any way to make upstream-supplied text occupy a field this server authors —
  the confirmation token, the sanity warnings, or the error taxonomy — or to
  make it render as something other than what its bytes say.
- Any way to bypass the rate limiter, the read-only mode, or the account-scope
  check.
- Any way to make a successful money-moving call report as a failure, or a
  failed one report as a success.

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
- Vulnerabilities in tastytrade's API itself — report those to tastytrade.

## Supported versions

The latest release on the default branch. There are no backported fixes.

## Hardening for operators

- Leave `TASTYTRADE_API_URL` unset to stay on the sandbox.
- Set `TASTYTRADE_READ_ONLY=1` unless you intend the agent to move money.
- Lower `MAX_ORDER_NOTIONAL_USD` to the largest order you would accept.
- Set `TASTYTRADE_CREDENTIAL_CHANNEL=strict` to refuse to start when a proxy or
  a modified certificate trust store is detected.
- Run `node dist/doctor.js` after any configuration change and gate on exit
  code `0`.
- Container hardening flags are documented in the `Dockerfile` header.
