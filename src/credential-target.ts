/**
 * The credential-destination guard — ONE implementation, two entry points.
 *
 * The rule: the OAuth refresh token and client secret may only be sent to a host
 * we recognise, over a channel that encrypts them. Two commands hold those
 * credentials and dial an operator-supplied URL with them — the MCP server, which
 * refuses to start, and the preflight CLI, which reports and continues.
 *
 * Two guards for one rule is how they drift, so the decision lives HERE and both
 * entry points call it. A second copy of the endpoint constants is a copy that can
 * warn where the server refuses — and the preflight is the command the README tells
 * an operator to run first, carrying the full credential set to whatever URL it was
 * given, so the two must answer identically about every host.
 *
 * Nothing here prints, throws or reads `process.env` except
 * {@link assertCredentialTargetAllowed}, the server's enforcement wrapper. Keeping
 * the DECISION pure is what lets the doctor report it as a check result instead of
 * dying on it.
 *
 * It must stay importable by src/doctor.ts, so it must not import the dispatcher:
 * that transitively loads the static resource modules, which read the vendored docs
 * AT MODULE LOAD and throw when one is missing — the very fault the doctor's last
 * check exists to explain.
 */

import * as tls from "node:tls";

import { toolError } from "./safety/errors.js";

/** tastytrade sandbox ("cert") API. No real money involved. */
export const SANDBOX_API_URL = "https://api.cert.tastyworks.com";

/** tastytrade production API. Real accounts, real funds. THE DEFAULT. */
export const PRODUCTION_API_URL = "https://api.tastyworks.com";

/** Env var naming the API base URL outright. Wins over {@link API_ENV_VAR}. */
export const API_URL_ENV_VAR = "TASTYTRADE_API_URL";

/** Env var selecting an environment by name, so the common case is one word. */
export const API_ENV_VAR = "TASTYTRADE_ENV";

/** Accepted spellings for production. */
const ENV_PRODUCTION: ReadonlySet<string> = new Set([
  "production",
  "prod",
  "live",
]);

/** Accepted spellings for the sandbox. "staging" is included because that is
 * what the environment is called colloquially, and an operator who writes it
 * means the sandbox. */
const ENV_SANDBOX: ReadonlySet<string> = new Set([
  "sandbox",
  "cert",
  "staging",
  "sbx",
]);

/** Which input decided the endpoint. */
export type ApiUrlSource =
  typeof API_URL_ENV_VAR | typeof API_ENV_VAR | "default";

export interface ApiEndpointResolution {
  /** The base URL the server will actually use. */
  apiUrl: string;
  source: ApiUrlSource;
  /**
   * The raw {@link API_ENV_VAR} value, when one was set but could not be read.
   *
   * Present only in that case, so a caller can say so loudly. The resolution
   * itself has already fallen back to the SANDBOX — see below.
   */
  unrecognisedEnvValue?: string;
}

/**
 * Resolve the API base URL from the environment.
 *
 * THE DEFAULT IS PRODUCTION. That is a deliberate reversal: the sandbox does
 * not serve market data, so a server pointed there cannot quote, and a default
 * that cannot do the job is not a safe default — it is a broken one that
 * teaches an operator to override it without reading why. Production is
 * therefore the default, and every surface says so out loud: the startup
 * banner, the `instructions` the client receives on initialize, and the
 * `environment` member on every order result.
 *
 * Precedence, highest first:
 *   1. TASTYTRADE_API_URL — an explicit URL, for a gateway, a proxy or a test
 *      double. Unchanged in meaning, and still the only way to reach a host
 *      that is not one of tastytrade's own.
 *   2. TASTYTRADE_ENV — `production` | `sandbox` (with `prod`/`live` and
 *      `cert`/`staging`/`sbx` accepted), so switching is one word.
 *   3. Nothing set — PRODUCTION.
 *
 * A TASTYTRADE_ENV that is SET but unreadable resolves to the SANDBOX, not to
 * production. An operator who wrote something meant to select an environment
 * and misspelled it must not have that read as permission to trade real money;
 * the same rule the read-only switch follows for the same reason. Note this is
 * not the same case as "unset": unset is a default, a typo is a failed
 * instruction.
 */
export function resolveApiEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): ApiEndpointResolution {
  const explicit = env[API_URL_ENV_VAR]?.trim();
  if (explicit) return { apiUrl: explicit, source: API_URL_ENV_VAR };

  const raw = env[API_ENV_VAR];
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = raw.trim().toLowerCase();
    if (ENV_SANDBOX.has(value))
      return { apiUrl: SANDBOX_API_URL, source: API_ENV_VAR };
    if (ENV_PRODUCTION.has(value))
      return { apiUrl: PRODUCTION_API_URL, source: API_ENV_VAR };
    return {
      apiUrl: SANDBOX_API_URL,
      source: API_ENV_VAR,
      unrecognisedEnvValue: raw,
    };
  }

  return { apiUrl: PRODUCTION_API_URL, source: "default" };
}

/** The base URL the server will use. Thin wrapper over {@link resolveApiEndpoint}. */
export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveApiEndpoint(env).apiUrl;
}

/** The three classes of endpoint the server distinguishes on its own surface. */
export type ApiEnvironmentClass = "production" | "sandbox" | "other";

/**
 * Classify a base URL as production, sandbox, or something else.
 *
 * The comparison goes through `normaliseHostname`, which is not decoration:
 * `https://api.tastyworks.com.` — the fully-qualified spelling every DNS tool
 * prints, and therefore one an operator pastes — is production to a resolver,
 * and an exact string match returned false for it. Every predicate that decides
 * whether real money is involved reads the host through this one function, so
 * they cannot disagree about the same string.
 *
 * An unparseable value falls back to a substring probe, so a malformed but
 * production-looking URL still classifies as production. The sandbox host does
 * not contain that substring, so the fallback cannot mislabel a sandbox.
 */
export function apiEnvironmentOf(
  apiUrl: string | undefined,
): ApiEnvironmentClass {
  if (!apiUrl) return "other";
  let hostname: string;
  try {
    hostname = new URL(apiUrl).hostname;
  } catch {
    return apiUrl.toLowerCase().includes("api.tastyworks.com")
      ? "production"
      : "other";
  }
  const host = normaliseHostname(hostname);
  if (host === "api.tastyworks.com") return "production";
  if (
    host === "api.cert.tastyworks.com" ||
    host === "api.sandbox.tastytrade.com"
  )
    return "sandbox";
  return "other";
}

/**
 * Env var an operator sets to acknowledge, by name, an API host this server
 * does not recognise. See {@link inspectCredentialTarget}.
 */
export const ALLOW_UNKNOWN_API_HOST_ENV_VAR =
  "TASTYTRADE_ALLOW_UNKNOWN_API_HOST";

/**
 * Env var an operator sets to choose what this server DOES about an interposed
 * credential channel, as distinct from what it says about one.
 *
 * `warn` (the default, and any unrecognised value) keeps the historical
 * behaviour: a proxy or a trust-store override is named in the startup banner
 * and in the preflight report, and the server starts. `strict` makes it a
 * refusal. See {@link inspectCredentialTarget}'s rule 6 for why the default is
 * not `strict`.
 */
