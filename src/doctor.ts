#!/usr/bin/env node
/**
 * The operator preflight command, run as `npm run doctor` or
 * `node dist/doctor.js`.
 *
 * When the credentials are wrong, this server fails the same way on every tool
 * call: `auth_failed`, with nothing saying which of the four things is broken.
 * Diagnosing one real broken credential set took an hour, and every step was
 * mechanical — a REFRESH TOKEN pasted into TASTYTRADE_CLIENT_ID (its JWT header
 * says `"typ":"rt+jwt"`, and the real client id was that token's `aud` claim); an
 * `iss` naming a host that does not resolve; the two sandbox environments answering
 * on DIFFERENT domains (`api.cert` on tastyworks.com, `api.sandbox` on
 * tastytrade.com), each NXDOMAIN on the other; and a secret that did not belong to
 * the client, which the token endpoint says in as many words if you ask it. Three
 * of the four need no network. This command runs them in dependency order, names
 * the failed check and exits non-zero.
 *
 * OUTPUT CHANNEL — deliberate, do not "fix" it. This is not the MCP server: the
 * stdout-is-reserved rule applies to src/index.ts and what it loads. This is a
 * standalone CLI with no protocol on its file descriptors, so the report goes to
 * stdout (which is what makes `--json` pipeable) and only usage errors to stderr.
 *
 * WHAT IS NEVER PRINTED. TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN are
 * never emitted in any form — not truncated, not fingerprinted, only presence and
 * character count. Any text from the network passes through a redactor built from
 * the configured secrets first. A URL is a credential too when it carries userinfo,
 * so every echo of the endpoint prints `EndpointState.display`, never the raw
 * value, and the password half joins the redactor's literals.
 *
 * The one credential-adjacent value that IS printed is the refresh token's `aud`
 * claim, because that is the whole point of check 5: `aud` is the client identifier
 * the token was issued to, public by construction (RFC 6749 §2.2), and seeing it
 * turns "auth keeps failing" into "my client id is wrong, and here is the right
 * one". The configured TASTYTRADE_CLIENT_ID is still never echoed.
 *
 * WHERE THE CREDENTIALS MAY GO. This command holds the same long-lived refresh
 * token the server does and POSTs it to whatever TASTYTRADE_API_URL names, which
 * made it the softer of the two doors. The decision now lives in
 * src/credential-target.ts and both commands ask the same function; a refused
 * destination is a hard `fail` on check 2 and checks 6-8 are skipped.
 *
 * SHAREABLE BY DEFAULT. "Never prints a credential" is not "safe to paste", and
 * being pasted somewhere is what this command is FOR. So the default output carries
 * nothing identifying: account numbers masked to their last four, nicknames
 * withheld, the install path printed home-relative. None of that costs diagnostic
 * value. `--show-accounts` un-masks for an operator reading their own terminal, and
 * the report says not to paste that form. Keep this in step with
 * .github/ISSUE_TEMPLATE/bug_report.yml.
 */

import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import axios from "axios";
import { TastytradeClient } from "./api-client.js";
import type { HttpAdapter } from "./api-client.js";
import { redactSecrets, REDACTED } from "./safety/errors.js";
// The server's transport safety values, imported rather than re-stated: this
// file's token POST is deliberately identical to src/oauth-client.ts's, and a
// doctor that bounded a request differently could pass where the server fails.
// No cycle — oauth-client.ts imports only axios, ./types.js, ./safety/clock.js
// and ./credential-target.js.
import {
  httpTransportLimits,
  httpWallClockSignal,
  resolveHttpWallClockMs,
} from "./oauth-client.js";
import {
  MAX_UPSTREAM_BODY_TEXT_CHARS,
  boundedDeep,
  boundedText,
  tallyIsEmpty,
} from "./safety/bounded-text.js";
import type { BoundedTally } from "./safety/bounded-text.js";
import {
  ALLOW_UNKNOWN_API_HOST_ENV_VAR,
  PRODUCTION_API_URL,
  SANDBOX_API_URL,
  SWAPPED_DOMAIN_NOTE as GUARD_SWAPPED_DOMAIN_NOTE,
  apiEndpointForDisplay,
  atSignOutsideUserinfo,
  clipHostForMessage,
  inspectCredentialChannel,
  inspectCredentialTarget,
  normaliseHostname,
  urlUserinfo,
  type CredentialTargetDecision,
} from "./credential-target.js";
import { DEFAULT_MAX_ORDER_NOTIONAL_USD } from "./safety/sanity-checks.js";
import { DOCS_ROOT, REQUIRED_DOCS } from "./resources/static/vendored-docs.js";
import { PACKAGE_VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Configuration constants
//
// The endpoint identities and the credential-destination guard are IMPORTED from
// src/credential-target.ts — not local copies, and not from src/mcp-server/index.ts
// either, which would drag in the whole dispatcher and with it the static resource
// modules, which read the vendored docs AT MODULE LOAD and throw if one is missing.
// A doctor that cannot start when the vendored docs are missing could never report
// check 11, which is precisely the failure it exists to explain.
//
// Copying is how this command ended up sending the credentials to any host while
// the server refused to start on the same value. `READ_ONLY_ENV_VAR` and its
// truthiness rule stay local copies — they are not a credential rule, and mirroring
// the dispatcher's fail-closed behaviour is the point — pinned to the originals by
// test/doctor.test.ts.
// ---------------------------------------------------------------------------

/** Re-exported for callers and tests that read the endpoints from here. */
export { SANDBOX_API_URL, PRODUCTION_API_URL };

/** Env var that switches the server into read-only mode. */
export const READ_ONLY_ENV_VAR = "TASTYTRADE_READ_ONLY";

/** Values that enable read-only mode, after trim + lowercase. */
const READ_ONLY_TRUTHY = new Set(["1", "true"]);

/** Values that disable read-only mode, after trim + lowercase. */
const READ_ONLY_FALSY = new Set(["", "0", "false"]);

/** The three OAuth variables the server needs, in report order. */
export const REQUIRED_CREDENTIAL_VARS = [
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
] as const;

/**
 * The phrase the TLS probe emits when the handshake completed but the peer
 * certificate was NOT verified.
 *
 * One constant, produced by `probeConnectionForReal` and read by
 * `inspectConnectivity`, so the two cannot drift into disagreement about what a
 * verified session looks like.
 */
export const UNVERIFIED_CERT_MARKER = "certificate NOT verified";

/** How long the TCP/TLS reachability probe waits before giving up. */
export const CONNECT_TIMEOUT_MS = 5_000;

/** How long the token grant and the account fetch wait before giving up. */
export const HTTP_TIMEOUT_MS = 15_000;

/** Opt-in flag that un-masks the account identifiers in check 8. */
export const SHOW_ACCOUNTS_FLAG = "--show-accounts";

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

/**
 * `pass` — verified. `warn` — works, but the operator should know. `fail` — the
 * server cannot serve traffic in this state. `skip` — a prerequisite failed, so
 * the check could not be attempted; a skip therefore always sits downstream of
 * a fail and never appears in a passing run.
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  /** Stable machine identifier, named in the exit message and in `--json`. */
  id: string;
  /** Human label. */
  title: string;
  status: CheckStatus;
  /** One line: what was found. */
  summary: string;
  /** Supporting lines, printed indented under the summary. */
  details: string[];
  /** Structured payload for `--json` consumers. */
  data?: Record<string, unknown>;
}

/**
 * What the report PRINTS. Nothing here changes which checks run or how they are
 * judged — an option that could alter a verdict would make two operators
 * reading the same command disagree about whether the server is healthy.
 */
export interface DoctorOptions {
  /**
   * Print brokerage account numbers and nicknames in full instead of masked.
   * Default false: the doctor exists to be pasted somewhere when someone is
   * stuck, and an account number plus a named account is the raw material for
   * brokerage social engineering — permanent, once it is in a public issue.
   */
  revealAccounts: boolean;
}

/** Shareable by default. */
export const DEFAULT_DOCTOR_OPTIONS: DoctorOptions = { revealAccounts: false };

/**
 * The aggregate verdict, with a name for the state that had none.
 *
 * `CheckStatus` has four members, and an aggregate of
 * `checks.find((c) => c.status === "fail")` names one: `warn` then cannot affect
 * `ok`, the exit code or the verdict line, so a report whose ONLY check is a
 * warning prints "verified" and exits 0. With an ambient proxy that is the report
 * saying "whatever terminates that connection sees the request" and then saying
 * `verified` four lines later.
 *
 * Three states, so "not failed" is not a synonym for "verified". Adding a member to
 * `CheckStatus` now forces the exhaustive switches here to be revisited.
 */
export type DoctorVerdict = "passed" | "passed_with_warnings" | "failed";

/** Exit code for a run that passed but was not verified. */
export const EXIT_WARN = 3;

/** Every status in a check list, counted once. */
export function tallyStatuses(
  checks: readonly CheckResult[],
): Record<CheckStatus, number> {
  const tally: Record<CheckStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    skip: 0,
  };
  for (const check of checks) tally[check.status] += 1;
  return tally;
}

/**
 * The aggregate verdict, derived from the WHOLE status tally.
 *
 * `skip` is folded in with `warn` deliberately. Every skip reachable today
 * follows a fail or a warn, so including it changes no current outcome — and it
 * means a future skip on an otherwise clean run cannot be rendered as "verified"
 * either, which is the same conflation this function exists to prevent. A check
 * that could not run verified nothing.
 */
export function deriveVerdict(checks: readonly CheckResult[]): DoctorVerdict {
  const tally = tallyStatuses(checks);
  if (tally.fail > 0) return "failed";
  if (tally.warn + tally.skip > 0) return "passed_with_warnings";
  return "passed";
}

/** The process exit code each verdict carries. */
export function exitCodeFor(verdict: DoctorVerdict): number {
  switch (verdict) {
    case "failed":
      return 1;
    case "passed_with_warnings":
      return EXIT_WARN;
    case "passed":
      return 0;
  }
}