export const CREDENTIAL_CHANNEL_ENV_VAR = "TASTYTRADE_CREDENTIAL_CHANNEL";

/**
 * Env var an operator sets to acknowledge, by name, a proxy that may carry the
 * credential POST under `strict` posture.
 *
 * Shaped exactly like {@link ALLOW_UNKNOWN_API_HOST_ENV_VAR}, and for the reason
 * that variable already gives: it takes HOSTNAMES, not a boolean. A boolean is
 * one line for an attacker to add and, once set, silently blesses every future
 * change to the proxy; naming the host means the acknowledgement and the target
 * have to agree, so a config that later retargets the proxy fails closed again.
 */
export const ALLOW_PROXY_ENV_VAR = "TASTYTRADE_ALLOW_PROXY";

/**
 * Every hostname that is genuinely a tastytrade API endpoint.
 *
 * The single allowlist. `classifyApiHost` in src/doctor.ts adds a human LABEL
 * per environment for the preflight report, but it is not a second allowlist:
 * whether a host may receive the credentials is decided here, and the doctor
 * asks {@link inspectCredentialTarget} for that answer like the server does.
 * test/doctor.test.ts pins the two together in both directions.
 */
export const KNOWN_API_HOSTS: readonly string[] = [
  "api.tastyworks.com", // production
  "api.cert.tastyworks.com", // sandbox ("cert")
  "api.sandbox.tastytrade.com", // sandbox
];

/**
 * Sandbox names on the WRONG registrable domain. Not endpoints — they do not
 * resolve publicly — but they are the two typos an operator actually makes, so
 * a refusal that names the trap saves an hour. See src/doctor.ts's
 * SWAPPED_DOMAIN_NOTE for the same explanation on the preflight side.
 */
export const SWAPPED_DOMAIN_HOSTS: readonly string[] = [
  "api.sandbox.tastyworks.com",
  "api.cert.tastytrade.com",
];

export const SWAPPED_DOMAIN_NOTE =
  "The two sandbox environments answer on DIFFERENT domains: api.cert on " +
  "tastyworks.com, api.sandbox on tastytrade.com. Crossing them gives a host " +
  "that does not resolve publicly.";

/**
 * A hostname reduced to the one spelling every comparison in this tree uses:
 * lowercased, with the DNS root's trailing dot removed.
 *
 * `api.tastyworks.com.` and `api.tastyworks.com` are the same name, and a resolver
 * answers identically for both. Comparing without normalising has call sites
 * disagreeing in opposite directions on the same value: this guard fails CLOSED on
 * the dotted form (safe, but it refuses to start over a value that looks identical
 * to what the operator typed) while `isProductionApiUrl` fails OPEN (acknowledge
 * the host once and real orders go out with no LIVE TRADING banner).
 *
 * Exactly ONE trailing dot is stripped: a second leaves an empty label, which is
 * not resolvable in any resolver, so treating `api.tastyworks.com..` as production
 * would widen the allowlist to a string that can never reach the API.
 */
export function normaliseHostname(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.length > 1 && h.endsWith(".") ? h.slice(0, -1) : h;
}

/**
 * Loopback hostnames, where "the network" is this machine.
 *
 * `new URL()` renders an IPv6 host bracketed (`[::1]`), and normalises the many
 * spellings of the v6 loopback (`[0:0:0:0:0:0:0:1]`) to `[::1]`. IPv4 loopback
 * is the whole 127.0.0.0/8 block, not just 127.0.0.1.
 */
function isLoopbackHost(hostname: string): boolean {
  const h = normaliseHostname(hostname);
  if (h === "localhost" || h === "[::1]") return true;
  const parts = h.split(".");
  if (parts.length !== 4) return false;
  // Every octet must be a real octet. `127.999.1.1` is NOT an IPv4 address —
  // `new URL()` leaves it as a domain name — and a four-numeric-group shape is
  // not on its own proof of one, so the range is checked rather than assumed.
  // The dotted-quad here is already canonical: `new URL()` normalises the short
  // and octal and integer spellings (`127.1`, `0177.0.0.1`, `2130706433`) to it.
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return Number(parts[0]) === 127;
}

/**
 * Hostnames the operator has acknowledged by name, normalised.
 *
 * Both sides of this comparison go through {@link normaliseHostname}, so the
 * operator does not have to guess which spelling the variable wants: a URL
 * written `https://gw.corp.example.` is acknowledged by either `gw.corp.example`
 * or `gw.corp.example.`. Normalising only one side would be a hatch that
 * silently fails to match, which reads as "the guard is broken" rather than as
 * "you spelled it differently".
 */
function acknowledgedHosts(env: NodeJS.ProcessEnv): string[] {
  return (env[ALLOW_UNKNOWN_API_HOST_ENV_VAR] ?? "")
    .split(",")
    .map((h) => normaliseHostname(h.trim()))
    .filter((h) => h.length > 0);
}

/**
 * Proxy hostnames the operator has acknowledged by name, normalised.
 *
 * Deliberately the same shape as {@link acknowledgedHosts} — comma-separated,
 * both sides through {@link normaliseHostname} — so an operator who has met one
 * of these variables already knows how the other behaves, and so a trailing dot
 * or a capital letter on either side cannot produce a hatch that silently fails
 * to match.
 */
function acknowledgedProxies(env: NodeJS.ProcessEnv): string[] {
  return (env[ALLOW_PROXY_ENV_VAR] ?? "")
    .split(",")
    .map((h) => normaliseHostname(h.trim()))
    .filter((h) => h.length > 0);
}

/**
 * Is the operator asking for an interposed credential channel to be REFUSED?
 *
 * `strict` is matched case-insensitively and trimmed, because it is typed into a
 * JSON config by hand. Every other value — including a typo, `1`, `true` and the
 * empty string — is the default `warn`, and that direction is deliberate: this
 * is the opposite of the choice `isReadOnlyModeEnabled` makes, and for the same
 * reason it is right there. Read-only mode fails SAFE by treating an
 * unrecognised value as "restrict"; here an unrecognised value that meant
 * "restrict" would take a working deployment down over a typo, which is the
 * failure a posture variable must not have.
 */
function wantsStrictChannel(env: NodeJS.ProcessEnv): boolean {
  return (
    (env[CREDENTIAL_CHANNEL_ENV_VAR] ?? "").trim().toLowerCase() === "strict"
  );
}

/**
 * Where the bytes actually go, as distinct from where the URL says they go.
 *
 * See {@link inspectCredentialChannel}.
 */
export interface CredentialChannel {
  /** A proxy variable that applies to this scheme is set in the environment. */
  proxied: boolean;
  /**
   * Which spelling of it was found — `https_proxy`, `ALL_PROXY` and so on.
   * Callers that need one short phrase rather than the whole note name this,
   * so the operator is told the variable to look at rather than the concept.
   */
  proxyVariable?: string;
  /**
   * The proxy URL's hostname, normalised, or undefined when there is no proxy or
   * its URL did not parse.
   *
   * Present so the strict-posture hatch can compare a NAME against a NAME.
   * `undefined` while `proxied` is true means the value is set and unreadable,
   * which strict posture treats as a refusal — an unparseable proxy cannot be
   * acknowledged, and guessing at it would be a hatch that opens by accident.
   */
  proxyHostname?: string;
  /**
   * The variables that change which certificate authorities this process
   * accepts, by name — `NODE_EXTRA_CA_CERTS`, and `SSL_CERT_FILE` /
   * `SSL_CERT_DIR` when `--use-openssl-ca` is in effect.
   *
   * A list rather than a boolean because the refusal has to say WHICH, and
   * because the two do different things: one adds an anchor, the other replaces
   * the store.
   */
  trustStoreOverrides: string[];
  /** NODE_TLS_REJECT_UNAUTHORIZED is set to the one value Node treats as off. */
  verificationDisabled: boolean;
  /** One sentence per setting found, naming the variable and what it changes. */
  notes: string[];
  /**
   * Sentences that are TRUE and CONDITIONAL: something in the environment would
   * change the credential path if a condition this process cannot observe holds.
   *
   * Split from {@link notes} because the two have different consequences.
   * `notes` means "something IS changing the channel for this process" and
   * promotes the preflight's endpoint check to `warn`. These are printed and
   * promote nothing — which is the only way to say a true-but-unremarkable
   * sentence at all. The alternative was the one the module had: alarm or
   * silence, with silence winning, because `SSL_CERT_FILE` exported for `curl`
   * on an ordinary machine is not a warning and pretending otherwise turns every
   * such machine into a non-zero exit.
   */
  informationalNotes: string[];
}

/**
 * Every environment variable {@link inspectCredentialChannel} reads, in every
 * spelling it reads it in.
 *
 * Exported because two other places need the same list and must not keep their
 * own: the test harness scrubs these out of `process.env` so a green suite
 * means the same thing on a machine whose owner has `HTTPS_PROXY` or
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` exported for unrelated reasons, and the
 * suite asserts the two lists are the same list. A variable added to the
 * inspection and forgotten in the scrubber is how the test suite became
 * sensitive to its author's shell in the first place.
 */