export interface DoctorReport {
  /**
   * The aggregate verdict. Everything else on this object that summarises the
   * run is a projection of it, never an independent expression — that
   * independence is what let `ok` disagree with the checks it was summarising.
   */
  verdict: DoctorVerdict;
  /**
   * True when no check failed — i.e. `verdict !== "failed"`.
   *
   * Kept for compatibility with existing `--json` consumers, and defined in ONE
   * place as a projection of `verdict`. It is NOT the field to gate on: `ok` is
   * true for `passed_with_warnings`, which is a run this report declines to call
   * verified. Gate on `verdict === "passed"`, or on exit code 0.
   */
  ok: boolean;
  /** 0 passed, 1 failed, {@link EXIT_WARN} passed with warnings. */
  exitCode: number;
  /** The id of the first failed check, when there is one. */
  failedCheck?: string;
  version: string;
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Injection seams
//
// Every side effect the doctor performs is reachable through one of these, so
// the whole command runs offline and deterministically in tests. `adapter` is
// the same axios seam the server's own test harness uses, which means the token
// grant and the account fetch exercise the REAL request path — real headers,
// real URL construction, real response unwrapping — with only the transport
// replaced.
// ---------------------------------------------------------------------------

export interface ConnectionTarget {
  host: string;
  port: number;
  /** True for https — the probe then completes a TLS handshake, not just TCP. */
  secure: boolean;
}

export interface DoctorDeps {
  /** The environment to inspect. Always passed explicitly. */
  env: NodeJS.ProcessEnv;
  /** Resolves a hostname to addresses; rejects (ENOTFOUND) when it does not. */
  lookupHost: (hostname: string) => Promise<string[]>;
  /** Opens and immediately closes a connection; resolves with a detail line. */
  probeConnection: (target: ConnectionTarget) => Promise<string>;
  /** Replaces the HTTP transport for the token grant and the account fetch. */
  adapter?: HttpAdapter;
  /** Existence probe for the vendored docs. */
  fileExists: (filePath: string) => boolean;
  /** Wall clock, for token age and expiry arithmetic. */
  now: () => number;
}

/** The real seams. Constructed lazily so importing this module does nothing. */
export function defaultDeps(env: NodeJS.ProcessEnv = process.env): DoctorDeps {
  return {
    env,
    lookupHost: async (hostname) => {
      const records = await lookup(hostname, { all: true });
      return records.map((r) => r.address);
    },
    probeConnection: probeConnectionForReal,
    fileExists: existsSync,
    now: () => Date.now(),
  };
}

/**
 * Open a connection to the target, complete the TLS handshake when the scheme
 * is https, then tear it down. Nothing is sent — the point is only to prove the
 * host answers on the port and, for https, that a TLS session can be built.
 */
function probeConnectionForReal(target: ConnectionTarget): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Guards against a socket that both errors and times out.
    let done = false;
    const settle = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.destroy();
      fn();
    };

    const socket = target.secure
      ? tls.connect({
          host: target.host,
          port: target.port,
          servername: target.host,
        })
      : net.connect({ host: target.host, port: target.port });

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on("timeout", () =>
      settle(() =>
        reject(
          new Error(
            `no answer from ${target.host}:${target.port} within ${CONNECT_TIMEOUT_MS}ms`,
          ),
        ),
      ),
    );
    socket.on("error", (err: Error) => settle(() => reject(err)));

    if (target.secure) {
      const secure = socket as tls.TLSSocket;
      socket.on("secureConnect", () => {
        // Read the session facts BEFORE settling: settle() destroys the socket,
        // and getProtocol() on a destroyed socket returns null.
        const protocol = secure.getProtocol() ?? "unknown protocol";
        // Reachable, despite `rejectUnauthorized` defaulting to true: when the
        // environment sets NODE_TLS_REJECT_UNAUTHORIZED=0 (or an equivalent),
        // Node completes the handshake and records the failure here instead.
        const certificate = secure.authorized
          ? "certificate verified"
          : `${UNVERIFIED_CERT_MARKER}: ${secure.authorizationError}`;
        settle(() =>
          resolve(`TLS handshake completed (${protocol}, ${certificate})`),
        );
      });
    } else {
      socket.on("connect", () =>
        settle(() => resolve("TCP connection opened")),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Build a redactor for the given environment.
 *
 * Two layers: the literal configured secrets, then the shared pattern scrubber from
 * the safety layer, which catches `Bearer …` and `client_secret=…` in bodies the
 * doctor never parsed. Values under 8 characters are ignored — a three-character
 * "secret" would mangle unrelated words.
 *
 * The password half of any userinfo in TASTYTRADE_API_URL counts as a configured
 * secret: `https://ops:hunter2@host` is a credential axios turns into an
 * Authorization header. Only the half after the first `:` is added — a userinfo
 * with no colon cannot be told from a hostname look-alike
 * (`https://api.tastyworks.com@evil.example` is a real attack shape), and blanking
 * that out of the "Recognised hosts" line would wreck the diagnosis of the very
 * attack it appears in.
 */
export function makeRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
  const literals: string[] = [];
  for (const name of [
    "TASTYTRADE_CLIENT_SECRET",
    "TASTYTRADE_REFRESH_TOKEN",
    "TASTYTRADE_SESSION_TOKEN",
  ]) {
    const raw = env[name];
    if (typeof raw === "string" && raw.trim().length >= 8) {
      literals.push(raw.trim());
    }
  }
  // Two ways a URL carries a password, and the redactor needs both. The first
  // is the parser's userinfo. The second is the text before an `@` the parser
  // read as a path — see atSignOutsideUserinfo — which is what an operator
  // writes when their password happens to begin with digits that spell a valid
  // port. The flag said "no userinfo" for that one, which was true and which
  // also left the literal out of this list, so the belt and the braces failed
  // on the same input.
  const configuredUrl = env.TASTYTRADE_API_URL?.trim() ?? "";
  for (const candidate of [
    urlUserinfo(configuredUrl),
    atSignOutsideUserinfo(configuredUrl),
  ]) {
    if (candidate === undefined) continue;
    const colon = candidate.indexOf(":");
    if (colon < 0) continue;
    // The half after the first colon, and only when it is long enough to be a
    // password rather than a port or a scheme fragment. An ordinary path that
    // happens to contain an `@` therefore contributes nothing: a redactor that
    // blanked short common strings would wreck the report it is protecting.
    const password = candidate.slice(colon + 1);
    if (password.length >= 8) literals.push(password);
  }
  return (text: string) => {
    let out = text;
    for (const literal of literals) out = out.split(literal).join(REDACTED);
    return redactSecrets(out);
  };
}

// ---------------------------------------------------------------------------
// Check 1 — credentials present
// ---------------------------------------------------------------------------

interface CredentialState {
  check: CheckResult;
  /** Raw values, exactly as the server would read them (never trimmed). */
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  /** True when all three are set to a non-blank value. */
  complete: boolean;
}

/**
 * Flag the copy-paste faults that produce an unexplainable `auth_failed`:
 * surrounding whitespace, quote characters kept literally by an `.env` loader,
 * and a value that is itself a JWT where an identifier belongs.
 */
function credentialAnomalies(name: string, raw: string): string[] {
  const notes: string[] = [];
  if (raw !== raw.trim()) {
    notes.push(
      `${name} has leading or trailing whitespace — it is sent verbatim, so the grant will fail.`,
    );
  }
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    notes.push(
      `${name} is wrapped in quote characters. Some .env loaders keep them literally; drop the quotes.`,
    );
  }
  if (name !== "TASTYTRADE_REFRESH_TOKEN") {
    const jwt = decodeJwt(trimmed);
    if (jwt) {
      const typ =
        typeof jwt.header.typ === "string"
          ? ` (header typ=${jwt.header.typ})`
          : "";
      notes.push(
        `${name} is itself a JWT${typ} — that is a token, not an identifier. ` +
          `A refresh token's "aud" claim is the client id it belongs to.`,
      );
    }
  }
  return notes;
}