export const CHANNEL_ENV_VARS: readonly string[] = [
  // axios reads the lowercase spelling first and falls back to uppercase.
  ...["http_proxy", "https_proxy", "all_proxy", "no_proxy"].flatMap((name) => [
    name,
    name.toUpperCase(),
  ]),
  // Node reads these by their exact uppercase names only.
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_OPTIONS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Read the environment variables that decide where the credential-bearing POST
 * actually goes and whether its peer is verified.
 *
 * WHY THE HOST ALLOWLIST IS NOT THE WHOLE ANSWER. {@link inspectCredentialTarget}
 * compares `new URL(apiUrl).hostname` against a list, which is complete only while
 * the hostname determines the destination — and two generic environment variables,
 * sitting in the same MCP client `env` block this module's threat model is built
 * around, break that without touching TASTYTRADE_API_URL. `HTTPS_PROXY` moves the
 * TCP connection to a host the guard never sees; `NODE_EXTRA_CA_CERTS` makes that
 * host's certificate for `api.tastyworks.com` verify cleanly. Set both and the
 * guard reports `allowed: true, recognised: true, notes: []` while the credentials
 * cross a session an intermediary can read.
 *
 * `--use-openssl-ca` plus `SSL_CERT_FILE` or `SSL_CERT_DIR` says the second half
 * more strongly, REPLACING the trust store rather than adding to it.
 * {@link CHANNEL_ENV_VARS} is the whole list in one place, because "reported one
 * and not its twin" is the shape every defect in this area has had.
 *
 * WHERE THE LINE IS DRAWN. A proxy is NOT refused: corporate egress gateways are
 * legitimate and ordinary, and the operator who set `HTTPS_PROXY` did so for every
 * process on the machine. What a proxy MUST NOT do is pass unremarked — the
 * module's stated value is visibility — so it becomes a note both the startup
 * banner and the preflight print.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused by the caller, and that is the same
 * rule as the clear-text refusal rather than a new one: a channel whose far end is
 * unverified is the plain-http case wearing a TLS hat, and it has a remediation
 * that is not "give up".
 *
 * We do NOT re-implement `no_proxy` matching. axios owns that rule, and a second
 * copy is exactly the drift that produced this module; when `no_proxy` is set the
 * note says so.
 */
/**
 * Reduce a NODE_OPTIONS string, or an argv array, to the set of FLAG NAMES it
 * carries — canonicalised the way Node's own parser canonicalises them.
 *
 * An exact-token comparison is strictly tighter than Node's parser, so the control
 * disagrees with the runtime. Canonicalising each token to the form the runtime
 * reduces it to makes the two answers equal by CONSTRUCTION: any mix of
 * underscores, `=value` and double quotes reduces to the same name.
 *
 * Three transforms, each matching measured behaviour on the pinned runtime:
 *
 *   1. ONE surrounding pair of DOUBLE quotes is stripped.
 *   2. The token is split on the FIRST `=` and the value DISCARDED, never
 *      interpreted — `--use-openssl-ca=false` turns the flag ON, because Node
 *      ignores the value on a boolean flag, so "honouring" the parsed value would
 *      be wrong in the same direction as the bug it replaces.
 *   3. `_` folds to `-`.
 *
 * And two things it deliberately does NOT do, because in both silence AGREES with
 * the runtime: SINGLE quotes are not stripped (Node does not honour
 * `'--use-openssl-ca'`), and nothing is case-folded (Node REFUSES
 * `--USE-OPENSSL-CA` outright, so a process spelled that way never starts).
 */
export function nodeOptionFlagNames(
  source: string | readonly string[],
): Set<string> {
  const tokens = typeof source === "string" ? source.split(/\s+/) : [...source];
  const names = new Set<string>();
  for (const raw of tokens) {
    if (raw === "") continue;
    const unquoted =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    const equals = unquoted.indexOf("=");
    const name = equals === -1 ? unquoted : unquoted.slice(0, equals);
    const canonical = name.replace(/_/g, "-");
    if (canonical !== "") names.add(canonical);
  }
  return names;
}

/**
 * Ask the RUNTIME whether this process is using a trust store other than the one
 * Node ships with — the question the `--use-openssl-ca` note is about.
 *
 * Every string-parsing answer is an answer about a SPELLING. This one is about the
 * EFFECT, so it covers every spelling including the ones nobody has thought of, and
 * needs no access to another process's command line.
 *
 * `tls.getCACertificates` arrived in Node 22.15. On anything older, and on any
 * failure, the answer is `undefined` — "this probe cannot say" — and the caller
 * falls back to the parse. It NEVER throws: a probe that can break the guard it
 * corroborates is worse than no probe.
 *
 * `"extra"` is subtracted deliberately: `NODE_EXTRA_CA_CERTS` also makes
 * `"default"` differ from `"bundled"` and has its own note, so counting it here
 * would report the openssl flag for a variable that is not it.
 */
export function trustStoreOverridden(): boolean | undefined {
  try {
    const bundled = caCertificateCount("bundled");
    const extra = caCertificateCount("extra");
    const dflt = caCertificateCount("default");
    if (bundled === undefined || extra === undefined || dflt === undefined) {
      return undefined;
    }
    // With the flag in effect the default store is OpenSSL's, which has no
    // relation to the bundled count — in a container with no system CA bundle it
    // is 0. Without it, `default` is `bundled` plus whatever `extra` added.
    return dflt !== bundled + extra;
  } catch {
    return undefined;
  }
}

/**
 * `tls.getCACertificates`, which @types/node does not declare on the pinned
 * version, reached through one cast in one place.
 *
 * Not `require()`: this package is `"type": "module"`, so `require` is not
 * defined at runtime and a `try { require(...) } catch` would have silently
 * returned `undefined` forever — a probe that never probes, and a green test
 * suite either way because `undefined` is a legitimate answer. Measured on the
 * pinned runtime instead: with the flag in effect `getCACertificates("default")`
 * is 0 against a bundled 145; without it, 145 against 145.
 */
function caCertificateCount(kind: string): number | undefined {
  const api = tls as unknown as {
    getCACertificates?: (k: string) => readonly unknown[];
  };
  if (typeof api.getCACertificates !== "function") return undefined;
  return api.getCACertificates(kind).length;
}

export function inspectCredentialChannel(
  protocol: "http:" | "https:",
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
  probeTrustStore: () => boolean | undefined = trustStoreOverridden,
): CredentialChannel {
  // axios reads the lowercase spelling first and falls back to uppercase
  // (`getEnv` in its node adapter). Mirrored, so the variable this names is the
  // variable axios will use.
  const read = (name: string): { name: string; value: string } | undefined => {
    for (const spelling of [name.toLowerCase(), name.toUpperCase()]) {
      const value = env[spelling]?.trim();
      if (value) return { name: spelling, value };
    }
    return undefined;
  };

  const notes: string[] = [];
  const informationalNotes: string[] = [];
  const trustStoreOverrides: string[] = [];
  const proxy =
    read(protocol === "https:" ? "https_proxy" : "http_proxy") ??
    read("all_proxy");
  let proxyHostname: string | undefined;
  if (proxy) {
    // `new URL` and nothing cleverer: axios parses the proxy variable the same
    // way, so what is reported here is the host axios will dial. A value with no
    // scheme (`proxy.example:3128`) does not parse as a URL with a hostname, and
    // it is left undefined rather than repaired — see `proxyHostname`.
    try {
      const parsedProxy = new URL(proxy.value);
      if (parsedProxy.hostname !== "") {
        proxyHostname = normaliseHostname(parsedProxy.hostname);
      }
    } catch {
      proxyHostname = undefined;
    }
    // The proxy URL carries userinfo as often as the API URL does, and this
    // note lands on the same stderr and in the same pasted report.
    notes.push(
      `${proxy.name} is set, so this process may send the credential POST through ` +
        `${clipUrlForMessage(proxy.value)} rather than connecting to the API host directly. ` +
        `The host check above vetted TASTYTRADE_API_URL, not the proxy: whatever terminates ` +
        `that connection sees the request, so vet it the same way.`,
    );
    const noProxy = read("no_proxy");
    if (noProxy) {
      notes.push(
        `${noProxy.name} is also set and may exempt this host from the proxy. Which of the two ` +
          `applies to a given request is decided by the HTTP client, not by this check.`,
      );
    }
  }

  // Node reads these two by their exact uppercase names only, so no case
  // folding here — reporting a lowercase `node_extra_ca_certs` would name a
  // variable that changes nothing.
  const extraCa = env.NODE_EXTRA_CA_CERTS?.trim();
  if (extraCa) {
    trustStoreOverrides.push("NODE_EXTRA_CA_CERTS");
    notes.push(
      "NODE_EXTRA_CA_CERTS is set, so this process trusts a certificate authority beyond the " +
        "public trust store. A certificate for the API host that would otherwise be rejected — " +
        "including one minted by an intercepting proxy — verifies cleanly here.",
    );
  }

  // The same door, by another name. `--use-openssl-ca` makes Node use OpenSSL's
  // trust store, which reads SSL_CERT_FILE and SSL_CERT_DIR — and SSL_CERT_FILE
  // REPLACES the store rather than adding to it, so the proxy's own CA can be the
  // only one that verifies.
  //
  // Both sources are read because they are disjoint and both appear in an MCP
  // client's server block: the flag can arrive in `env` as NODE_OPTIONS or in `args`
  // on the command line, and Node does NOT merge NODE_OPTIONS into `process.execArgv`.
  // Both go through {@link nodeOptionFlagNames}, so the answer here EQUALS the
  // runtime's rather than agreeing for one spelling.
  //
  // The certificate variables are not reported on their own AS A WARNING — without
  // the flag Node ignores them, and they are set machine-wide for curl and openssl on
  // plenty of hosts. They get a conditional, non-promoting sentence instead.
  const namedCertVars = ["SSL_CERT_FILE", "SSL_CERT_DIR"].filter((name) =>
    env[name]?.trim(),
  );
  // Three sources, not two, and the third is the only one that is not a
  // SPELLING. `execArgv` describes the process ASKING — see the block below —
  // so a flag in the server's `args` is invisible to the doctor however well
  // either string source is parsed. The runtime's own trust store is a fact
  // about this process that no parse can contradict, so it may only ADD the
  // note, never suppress it: a spelling nobody has thought of yet still
  // produces the banner in the process that holds the credentials.
  const parsedFlag =
    nodeOptionFlagNames(env.NODE_OPTIONS ?? "").has("--use-openssl-ca") ||
    nodeOptionFlagNames(execArgv).has("--use-openssl-ca");
  const opensslCa = parsedFlag || probeTrustStore() === true;
  if (opensslCa) {
    const named = namedCertVars;
    // Only alongside the flag, which is the same condition the note below
    // carries: without `--use-openssl-ca` Node ignores these two outright, so
    // refusing over them would be a refusal for a setting that changes nothing.
    trustStoreOverrides.push(...named);
    notes.push(
      "--use-openssl-ca is in effect, so this process verifies certificates against OpenSSL's " +
        "trust store rather than the one Node ships with. " +
        (named.length > 0
          ? `${named.join(" and ")} ${named.length === 1 ? "points" : "point"} that store at a location ` +
            "of the operator's choosing, which REPLACES the public roots rather than adding to them: " +
            "a certificate minted by an intercepting proxy can be the only one this process accepts."
          : "Set SSL_CERT_FILE or SSL_CERT_DIR alongside it and that store is whatever they name."),
    );
  }

  // THE FLAG WAS NOT FOUND, AND THE CERTIFICATE VARIABLES ARE SET.
  //
  // `process.execArgv` is the flag list of THIS process. `env` is shared — an MCP
  // client's `env` block reaches the server, and an operator who exported the same
  // variables reaches the doctor — but `args` is not: when the doctor runs as its own
  // command, the server's `args` are not in its address space. Naming SSL_CERT_FILE /
  // SSL_CERT_DIR only alongside the flag lets the same failed condition silence the
  // one signal that DOES cross the boundary.
  //
  // No parser fixes that: with the flag in the server's `args` there is nothing in
  // the shared channel to find. What is available is a sentence that is exactly true
  // — the variable is set, it changes nothing unless the flag is in effect, this
  // process cannot see another's command line — on the informational channel, so on
  // an ordinary machine with SSL_CERT_FILE exported for curl it does not promote a
  // clean report to a warning.
  if (!opensslCa && namedCertVars.length > 0) {
    informationalNotes.push(
      `${namedCertVars.join(" and ")} ${namedCertVars.length === 1 ? "is" : "are"} set. ` +
        "Node ignores them unless --use-openssl-ca is in effect, and it is not in " +
        "effect for THIS process — but no process can read another process's command " +
        `line, so if the server is launched with --use-openssl-ca in its \`args\` array, ` +
        `${namedCertVars.join(" / ")} REPLACES the public certificate authorities for it and a ` +
        "certificate minted by an intercepting proxy can be the only one it accepts. " +
        "Check the `args` array of your MCP client's server block.",
    );
  }

  // Node's own test is a strict `=== "0"` on the raw value, so this one is too:
  // ` 0 ` and `false` leave verification ON, and refusing to start over them
  // would be a refusal for a configuration that is actually safe.
  const verificationDisabled = env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
  if (verificationDisabled) {
    notes.push(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 switches off certificate verification for every TLS " +
        "connection this process makes, so a handshake proves only that something answered.",
    );
  }

  return {
    proxied: proxy !== undefined,
    proxyVariable: proxy?.name,
    proxyHostname,
    trustStoreOverrides,
    verificationDisabled,
    notes,
    informationalNotes,
  };
}

/** The verdict on whether this server may hand its credentials to a URL. */
export interface CredentialTargetDecision {
  /** May the server start and send the OAuth credentials to this URL? */
  allowed: boolean;
  /** Parsed hostname, lowercased. Empty when the URL did not parse. */
  hostname: string;
  /** True when the host is one of {@link KNOWN_API_HOSTS}. */
  recognised: boolean;
  /** Set when an unrecognised host was permitted by explicit acknowledgement. */
  acknowledged: boolean;
  /** One sentence naming what is wrong. Absent when `allowed`. */
  refusal?: string;
  /** Extra guidance — the swapped-domain trap, the clear-text warning. */
  notes: string[];
  /**
   * What the environment does to the channel, from
   * {@link inspectCredentialChannel}. Kept separate from `notes` because these
   * are the sentences that must be surfaced even when everything else about
   * this decision is unremarkable: an allowed, recognised production host
   * behind a proxy has nothing else to say, and is exactly the case that would
   * otherwise pass in silence.
   */
  channelNotes: string[];
  /**
   * The channel's INFORMATIONAL half — see
   * {@link CredentialChannel.informationalNotes}. Carried separately all the way
   * out so a `--json` consumer can tell a conditional sentence from a warning,
   * which is the distinction that decides an exit code.
   */
  channelInformationalNotes: string[];
}

/**
 * Decide whether the OAuth refresh token and client secret may be sent to
 * `apiUrl`.
 *
 * A REFUSAL, NOT A WARNING. The credential is a tastytrade refresh token —
 * long-lived and non-rotating, so one leak is durable access to a funded brokerage
 * account. The realistic vector is not a compromised machine but a poisoned or
 * copy-pasted MCP client config, because README.md and server.json both ship
 * paste-ready blocks that set `TASTYTRADE_API_URL`. One altered line and the first
 * tool call POSTs `{grant_type, refresh_token, client_id, client_secret}` to
 * whoever is listening. A warning does not help: the operator who pasted the config
 * is not reading stderr, and by the time anyone reads it the token is gone.
 *
 * THE ESCAPE HATCH takes HOSTNAMES, not a boolean, and the host in
 * `TASTYTRADE_API_URL` must appear in it. A boolean is one line for an attacker to
 * add and then silently blesses every future change to the URL. Naming the host
 * means the acknowledgement and the target must agree, so a config that later
 * retargets fails closed again.
 *
 * RULES, IN ORDER:
 *
 *  1. The URL must parse, and must have a host.
 *  2. The scheme must be http: or https:.
 *  3. The host must be recognised, or acknowledged by name.
 *  4. http: is refused for any non-loopback host, with NO hatch — the credentials
 *     would cross the network in clear text. Loopback is exempt because "the
 *     network" there is this machine, and an attacker who can listen on it can read
 *     the environment variable directly.
 *  5. https: to a non-loopback host is refused while NODE_TLS_REJECT_UNAUTHORIZED
 *     is off, on the same grounds and with the same absent hatch.
 *  6. An interposed channel — a proxy, or a variable that changes which CAs this
 *     process accepts — is refused when {@link CREDENTIAL_CHANNEL_ENV_VAR} is
 *     `strict`. Opt-in, with a named hatch for the proxy half and none for the
 *     trust-store half.
 *
 * Comparison is always on `new URL(...).hostname`, never a substring: userinfo and
 * a path make `https://api.tastyworks.com@evil.example/` and
 * `https://evil.example/api.tastyworks.com` both contain the production host as
 * text while dialling neither. Always on the {@link normaliseHostname} form, too.
 *
 * What this CANNOT decide is whether the bytes reach the host it approved: a proxy
 * in the environment moves them and this returns a note saying so. The honest
 * promise is "the URL names a host we recognise".
 */
export function inspectCredentialTarget(
  apiUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CredentialTargetDecision {
  const base: CredentialTargetDecision = {
    allowed: false,
    hostname: "",
    recognised: false,
    acknowledged: false,
    notes: [],
    channelNotes: [],
    channelInformationalNotes: [],
  };

  const raw = apiUrl?.trim();
  if (!raw) {
    return {
      ...base,
      refusal:
        "No API base URL is configured, so there is no endpoint to authenticate against.",
      notes: [
        `Set ${API_URL_ENV_VAR} to an explicit endpoint, or ${API_ENV_VAR}=sandbox ` +
          `for ${SANDBOX_API_URL}. With neither set, the endpoint is ` +
          `${PRODUCTION_API_URL}.`,
      ],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ...base,
      refusal: `TASTYTRADE_API_URL is not a parseable URL: ${clipUrlForMessage(raw)}`,
      notes: [
        `Expected an absolute origin with a scheme, e.g. ${SANDBOX_API_URL}.`,
      ],
    };
  }

  // `hostname` stays the form axios will dial, so what this reports and what
  // the transport does can never diverge; `identity` is that same host reduced
  // to the one spelling every comparison uses.
  const hostname = parsed.hostname.toLowerCase();
  const identity = normaliseHostname(hostname);
  const recognised = KNOWN_API_HOSTS.includes(identity);
  const acknowledged =
    !recognised && acknowledgedHosts(env).includes(identity) && identity !== "";
  const notes: string[] = [];
  if (SWAPPED_DOMAIN_HOSTS.includes(identity)) notes.push(SWAPPED_DOMAIN_NOTE);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ...base,
      hostname,
      recognised,
      refusal: `TASTYTRADE_API_URL uses the scheme "${parsed.protocol}", which cannot carry an HTTPS request.`,
      notes: [...notes, "Use https: (or http: against a loopback host)."],
    };
  }

  const channel = inspectCredentialChannel(parsed.protocol, env);

  if (hostname === "") {
    return {
      ...base,
      channelNotes: channel.notes,
      refusal: `TASTYTRADE_API_URL has no host: ${clipUrlForMessage(raw)}`,
      notes: [
        ...notes,
        `Expected an absolute origin with a scheme, e.g. ${SANDBOX_API_URL}.`,
      ],
    };
  }

  // Every message below quotes the host, and the host is operator-supplied:
  // WHATWG URL imposes no DNS length limit, so a multi-megabyte hostname parses
  // fine. Clipped once, here, rather than at each interpolation, so a new refusal
  // cannot forget.
  const shown = clipHostForMessage(hostname);

  if (!recognised && !acknowledged) {
    return {
      ...base,
      hostname,
      recognised,
      channelNotes: channel.notes,
      refusal: `TASTYTRADE_API_URL points at "${shown}", which is not a tastytrade API host this server recognises.`,
      notes: [
        ...notes,
        `Recognised hosts: ${KNOWN_API_HOSTS.join(", ")}.`,
        // The remediation has to be COPYABLE, which is why the clipped host is
        // not simply pasted in. Capping the echo turned this line into
        // `…=aaaa…[truncated, 200013 chars]` — an instruction to set a value
        // that can never match the host it acknowledges, which is worse than
        // the flood it was fixing because the operator follows it and it fails.
        // Over the cap the variable is named and the value is described
        // instead.
        shown === hostname
          ? `If you meant it — a proxy, a gateway, a local test double — acknowledge that exact host by name: ${ALLOW_UNKNOWN_API_HOST_ENV_VAR}=${shown}`
          : `If you meant it — a proxy, a gateway, a local test double — set ${ALLOW_UNKNOWN_API_HOST_ENV_VAR} to that host, spelled exactly as it appears in TASTYTRADE_API_URL. It is ${hostname.length} characters long, which is too long to print here.`,
      ],
    };
  }

  if (parsed.protocol === "http:" && !isLoopbackHost(hostname)) {
    return {
      ...base,
      hostname,
      recognised,
      acknowledged,
      channelNotes: channel.notes,
      refusal: `TASTYTRADE_API_URL uses plain http: for "${shown}", so the refresh token and client secret would cross the network in clear text.`,
      notes: [
        ...notes,
        `Use https:. ${ALLOW_UNKNOWN_API_HOST_ENV_VAR} does not lift this — it acknowledges a host, not an unencrypted channel.`,
      ],
    };
  }

  if (channel.verificationDisabled && !isLoopbackHost(hostname)) {
    // Rule 4 in a different disguise, so it is refused the same way and the
    // host acknowledgement does not lift it either. Loopback is exempt for the
    // reason it is exempt above, plus one more: a local test double with a
    // self-signed certificate is an ordinary thing to have, and nothing on the
    // wire is exposed to the network anyway.
    return {
      ...base,
      hostname,
      recognised,
      acknowledged,
      channelNotes: channel.notes,
      refusal: `NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate verification for this process, so the refresh token and client secret would go to whatever answers for "${shown}" rather than to a peer that proved it is "${shown}".`,
      notes: [
        ...notes,
        `Unset NODE_TLS_REJECT_UNAUTHORIZED, or point NODE_EXTRA_CA_CERTS at the CA of the appliance terminating TLS. ${ALLOW_UNKNOWN_API_HOST_ENV_VAR} does not lift this — it acknowledges a host, not an unverified channel.`,
      ],
    };
  }

  // RULE 6 — an interposed credential channel, when the operator has asked for one
  // to be refused.
  //
  // The module's own asymmetry made the gap legible: `NODE_TLS_REJECT_UNAUTHORIZED=0`
  // becomes a refusal through rule 5, while `https_proxy` plus a trusted CA — the
  // whole interception, needing no NODE_OPTIONS and granting no code execution — was
  // only a NOTE.
  //
  // OPT-IN, NOT THE DEFAULT. Corporate egress gateways and TLS-inspecting appliances
  // are legitimate and ordinary, this server is meant to run inside enterprises, and
  // the operator who set HTTPS_PROXY set it for every process on the machine.
  // Refusing by default would make the server unusable for the population that most
  // needs it. What was wrong was that the refusal was UNAVAILABLE.
  //
  // The hatch is named, not boolean, for the reason rule 3's is: one deliberate line
  // naming the gateway, and a config that later retargets the proxy fails closed
  // again. There is deliberately NO hatch for the trust-store half — a store that can
  // be repointed is exactly what makes an interposed channel verify cleanly.
  if (wantsStrictChannel(env)) {
    const acknowledgedProxyHosts = acknowledgedProxies(env);
    const proxyRefused =
      channel.proxied &&
      (channel.proxyHostname === undefined ||
        !acknowledgedProxyHosts.includes(channel.proxyHostname));
    if (proxyRefused || channel.trustStoreOverrides.length > 0) {
      const reasons: string[] = [];
      if (proxyRefused) {
        reasons.push(
          `${channel.proxyVariable} routes it through ` +
            `${channel.proxyHostname === undefined ? "a proxy URL this server could not parse" : clipHostForMessage(channel.proxyHostname)}`,
        );
      }
      if (channel.trustStoreOverrides.length > 0) {
        reasons.push(
          `${channel.trustStoreOverrides.join(" and ")} ` +
            `${channel.trustStoreOverrides.length === 1 ? "changes" : "change"} which certificate authorities this process accepts`,
        );
      }
      return {
        ...base,
        hostname,
        recognised,
        acknowledged,
        channelNotes: channel.notes,
        refusal:
          `${CREDENTIAL_CHANNEL_ENV_VAR}=strict, and the environment interposes something ` +
          `between this server and "${shown}": ${reasons.join("; ")}. The refresh token and ` +
          `client secret are not sent.`,
        notes: [
          ...notes,
          ...(proxyRefused
            ? [
                `If that proxy is yours — a corporate egress gateway, a recording proxy, a local test double — acknowledge it by name: ${ALLOW_PROXY_ENV_VAR}=<its hostname>, spelled as it appears in ${channel.proxyVariable}. ${ALLOW_UNKNOWN_API_HOST_ENV_VAR} does not lift this: it acknowledges a host the URL names, not a hop the URL does not.`,
                `Whether the proxy applies to THIS host is the HTTP client's rule, not this server's — no_proxy is not re-implemented here — so strict posture may refuse a proxy axios would have bypassed for "${shown}".`,
              ]
            : []),
          ...(channel.trustStoreOverrides.length > 0
            ? [
                `There is no acknowledgement variable for a trust-store override. Unset ${channel.trustStoreOverrides.join(" / ")}, or set ${CREDENTIAL_CHANNEL_ENV_VAR}=warn to go back to being told rather than stopped.`,
              ]
            : []),
        ],
      };
    }
  }

  if (parsed.protocol === "http:") {
    // Permitted, but not on the grounds one first reaches for. "The request
    // never leaves this machine" is not something this check can promise: a
    // loopback listener is free to answer with a redirect, and whatever is
    // listening on 127.0.0.1 was not necessarily put there by the operator. The
    // real reason clear text is tolerable here is narrower — the bytes are not
    // exposed to the network on the FIRST hop. `maxRedirects: 0` on both
    // credential-bearing POSTs is what stops there being a second one.
    notes.push(
      "Plain http: to a loopback host — permitted because the first hop does not touch the network. A redirect cannot extend it: the token grant refuses to follow one.",
    );
  }
  return {
    allowed: true,
    hostname,
    recognised,
    acknowledged,
    notes,
    channelNotes: channel.notes,
    channelInformationalNotes: channel.informationalNotes,
  };
}

/**
 * Enforce {@link inspectCredentialTarget} at startup: print a banner nobody can
 * miss and, on a refusal, throw before a client capable of sending the credentials
 * is ever constructed.
 *
 * Refusing to start rather than starting-and-declining is deliberate, and it is the
 * opposite of what `isReadOnlyModeEnabled` does for an unrecognised value: read-only
 * mode is a SAFE state to keep running in, so serving the read tools beats an opaque
 * disconnect. An unrecognised credential target is not a safe state — every extra
 * code path that could reach the client is another chance to leak — and the operator
 * has a diagnostic that prints the whole explanation on demand. Not starting is the
 * only outcome that guarantees the token stays put.
 *
 * @returns the decision, for tests and for the caller's logging.
 */
export function assertCredentialTargetAllowed(
  apiUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CredentialTargetDecision {
  const decision = inspectCredentialTarget(apiUrl, env);

  if (!decision.allowed) {
    console.error(
      [
        "",
        "**************************************************************",
        "*  REFUSING TO START: UNSAFE CREDENTIAL DESTINATION          *",
        "**************************************************************",
        `  ${decision.refusal}`,
        "",
        "  This server holds a tastytrade OAuth refresh token and client",
        "  secret. They are POSTed to the configured API URL on the first",
        "  request, so an endpoint it cannot vouch for is an endpoint it",
        "  will not authenticate against.",
        "",
        ...decision.notes.map((n) => `  ${n}`),
        "**************************************************************",
        "",
      ].join("\n"),
    );
    throw toolError({
      code: "validation",
      message: `Refusing to start: ${decision.refusal}`,
      retryable: false,
      hint: decision.notes.join(" "),
    });
  }

  if (!decision.recognised) {
    console.error(
      [
        "",
        "**************************************************************",
        "*  WARNING: UNRECOGNISED API HOST — CREDENTIALS GO THERE     *",
        "**************************************************************",
        // Clipped, both of them. This banner is on the ALLOWED path — the
        // server keeps running and re-prints it on every restart, into the log
        // file the MCP client persists — and it was the one path the cap never
        // reached: 400 KB of stderr per launch for a 200 KB host, unchanged by
        // the round of work that capped the refusals.
        `  API endpoint: ${clipUrlForMessage(apiUrl)}`,
        `  "${clipHostForMessage(decision.hostname)}" is not a tastytrade API host. It is allowed`,
        `  only because ${ALLOW_UNKNOWN_API_HOST_ENV_VAR} names it.`,
        "",
        "  The OAuth refresh token and client secret will be sent to this",
        "  host on the first request. A tastytrade refresh token is",
        "  long-lived and non-rotating: if this host is not one you control,",
        "  stop the server and rotate the credential now.",
        "",
        ...decision.notes.map((n) => `  ${n}`),
        `  Recognised hosts: ${KNOWN_API_HOSTS.join(", ")}.`,
        "**************************************************************",
        "",
      ].join("\n"),
    );
  }

  if (decision.channelNotes.length > 0) {
    // Its own banner, deliberately separate from the unrecognised-host one.
    // These two say different things — that banner is about which host the URL
    // names, this one is about the fact that the URL does not decide where
    // the bytes go — and the case this exists for is the one where the host is
    // perfectly ordinary and there is nothing else to print.
    console.error(
      [
        "",
        "**************************************************************",
        "*  NOTE: THE ENVIRONMENT CHANGES THE CREDENTIAL PATH         *",
        "**************************************************************",
        `  API endpoint: ${clipUrlForMessage(apiUrl)}`,
        "",
        "  The host above was checked against the recognised list. What",
        "  carries the request to it is decided elsewhere, by the",
        "  variables below — this server cannot vouch for those, so it",
        "  names them instead of implying they are not there.",
        "",
        // The posture, stated on the banner that reports it, so an
        // operator reading stderr knows whether the server WOULD have refused —
        // rather than having to know that a second variable exists.
        `  ${CREDENTIAL_CHANNEL_ENV_VAR} is not set to "strict", so this is a`,
        '  note and the server is starting. Set it to "strict" to refuse',
        `  instead, and name your own gateway in ${ALLOW_PROXY_ENV_VAR}.`,
        "",
        ...decision.channelNotes.map((n) => `  ${n}`),
        "**************************************************************",
        "",
      ].join("\n"),
    );
  }

  // Its own line, and no banner. An informational note is a true sentence about
  // a condition this process cannot observe — see
  // CredentialChannel.informationalNotes — and wrapping it in the banner above
  // would say "the environment CHANGES the credential path" about something that
  // may well be changing nothing. Printed all the same, because the server is
  // the process that CAN see its own `args`, so it is the one whose report on
  // this is worth anything.
  for (const note of decision.channelInformationalNotes) {
    console.error(`[tastytrade-mcp] note: ${note}`);
  }

  return decision;
}

/**
 * Longest operator-supplied URL this module will echo into a message.
 *
 * Deliberately the same number as `MAX_ECHOED_ARGUMENT_CHARS` in the dispatcher
 * and for the same reason: a hostile value must not be able to make the message
 * that explains it unbounded. test/doctor.test.ts pins the two equal.
 */
export const MAX_ECHOED_URL_CHARS = 120;

/**
 * Render an operator-supplied URL for a refusal message: userinfo stripped,
 * then length capped.
 *
 * A refusal has to quote the value to be useful — "not a parseable URL" without
 * the value is a riddle — but the value itself can BE a credential. A URL may
 * carry Basic-auth userinfo (`https://ops:hunter2@host`), and these messages go
 * to stderr, which is where MCP clients collect and persist server logs, and
 * into the doctor's report, which the README invites an operator to paste into
 * an issue. So the userinfo-stripping renderer runs first and the cap second.
 * SECURITY.md promises this unconditionally; it has to be true on the unhappy
 * paths too, which are the ones a malformed-but-credentialed value takes.
 */
export function clipUrlForMessage(raw: string | undefined): string {
  return clipToCap(apiEndpointForDisplay(raw));
}

/**
 * Clip an already-safe fragment — a parsed hostname — to the same width.
 *
 * Separate from {@link clipUrlForMessage} because a hostname must not be run
 * through the URL renderer: that would try to find a scheme and an authority in
 * a string that is neither. The cap is the same one, and it has to be applied
 * here too. `MAX_ECHOED_URL_CHARS` promised the whole module was bounded while
 * only two of five refusal paths reached it; the unrecognised-host refusal, the
 * common path and the one this module exists for, interpolated the hostname
 * raw. A 200 KB `TASTYTRADE_API_URL` turned into 600 KB of stderr per restart,
 * into a log file an MCP client keeps.
 */
export function clipHostForMessage(hostname: string): string {
  return clipToCap(hostname);
}

function clipToCap(text: string): string {
  if (text.length <= MAX_ECHOED_URL_CHARS) return text;
  return `${text.slice(0, MAX_ECHOED_URL_CHARS)}…[truncated, ${text.length} chars]`;
}

/**
 * The configured API endpoint, rendered for logging: scheme, host and
 * non-default port, and nothing else.
 *
 * `TASTYTRADE_API_URL` is operator-supplied, and a URL may carry credentials in
 * its userinfo — `https://apiuser:s3cret@api.tastyworks.com`, which axios turns
 * into a Basic auth header. The live-trading banner printed the configured value
 * verbatim, so that password went to stderr, which is exactly where MCP clients
 * collect and persist server logs. Userinfo is a credential and is never echoed.
 * The path, query and fragment are dropped with it: they can carry a token just
 * as easily, and identifying the environment needs only the origin.
 */
export function apiEndpointForDisplay(apiUrl: string | undefined): string {
  if (!apiUrl) return "";
  try {
    const parsed = new URL(apiUrl);
    // `protocol` + `host`, not `origin`: origin is the literal string "null" for
    // every non-special scheme. An empty host means the value parsed as an
    // opaque path ("user:pw@host" is scheme `user:`), which the textual pass
    // below handles instead.
    if (parsed.host) return `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Not a parseable URL — and still reachable here, because
    // isProductionApiUrl falls back to a substring probe so a malformed but
    // production-looking value still trips the banner.
  }
  // Textual fallback: drop the userinfo FIRST, then keep what is left up to the
  // first `/`, `?` or `#`. The order is the whole fix — see splitUserinfo.
  const { scheme, rest } = splitUserinfo(apiUrl);
  let authority = rest;
  for (const stop of ["/", "?", "#"]) {
    const at = authority.indexOf(stop);
    if (at >= 0) authority = authority.slice(0, at);
  }
  return scheme + authority;
}

/**
 * Split a URL-shaped string that `new URL()` could not parse into its scheme, its
 * userinfo, and everything from the host onwards.
 *
 * THE LAST `@`, AND BEFORE THE AUTHORITY IS TRUNCATED. Truncating at the first
 * `/`, `?` or `#` and only THEN looking for the `@` leaks the credential: a
 * password containing one of those three — what an ordinary generated password
 * looks like pasted into a URL unencoded, and exactly why `new URL()` rejected it —
 * has its `@` cut away first, `lastIndexOf` finds nothing, and the "safe" rendering
 * returns the username and the password up to that character.
 *
 * A host can contain none of `/`, `?`, `#` or `@`, so after the last `@` the next
 * such character starts the path: taking the last `@` in the whole remainder is the
 * reading that cannot leave credential bytes in front of it.
 *
 * The cost, stated plainly: a `@` that genuinely belongs to a path is read as the
 * end of a userinfo, so `https://host:99999/a@b` renders as `https://b`. This path
 * is only reached for values that did not parse, where the structure is unknowable
 * — and the two errors are not symmetric: one prints an unhelpful origin, the other
 * prints a password.
 */
function splitUserinfo(raw: string): {
  scheme: string;
  userinfo?: string;
  rest: string;
} {
  const schemeEnd = raw.indexOf("://");
  const scheme = schemeEnd < 0 ? "" : raw.slice(0, schemeEnd + 3);
  const after = raw.slice(scheme.length);
  const at = after.lastIndexOf("@");
  if (at < 0) return { scheme, rest: after };
  const userinfo = after.slice(0, at);
  return {
    scheme,
    userinfo: userinfo === "" ? undefined : userinfo,
    rest: after.slice(at + 1),
  };
}

/**
 * The `userinfo` component of a URL-shaped string, or undefined when it has none.
 *
 * `https://ops:hunter2@host` is a Basic-auth password axios turns into an
 * Authorization header, so its PRESENCE is worth reporting and its VALUE never is.
 * The preflight uses both: the `userinfo: true` flag, and the literal its redactor
 * blanks out of anything the endpoint echoes back.
 *
 * It lives here rather than in src/doctor.ts because a byte-identical second copy
 * failed on the same input in complementary ways — the report printed the password
 * prefix and said `userinfo: false` in the same breath, so the "rotate it" warning
 * was suppressed at the one moment it was earned.
 *
 * The parser answers first for anything it can parse: it knows the `@` in
 * `https://host.example/a@b` belongs to the path, which no textual rule can decide
 * without re-implementing WHATWG's authority state. The textual pass is for the
 * values it rejects — the ones carrying a credential in a shape nobody meant.
 */
export function urlUserinfo(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.host) {
      const info = parsed.password
        ? `${parsed.username}:${parsed.password}`
        : parsed.username;
      return info === "" ? undefined : info;
    }
  } catch {
    // Falls through to the textual pass, which is what this is for.
  }
  // No `://` means this is not a URL at all — an email address, a bare host, a
  // path. Guessing a userinfo out of it produces false "you have a credential
  // in your URL" warnings on values that have none.
  if (!raw.includes("://")) return undefined;
  return splitUserinfo(raw).userinfo;
}