export function inspectCredentials(env: NodeJS.ProcessEnv): CredentialState {
  const details: string[] = [];
  const missing: string[] = [];
  const anomalies: string[] = [];
  const lengths: Record<string, number> = {};

  for (const name of REQUIRED_CREDENTIAL_VARS) {
    const raw = env[name];
    if (typeof raw !== "string" || raw.trim() === "") {
      missing.push(name);
      details.push(`${name.padEnd(26)} MISSING`);
      continue;
    }
    lengths[name] = raw.length;
    details.push(`${name.padEnd(26)} set, ${raw.length} characters`);
    anomalies.push(...credentialAnomalies(name, raw));
  }
  details.push(...anomalies);

  const complete = missing.length === 0;
  const status: CheckStatus = !complete
    ? "fail"
    : anomalies.length > 0
      ? "warn"
      : "pass";
  const summary = !complete
    ? `not set: ${missing.join(", ")}`
    : anomalies.length > 0
      ? "all three variables are set, but one or more look mistyped"
      : "all three OAuth variables are set";

  return {
    check: {
      id: "credentials",
      title: "Credentials",
      status,
      summary,
      details,
      data: {
        missing,
        // Lengths only. The values themselves are never reported.
        lengths,
        anomalies,
      },
    },
    clientId: env.TASTYTRADE_CLIENT_ID,
    clientSecret: env.TASTYTRADE_CLIENT_SECRET,
    refreshToken: env.TASTYTRADE_REFRESH_TOKEN,
    complete,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — API endpoint
// ---------------------------------------------------------------------------

export type ApiEnvironment =
  | "production"
  | "sandbox"
  | "swapped-domain"
  | "unknown";

export interface HostClassification {
  environment: ApiEnvironment;
  label: string;
  /** Extra guidance, printed when present. */
  note?: string;
}

/**
 * The twin-domain trap, spelled out because it costs an hour every time:
 * tastytrade's two non-production environments live on DIFFERENT registrable
 * domains. `api.cert.tastyworks.com` is the documented sandbox
 * (tastytrade-llms-txt-docs/docs/sandbox.md); `api.sandbox.tastytrade.com` is
 * the other one. Cross the two — `api.sandbox.tastyworks.com`,
 * `api.cert.tastytrade.com` — and DNS answers NXDOMAIN, which surfaces to an
 * agent as 93 identical network errors.
 */
const SWAPPED_DOMAIN_NOTE =
  "The two sandbox environments answer on DIFFERENT domains: `api.cert` on " +
  "tastyworks.com, `api.sandbox` on tastytrade.com. Crossing them gives a host " +
  "that does not resolve publicly. Use https://api.cert.tastyworks.com or " +
  "https://api.sandbox.tastytrade.com.";

export function classifyApiHost(host: string): HostClassification {
  // normaliseHostname, not toLowerCase: `api.tastyworks.com.` is production to
  // a resolver, and this label is how the operator learns that real money is
  // involved. The guard, the dispatcher's money predicate and this switch all
  // read the host through the same function so they cannot answer differently
  // about the same string.
  switch (normaliseHostname(host)) {
    case "api.tastyworks.com":
      return {
        environment: "production",
        label: "tastytrade PRODUCTION — real accounts, real funds",
      };
    case "api.cert.tastyworks.com":
      return {
        environment: "sandbox",
        label:
          "tastytrade sandbox (cert) — the documented sandbox, no real money",
      };
    case "api.sandbox.tastytrade.com":
      return {
        environment: "sandbox",
        label: "tastytrade sandbox — no real money",
      };
    case "api.sandbox.tastyworks.com":
    case "api.cert.tastytrade.com":
      return {
        environment: "swapped-domain",
        label: "sandbox name on the wrong domain — this host is not public",
        note: SWAPPED_DOMAIN_NOTE,
      };
    default:
      return {
        environment: "unknown",
        label: "not a hostname this server recognises",
        note:
          "Recognised: https://api.tastyworks.com (production), " +
          "https://api.cert.tastyworks.com and https://api.sandbox.tastytrade.com " +
          "(sandbox).",
      };
  }
}

export interface EndpointState {
  check: CheckResult;
  /** The resolved base URL, exactly as the server would use it. */
  apiUrl: string;
  /**
   * `apiUrl` with any userinfo removed — the ONLY form this command prints.
   *
   * A URL may embed Basic-auth credentials (`https://ops:hunter2@host`), which
   * axios turns into an Authorization header. This report is written to be
   * pasted into an issue and its `--help` promises it never prints a credential,
   * so the raw value is used to make requests and this one is used to talk about
   * them.
   */
  display: string;
  /**
   * Whether the OAuth credentials may be sent here at all, from the SAME
   * function the server enforces at startup ({@link inspectCredentialTarget}).
   * Not a second opinion — the same one.
   */
  credentialTarget: CredentialTargetDecision;
  /** Absent when the URL could not be parsed — downstream checks then skip. */
  target?: ConnectionTarget;
  classification?: HostClassification;
}

/**
 * The `userinfo` component of a URL-shaped string, or undefined when it has
 * none.
 *
 * Re-exported from src/credential-target.ts rather than implemented here. A
 * byte-identical copy in this file would disagree with the original about the same
 * value: `apiEndpointForDisplay` printing the first half of a password containing
 * `/`, `?` or `#` while this one returns undefined for it — so the report would say
 * `userinfo: false`, withhold the "rotate this credential" warning, and leave the
 * password out of the redactor, all in the run that printed it. One implementation,
 * in the module that owns the
 * credential rules. Still exported from here because the report's own tests
 * read it as part of this command's surface.
 */
export { urlUserinfo } from "./credential-target.js";

/**
 * Check 2 — where the credentials would be sent, and whether they may be.
 *
 * The verdict is NOT this file's own: it comes from `inspectCredentialTarget`, the
 * function `src/index.ts` enforces before it will start. This command must not
 * classify the host itself — calling an unrecognised one a WARNING and then handing
 * it the refresh token four checks later, while the server refuses to start on the
 * same environment, is worse than no preflight.
 *
 * So a refused destination is a hard `fail` and checks 6-8 are skipped. The checks
 * that send nothing still run: DNS and the TCP/TLS probe carry no credential, and
 * NXDOMAIN on a swapped-domain host is the single most valuable line this report
 * prints. Refusing to diagnose is not the same as refusing to transmit.
 */
export function inspectApiUrl(env: NodeJS.ProcessEnv): EndpointState {
  // Mirrors resolveApiUrl() in the dispatcher: trim, and fall back to the
  // SANDBOX so an operator who made no choice cannot land on production.
  const configured = env.TASTYTRADE_API_URL?.trim();
  const apiUrl = configured ? configured : SANDBOX_API_URL;
  // Clipped where it is built, not at each of its seven print sites: `display`
  // is documented as the only form this command prints, so bounding it here is
  // what makes that documentation true for a hostile value as well as a
  // careless one. `apiUrl` — the value requests are actually built from — is
  // untouched.
  const display = clipHostForMessage(apiEndpointForDisplay(apiUrl));
  const userinfo = urlUserinfo(apiUrl);
  // The same call src/index.ts makes at startup, on the same resolved value.
  const credentialTarget = inspectCredentialTarget(apiUrl, env);
  const source = configured
    ? "from TASTYTRADE_API_URL"
    : "TASTYTRADE_API_URL is unset — using the sandbox default";
  const details: string[] = [`Base URL: ${display} (${source})`];
  const base = { id: "api-url", title: "API endpoint" };
  const targetData = {
    base_url: display,
    // Presence only, never the value: userinfo IS a credential.
    userinfo: userinfo !== undefined,
    // The other way to write one. `userinfo` above is the parser's answer and
    // it is correct — no Authorization header is sent — which is exactly why a
    // script reading only that field concluded there was no credential in the
    // URL when there was one in the path.
    at_sign_outside_userinfo: atSignOutsideUserinfo(apiUrl) !== undefined,
    credential_target: {
      allowed: credentialTarget.allowed,
      recognised: credentialTarget.recognised,
      acknowledged: credentialTarget.acknowledged,
      refusal: credentialTarget.refusal ?? null,
      notes: credentialTarget.notes,
      // What the environment does to the channel, separate from the host
      // verdict: a script reading --json must be able to tell "the URL names a
      // host we know" from "and nothing intercepts the connection to it",
      // because only the first of those was ever checked.
      channel: credentialTarget.channelNotes,
      // The informational half, under its OWN key. A machine consumer has to be
      // able to tell "something IS changing the channel" from "something WOULD
      // change it if a condition this process cannot observe holds", because the
      // first promotes this check to `warn` and the second must not — and, with
      // a three-state verdict, that difference is an exit code.
      channel_informational: credentialTarget.channelInformationalNotes,
    },
  };

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return {
      apiUrl,
      display,
      credentialTarget,
      check: {
        ...base,
        status: "fail",
        summary: "TASTYTRADE_API_URL is not a parseable URL",
        details: [
          ...details,
          "Expected an absolute URL with a scheme, e.g. https://api.cert.tastyworks.com.",
        ],
        data: { ...targetData, parseable: false },
      },
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      apiUrl,
      display,
      credentialTarget,
      check: {
        ...base,
        status: "fail",
        summary: `unsupported URL scheme "${parsed.protocol}"`,
        details: [
          ...details,
          "The HTTP client can only speak http: or https:.",
        ],
        data: { ...targetData, scheme: parsed.protocol },
      },
    };
  }

  const secure = parsed.protocol === "https:";
  const port = parsed.port ? Number(parsed.port) : secure ? 443 : 80;
  const classification = classifyApiHost(parsed.hostname);
  const warnings: string[] = [];
  const closing: string[] = [];
  // Bounded for the same reason `display` is. `target.host` below keeps the
  // real value: that one is dialled, not printed.
  const shownHost = clipHostForMessage(parsed.hostname);

  details.push(`Host: ${shownHost}   Port: ${port}`);
  // The "unknown host" note is suppressed when the destination is refused: the
  // refusal below already lists the recognised hosts, and saying it twice buries
  // the sentence that matters.
  if (classification.note && classification.environment !== "unknown") {
    details.push(classification.note);
  }

  if (userinfo !== undefined) {
    warnings.push(
      "TASTYTRADE_API_URL embeds userinfo (a username, and possibly a password, inside the URL). " +
        "Its value is not printed anywhere in this report, and the password half is redacted out of any " +
        "message quoted from the endpoint. axios turns userinfo into an Authorization header on every " +
        "request, so if it was not deliberate, treat it as a leaked credential and rotate it.",
    );
  }
  // The server builds request paths by concatenation (`${apiUrl}/oauth/token`),
  // so a trailing slash or a path prefix silently produces `//oauth/token` or
  // a nested path. Worth naming: it looks like a credential fault.
  //
  // Everything after the authority, not `pathname` alone: a query or a fragment
  // is concatenated onto in exactly the same way and swallows the path the
  // server appends, and `pathname` is "/" for both — so two of the three ways
  // to write this would otherwise pass without a word.
  const afterAuthority = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  // May be the operator's password, in a shape the parser reads as a path. See
  // atSignOutsideUserinfo, and the warning below.
  const atSignText = atSignOutsideUserinfo(apiUrl);
  if (afterAuthority !== "" || apiUrl.endsWith("/")) {
    warnings.push(
      "TASTYTRADE_API_URL carries a path, a query or a trailing slash" +
        // Quoted, because seeing it is what ends the diagnosis — unless it
        // may BE the credential, which is the case the next warning is about.
        // It is operator-supplied either way, so what is quoted is capped.
        (atSignText === undefined
          ? ` ("${clipHostForMessage(afterAuthority === "" ? parsed.pathname : afterAuthority)}")`
          : "") +
        ". Request paths are concatenated onto it, so this changes every URL the server requests. " +
        "Use the bare origin.",
    );
  }
  if (atSignText !== undefined) {
    warnings.push(
      'TASTYTRADE_API_URL has an "@" after the host, which this URL grammar reads as part of the ' +
        `path, the query or the fragment rather than as a username and password — the host being ` +
        `called is "${shownHost}", not the name after the @. If that text was meant to be ` +
        "credentials they are not being used as any: no Authorization header is sent, and they are " +
        "instead concatenated into the path of every request. Treat them as leaked and rotate them. " +
        "Their value is not printed anywhere in this report and is redacted out of anything quoted " +
        "from the endpoint.",
    );
  }

  let status: CheckStatus = "pass";
  let summary = classification.label;

  if (!credentialTarget.allowed) {
    status = "fail";
    summary = "REFUSED — the credentials must not be sent to this endpoint";
    // The server's own sentence, verbatim, not a paraphrase of it. Two texts for
    // one rule is how these two files drifted apart in the first place, and the
    // operator should read here exactly what the startup banner would say.
    details.push(
      credentialTarget.refusal ??
        "This endpoint may not receive the OAuth credentials.",
    );
    closing.push(
      "The server REFUSES TO START on this value, and this preflight will not send the refresh " +
        "token or client secret to it: the grant, the token scope and the account checks are skipped. " +
        "The checks that transmit nothing (DNS, TCP/TLS) still ran, above.",
    );
  } else if (classification.environment === "production") {
    status = "warn";
    summary =
      "PRODUCTION API — real money is at risk; every order affects real funds";
    details.push(
      `For the sandbox instead, unset TASTYTRADE_API_URL (default ${SANDBOX_API_URL}).`,
      `To withhold every write and destructive tool, set ${READ_ONLY_ENV_VAR}=1.`,
    );
  } else if (!credentialTarget.recognised) {
    // Allowed only because the operator named this host. The server prints an
    // unmissable banner here; the report says the same thing.
    status = "warn";
    summary = `${classification.label} — allowed only because ${ALLOW_UNKNOWN_API_HOST_ENV_VAR} names it`;
    details.push(
      `"${shownHost}" is not a tastytrade API host. The refresh token and client ` +
        `secret WILL be sent to it, and a tastytrade refresh token is long-lived and non-rotating: ` +
        "if this host is not one you control, stop and rotate the credential now.",
      "The host name and resolved addresses in checks 2-4 are yours, not the vendor's — redact " +
        "them before pasting this report anywhere public.",
    );
  }

  // Whatever the guard wanted the operator to know — the loopback exemption, the
  // exact variable to set — in its own words.
  for (const note of credentialTarget.notes) {
    // Except its swapped-domain note, when the version above already said it.
    // This file's copy is the longer one: it names the two URLs that actually
    // work, which is the sentence that ends the incident. Printing both makes
    // the report look like it is stuttering.
    if (
      note === GUARD_SWAPPED_DOMAIN_NOTE &&
      classification.note !== undefined &&
      details.includes(classification.note)
    ) {
      continue;
    }
    if (!details.includes(note)) details.push(note);
  }
  // What the environment does to the channel. Printed on every outcome,
  // including the wholly unremarkable one — a recognised production host behind
  // a corporate proxy is the case this exists for, and it is the case that used
  // to render as an unqualified `[ ok ]`. A pass that says "the credentials go
  // to api.tastyworks.com" while an appliance in the middle reads them is the
  // one claim this report must never make.
  if (credentialTarget.channelNotes.length > 0) {
    status = status === "pass" ? "warn" : status;
    details.push(...credentialTarget.channelNotes);
  }
  // Printed, and promoting NOTHING. See CredentialChannel.informationalNotes:
  // these are the sentences that are true and conditional, and the condition is
  // one this process cannot observe.
  details.push(...credentialTarget.channelInformationalNotes);
  // The standing scope sentence, on EVERY run including the clean one. The
  // doctor reads the same `env` the server does and CANNOT read the server's
  // `args`, so a channel-clean report is a statement about this process and not
  // about the server. A report that names its own blind spot is not evidence of
  // a clean channel; a silent one is not evidence of anything, and this check
  // names its own.
  details.push(
    "Scope: this checks the environment THIS process can see. No process can " +
      "read another process's command line, so a flag in the server's `args` " +
      "array — --use-openssl-ca in particular — is invisible here. The server " +
      "reports its own on startup, and it asks the runtime rather than only " +
      "parsing, so its banner is authoritative for every spelling.",
  );
  if (warnings.length > 0) {
    status = status === "pass" ? "warn" : status;
    details.push(...warnings);
  }
  details.push(...closing);

  return {
    apiUrl,
    display,
    credentialTarget,
    target: { host: parsed.hostname, port, secure },
    classification,
    check: {
      ...base,
      status,
      summary,
      details,
      data: {
        ...targetData,
        configured: Boolean(configured),
        host: shownHost,
        port,
        environment: classification.environment,
        production: classification.environment === "production",
        warnings,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Checks 3 and 4 — DNS, then TCP/TLS
// ---------------------------------------------------------------------------

/** Error `code` values that mean "this name does not resolve". */
const NXDOMAIN_CODES = new Set(["ENOTFOUND", "EAI_NONAME", "NXDOMAIN"]);

/**
 * The target host as this report prints it, plus a rewriter for text produced
 * elsewhere that quotes it.
 *
 * Checks 3 and 4 name the host in a summary, in a detail and in `data`, and the
 * OS quotes it back a fourth time inside `getaddrinfo ENOTFOUND <host>`. All
 * four are the same operator-supplied string, and WHATWG URL will happily parse
 * a multi-megabyte one — so the cap has to reach the error text too, or the
 * report stays unreadable for the value that motivated capping it. `inText`
 * substitutes rather than truncating the whole message, so a genuinely useful
 * TLS or DNS error is never cut short: for every host of a sane length it is
 * the identity function and nothing changes.
 */
function hostForMessages(host: string): {
  shown: string;
  inText: (text: string) => string;
} {
  const shown = clipHostForMessage(host);
  return {
    shown,
    inText: (text) => (shown === host ? text : text.split(host).join(shown)),
  };
}

export async function inspectDns(
  deps: DoctorDeps,
  target: ConnectionTarget,
  classification: HostClassification | undefined,
  redact: (text: string) => string,
): Promise<CheckResult> {
  const base = { id: "dns", title: "DNS resolution" };
  const host = hostForMessages(target.host);
  let addresses: string[];
  try {
    addresses = await deps.lookupHost(target.host);
  } catch (err) {
    const code = errorCode(err);
    const details = [
      `Lookup of ${host.shown} failed${code ? ` (${code})` : ""}: ${host.inText(redact(errorMessage(err)))}`,
    ];
    if (!code || NXDOMAIN_CODES.has(code)) {
      details.push(
        "The hostname does not exist in DNS. Nothing this server does can reach it.",
      );
      details.push(classification?.note ?? SWAPPED_DOMAIN_NOTE);
    }
    return {
      ...base,
      status: "fail",
      summary: `${host.shown} does not resolve`,
      details,
      data: { host: host.shown, resolved: false, code },
    };
  }

  if (addresses.length === 0) {
    return {
      ...base,
      status: "fail",
      summary: `${host.shown} resolved to no addresses`,
      details: [
        "The lookup succeeded but returned an empty answer, so there is nothing to connect to.",
        classification?.note ?? SWAPPED_DOMAIN_NOTE,
      ],
      data: { host: host.shown, resolved: false, addresses },
    };
  }

  return {
    ...base,
    status: "pass",
    summary: `${host.shown} resolves`,
    details: [`Addresses: ${addresses.join(", ")}`],
    data: { host: host.shown, resolved: true, addresses },
  };
}

/**
 * Check 4's result, and — separately — whether there is anything there.
 *
 * They answer different questions and one gates three other checks. `status` is a
 * judgement about what was found, and is `warn` for a session that completed but
 * that the credentials will not cross. `reachable` is the fact the grant depends
 * on, and must not be derived from the first: deriving it from `tcp.status ===
 * "pass"` means adding the proxy caveat silently skips the grant, the scope and the
 * accounts fetch on every proxied machine, under the false reason "the API host is
 * not reachable" when the probe had resolved and connected — returning ok=true and
 * exit 0 for a configuration whose credentials were never tested.
 */
export interface ConnectivityOutcome {
  check: CheckResult;
  /** The port answered. Says nothing about what the session is worth. */
  reachable: boolean;
}

export async function inspectConnectivity(
  deps: DoctorDeps,
  target: ConnectionTarget,
  redact: (text: string) => string,
): Promise<ConnectivityOutcome> {
  const base = {
    id: "connectivity",
    title: target.secure ? "TCP/TLS reachability" : "TCP reachability",
  };
  const host = hostForMessages(target.host);
  // `probeConnectionForReal` calls tls.connect on the host directly: it does
  // not read the proxy variables and does not CONNECT-tunnel. With a proxy
  // configured, this check therefore describes a session the credentials never
  // cross — it certifies a certificate the grant will not see. Teaching the
  // probe to tunnel is the better fix and a larger one; until then it says what
  // it did, because a report that quietly measures the wrong thing is worse
  // than one that measures nothing.
  const channel = inspectCredentialChannel(
    target.secure ? "https:" : "http:",
    deps.env,
  );
  const directCaveat = channel.proxied
    ? [
        `This probe connected to the host directly. ${channel.proxyVariable} is set, so the ` +
          "credential-bearing request goes through that proxy instead and the result here does " +
          "not describe the session it crosses.",
      ]
    : [];
  try {
    const detail = await deps.probeConnection(target);
    // A handshake that completed without verifying the certificate is not a
    // finding to bury in a detail line under `[ ok ]`. It happens when the
    // environment disables verification — the corporate TLS-inspecting-proxy
    // case, which is exactly the population that also needs
    // TASTYTRADE_ALLOW_UNKNOWN_API_HOST — and the credentials cross that
    // session. Reported as a warning rather than a failure because the
    // connection genuinely works and the operator may have chosen this.
    const unverified = target.secure && detail.includes(UNVERIFIED_CERT_MARKER);
    return {
      reachable: true,
      check: {
        ...base,
        status: unverified || channel.proxied ? "warn" : "pass",
        summary: unverified
          ? `${host.shown}:${target.port} answers, but its TLS certificate was NOT verified`
          : `${host.shown}:${target.port} answers`,
        details: unverified
          ? [
              detail,
              "Certificate verification is switched off in this environment (NODE_TLS_REJECT_UNAUTHORIZED=0 " +
                "or an equivalent), so the handshake proves the port answers, not that it belongs to the host " +
                "it claims to be — and the refresh token and client secret cross that session. Unset it, or " +
                "point NODE_EXTRA_CA_CERTS at the CA of whatever terminates TLS — the endpoint check names " +
                "that variable too, so the trust stays visible instead of becoming silent.",
              ...directCaveat,
            ]
          : [detail, ...directCaveat],
        data: {
          host: host.shown,
          port: target.port,
          reachable: true,
          certificate_verified: target.secure ? !unverified : undefined,
          // Present only when it carries information: a proxy is configured and
          // this measurement went around it.
          probed_directly: channel.proxied ? true : undefined,
        },
      },
    };
  } catch (err) {
    const code = errorCode(err);
    return {
      reachable: false,
      check: {
        ...base,
        status: "fail",
        summary: `cannot reach ${host.shown}:${target.port}`,
        details: [
          // BOUNDED AT THE OPERAND. On the hostname branch node:tls interpolates
          // `cert.subjectaltname` into the message VERBATIM — an X.509 field the peer wrote,
          // and a certificate may carry hundreds of SAN entries. Measured: one certificate
          // with 800 DNS entries put 104,954 characters into a report whose healthy baseline
          // is 3,061.
          //
          // Neither transform already here bounds it: `redact` substitutes credential
          // literals and a SAN is not a credential, and `host.inText` is the identity
          // function whenever the operator's own hostname is under its cap.
          //
          // Bounded HERE and not only at the renderers, because the renderers bound a LINE:
          // any other consumer of this CheckResult — and `--json` reads `data` too — sees
          // whatever the operand holds.
          `${code ? `${code}: ` : ""}${upstreamText(host.inText(redact(errorMessage(err))))}`,
          "A proxy, a firewall or an outbound TLS-inspecting appliance is the usual cause when DNS resolves but the port does not answer.",
          ...directCaveat,
        ],
        data: {
          host: host.shown,
          port: target.port,
          reachable: false,
          code,
          probed_directly: channel.proxied ? true : undefined,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Check 5 — refresh-token claims, decoded offline and cross-checked
// ---------------------------------------------------------------------------

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Decode a JWT's header and payload. NO SIGNATURE VERIFICATION — this is
 * deliberate and it is safe here: the claims are used only to describe the
 * operator's own configuration back to them, never to authorise anything. The
 * authority on whether the token is good is the token endpoint, in check 6.
 *
 * Returns undefined for anything that is not a three-segment JWT with two
 * base64url-encoded JSON objects, which is how an opaque token reads.
 */
export function decodeJwt(token: string): JwtParts | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const [rawHeader, rawPayload] = segments;
  const header = decodeJwtSegment(rawHeader);
  const payload = decodeJwtSegment(rawPayload);
  if (!header || !payload) return undefined;
  return { header, payload };
}

function decodeJwtSegment(
  segment: string,
): Record<string, unknown> | undefined {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const json = Buffer.from(segment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** `aud` may be a string or an array of strings (RFC 7519 §4.1.3). */
function audienceList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

/** `scope` may be space-delimited (OAuth) or an array (some providers). */
export function parseScopeList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter((s) => s !== "");
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * The widest instant a JS `Date` can represent: +/-8.64e15 ms (ECMA-262).
 * `new Date(ms).toISOString()` throws `RangeError` outside it.
 */
const MAX_REPRESENTABLE_DATE_MS = 8.64e15;

/** Seconds-since-epoch claim → ISO string plus a human age, or undefined. */
function describeEpochClaim(
  value: unknown,
  nowMs: number,
): { iso: string; relative: string; ms: number } | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const ms = value * 1000;
  // The SAME shape as the access-token lifetime one module away: a finiteness
  // gate on the operand, a multiplication, and no re-check of the product. Here
  // the consequence is a thrown `RangeError` from the `new Date(ms)` below — the
  // diagnostic crashing on the very token it was asked to explain — for any
  // `exp` beyond about 2.7e11 seconds. A claim outside `Date`'s range is not a
  // date, so the honest answer is to say nothing about it. The claim itself is
  // still reported as unreadable by the caller, exactly as a non-numeric one is.
  if (Math.abs(ms) > MAX_REPRESENTABLE_DATE_MS) return undefined;
  const deltaMs = nowMs - ms;
  const days = Math.abs(deltaMs) / 86_400_000;
  const magnitude =
    days >= 1
      ? `${days.toFixed(1)} days`
      : `${Math.max(0, Math.round(Math.abs(deltaMs) / 60_000))} minutes`;
  return {
    ms,
    iso: new Date(ms).toISOString(),
    relative: deltaMs >= 0 ? `${magnitude} ago` : `in ${magnitude}`,
  };
}

/**
 * The offline half of the diagnosis. Everything here is computed from the token
 * the operator already holds plus the URL they configured, so it works with no
 * network, no credentials that resolve, and no vendor cooperation.
 */
export function inspectRefreshTokenClaims(
  deps: DoctorDeps,
  creds: CredentialState,
  endpoint: EndpointState,
): CheckResult {
  const base = { id: "refresh-token-claims", title: "Refresh-token claims" };
  const raw = creds.refreshToken?.trim();
  if (!raw) {
    return {
      ...base,
      status: "skip",
      summary: "no TASTYTRADE_REFRESH_TOKEN to inspect",
      details: [],
    };
  }

  const jwt = decodeJwt(raw);
  if (!jwt) {
    return {
      ...base,
      status: "pass",
      summary: "opaque refresh token — no claims to read",
      details: [
        "The value is not a JWT, so nothing can be cross-checked offline. Not reported as a fault, because the token endpoint is the authority and check 6 asks it directly.",
        "Worth a second look all the same: tastytrade issues JWT refresh tokens today and its token endpoint answers `Invalid JWT` for anything else, so an opaque value here is often not a refresh token at all.",
      ],
      data: { jwt: false },
    };
  }

  const details: string[] = [];
  const problems: Array<{ status: "warn" | "fail"; message: string }> = [];
  const typ = typeof jwt.header.typ === "string" ? jwt.header.typ : undefined;
  const iss = typeof jwt.payload.iss === "string" ? jwt.payload.iss : undefined;
  const aud = audienceList(jwt.payload.aud);
  const scopes = parseScopeList(jwt.payload.scope);
  const nowMs = deps.now();
  const issued = describeEpochClaim(jwt.payload.iat, nowMs);
  const expires = describeEpochClaim(jwt.payload.exp, nowMs);

  details.push(`typ:   ${typ ?? "(absent)"}`);
  details.push(`iss:   ${iss ?? "(absent)"}`);
  // `aud` is the OAuth client identifier, not a secret — see the file header
  // for why printing it is the point of this check.
  details.push(`aud:   ${aud.length > 0 ? aud.join(", ") : "(absent)"}`);
  details.push(`scope: ${scopes.length > 0 ? scopes.join(" ") : "(absent)"}`);
  details.push(
    `iat:   ${issued ? `${issued.iso} (${issued.relative})` : "(absent)"}`,
  );
  if (expires) details.push(`exp:   ${expires.iso} (${expires.relative})`);

  // --- typ: is this even a refresh token? ---
  if (typ && /^at\+/i.test(typ)) {
    problems.push({
      status: "fail",
      message: `The token's header says typ=${typ} — that is an ACCESS token, not a refresh token. Access tokens live ~15 minutes and cannot be exchanged.`,
    });
  }

  // --- exp: already dead? ---
  if (expires && expires.ms <= nowMs) {
    problems.push({
      status: "fail",
      message: `The refresh token expired at ${expires.iso}. Mint a new one at my.tastytrade.com > Manage > My Profile > API.`,
    });
  }

  // --- aud vs TASTYTRADE_CLIENT_ID ---
  const clientId = creds.clientId?.trim();
  if (aud.length === 0) {
    details.push(
      "No `aud` claim, so the token cannot be matched to a client id offline.",
    );
  } else if (!clientId) {
    details.push(
      "TASTYTRADE_CLIENT_ID is unset, so there is nothing to match `aud` against.",
    );
  } else if (aud.includes(clientId)) {
    details.push("`aud` matches TASTYTRADE_CLIENT_ID.");
  } else {
    problems.push({
      status: "fail",
      message:
        "The token's `aud` claim does not match TASTYTRADE_CLIENT_ID " +
        `(configured value is ${clientId.length} characters). A refresh token's audience IS ` +
        "the client id it was issued to, so the two belong to different OAuth applications — " +
        "or what was pasted into TASTYTRADE_CLIENT_ID is not a client id at all. The `aud` " +
        "printed above is the client id this token will authenticate as.",
    });
  }

  // --- iss vs TASTYTRADE_API_URL ---
  if (iss) {
    const issHost = hostOf(iss);
    if (!issHost) {
      details.push(
        `The \`iss\` claim is not a URL, so its host cannot be compared.`,
      );
    } else if (!endpoint.target) {
      details.push(
        "TASTYTRADE_API_URL did not parse, so `iss` cannot be compared against it.",
      );
    } else if (
      // normaliseHostname on both sides, like every other host comparison in
      // the tree: an `iss` of `https://api.tastyworks.com` against a
      // TASTYTRADE_API_URL of `https://api.tastyworks.com.` is a match, and
      // reporting it as a twin-domain mismatch would send the operator hunting
      // for a fault that is a trailing dot.
      normaliseHostname(issHost) === normaliseHostname(endpoint.target.host)
    ) {
      details.push("`iss` host matches TASTYTRADE_API_URL.");
    } else {
      const issClass = classifyApiHost(issHost);
      const apiClass =
        endpoint.classification ?? classifyApiHost(endpoint.target.host);
      // Both halves of this sentence are operator-supplied — one from
      // TASTYTRADE_API_URL, one from a claim inside their own refresh token —
      // so both are bounded before they are quoted, exactly as check 2 bounds
      // the host it prints.
      const shownIss = clipHostForMessage(issHost);
      const shownApi = clipHostForMessage(endpoint.target.host);
      const bothKnown =
        (issClass.environment === "production" ||
          issClass.environment === "sandbox") &&
        (apiClass.environment === "production" ||
          apiClass.environment === "sandbox");
      if (bothKnown && issClass.environment !== apiClass.environment) {
        problems.push({
          status: "fail",
          message:
            `The token was issued by ${shownIss} (${issClass.environment}) but ` +
            `TASTYTRADE_API_URL points at ${shownApi} (${apiClass.environment}). ` +
            "Sandbox credentials never work against production, or the reverse.",
        });
      } else {
        problems.push({
          status: "warn",
          message:
            `The token's issuer host (${shownIss}) is not the host being called ` +
            `(${shownApi}). That can be legitimate — an issuer may name a ` +
            "vendor-internal alias that does not resolve publicly — but it is also how " +
            "the twin-domain mistake looks. " +
            SWAPPED_DOMAIN_NOTE,
        });
      }
    }
  }

  details.push(...problems.map((p) => p.message));
  const status: CheckStatus = problems.some((p) => p.status === "fail")
    ? "fail"
    : problems.length > 0
      ? "warn"
      : "pass";
  const summary =
    status === "pass"
      ? "claims decode and agree with the configured client id and endpoint"
      : status === "warn"
        ? "claims decode, with one thing worth checking"
        : "the claims contradict the configuration";

  return {
    ...base,
    status,
    summary,
    details,
    data: {
      jwt: true,
      typ,
      iss,
      aud,
      scope: scopes,
      issued_at: issued?.iso,
      expires_at: expires?.iso,
      aud_matches_client_id:
        aud.length > 0 && clientId !== undefined && aud.includes(clientId),
    },
  };
}

/** The host of a URL-shaped string, or undefined when it is not one. */
function hostOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Check 6 — one live refresh_token grant
// ---------------------------------------------------------------------------

interface GrantOutcome {
  check: CheckResult;
  accessToken?: string;
  /** Scopes the endpoint says the access token carries. */
  scopes?: string[];
  /** True when the endpoint answered at all (so `scope` reporting is possible). */
  answered: boolean;
}

/**
 * The one check in this command that transmits the credentials.
 *
 * ## The guard is here, at the egress point
 *
 * `runDoctor` already skips this check when check 2 refused the destination, but
 * the refusal is re-derived HERE as well, from `inspectCredentialTarget`, before
 * anything is sent. Ordering in a caller is not a control: this function is
 * exported, and anything that can call it can POST a long-lived refresh token
 * and a client secret to an operator-supplied host. The rule that stops that has
 * to sit in the function that does the sending. `inspectCredentialTarget` is
 * pure, so asking it twice costs nothing and the two answers cannot disagree.
 */
export async function inspectTokenGrant(
  deps: DoctorDeps,
  endpoint: EndpointState,
  creds: CredentialState,
  redact: (text: string) => string,
): Promise<GrantOutcome> {
  const base = { id: "token-grant", title: "Refresh-token grant" };
  const decision = inspectCredentialTarget(endpoint.apiUrl, deps.env);
  if (!decision.allowed) {
    return {
      answered: false,
      check: {
        ...base,
        status: "skip",
        summary: "not attempted — the endpoint may not receive the credentials",
        details: [
          decision.refusal ??
            "This endpoint may not receive the OAuth credentials.",
          "Nothing was sent: no refresh token, no client secret, no request. Fix the endpoint (check 2) and run this again.",
        ],
        data: { sent: false, refused: true },
      },
    };
  }
  // The request is made against the raw configured URL, exactly as the server
  // does; only the printed form has userinfo stripped.
  const url = `${endpoint.apiUrl}/oauth/token`;
  const shown = `${endpoint.display}/oauth/token`;

  let status: number;
  let data: unknown;
  try {
    // Deliberately identical to what src/oauth-client.ts sends — same URL
    // construction, same JSON body, same single header. A doctor that decorates
    // the request differently could pass where the server fails. Identical in
    // the precondition too, which is the part that was missing: oauth-client.ts
    // is only ever reached after the server has cleared the destination, and now
    // so is this.
    const response = await axios.post(
      url,
      {
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      },
      {
        headers: { "Content-Type": "application/json" },
        // Part of "deliberately identical" too: axios defaults both size keys to
        // -1 (unlimited) and buffers the whole body before anything can inspect
        // it, so an oversized reply to THIS request would abort the preflight
        // the same way it aborted the server. Spread from the module that owns
        // the server's transport safety values, so the two cannot drift.
        ...httpTransportLimits(),
        signal: httpWallClockSignal(resolveHttpWallClockMs()),
        timeout: HTTP_TIMEOUT_MS,
        // Part of "deliberately identical", and the part that matters most: the
        // body below holds the refresh token and the client secret, and axios
        // would otherwise follow up to 21 redirects, preserving both method and
        // body on a 307 or 308. The endpoint check above vets only the first
        // hop, so without this a preflight run could hand both credentials to a
        // redirect target and still print PREFLIGHT PASSED. A 3xx is reported
        // as a failure by the non-2xx branch below.
        maxRedirects: 0,
        // Read the 4xx body instead of throwing: `error_description` is the
        // single most useful line this command can print.
        validateStatus: () => true,
        ...(deps.adapter ? { adapter: deps.adapter } : {}),
      },
    );
    status = response.status;
    data = response.data;
  } catch (err) {
    const code = errorCode(err);
    return {
      answered: false,
      check: {
        ...base,
        status: "fail",
        summary: "the token endpoint could not be reached",
        details: [
          `POST ${shown}`,
          `${code ? `${code}: ` : ""}${redact(errorMessage(err))}`,
        ],
        data: { url: shown, reached: false, code },
      },
    };
  }

  const body = (data ?? {}) as Record<string, unknown>;

  if (status < 200 || status >= 300) {
    const error = typeof body.error === "string" ? body.error : undefined;
    const description =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.message === "string"
          ? body.message
          : undefined;
    // Verbatim, redacted only for credential material. "Client secret mismatch"
    // is the whole diagnosis; paraphrasing it loses the diagnosis.
    const verbatim = [error, description]
      .filter((v): v is string => typeof v === "string" && v !== "")
      .map(redact)
      .map(upstreamText)
      .join(": ");
    const details = [`POST ${shown}`, `HTTP ${status}`];
    if (verbatim) details.push(`The endpoint said: ${verbatim}`);
    else
      details.push(
        "The endpoint returned no `error_description` to quote; the body was empty or unrecognised.",
      );
    details.push(
      status === 400 || status === 401
        ? "All three of TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN must belong to the same OAuth application and to the environment TASTYTRADE_API_URL names."
        : status >= 300 && status < 400
          ? "A redirect, not a rejection: nothing was validated, and the refresh token and client secret were NOT forwarded to the redirect target. A token endpoint has no legitimate reason to redirect, so this usually means TASTYTRADE_API_URL names a proxy or a login portal rather than the API. The server refuses this too, identically."
          : "Retry once; a 5xx here is the token endpoint itself failing.",
    );
    return {
      answered: true,
      check: {
        ...base,
        status: "fail",
        summary: `the grant was rejected with HTTP ${status}${verbatim ? ` (${verbatim})` : ""}`,
        details,
        data: {
          url: shown,
          http_status: status,
          // Redacted here too, not only in the rendered lines: `--json` is a
          // scripting interface that gets piped into logs, and an endpoint that
          // echoes a credential back inside its own error text would otherwise
          // leak it there while the human report stayed clean.
          error: error === undefined ? undefined : upstreamText(redact(error)),
          error_description:
            description === undefined
              ? undefined
              : upstreamText(redact(description)),
        },
      },
    };
  }

  const accessToken =
    typeof body.access_token === "string" ? body.access_token : undefined;
  if (!accessToken) {
    return {
      answered: true,
      check: {
        ...base,
        status: "fail",
        summary: `HTTP ${status} with no access_token in the body`,
        details: [
          `POST ${shown}`,
          "The endpoint accepted the grant but returned nothing usable. Confirm TASTYTRADE_API_URL points at a tastytrade API host.",
        ],
        data: { url: shown, http_status: status, access_token: false },
      },
    };
  }

  const expiresIn =
    typeof body.expires_in === "number" ? body.expires_in : undefined;
  const scopes = parseScopeList(body.scope);
  return {
    answered: true,
    accessToken,
    scopes,
    check: {
      ...base,
      status: "pass",
      summary: "the endpoint minted an access token",
      details: [
        `POST ${shown} -> HTTP ${status}`,
        // Length only; the token itself is never printed.
        `Access token received (${accessToken.length} characters)` +
          (expiresIn !== undefined ? `, expires in ${expiresIn}s` : ""),
      ],
      data: {
        url: shown,
        http_status: status,
        expires_in: expiresIn,
        token_length: accessToken.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Check 7a — the scope the access token actually carries
// ---------------------------------------------------------------------------

export function inspectTokenScope(
  scopes: string[] | undefined,
  readOnly: ReadOnlyState,
): CheckResult {
  const base = { id: "token-scope", title: "Access-token scope" };
  if (!scopes) {
    return {
      ...base,
      status: "skip",
      summary: "no access token was minted",
      details: [],
    };
  }
  const hasTrade = scopes.includes("trade");
  const details = [
    `Scopes: ${scopes.length > 0 ? upstreamText(scopes.join(" ")) : "(the endpoint returned none)"}`,
  ];

  if (scopes.length === 0) {
    return {
      ...base,
      status: "warn",
      summary: "the token endpoint reported no scope",
      details: [
        ...details,
        "Without a scope list the doctor cannot tell whether order entry is permitted. The tools will find out on the first call.",
      ],
      data: { scopes, trade: false, reported: false },
    };
  }

  if (hasTrade && readOnly.enabled) {
    details.push(
      `The token permits order entry, but ${READ_ONLY_ENV_VAR} withholds every write and destructive tool anyway.`,
    );
  }
  if (!hasTrade) {
    details.push(
      readOnly.enabled
        ? `The token cannot place orders. That matches ${READ_ONLY_ENV_VAR}, so nothing is affected.`
        : "The token has no `trade` scope, so all 14 write and destructive tools will fail at the broker even though this server offers them. Reads are unaffected.",
    );
  }

  const status: CheckStatus = !hasTrade && !readOnly.enabled ? "warn" : "pass";
  return {
    ...base,
    status,
    summary: hasTrade
      ? "includes `trade` — order entry is permitted"
      : "does not include `trade` — reads only",
    details,
    data: { scopes, trade: hasTrade, reported: true },
  };
}

// ---------------------------------------------------------------------------
// Check 7b — the accounts the credentials can actually see
// ---------------------------------------------------------------------------

export async function inspectAccounts(
  deps: DoctorDeps,
  endpoint: EndpointState,
  accessToken: string | undefined,
  redact: (text: string) => string,
  reveal = false,
): Promise<CheckResult> {
  const base = { id: "accounts", title: "Reachable accounts" };
  // Same reasoning as inspectTokenGrant: the guard sits in the function that
  // constructs a credential-bearing client, not in its caller. A bearer token
  // minted for one host must not be handed to another.
  const decision = inspectCredentialTarget(endpoint.apiUrl, deps.env);
  if (!decision.allowed) {
    return {
      ...base,
      status: "skip",
      summary: "not attempted — the endpoint may not receive the credentials",
      details: [
        decision.refusal ??
          "This endpoint may not receive the OAuth credentials.",
        "No request was made and no access token was sent.",
      ],
      data: { fetched: false, refused: true },
    };
  }
  if (!accessToken) {
    return {
      ...base,
      status: "skip",
      summary: "no access token was minted",
      details: [],
    };
  }

  // The REAL client, so this exercises the production request path: the
  // required User-Agent, the date-stamped Accept-Version, the bearer header and
  // the `{data:{items:[…]}}` unwrapping. Only the transport is replaceable.
  const client = new TastytradeClient(
    { apiUrl: endpoint.apiUrl },
    {
      tokenProvider: () => accessToken,
      ...(deps.adapter ? { adapter: deps.adapter } : {}),
    },
  );

  let items: unknown;
  try {
    items = await client.getAccounts();
  } catch (err) {
    const status = httpStatus(err);
    return {
      ...base,
      status: "fail",
      summary: "the account list could not be fetched",
      details: [
        // Userinfo-stripped: this line is printed, not requested.
        `GET ${endpoint.display}/customers/me/accounts`,
        `${status !== undefined ? `HTTP ${status}: ` : ""}${redact(errorMessage(err))}`,
        "The grant succeeded, so this is not a credential fault — the token is probably missing the `read` scope, or the customer has no API entitlement in this environment.",
      ],
      data: { fetched: false, http_status: status },
    };
  }

  const accounts = Array.isArray(items) ? items : [];
  if (accounts.length === 0) {
    return {
      ...base,
      status: "warn",
      summary: "no accounts are visible to these credentials",
      details: [
        "The request succeeded and returned an empty list. Every account-scoped tool will report `not_found`.",
        "In the sandbox, an account must be created for the sandbox user before it appears here.",
      ],
      data: { fetched: true, count: 0, redacted: !reveal, accounts: [] },
    };
  }

  const described = accounts.map((entry) => describeAccount(entry, reveal));
  const details = described.map((a) => a.line);
  if (reveal) {
    // The caution belongs on THIS branch, and first.
    //
    // On the masked branch alone it lands wrong: the output that is safe to paste
    // would say "do not paste this" while the output that names a real brokerage
    // account, and routinely a real person, says nothing. The realistic path to harm
    // is a maintainer saying "run it with --show-accounts and paste the result", so the
    // warning travels WITH the identifying text, ahead of it, where a truncated paste
    // still carries it.
    details.unshift(
      `Account numbers and nicknames below are UN-MASKED because ${SHOW_ACCOUNTS_FLAG} was passed. ` +
        "This output identifies you and the accounts you can trade: do not paste it into an issue, " +
        "a chat or a screenshot. Re-run without the flag for a shareable report.",
    );
  } else {
    details.push(
      `Account numbers are masked and nicknames withheld. Re-run with ${SHOW_ACCOUNTS_FLAG} to print them in full — that output identifies you, so do not paste it in public.`,
    );
  }
  // The enumeration is capped; the TOTAL is not. `count` stays the real number,
  // so an operator is never told there are fewer accounts than there are — only
  // that this report stopped listing them, and by how many.
  const enumerated = described.slice(0, MAX_DETAILS_PER_CHECK);
  const omitted = described.length - enumerated.length;
  return {
    ...base,
    status: "pass",
    summary: `${accounts.length} account${accounts.length === 1 ? "" : "s"} reachable`,
    details,
    data: {
      fetched: true,
      count: accounts.length,
      redacted: !reveal,
      accounts: enumerated.map((a) => a.data),
      ...(omitted > 0 ? { accounts_omitted: omitted } : {}),
    },
  };
}

/**
 * Mask a brokerage account number down to its last four characters.
 *
 * Four characters is enough for the operator to recognise which of their own
 * accounts a line refers to, and not enough for a reader of a pasted report to
 * name one. Anything four characters or shorter is masked whole rather than
 * printed as itself.
 */
export function maskAccountNumber(value: string): string {
  const tail = value.slice(-4);
  return tail.length < value.length ? `****${tail}` : "****";
}

/**
 * One line per account. The account list is wrapped as
 * `{account: {...}, authority-level: ...}` per customer-account payload, but a
 * flat account object is accepted too — this is diagnostics, not a schema gate.
 *
 * `reveal` is off by default and that default is load-bearing. This report is
 * written to be pasted into a bug report, and the repository's own issue
 * template requires the reporter to strip account numbers first. What the
 * diagnosis actually needs from this check is "how many accounts answer, and
 * are any of them closed" — every bit of that survives masking. The full
 * number and the nickname (which routinely carries a real person's name) are
 * available behind the flag, for an operator reading their own terminal.
 */
function describeAccount(
  entry: unknown,
  reveal: boolean,
): {
  line: string;
  data: Record<string, unknown>;
} {
  const outer = (entry ?? {}) as Record<string, unknown>;
  const inner = (
    typeof outer.account === "object" && outer.account !== null
      ? outer.account
      : outer
  ) as Record<string, unknown>;
  const rawNumber = str(inner["account-number"]);
  const number =
    rawNumber === undefined
      ? "(no account-number)"
      : reveal
        ? rawNumber
        : maskAccountNumber(rawNumber);
  // Every one of these is a field of the ACCOUNTS PAYLOAD, so every one is
  // network text. The masking below covers the account NUMBER and nothing else,
  // which is why an operator could be shown a "[Cash, Individual]" line for a
  // margin account: `margin-or-cash` and `account-type-name` were rendered
  // verbatim, and neither needs --show-accounts to appear.
  const nickname = reveal ? bounded(str(inner.nickname)) : undefined;
  const type = bounded(str(inner["account-type-name"]));
  const margin = inner["margin-or-cash"];
  const closed = inner["is-closed"] === true;
  const flags = [
    typeof margin === "string" ? upstreamText(margin) : undefined,
    type,
    closed ? "CLOSED" : undefined,
  ].filter((v): v is string => Boolean(v));
  return {
    line: `${number.padEnd(12)} ${nickname ? `"${nickname}" ` : ""}${flags.length > 0 ? `[${flags.join(", ")}]` : ""}`.trimEnd(),
    data: {
      account_number: number,
      nickname,
      margin_or_cash:
        typeof margin === "string" ? upstreamText(margin) : undefined,
      account_type: type,
      is_closed: closed,
    },
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Check 8 — the effective safety configuration
// ---------------------------------------------------------------------------

export interface ReadOnlyState {
  enabled: boolean;
  /** True when the variable held a value this server does not understand. */
  unrecognised: boolean;
  raw?: string;
}

/**
 * Mirrors isReadOnlyModeEnabled() in the dispatcher, including its fail-closed
 * rule: a value that is set but unrecognised ENABLES read-only mode. Unlike the
 * dispatcher this prints nothing — the doctor reports, it does not warn on
 * stderr.
 */
export function classifyReadOnly(env: NodeJS.ProcessEnv): ReadOnlyState {
  const raw = env[READ_ONLY_ENV_VAR];
  if (typeof raw !== "string") return { enabled: false, unrecognised: false };
  const v = raw.trim().toLowerCase();
  if (READ_ONLY_TRUTHY.has(v))
    return { enabled: true, unrecognised: false, raw };
  if (READ_ONLY_FALSY.has(v))
    return { enabled: false, unrecognised: false, raw };
  return { enabled: true, unrecognised: true, raw };
}

export function inspectReadOnly(state: ReadOnlyState): CheckResult {
  const base = { id: "read-only-mode", title: "Read-only mode" };
  if (state.unrecognised) {
    return {
      ...base,
      status: "warn",
      summary: "ENABLED because the configured value is not understood",
      details: [
        `${READ_ONLY_ENV_VAR}=${JSON.stringify(state.raw)} is not a recognised value.`,
        "Recognised: 1 / true (enable), 0 / false / empty (disable).",
        "The server fails closed here: every write and destructive tool is withheld and refused.",
      ],
      data: { enabled: true, unrecognised: true },
    };
  }
  return {
    ...base,
    status: "pass",
    summary: state.enabled
      ? "ENABLED — all 14 write and destructive tools are withheld"
      : "disabled — write and destructive tools are live",
    details: state.enabled
      ? [`${READ_ONLY_ENV_VAR}=${JSON.stringify(state.raw)}`]
      : [
          `${READ_ONLY_ENV_VAR} is ${state.raw === undefined ? "unset" : JSON.stringify(state.raw)}. Set it to 1 to withhold every money-moving tool.`,
        ],
    data: { enabled: state.enabled, unrecognised: false },
  };
}

/**
 * Mirrors resolveNotionalCap() in src/safety/sanity-checks.ts, which is private
 * to that module. The DEFAULT is imported rather than copied, so the number
 * cannot drift; the parsing rule is duplicated and pinned by a test.
 */
export function inspectNotionalCap(env: NodeJS.ProcessEnv): CheckResult {
  const base = { id: "notional-cap", title: "Notional cap" };
  const raw = env.MAX_ORDER_NOTIONAL_USD;
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

  if (raw === undefined) {
    return {
      ...base,
      status: "pass",
      summary: `${usd(DEFAULT_MAX_ORDER_NOTIONAL_USD)} (documented default)`,
      details: [
        "MAX_ORDER_NOTIONAL_USD is unset. Any order whose buying-power effect exceeds the cap is refused before it is sent.",
      ],
      data: { limit: DEFAULT_MAX_ORDER_NOTIONAL_USD, source: "default" },
    };
  }

  const parsed = Number(raw.trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return {
      ...base,
      status: "pass",
      summary: `${usd(parsed)} (from MAX_ORDER_NOTIONAL_USD)`,
      details: [],
      data: { limit: parsed, source: "env" },
    };
  }

  return {
    ...base,
    status: "warn",
    summary: `unusable value — falling back to ${usd(DEFAULT_MAX_ORDER_NOTIONAL_USD)}`,
    details: [
      `MAX_ORDER_NOTIONAL_USD=${JSON.stringify(raw)} is not a positive number of dollars.`,
      "The cap has NOT been disabled — there is no way to disable it. Write digits only, e.g. 50000.",
    ],
    data: {
      limit: DEFAULT_MAX_ORDER_NOTIONAL_USD,
      source: "fallback",
      configured: raw,
    },
  };
}

/**
 * The vendored docs are a RUNTIME dependency: the static resource modules read
 * them at module load, so a missing file means the server throws during import
 * and exits before serving one request. Checking them here turns that into a
 * named preflight failure instead of an opaque client disconnect.
 */
export function inspectVendoredDocs(deps: DoctorDeps): CheckResult {
  const base = { id: "vendored-docs", title: "Vendored documentation" };
  const root = abbreviateHome(DOCS_ROOT, deps.env);
  const missing = REQUIRED_DOCS.filter(
    (file) => !deps.fileExists(path.join(DOCS_ROOT, file)),
  );
  if (missing.length === 0) {
    return {
      ...base,
      status: "pass",
      summary: `all ${REQUIRED_DOCS.length} required documents are present`,
      details: [`Directory: ${root}`],
      data: { docs_root: root, missing: [] },
    };
  }
  return {
    ...base,
    status: "fail",
    summary: `${missing.length} required document${missing.length === 1 ? "" : "s"} missing`,
    details: [
      `Directory: ${root}`,
      `Missing: ${missing.join(", ")}`,
      "The server builds its static MCP resources from these at import time, so it will refuse to start. If you are running from a clone the directory is in the repository root; if you built an image or a tarball, confirm it was copied in.",
    ],
    data: { docs_root: root, missing },
  };
}

/**
 * Rewrite a leading home directory as `~`.
 *
 * The install path is genuinely useful when a vendored document is missing —
 * it says where to look — but printed raw it also publishes the operator's
 * login name and directory layout into a report meant to be shared. `~` keeps
 * every bit of the diagnostic value (a shell expands it back) and drops the
 * identity. Home comes from the injected environment, not from `os.homedir()`,
 * so the substitution is deterministic under test like everything else here.
 */
export function abbreviateHome(
  filePath: string,
  env: NodeJS.ProcessEnv,
): string {
  const raw = env.HOME ?? env.USERPROFILE;
  if (typeof raw !== "string") return filePath;
  const home = raw.endsWith(path.sep) ? raw.slice(0, -1) : raw;
  // A one-character home ("/") would swallow every absolute path.
  if (home.length < 2) return filePath;
  if (filePath === home) return "~";
  if (filePath.startsWith(`${home}${path.sep}`)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Error shape helpers (axios and node errors, without importing the taxonomy)
// ---------------------------------------------------------------------------

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && message !== ""
    ? message
    : String(err ?? "unknown error");
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response
    ?.status;
  return typeof status === "number" ? status : undefined;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A check that could not be attempted because something upstream failed. */
function skipped(id: string, title: string, reason: string): CheckResult {
  return { id, title, status: "skip", summary: reason, details: [] };
}

/**
 * Run every check, in dependency order, and assemble the report.
 *
 * Ordering rule: a check runs whenever its own inputs exist, even if an earlier
 * check failed. The claims check (5) in particular is deliberately NOT gated on
 * DNS or connectivity — when the host does not resolve, the decoded `iss` is
 * usually the reason, and reporting both together is what closes the case in one
 * pass instead of three.
 */
export async function runDoctor(
  deps: DoctorDeps,
  options: DoctorOptions = DEFAULT_DOCTOR_OPTIONS,
): Promise<DoctorReport> {
  const redact = makeRedactor(deps.env);
  const checks: CheckResult[] = [];

  const creds = inspectCredentials(deps.env);
  checks.push(creds.check);

  const endpoint = inspectApiUrl(deps.env);
  checks.push(endpoint.check);

  let reachable = false;
  if (!endpoint.target) {
    checks.push(
      skipped("dns", "DNS resolution", "TASTYTRADE_API_URL did not parse"),
      skipped(
        "connectivity",
        "TCP/TLS reachability",
        "TASTYTRADE_API_URL did not parse",
      ),
    );
  } else {
    const dns = await inspectDns(
      deps,
      endpoint.target,
      endpoint.classification,
      redact,
    );
    checks.push(dns);
    if (dns.status === "fail") {
      checks.push(
        skipped(
          "connectivity",
          "TCP/TLS reachability",
          `${clipHostForMessage(endpoint.target.host)} does not resolve`,
        ),
      );
    } else {
      const tcp = await inspectConnectivity(deps, endpoint.target, redact);
      checks.push(tcp.check);
      // The FACT, not the check's verdict. A `warn` here means the probe went
      // around a proxy or did not verify a certificate — both worth saying,
      // neither a reason to leave the credentials untested and call the run
      // green. See ConnectivityOutcome.
      reachable = tcp.reachable;
    }
  }

  checks.push(inspectRefreshTokenClaims(deps, creds, endpoint));

  const readOnly = classifyReadOnly(deps.env);

  let grant: GrantOutcome | undefined;
  if (!creds.complete) {
    checks.push(
      skipped(
        "token-grant",
        "Refresh-token grant",
        "the OAuth credentials are incomplete",
      ),
    );
  } else if (!endpoint.credentialTarget.allowed) {
    // Checked before reachability on purpose: "this host may not have the
    // credentials" is what the operator has to act on, and a refused host
    // that also happens to answer on port 443 is the dangerous case, not the
    // harmless one. inspectTokenGrant enforces the same rule itself; this is
    // what puts the reason in the report.
    checks.push(
      skipped(
        "token-grant",
        "Refresh-token grant",
        "the endpoint may not receive the credentials — see check 2",
      ),
    );
  } else if (!reachable) {
    checks.push(
      skipped(
        "token-grant",
        "Refresh-token grant",
        "the API host is not reachable",
      ),
    );
  } else {
    grant = await inspectTokenGrant(deps, endpoint, creds, redact);
    checks.push(grant.check);
  }

  checks.push(inspectTokenScope(grant?.scopes, readOnly));
  checks.push(
    await inspectAccounts(
      deps,
      endpoint,
      grant?.accessToken,
      redact,
      options.revealAccounts,
    ),
  );

  checks.push(inspectReadOnly(readOnly));
  checks.push(inspectNotionalCap(deps.env));
  checks.push(inspectVendoredDocs(deps));

  const failed = checks.find((c) => c.status === "fail");
  const verdict = deriveVerdict(checks);
  return {
    verdict,
    // Projections of `verdict`, both of them. The defect was that `ok` and
    // `exitCode` were each computed from the ABSENCE of one status, so neither
    // could see a warning; deriving them from the verdict means there is no
    // expression left that can conflate "not failed" with "verified".
    ok: verdict !== "failed",
    exitCode: exitCodeFor(verdict),
    failedCheck: failed?.id,
    version: PACKAGE_VERSION,
    checks,
  };
}

// ---------------------------------------------------------------------------
// Network operands
// ---------------------------------------------------------------------------

/**
 * Bound one NETWORK-supplied string before it is interpolated into a report line
 * or a `--json` field.
 *
 * THE OPERAND, NEVER THE COMPOSITE. Every site concatenates this into server prose
 * that IS the diagnosis — "the grant was rejected with HTTP 401 (…)" is useless
 * without the parenthesis and useless if the sentence around it has been clipped
 * away.
 *
 * `MAX_UPSTREAM_BODY_TEXT_CHARS` and not a doctor-specific figure: the same 200
 * characters for the same hazard, and a second constant with the same value and a
 * different name is the drift src/safety/bounded-text.ts exists to prevent.
 *
 * `collapseWhitespace` is TRUE here and false at the renderer: here the value is
 * prose, and collapsing the spaces a flattened newline leaves keeps it a fragment
 * of one line; there the line is an aligned table row.
 */
function upstreamText(value: string): string {
  return boundedText(value, {
    maxChars: MAX_UPSTREAM_BODY_TEXT_CHARS,
    collapseWhitespace: true,
  });
}

/** `upstreamText` for an optional value, which several payload fields are. */
function bounded(value: string | undefined): string | undefined {
  return value === undefined ? undefined : upstreamText(value);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_TOKENS: Record<CheckStatus, string> = {
  pass: "[ ok ]",
  warn: "[warn]",
  fail: "[FAIL]",
  skip: "[skip]",
};

/** Column the status token starts at, so the report scans vertically. */
const TITLE_WIDTH = 24;

/**
 * Most detail lines one check may contribute to either rendering of the report.
 *
 * THE AXIS A STRING-ORIENTED BOUND CANNOT SEE. `boundedText` caps how long a line
 * is; nothing about it can see a check that supplies five thousand of them. And the
 * count is attacker-reachable independently: `inspectAccounts` pushes one detail
 * per account in the upstream response. Measured: 5,000 details produced 5,000
 * report lines and 229,136 bytes.
 *
 * 64, sized against what a real check contributes — generous headroom over any
 * plausible number of brokerage accounts one customer holds, and still turns 5,000
 * into 65 lines.
 *
 * ONE constant and ONE helper, called from both renderers: two caps that disagree
 * about how much of a report to show is worse than either.
 */
export const MAX_DETAILS_PER_CHECK = 64;

/**
 * Cap a check's detail lines and, when the cap bites, append one
 * SERVER-AUTHORED line naming the number omitted.
 *
 * The disclosure is the point, not a courtesy. A silently shortened diagnostic
 * is worse than a long one: an operator reading 64 account lines has no way to
 * know whether that is all of them, and "the report showed 64" is a materially
 * different fact from "the endpoint reported 5,000". `clipBrokerNote` and
 * `boundedText` already report a truncated length for the same reason.
 */
function boundedDetails(details: readonly string[]): string[] {
  if (details.length <= MAX_DETAILS_PER_CHECK) return [...details];
  const omitted = details.length - MAX_DETAILS_PER_CHECK;
  return [
    ...details.slice(0, MAX_DETAILS_PER_CHECK),
    `… and ${omitted} more detail line${omitted === 1 ? "" : "s"} omitted by this server (${details.length} in total).`,
  ];
}

/**
 * Longest line the human report will emit.
 *
 * A BACKSTOP, not the primary bound — the primary bound is `upstreamText` at the
 * taint sites, because by the time a value reaches this function it has already
 * been concatenated into server prose, and a tight cap here would delete the
 * diagnosis and keep none of the payload. Set generously above the longest
 * server-authored string in this file, which is 325 characters (the
 * "A redirect, not a rejection" paragraph), plus the widest prefix the table
 * adds.
 */
export const MAX_REPORT_LINE_CHARS = 1_000;

/**
 * Bound one line of the human report: strip the display-hostile classes, then
 * clip. Every `lines.push` in `formatReport` goes through this, and a source
 * invariant in test/doctor.test.ts asserts so.
 *
 * THE RENDERER AND NOT ONLY THE TAINT SITES. This command's purpose is to be
 * believed about a credential destination, so the threat model is the operator's
 * EYES, and a diagnostic that can be made to lie about its own verdict is worse
 * than no diagnostic. With four network taint sites feeding this today, a per-site
 * fix leaves the fifth one added next year unguarded; neutralising at the renderer
 * makes it structurally impossible for ANY string to emit a control byte — and a
 * screen repaint is impossible once ESC cannot be emitted.
 *
 * NO WHITESPACE COLLAPSING, deliberately: the table is aligned with `padEnd` and
 * details are indented, so collapsing runs of spaces would shift every column. The
 * strip flattens a break to a single space, which moves nothing.
 */
function reportLine(text: string): string {
  return boundedText(text, { maxChars: MAX_REPORT_LINE_CHARS });
}

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [
    reportLine(`tastytrade MCP server — preflight doctor (v${report.version})`),
    "",
  ];

  report.checks.forEach((check, index) => {
    const number = `${index + 1}`.padStart(2, " ");
    lines.push(
      reportLine(
        `${number}/${report.checks.length}  ${check.title.padEnd(TITLE_WIDTH)} ${STATUS_TOKENS[check.status]}  ${check.summary}`,
      ),
    );
    for (const detail of boundedDetails(check.details)) {
      // ONE LINE PER DETAIL, and that is the fix rather than a limitation.
      //
      // `for (const line of detail.split("\n"))` would let a detail emit as many report
      // lines as it contains newlines. Bounding inside that loop cannot help: the split
      // has already created the lines, so each forged `[ ok ]` row arrives as its own
      // line, gets stripped of ESC, and is pushed anyway.
      //
      // Flattening instead costs nothing real: no server-authored detail in this
      // file contains a newline (checked, not assumed), so the only value that
      // loop ever split in production was network text.
      lines.push(reportLine(`${" ".repeat(9)}${detail}`));
    }
  });

  const tally = tallyStatuses(report.checks);

  lines.push(
    "",
    reportLine(
      `Summary: ${tally.pass} ok, ${tally.warn} warning${tally.warn === 1 ? "" : "s"}, ` +
        `${tally.fail} failed, ${tally.skip} skipped.`,
    ),
  );

  // Switched on the three-state verdict, exhaustively. The lower-case word
  // "verified" is emitted for `passed` and for nothing else — it is the
  // strongest sentence this tool knows how to say, and it must never be printed over
  // the top of a warning that the credential channel was intercepted.
  // The middle verdict says "NOT VERIFIED" in capitals deliberately: it reads as
  // emphasis to a human, and it means a case-sensitive `grep verified` over this
  // output matches the genuine pass and nothing else.
  switch (report.verdict) {
    case "passed":
      lines.push(
        reportLine(
          "PREFLIGHT PASSED — the credentials, the endpoint and the safety configuration are verified.",
        ),
      );
      break;
    case "passed_with_warnings": {
      const flagged =
        tally.warn > 0
          ? `${tally.warn} WARNING${tally.warn === 1 ? "" : "S"}`
          : `${tally.skip} SKIPPED CHECK${tally.skip === 1 ? "" : "S"}`;
      lines.push(
        reportLine(
          `PREFLIGHT PASSED WITH ${flagged} — NOT VERIFIED: nothing failed, ` +
            `but something here was not confirmed.`,
        ),
        reportLine("Review the warnings above before trading."),
      );
      break;
    }
    case "failed": {
      const failed = report.checks.find((c) => c.id === report.failedCheck);
      lines.push(
        reportLine(
          `PREFLIGHT FAILED at check "${report.failedCheck}" (${failed?.title}): ${failed?.summary}`,
        ),
      );
      break;
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Most values the `--json` projection walks before it stops.
 *
 * The aggregate axis, and the one a string cap cannot see: `data.scopes` arrives
 * from `parseScopeList` with one entry per space-separated token the token
 * endpoint chose to send, and `data.accounts` with one entry per account in the
 * upstream response. Measured before this bound: a 4,000-entry scope list
 * produced 95,366 bytes of `--json` on a run that PASSED, so there was no
 * failure for the operator to be suspicious of.
 *
 * Sized well above any real report: eleven checks, a handful of details each and
 * a `data` object of a dozen fields is a few hundred values, and a real account
 * list adds five per account.
 */
const MAX_JSON_REPORT_NODES = 2_000;

/**
 * The `--json` payload. snake_case, because it is a scripting interface.
 *
 * BOUNDED, AND NOT ONLY ESCAPED. This is the surface most likely to be piped into
 * a log or pasted into an issue, and it is a DIFFERENT function from
 * `formatReport`, so the report-forgery fix does not reach it. Its only incidental
 * protection is that `JSON.stringify` escapes a raw ESC to inert literal
 * characters — which covers the control-sequence limb and nothing else. Copying
 * `check.data` untransformed measures at 3,000,499 bytes of stdout for 1 MB of
 * `error_description`.
 *
 * `boundedDeep` over the whole projection rather than three separate bounds on
 * `summary`, `details` and `data`: same hazard, same surface, and one walk cannot
 * disagree with itself about the number. It also STRIPS the display-hostile
 * classes rather than leaving them escaped, because a consumer that unescapes gets
 * the control character back.
 *
 * The cap is `MAX_REPORT_LINE_CHARS`: the machine surface should not be tighter
 * than the one a human reads, and two numbers for two serialisers of one report is
 * a drift this repository has been bitten by.
 *
 * DECLARED, NEVER SILENT: `bounded` and `truncation` say what was cut.
 */
export function reportToJson(report: DoctorReport): string {
  const tally = tallyStatuses(report.checks);
  const bounded = boundedDeep(
    report.checks.map((check) => ({
      id: check.id,
      title: check.title,
      status: check.status,
      summary: check.summary,
      details: boundedDetails(check.details),
      data: check.data ?? {},
    })),
    {
      maxStringChars: MAX_REPORT_LINE_CHARS,
      // The same count bound the human report applies to its detail lines, applied to
      // EVERY array in the projection rather than only to `details`. `data` is a
      // `Record<string, unknown>` filled from several checks, so a per-field cap would
      // need extending every time a check gained a list, and the one it forgot would be
      // the open one.
      //
      // It also repairs collateral damage the node budget does alone: a check with 5,000
      // details spends the whole budget before the walk reaches `data`, so the
      // machine-readable half vanishes entirely.
      //
      // Plus one, for `boundedDetails`'s own disclosure line: the details array
      // legitimately arrives at cap + 1, and truncating back to the cap would drop the
      // sentence saying something was omitted.
      maxArrayItems: MAX_DETAILS_PER_CHECK + 1,
      nodeBudget: MAX_JSON_REPORT_NODES,
    },
  );
  return `${JSON.stringify(
    {
      // The field a machine consumer should gate on, and the reason it exists:
      // `ok` is true for `passed_with_warnings`, and a consumer that trusted it
      // had to walk `checks[]` itself and know that `warn` mattered. Now it does
      // not — one field, three values, same information as the exit code.
      verdict: report.verdict,
      ok: report.ok,
      exit_code: report.exitCode,
      version: report.version,
      failed_check: report.failedCheck ?? null,
      summary: {
        pass: tally.pass,
        warn: tally.warn,
        fail: tally.fail,
        skip: tally.skip,
      },
      bounded: !tallyIsEmpty(bounded.tally),
      ...(tallyIsEmpty(bounded.tally)
        ? {}
        : { truncation: jsonTruncation(bounded.tally) }),
      checks: bounded.value,
    },
    null,
    2,
  )}\n`;
}

/** The tally, in this surface's own snake_case. */
function jsonTruncation(tally: BoundedTally): Record<string, number> {
  return {
    strings_truncated: tally.stringsTruncated,
    characters_dropped: tally.charactersDropped,
    control_characters_flattened: tally.controlCharactersFlattened,
    format_code_points_removed: tally.formatCodepointsRemoved,
    arrays_truncated: tally.arraysTruncated,
    items_dropped: tally.itemsDropped,
    branches_truncated_by_depth: tally.branchesTruncatedByDepth,
    nodes_dropped_by_budget: tally.nodesDroppedByBudget,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `Preflight the tastytrade MCP server's configuration

Usage:
  node dist/doctor.js [doctor] [--json] [${SHOW_ACCOUNTS_FLAG}] [--help]

Options:
  --json             Emit one JSON object instead of the human report.
  ${SHOW_ACCOUNTS_FLAG}    Print account numbers and nicknames in full. Off by
                     default so the report can be shared; the un-masked output
                     identifies you, so do not paste it in public.
  -h, --help         Show this help.

Reads TASTYTRADE_CLIENT_ID, TASTYTRADE_CLIENT_SECRET, TASTYTRADE_REFRESH_TOKEN,
TASTYTRADE_API_URL, TASTYTRADE_ALLOW_UNKNOWN_API_HOST, TASTYTRADE_CREDENTIAL_CHANNEL,
TASTYTRADE_ALLOW_PROXY, TASTYTRADE_READ_ONLY and
MAX_ORDER_NOTIONAL_USD from the environment. Performs one refresh_token grant and
one account lookup; sends no orders. Never prints a credential, and by default
no account number or nickname either — account numbers are masked to their last four characters.
Any username or password embedded in TASTYTRADE_API_URL is stripped before the
URL is printed.

The credentials are only ever sent to a host the server itself would start
against: api.tastyworks.com, api.cert.tastyworks.com, api.sandbox.tastytrade.com,
or a host named in TASTYTRADE_ALLOW_UNKNOWN_API_HOST (over https, or http to
loopback). Anything else fails check 2 and the grant, the token scope and the
account lookup are skipped rather than performed — the same refusal the server
makes at startup, from the same code.

Set TASTYTRADE_CREDENTIAL_CHANNEL=strict and the same refusal covers a proxy or a
trust-store override in the environment: the URL naming a recognised host is no
longer enough if something is interposed between this process and that host.
Name your own gateway in TASTYTRADE_ALLOW_PROXY to permit it. The default posture
is warn, which names those variables in the report and continues.

Exit codes:
  0  every check passed — the configuration is verified
  1  a check failed — the failing check is named on the last line
  2  bad usage
  3  nothing failed, but at least one check warned or was skipped, so the run is
     NOT verified. A caller that wants the old behaviour treats 0 and 3 alike
     (doctor; [ $? -eq 0 -o $? -eq 3 ]); a caller that cares gates on 0.
     --json carries the same answer as a top-level "verdict" field.
`;

export interface CliOptions {
  json: boolean;
  help: boolean;
  /** Opt in to un-masked account numbers and nicknames. */
  showAccounts: boolean;
  /** Set when an argument was not understood; the CLI then exits 2. */
  error?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, help: false, showAccounts: false };
  for (const arg of argv) {
    // `doctor` is tolerated as a leading verb so the command reads the same
    // whether it is invoked directly or as a subcommand of a wrapper script.
    if (arg === "doctor") continue;
    else if (arg === "--json") options.json = true;
    else if (arg === SHOW_ACCOUNTS_FLAG) options.showAccounts = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else return { ...options, error: `unrecognised argument: ${arg}` };
  }
  return options;
}

/** Exit code for a usage error. */
export const EXIT_USAGE = 2;

/**
 * Run the CLI and return the exit code. Writes the report with `out` and usage
 * errors with `err` — see the file header on why the report goes to stdout.
 */
export async function main(
  argv: string[],
  deps: DoctorDeps = defaultDeps(),
  out: (text: string) => void = (text) => void process.stdout.write(text),
  err: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<number> {
  const options = parseArgs(argv);
  if (options.error) {
    err(`doctor: ${options.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    out(USAGE);
    return 0;
  }
  const report = await runDoctor(deps, {
    revealAccounts: options.showAccounts,
  });
  out(options.json ? reportToJson(report) : formatReport(report));
  return report.exitCode;
}

/**
 * True when this module is the process entry point.
 *
 * `process.argv[1]` is the path that was executed, which may be a symlink — a
 * link an operator puts on PATH, or one a container image layer creates —
 * while `import.meta.url` is always the real file. Comparing them raw makes an
 * invocation through such a link silently do nothing, so both sides are
 * resolved through realpath first.
 */
export function isDirectInvocation(
  argv1: string | undefined,
  moduleUrl: string,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  const resolve = (p: string) => {
    try {
      return realpath(p);
    } catch {
      return path.resolve(p);
    }
  };
  try {
    return resolve(fileURLToPath(moduleUrl)) === resolve(argv1);
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