/**
 * The text before an `@` that the URL grammar did NOT read as a userinfo
 * delimiter, or undefined when the value has no such `@`.
 *
 * `https://ops:12345/S3cretPassw0rd@api.cert.tastyworks.com` parses: WHATWG ends
 * the authority at the first `/`, so the host is `ops`, the port `12345` and the
 * rest a path — and with no `@` inside the authority, `parsed.username` and
 * `parsed.password` are both empty. {@link urlUserinfo} correctly answers "none",
 * so an operator who pasted a username and password into the URL is told nothing:
 * no "rotate this", and the password never reaches the redactor. All it takes is a
 * password whose leading characters spell a valid port.
 *
 * The rule is the `@`, not a guess about intent. This also fires for
 * `https://host.example/a@b`, where the `@` belongs to a path — distinguishing
 * them needs a guess that is wrong in the dangerous direction as often as the safe
 * one, and the caller's sentence is conditional either way.
 *
 * The value returned is the candidate userinfo, for the redactor. Callers must not
 * print it: on the shape this exists for, it IS the password.
 */
export function atSignOutsideUserinfo(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.includes("://")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Did not parse, so `urlUserinfo`'s textual pass already reads the last
    // `@` as the userinfo delimiter and already answers for this value. Saying
    // it twice would double every warning on the unparseable path.
    return undefined;
  }
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  const afterAuthority = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!afterAuthority.includes("@")) return undefined;
  return splitUserinfo(value).userinfo;
}
