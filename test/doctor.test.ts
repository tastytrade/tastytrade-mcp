/**
 * The operator preflight command — `src/doctor.ts`.
 *
 * Everything here runs OFFLINE and deterministically. The doctor's four side effects
 * (DNS, TCP/TLS, HTTP, filesystem) are injected through DoctorDeps, and the default
 * adapter in `makeDeps` REJECTS every request, so a test that forgets to route an
 * HTTP call fails loudly instead of silently reaching the real API. No test depends
 * on a hostname resolving.
 *
 * The HTTP seam is the same axios adapter seam the server's harness uses, so the
 * token grant and the account fetch exercise the real request path — real URL
 * construction, real headers, real envelope unwrapping — with only the transport
 * replaced.
 *
 * Two classes of test earn their keep beyond the per-check assertions. DRIFT GUARDS:
 * the doctor keeps local copies of four values that also live in the dispatcher,
 * because importing the dispatcher would load the static resource modules, which read
 * the vendored docs at module load and throw when one is missing — the very fault
 * check 11 exists to report. The copies are pinned against the originals below. And
 * THE LEAK GUARD: the whole command is worthless if it prints a credential into a
 * terminal that ends up in a bug report, so the rendered report AND the --json
 * payload are searched for the configured secret, including where the token endpoint
 * echoes it back inside `error_description`.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import {
  CONNECT_TIMEOUT_MS,
  EXIT_USAGE,
  EXIT_WARN,
  deriveVerdict,
  exitCodeFor,
  HTTP_TIMEOUT_MS,
  PRODUCTION_API_URL,
  READ_ONLY_ENV_VAR,
  REQUIRED_CREDENTIAL_VARS,
  SANDBOX_API_URL,
  SHOW_ACCOUNTS_FLAG,
  USAGE,
  abbreviateHome,
  classifyApiHost,
  classifyReadOnly,
  decodeJwt,
  defaultDeps,
  MAX_DETAILS_PER_CHECK,
  MAX_REPORT_LINE_CHARS,
  formatReport,
  inspectAccounts,
  inspectApiUrl,
  inspectConnectivity,
  urlUserinfo,
  UNVERIFIED_CERT_MARKER,
  inspectCredentials,
  inspectDns,
  inspectNotionalCap,
  inspectReadOnly,
  inspectRefreshTokenClaims,
  inspectTokenGrant,
  inspectTokenScope,
  inspectVendoredDocs,
  isDirectInvocation,
  main,
  makeRedactor,
  maskAccountNumber,
  parseArgs,
  parseScopeList,
  reportToJson,
  runDoctor,
} from "../src/doctor.js";
import type {
  CheckResult,
  CheckStatus,
  DoctorDeps,
  DoctorReport,
  DoctorVerdict,
} from "../src/doctor.js";
// Imported from the DISPATCHER, deliberately: what has to hold is that the
// doctor agrees with the module the server actually enforces, not merely with
// the shared module both of them import.
import {
  SANDBOX_API_URL as DISPATCHER_SANDBOX_API_URL,
  PRODUCTION_API_URL as DISPATCHER_PRODUCTION_API_URL,
  READ_ONLY_ENV_VAR as DISPATCHER_READ_ONLY_ENV_VAR,
  ALLOW_UNKNOWN_API_HOST_ENV_VAR,
  KNOWN_API_HOSTS,
  MAX_ECHOED_ARGUMENT_CHARS,
  inspectCredentialTarget,
  isProductionApiUrl,
  isReadOnlyModeEnabled,
  resolveApiUrl,
} from "../src/mcp-server/index.js";
import {
  MAX_ECHOED_URL_CHARS,
  SWAPPED_DOMAIN_HOSTS,
  SWAPPED_DOMAIN_NOTE as GUARD_SWAPPED_DOMAIN_NOTE,
  assertCredentialTargetAllowed,
  atSignOutsideUserinfo,
  clipUrlForMessage,
} from "../src/credential-target.js";
import { DEFAULT_MAX_ORDER_NOTIONAL_USD } from "../src/safety/sanity-checks.js";
import { REDACTED } from "../src/safety/errors.js";
import { isDisplayHostileCodepoint } from "../src/safety/bounded-text.js";
import { DEFAULT_USER_AGENT } from "../src/version.js";
import { REQUIRED_DOCS } from "../src/resources/static/vendored-docs.js";

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Frozen clock, so `iat` / `exp` prose is byte-stable. */
const NOW_MS = Date.parse("2026-08-15T12:00:00.000Z");

const CLIENT_ID = "0d1f2a3b-client-id";
const CLIENT_SECRET = "sekrit-value-that-must-never-print";

function makeJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const enc = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc(header)}.${enc(payload)}.c2lnbmF0dXJl`;
}

/** A well-formed sandbox refresh token whose claims agree with everything. */
const GOOD_REFRESH_TOKEN = makeJwt(
  { typ: "rt+jwt", alg: "RS256" },
  {
    iss: "https://api.cert.tastyworks.com",
    aud: CLIENT_ID,
    scope: "read trade openid",
    iat: Math.floor(NOW_MS / 1000) - 3600,
  },
);

interface RecordedRequest {
  method: string;
  /** Path as the caller passed it (relative for the API client). */
  url: string;
  baseUrl?: string;
  headers: Record<string, string>;
  body: unknown;
}

interface RouteReply {
  status: number;
  data: unknown;
}

interface FakeHttp {
  adapter: DoctorDeps["adapter"];
  requests: RecordedRequest[];
}

/**
 * An axios adapter built from a handler. Returning a RouteReply settles the
 * request with that status (whatever it is — the doctor's grant call sets
 * validateStatus so 4xx resolves); returning an Error rejects it, which is how a
 * transport failure and a throwing API client are simulated.
 */
function makeHttp(
  handler: (req: RecordedRequest) => RouteReply | Error,
): FakeHttp {
  const requests: RecordedRequest[] = [];
  const adapter = async (
    config: InternalAxiosRequestConfig,
  ): Promise<AxiosResponse> => {
    const rawHeaders =
      typeof (config.headers as { toJSON?: () => unknown })?.toJSON ===
      "function"
        ? ((config.headers as { toJSON: () => unknown }).toJSON() as Record<
            string,
            unknown
          >)
        : ((config.headers ?? {}) as Record<string, unknown>);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k.toLowerCase()] = String(v);
    }
    let body: unknown = config.data;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave the raw string */
      }
    }
    const recorded: RecordedRequest = {
      method: (config.method ?? "get").toLowerCase(),
      url: config.url ?? "",
      baseUrl: config.baseURL,
      headers,
      body,
    };
    requests.push(recorded);
    const outcome = handler(recorded);
    if (outcome instanceof Error) throw outcome;
    return {
      data: outcome.data,
      status: outcome.status,
      statusText: String(outcome.status),
      headers: {},
      config,
    } as AxiosResponse;
  };
  return { adapter, requests };
}

/** Routes the two calls a fully healthy run makes. */
function healthyHttp(
  overrides: { token?: RouteReply | Error; accounts?: RouteReply | Error } = {},
): FakeHttp {
  return makeHttp((req) => {
    if (req.url.includes("/oauth/token")) {
      return (
        overrides.token ?? {
          status: 200,
          data: {
            access_token: "at-".padEnd(48, "x"),
            token_type: "Bearer",
            expires_in: 900,
            scope: "read trade openid",
          },
        }
      );
    }
    if (req.url.includes("/customers/me/accounts")) {
      return (
        overrides.accounts ?? {
          status: 200,
          data: {
            data: {
              items: [
                {
                  account: {
                    "account-number": "5WT00001",
                    nickname: "Sandbox",
                    "margin-or-cash": "Margin",
                    "account-type-name": "Individual",
                    "is-closed": false,
                  },
                  "authority-level": "owner",
                },
              ],
            },
          },
        }
      );
    }
    return new Error(`unrouted request: ${req.url}`);
  });
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: {},
    lookupHost: async () => ["203.0.113.10"],
    probeConnection: async () => "TCP connection opened",
    fileExists: () => true,
    now: () => NOW_MS,
    // Fails closed: any HTTP call a test did not deliberately route is an
    // error, never a real request to the internet.
    adapter: async () => {
      throw new Error("no HTTP route configured in this test");
    },
    ...overrides,
  };
}

/** The environment of a healthy sandbox deployment. */
function healthyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TASTYTRADE_CLIENT_ID: CLIENT_ID,
    TASTYTRADE_CLIENT_SECRET: CLIENT_SECRET,
    TASTYTRADE_REFRESH_TOKEN: GOOD_REFRESH_TOKEN,
    ...extra,
  };
}

function byId(report: DoctorReport, id: string): CheckResult {
  const check = report.checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check with id "${id}"`);
  return check;
}

const noRedaction = (text: string) => text;

const HTTPS_TARGET = {
  host: "api.cert.tastyworks.com",
  port: 443,
  secure: true,
};

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Drift guards: the doctor's local copies must equal the server's originals
// ---------------------------------------------------------------------------

describe("configuration copied from the dispatcher", () => {
  it("pins the two base URLs and the read-only variable name", () => {
    expect(SANDBOX_API_URL).toBe(DISPATCHER_SANDBOX_API_URL);
    expect(PRODUCTION_API_URL).toBe(DISPATCHER_PRODUCTION_API_URL);
    expect(READ_ONLY_ENV_VAR).toBe(DISPATCHER_READ_ONLY_ENV_VAR);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["  TRUE  ", true],
    ["0", false],
    ["false", false],
    ["", false],
    // Fail-closed: an unrecognised value ENABLES read-only mode.
    ["yes", true],
    ["on", true],
    ["Y", true],
  ])(
    "classifies %s exactly as the dispatcher does (enabled=%s)",
    (raw, expected) => {
      // The dispatcher prints a banner for unrecognised values; the doctor never
      // does, which is the only intended difference.
      const stderr = jest.spyOn(console, "error").mockImplementation(() => {});
      const env = { [READ_ONLY_ENV_VAR]: raw };
      expect(classifyReadOnly(env).enabled).toBe(expected);
      expect(isReadOnlyModeEnabled(env)).toBe(expected);
      stderr.mockRestore();
    },
  );

  it("treats the variable being unset the same way the dispatcher does", () => {
    expect(classifyReadOnly({}).enabled).toBe(false);
    expect(isReadOnlyModeEnabled({})).toBe(false);
  });

  it.each([
    [undefined, SANDBOX_API_URL],
    ["", SANDBOX_API_URL],
    ["   ", SANDBOX_API_URL],
    ["  https://api.tastyworks.com  ", "https://api.tastyworks.com"],
    ["https://example.test", "https://example.test"],
  ])("resolves TASTYTRADE_API_URL=%s like the dispatcher", (raw, expected) => {
    const env: NodeJS.ProcessEnv =
      raw === undefined ? {} : { TASTYTRADE_API_URL: raw };
    expect(inspectApiUrl(env).apiUrl).toBe(expected);
    expect(resolveApiUrl(env)).toBe(expected);
  });

  it("takes the notional-cap default from the safety layer", () => {
    const check = inspectNotionalCap({});
    expect(check.data?.limit).toBe(DEFAULT_MAX_ORDER_NOTIONAL_USD);
  });

  it("is wired up as a bin entry pointing at the compiled doctor", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { bin?: Record<string, string>; files?: string[] };
    expect(pkg.bin).toBeDefined();
    const targets = Object.values(pkg.bin ?? {});
    expect(targets).toContain("dist/doctor.js");
    // dist/ must stay in `files` or an installed package has no bin target.
    expect(pkg.files).toContain("dist");
  });

  it("keeps the shebang first in the source, so the bin link is executable", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src", "doctor.ts"),
      "utf8",
    );
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Check 1 — credentials
// ---------------------------------------------------------------------------

describe("check 1: credentials", () => {
  it("passes when all three are set and reports lengths, never values", () => {
    const state = inspectCredentials(healthyEnv());
    expect(state.check.status).toBe("pass");
    expect(state.complete).toBe(true);
    const rendered = state.check.details.join("\n");
    for (const name of REQUIRED_CREDENTIAL_VARS) {
      expect(rendered).toContain(name);
    }
    expect(rendered).toContain(`set, ${CLIENT_SECRET.length} characters`);
    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).not.toContain(GOOD_REFRESH_TOKEN);
    expect(state.check.data?.lengths).toEqual({
      TASTYTRADE_CLIENT_ID: CLIENT_ID.length,
      TASTYTRADE_CLIENT_SECRET: CLIENT_SECRET.length,
      TASTYTRADE_REFRESH_TOKEN: GOOD_REFRESH_TOKEN.length,
    });
  });

  it("fails naming every missing variable, and blank counts as missing", () => {
    const state = inspectCredentials({
      TASTYTRADE_CLIENT_SECRET: "   ",
    });
    expect(state.check.status).toBe("fail");
    expect(state.complete).toBe(false);
    expect(state.check.summary).toContain("TASTYTRADE_CLIENT_ID");
    expect(state.check.summary).toContain("TASTYTRADE_CLIENT_SECRET");
    expect(state.check.summary).toContain("TASTYTRADE_REFRESH_TOKEN");
    expect(state.check.data?.missing).toEqual([...REQUIRED_CREDENTIAL_VARS]);
  });

  it("warns on surrounding whitespace, because the value is sent verbatim", () => {
    const state = inspectCredentials(
      healthyEnv({ TASTYTRADE_CLIENT_SECRET: ` ${CLIENT_SECRET}\n` }),
    );
    expect(state.check.status).toBe("warn");
    expect(state.check.details.join("\n")).toContain(
      "TASTYTRADE_CLIENT_SECRET has leading or trailing whitespace",
    );
  });

  it("warns when a value is still wrapped in quote characters", () => {
    const state = inspectCredentials(
      healthyEnv({ TASTYTRADE_CLIENT_SECRET: `"${CLIENT_SECRET}"` }),
    );
    expect(state.check.status).toBe("warn");
    expect(state.check.details.join("\n")).toContain(
      "is wrapped in quote characters",
    );
  });

  it("catches the mislabelled-token case: a client id that is itself a JWT", () => {
    // The exact fault that cost an hour of archaeology — the value labelled
    // "client key" was a refresh token, and its `aud` was the real client id.
    const state = inspectCredentials(
      healthyEnv({ TASTYTRADE_CLIENT_ID: GOOD_REFRESH_TOKEN }),
    );
    expect(state.check.status).toBe("warn");
    const rendered = state.check.details.join("\n");
    expect(rendered).toContain("TASTYTRADE_CLIENT_ID is itself a JWT");
    expect(rendered).toContain("header typ=rt+jwt");
    expect(rendered).toContain('"aud" claim is the client id');
  });

  it("does not flag the refresh token itself for being a JWT", () => {
    const state = inspectCredentials(healthyEnv());
    expect(state.check.details.join("\n")).not.toContain("is itself a JWT");
  });
});

// ---------------------------------------------------------------------------
// Check 2 — API endpoint
// ---------------------------------------------------------------------------

describe("check 2: API endpoint", () => {
  it("passes and names the sandbox when the variable is unset", () => {
    const state = inspectApiUrl({});
    expect(state.check.status).toBe("pass");
    expect(state.apiUrl).toBe(SANDBOX_API_URL);
    expect(state.target).toEqual({
      host: "api.cert.tastyworks.com",
      port: 443,
      secure: true,
    });
    expect(state.check.details.join("\n")).toContain(
      "TASTYTRADE_API_URL is unset",
    );
    expect(state.check.data?.environment).toBe("sandbox");
  });

  it("warns loudly for production", () => {
    const state = inspectApiUrl({ TASTYTRADE_API_URL: PRODUCTION_API_URL });
    expect(state.check.status).toBe("warn");
    expect(state.check.summary).toContain("PRODUCTION");
    expect(state.check.summary).toContain("real money");
    expect(state.check.data?.production).toBe(true);
    expect(state.check.details.join("\n")).toContain(READ_ONLY_ENV_VAR);
  });

  it("passes for the other sandbox, on the other domain", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.sandbox.tastytrade.com",
    });
    expect(state.check.status).toBe("pass");
    expect(state.check.data?.environment).toBe("sandbox");
  });

  it("fails, and explains the twin-domain trap, when the domains are crossed", () => {
    // A swapped-domain host is not an endpoint, so the server refuses to start
    // on it — and this check reports that refusal rather than a warning. The
    // trap is still spelled out: the refusal is not allowed to cost the
    // diagnosis, which is the whole reason this command exists.
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.sandbox.tastyworks.com",
    });
    expect(state.check.status).toBe("fail");
    expect(state.credentialTarget.allowed).toBe(false);
    expect(state.check.data?.environment).toBe("swapped-domain");
    const rendered = state.check.details.join("\n");
    expect(rendered).toContain("api.cert` on tastyworks.com");
    expect(rendered).toContain("api.sandbox` on tastytrade.com");
    expect(rendered).toContain("https://api.sandbox.tastytrade.com");
    // Said ONCE. The guard carries its own shorter version of this note; the
    // version above is the longer one, because it names the two URLs that work.
    // Printing both makes the report look like it is stuttering at the operator.
    expect(rendered.match(/DIFFERENT domains/g)).toHaveLength(1);
    expect(rendered).not.toContain(GUARD_SWAPPED_DOMAIN_NOTE);
  });

  it("fails, and blocks the network checks, when the URL will not parse", () => {
    const state = inspectApiUrl({ TASTYTRADE_API_URL: "api.cert.tastyworks" });
    expect(state.check.status).toBe("fail");
    expect(state.target).toBeUndefined();
    expect(state.check.data?.parseable).toBe(false);
  });

  it("fails on a scheme the HTTP client cannot speak", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "ftp://api.cert.tastyworks.com",
    });
    expect(state.check.status).toBe("fail");
    expect(state.check.summary).toContain("ftp:");
    expect(state.target).toBeUndefined();
  });

  it("FAILS on plaintext http to a real host, and reports the default port", () => {
    // The downgrade is the attack: over http: the refresh token and client
    // secret cross the network in the clear. The server refuses this with no
    // escape hatch at all, so warning about it here — which is what this check
    // would do, four checks before performing the grant — was the leak.
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "http://api.cert.tastyworks.com",
    });
    expect(state.check.status).toBe("fail");
    expect(state.credentialTarget.allowed).toBe(false);
    // The target is still resolved: DNS and the TCP probe send no credential,
    // and their answers are worth having.
    expect(state.target).toEqual({
      host: "api.cert.tastyworks.com",
      port: 80,
      secure: false,
    });
    expect(state.check.details.join("\n")).toContain("clear text");
  });

  it("admits plaintext http to loopback, and says why it is tolerable", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "http://127.0.0.1:18443",
      TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "127.0.0.1",
    });
    expect(state.check.status).toBe("warn");
    expect(state.credentialTarget.allowed).toBe(true);
    // Asserts the reasoning, not the sentence: clear text is tolerable here
    // because the hop stays off the network. It must NOT claim the request can
    // never leave the machine — a loopback listener can answer with a redirect,
    // and that promise would be false. See test/credential-redirect.test.ts,
    // which proves the grant refuses to follow one.
    const details = state.check.details.join("\n");
    expect(details).toMatch(/loopback/i);
    expect(details).not.toMatch(/never leaves this machine/);
  });

  it("keeps an explicit port", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.cert.tastyworks.com:8443",
    });
    expect(state.target?.port).toBe(8443);
  });

  it("warns about a trailing slash, which changes every request path", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.cert.tastyworks.com/",
    });
    expect(state.check.status).toBe("warn");
    expect(state.check.details.join("\n")).toContain("trailing slash");
  });

  it("keeps production a warning even when the URL also has a path", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: `${PRODUCTION_API_URL}/v1`,
    });
    expect(state.check.status).toBe("warn");
    expect(state.check.summary).toContain("PRODUCTION");
    expect(state.check.details.join("\n")).toContain("carries a path");
  });

  it("FAILS for a host it does not recognise, and names the way through", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.example.test",
    });
    expect(state.check.status).toBe("fail");
    expect(state.check.data?.environment).toBe("unknown");
    const rendered = state.check.details.join("\n");
    expect(rendered).toContain(
      "not a tastytrade API host this server recognises",
    );
    // The report has to name the variable AND the host, or a legitimate proxy
    // deployment is left with a preflight it cannot get past.
    expect(rendered).toContain(
      "TASTYTRADE_ALLOW_UNKNOWN_API_HOST=api.example.test",
    );
    expect(rendered).toContain(
      "the grant, the token scope and the account checks are skipped",
    );
  });

  it("warns, not fails, once the operator has acknowledged that host by name", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://proxy.internal:8443",
      TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "proxy.internal",
    });
    expect(state.check.status).toBe("warn");
    expect(state.credentialTarget.allowed).toBe(true);
    expect(state.credentialTarget.acknowledged).toBe(true);
    const rendered = state.check.details.join("\n");
    expect(rendered).toContain("WILL be sent to it");
    expect(rendered).toContain("rotate the credential");
    // It is the operator's own infrastructure being described from here on.
    expect(rendered).toContain("redact them before pasting");
  });

  it.each([
    ["api.tastyworks.com", "production"],
    ["API.TASTYWORKS.COM", "production"],
    ["api.cert.tastyworks.com", "sandbox"],
    ["api.sandbox.tastytrade.com", "sandbox"],
    ["api.sandbox.tastyworks.com", "swapped-domain"],
    ["api.cert.tastytrade.com", "swapped-domain"],
    ["localhost", "unknown"],
  ])("classifies %s as %s", (host, environment) => {
    expect(classifyApiHost(host).environment).toBe(environment);
  });
});

// ---------------------------------------------------------------------------
// Checks 3 and 4 — DNS and reachability
// ---------------------------------------------------------------------------

describe("check 3: DNS", () => {
  it("passes and lists the addresses", async () => {
    const deps = makeDeps({
      lookupHost: async () => ["203.0.113.10", "2001:db8::1"],
    });
    const check = await inspectDns(deps, HTTPS_TARGET, undefined, noRedaction);
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain("203.0.113.10, 2001:db8::1");
    expect(check.data?.resolved).toBe(true);
  });

  it("fails on NXDOMAIN and explains the twin-domain trap", async () => {
    const err = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.sandbox.tastyworks.com"),
      { code: "ENOTFOUND" },
    );
    const deps = makeDeps({
      lookupHost: async () => {
        throw err;
      },
    });
    const check = await inspectDns(
      deps,
      { host: "api.sandbox.tastyworks.com", port: 443, secure: true },
      classifyApiHost("api.sandbox.tastyworks.com"),
      noRedaction,
    );
    expect(check.status).toBe("fail");
    expect(check.summary).toContain("does not resolve");
    const rendered = check.details.join("\n");
    expect(rendered).toContain("ENOTFOUND");
    expect(rendered).toContain("https://api.sandbox.tastytrade.com");
    expect(check.data?.code).toBe("ENOTFOUND");
  });

  it("fails when the lookup succeeds with no addresses", async () => {
    const deps = makeDeps({ lookupHost: async () => [] });
    const check = await inspectDns(deps, HTTPS_TARGET, undefined, noRedaction);
    expect(check.status).toBe("fail");
    expect(check.summary).toContain("no addresses");
  });

  it("reports a non-NXDOMAIN failure without the domain lecture", async () => {
    const deps = makeDeps({
      lookupHost: async () => {
        throw Object.assign(new Error("Temporary failure"), {
          code: "EAI_AGAIN",
        });
      },
    });
    const check = await inspectDns(deps, HTTPS_TARGET, undefined, noRedaction);
    expect(check.status).toBe("fail");
    expect(check.details.join("\n")).toContain("EAI_AGAIN");
    expect(check.details.join("\n")).not.toContain("DIFFERENT domains");
  });
});

describe("check 4: TCP/TLS reachability", () => {
  it("passes with the probe's own detail line", async () => {
    const deps = makeDeps({
      probeConnection: async (target) => {
        expect(target).toEqual(HTTPS_TARGET);
        return "TLS handshake completed (TLSv1.3, certificate verified)";
      },
    });
    const outcome = await inspectConnectivity(deps, HTTPS_TARGET, noRedaction);
    expect(outcome.check.status).toBe("pass");
    expect(outcome.check.title).toBe("TCP/TLS reachability");
    expect(outcome.check.details[0]).toContain("TLSv1.3");
    expect(outcome.reachable).toBe(true);
  });

  it("WARNS when the handshake completed without verifying the certificate", async () => {
    // Reachable whenever the environment disables verification
    // (NODE_TLS_REJECT_UNAUTHORIZED=0) — the TLS-inspecting-proxy case, which is
    // the same population that needs the unknown-host acknowledgement. The
    // credentials cross that session, so it does not get to be an [ ok ] with a
    // sentence underneath.
    const deps = makeDeps({
      probeConnection: async () =>
        `TLS handshake completed (TLSv1.3, ${UNVERIFIED_CERT_MARKER}: SELF_SIGNED_CERT_IN_CHAIN)`,
    });
    const outcome = await inspectConnectivity(deps, HTTPS_TARGET, noRedaction);
    expect(outcome.check.status).toBe("warn");
    expect(outcome.check.summary).toContain("NOT verified");
    expect(outcome.check.data?.certificate_verified).toBe(false);
    expect(outcome.check.details.join("\n")).toContain(
      "NODE_TLS_REJECT_UNAUTHORIZED",
    );
    // The port answered. A caveat about what the session is worth is not the
    // same statement as "there is nothing there", and conflating the two is
    // what let a caveat disable the three checks that follow.
    expect(outcome.reachable).toBe(true);
  });

  it("does not look for a certificate on a plaintext probe", async () => {
    const deps = makeDeps({
      probeConnection: async () => `TCP connection opened`,
    });
    const { check } = await inspectConnectivity(
      deps,
      { host: "127.0.0.1", port: 18443, secure: false },
      noRedaction,
    );
    expect(check.status).toBe("pass");
    expect(check.data?.certificate_verified).toBeUndefined();
  });

  it("titles itself TCP-only for a plaintext endpoint", async () => {
    const deps = makeDeps({ probeConnection: async () => "TCP opened" });
    const { check } = await inspectConnectivity(
      deps,
      { host: "localhost", port: 80, secure: false },
      noRedaction,
    );
    expect(check.title).toBe("TCP reachability");
  });

  it("fails with the error code when the port does not answer", async () => {
    const deps = makeDeps({
      probeConnection: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      },
    });
    const outcome = await inspectConnectivity(deps, HTTPS_TARGET, noRedaction);
    expect(outcome.check.status).toBe("fail");
    expect(outcome.check.details.join("\n")).toContain("ECONNREFUSED");
    expect(outcome.check.details.join("\n")).toContain("proxy");
    expect(outcome.check.data?.reachable).toBe(false);
    expect(outcome.reachable).toBe(false);
  });

  it("reports a codeless failure without an empty prefix", async () => {
    const deps = makeDeps({
      probeConnection: async () => {
        throw new Error("no answer within 5000ms");
      },
    });
    const { check } = await inspectConnectivity(
      deps,
      HTTPS_TARGET,
      noRedaction,
    );
    expect(check.status).toBe("fail");
    expect(check.details[0]).toBe("no answer within 5000ms");
  });

  it("exposes the timeouts it applies, so they can be documented", () => {
    expect(CONNECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(HTTP_TIMEOUT_MS).toBeGreaterThan(CONNECT_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// Check 5 — JWT claims, decoded offline
// ---------------------------------------------------------------------------

describe("decodeJwt", () => {
  it("decodes a three-segment token", () => {
    const parts = decodeJwt(GOOD_REFRESH_TOKEN);
    expect(parts?.header.typ).toBe("rt+jwt");
    expect(parts?.payload.aud).toBe(CLIENT_ID);
  });

  it.each([
    ["opaque-token"],
    ["only.two"],
    ["a.b.c.d"],
    ["!!!.eyJhIjoxfQ.sig"],
    [".eyJhIjoxfQ.sig"],
    ["eyJhIjoxfQ..sig"],
    // base64url of `[1,2]` and of `"str"` — valid JSON, not an object.
    ["WzEsMl0.WzEsMl0.sig"],
    ["InN0ciI.InN0ciI.sig"],
    // base64url of `not json`
    ["bm90IGpzb24.bm90IGpzb24.sig"],
    [""],
  ])("returns undefined for %s", (value) => {
    expect(decodeJwt(value)).toBeUndefined();
  });
});

describe("parseScopeList", () => {
  it.each([
    ["read trade", ["read", "trade"]],
    ["  read   trade  ", ["read", "trade"]],
    ["", []],
  ])("splits the OAuth string %s", (raw, expected) => {
    expect(parseScopeList(raw)).toEqual(expected);
  });

  it("accepts an array and drops non-strings", () => {
    expect(parseScopeList(["read", 7, "trade"])).toEqual(["read", "trade"]);
  });

  it("returns nothing for an absent or unusable value", () => {
    expect(parseScopeList(undefined)).toEqual([]);
    expect(parseScopeList({ read: true })).toEqual([]);
  });
});

describe("check 5: refresh-token claims", () => {
  function claimsFor(
    payload: Record<string, unknown>,
    env: NodeJS.ProcessEnv = {},
    header: Record<string, unknown> = { typ: "rt+jwt", alg: "RS256" },
  ): CheckResult {
    const token = makeJwt(header, payload);
    const fullEnv = healthyEnv({ TASTYTRADE_REFRESH_TOKEN: token, ...env });
    const deps = makeDeps({ env: fullEnv });
    return inspectRefreshTokenClaims(
      deps,
      inspectCredentials(fullEnv),
      inspectApiUrl(fullEnv),
    );
  }

  // `describeEpochClaim` has the same shape as the OAuth
  // client's lifetime arithmetic one module away — a finiteness gate on the
  // operand, a multiplication, and no re-check of the product — and here the
  // consequence is a thrown RangeError from `new Date(ms).toISOString()`: the
  // diagnostic crashing on the very token it was asked to explain. A claim
  // outside Date's +/-8.64e15 ms range is not a date, so the honest answer is to
  // report it as unreadable rather than to throw.
  it.each([1e15, 1e306, -1e15, 8.64e12, 8.64e12 + 1])(
    "does not throw on an out-of-range exp claim: %p",
    (exp) => {
      let check: CheckResult | undefined;
      expect(() => {
        check = claimsFor({ aud: CLIENT_ID, exp });
      }).not.toThrow();
      expect(check).toBeDefined();
      // And it still says something about the token rather than going silent
      // about the whole check.
      expect(check!.details.length).toBeGreaterThan(0);
    },
  );

  it("skips when there is no refresh token to inspect", () => {
    const env = { TASTYTRADE_CLIENT_ID: CLIENT_ID };
    const check = inspectRefreshTokenClaims(
      makeDeps({ env }),
      inspectCredentials(env),
      inspectApiUrl(env),
    );
    expect(check.status).toBe("skip");
  });

  it("passes on an opaque token, and says the endpoint is the authority", () => {
    const env = healthyEnv({ TASTYTRADE_REFRESH_TOKEN: "opaque-value" });
    const check = inspectRefreshTokenClaims(
      makeDeps({ env }),
      inspectCredentials(env),
      inspectApiUrl(env),
    );
    expect(check.status).toBe("pass");
    expect(check.data?.jwt).toBe(false);
    expect(check.details.join("\n")).toContain("check 6");
  });

  it("reports iss, aud, scope and issue time, and cross-checks both", () => {
    const check = claimsFor({
      iss: SANDBOX_API_URL,
      aud: CLIENT_ID,
      scope: "read trade openid",
      iat: Math.floor(NOW_MS / 1000) - 2 * 86_400,
    });
    expect(check.status).toBe("pass");
    const rendered = check.details.join("\n");
    expect(rendered).toContain(`iss:   ${SANDBOX_API_URL}`);
    expect(rendered).toContain(`aud:   ${CLIENT_ID}`);
    expect(rendered).toContain("scope: read trade openid");
    expect(rendered).toContain("2026-08-13T12:00:00.000Z (2.0 days ago)");
    expect(rendered).toContain("`aud` matches TASTYTRADE_CLIENT_ID");
    expect(rendered).toContain("`iss` host matches TASTYTRADE_API_URL");
    expect(check.data?.aud_matches_client_id).toBe(true);
  });

  it("fails when aud does not match the configured client id", () => {
    const check = claimsFor({
      iss: SANDBOX_API_URL,
      aud: "a-completely-different-client",
      iat: Math.floor(NOW_MS / 1000),
    });
    expect(check.status).toBe("fail");
    const rendered = check.details.join("\n");
    expect(rendered).toContain(
      "does not match TASTYTRADE_CLIENT_ID (configured value is",
    );
    // The aud IS the client id the token belongs to — printing it is the point.
    expect(rendered).toContain("a-completely-different-client");
    // ...but the configured value is described by length only.
    expect(rendered).toContain(`${CLIENT_ID.length} characters`);
    expect(check.data?.aud_matches_client_id).toBe(false);
  });

  it("accepts an aud array that contains the client id", () => {
    const check = claimsFor({
      iss: SANDBOX_API_URL,
      aud: ["someone-else", CLIENT_ID],
      iat: Math.floor(NOW_MS / 1000),
    });
    expect(check.status).toBe("pass");
    expect(check.data?.aud).toEqual(["someone-else", CLIENT_ID]);
  });

  it("says so rather than failing when there is no aud claim at all", () => {
    const check = claimsFor({ iss: SANDBOX_API_URL });
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain("No `aud` claim");
  });

  it("says so when the client id is missing instead of the aud", () => {
    const token = makeJwt({ typ: "rt+jwt" }, { aud: CLIENT_ID });
    const env = {
      TASTYTRADE_REFRESH_TOKEN: token,
      TASTYTRADE_CLIENT_SECRET: CLIENT_SECRET,
    };
    const check = inspectRefreshTokenClaims(
      makeDeps({ env }),
      inspectCredentials(env),
      inspectApiUrl(env),
    );
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain("TASTYTRADE_CLIENT_ID is unset");
  });

  it("fails when the token is an access token, not a refresh token", () => {
    const check = claimsFor(
      { iss: SANDBOX_API_URL, aud: CLIENT_ID },
      {},
      { typ: "at+jwt", alg: "RS256" },
    );
    expect(check.status).toBe("fail");
    expect(check.details.join("\n")).toContain("ACCESS token");
  });

  it("fails when the token has already expired", () => {
    const check = claimsFor({
      iss: SANDBOX_API_URL,
      aud: CLIENT_ID,
      iat: Math.floor(NOW_MS / 1000) - 7200,
      exp: Math.floor(NOW_MS / 1000) - 60,
    });
    expect(check.status).toBe("fail");
    const rendered = check.details.join("\n");
    expect(rendered).toContain("expired at");
    expect(rendered).toContain("1 minutes ago");
  });

  it("reports a future expiry without complaining", () => {
    const check = claimsFor({
      iss: SANDBOX_API_URL,
      aud: CLIENT_ID,
      exp: Math.floor(NOW_MS / 1000) + 30 * 86_400,
    });
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain("in 30.0 days");
  });

  it("fails when the token's issuer is a different environment entirely", () => {
    // The credential-set fault that produces 93 identical auth failures.
    const check = claimsFor(
      { iss: SANDBOX_API_URL, aud: CLIENT_ID },
      { TASTYTRADE_API_URL: PRODUCTION_API_URL },
    );
    expect(check.status).toBe("fail");
    expect(check.details.join("\n")).toContain(
      "Sandbox credentials never work against production",
    );
  });

  it("only warns when the issuer host is an unreachable alias of the same environment", () => {
    // Exactly the observed case: iss names api.sandbox.tastyworks.com while the
    // reachable host is api.sandbox.tastytrade.com.
    const check = claimsFor(
      { iss: "https://api.sandbox.tastyworks.com", aud: CLIENT_ID },
      { TASTYTRADE_API_URL: "https://api.sandbox.tastytrade.com" },
    );
    expect(check.status).toBe("warn");
    const rendered = check.details.join("\n");
    expect(rendered).toContain("vendor-internal alias");
    expect(rendered).toContain("DIFFERENT domains");
  });

  it("notes rather than fails when iss is not a URL", () => {
    const check = claimsFor({ iss: "tastytrade", aud: CLIENT_ID });
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain("not a URL");
  });

  it("notes when the endpoint URL did not parse, so iss cannot be compared", () => {
    const check = claimsFor(
      { iss: SANDBOX_API_URL, aud: CLIENT_ID },
      { TASTYTRADE_API_URL: "not-a-url" },
    );
    expect(check.details.join("\n")).toContain("did not parse");
  });

  it("prints (absent) for every claim a bare token omits", () => {
    const check = claimsFor({}, {}, {});
    const rendered = check.details.join("\n");
    expect(rendered).toContain("typ:   (absent)");
    expect(rendered).toContain("iss:   (absent)");
    expect(rendered).toContain("aud:   (absent)");
    expect(rendered).toContain("scope: (absent)");
    expect(rendered).toContain("iat:   (absent)");
  });

  it("ignores an iat that is not a number", () => {
    const check = claimsFor({
      iss: SANDBOX_API_URL,
      aud: CLIENT_ID,
      iat: "yesterday",
    });
    expect(check.details.join("\n")).toContain("iat:   (absent)");
  });

  it("never prints the token itself", () => {
    const check = claimsFor({ iss: SANDBOX_API_URL, aud: CLIENT_ID });
    expect(JSON.stringify(check)).not.toContain("c2lnbmF0dXJl");
  });
});

// ---------------------------------------------------------------------------
// Check 6 — the grant
// ---------------------------------------------------------------------------

describe("check 6: refresh-token grant", () => {
  const env = healthyEnv();
  const endpoint = inspectApiUrl(env);
  const creds = inspectCredentials(env);

  it("sends exactly what the OAuth client sends, and passes on 200", async () => {
    const http = healthyHttp();
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.status).toBe("pass");
    expect(http.requests).toHaveLength(1);
    const req = http.requests[0];
    expect(req.method).toBe("post");
    expect(req.url).toBe(`${SANDBOX_API_URL}/oauth/token`);
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.body).toEqual({
      grant_type: "refresh_token",
      refresh_token: GOOD_REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(outcome.accessToken).toBeDefined();
    expect(outcome.scopes).toEqual(["read", "trade", "openid"]);
    // Length only — never the token.
    const rendered = outcome.check.details.join("\n");
    expect(rendered).toContain("characters), expires in 900s");
    expect(rendered).not.toContain(outcome.accessToken as string);
  });

  it("quotes the endpoint's own error_description verbatim on rejection", async () => {
    const http = makeHttp(() => ({
      status: 401,
      data: {
        error: "invalid_client",
        error_description: "Client secret mismatch",
      },
    }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.status).toBe("fail");
    expect(outcome.check.summary).toContain("HTTP 401");
    expect(outcome.check.summary).toContain(
      "invalid_client: Client secret mismatch",
    );
    expect(outcome.check.details.join("\n")).toContain(
      "The endpoint said: invalid_client: Client secret mismatch",
    );
    expect(outcome.accessToken).toBeUndefined();
    expect(outcome.check.data?.error_description).toBe(
      "Client secret mismatch",
    );
  });

  it("falls back to `message` when there is no error_description", async () => {
    const http = makeHttp(() => ({
      status: 400,
      data: { error: "invalid_grant", message: "Invalid JWT" },
    }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.details.join("\n")).toContain(
      "invalid_grant: Invalid JWT",
    );
  });

  it("says so when the rejection body explains nothing", async () => {
    const http = makeHttp(() => ({ status: 403, data: "" }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.status).toBe("fail");
    expect(outcome.check.details.join("\n")).toContain(
      "no `error_description` to quote",
    );
  });

  it("suggests a retry for a 5xx instead of blaming the credentials", async () => {
    const http = makeHttp(() => ({ status: 503, data: {} }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.details.join("\n")).toContain("Retry once");
  });

  it("fails when a 200 carries no access_token", async () => {
    const http = makeHttp(() => ({ status: 200, data: { scope: "read" } }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.status).toBe("fail");
    expect(outcome.check.summary).toContain("no access_token");
    expect(outcome.check.data?.access_token).toBe(false);
  });

  it("reports a transport failure with its code and reaches nothing", async () => {
    const http = makeHttp(() =>
      Object.assign(new Error("connect ECONNREFUSED 203.0.113.10:443"), {
        code: "ECONNREFUSED",
      }),
    );
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.status).toBe("fail");
    expect(outcome.answered).toBe(false);
    expect(outcome.check.details.join("\n")).toContain("ECONNREFUSED");
  });

  it("handles a 200 with no expires_in", async () => {
    const http = makeHttp(() => ({
      status: 200,
      data: { access_token: "at-token-value", scope: "read" },
    }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );
    expect(outcome.check.status).toBe("pass");
    expect(outcome.check.details.join("\n")).not.toContain("expires in");
  });

  it("redacts a credential the endpoint echoes back at it", async () => {
    const http = makeHttp(() => ({
      status: 401,
      data: {
        error: "invalid_client",
        error_description: `client_secret ${CLIENT_SECRET} is not valid`,
      },
    }));
    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      makeRedactor(env),
    );
    const rendered = JSON.stringify(outcome.check);
    expect(rendered).not.toContain(CLIENT_SECRET);
    expect(rendered).toContain(REDACTED);
  });
});

describe("makeRedactor", () => {
  it("removes the configured secret and token wherever they appear", () => {
    const redact = makeRedactor({
      TASTYTRADE_CLIENT_SECRET: CLIENT_SECRET,
      TASTYTRADE_REFRESH_TOKEN: GOOD_REFRESH_TOKEN,
    });
    const text = redact(
      `secret=${CLIENT_SECRET} token=${GOOD_REFRESH_TOKEN} bearer`,
    );
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(GOOD_REFRESH_TOKEN);
  });

  it("leaves short values alone rather than mangling unrelated text", () => {
    const redact = makeRedactor({ TASTYTRADE_CLIENT_SECRET: "abc" });
    expect(redact("abcdef")).toBe("abcdef");
  });

  it("still applies the shared pattern scrubber with nothing configured", () => {
    const redact = makeRedactor({});
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toContain(
      REDACTED,
    );
  });
});

// ---------------------------------------------------------------------------
// Check 7 — scope and accounts
// ---------------------------------------------------------------------------

describe("check 7a: access-token scope", () => {
  it("skips when no token was minted", () => {
    const check = inspectTokenScope(undefined, {
      enabled: false,
      unrecognised: false,
    });
    expect(check.status).toBe("skip");
  });

  it("passes and says order entry is permitted when `trade` is present", () => {
    const check = inspectTokenScope(["read", "trade"], {
      enabled: false,
      unrecognised: false,
    });
    expect(check.status).toBe("pass");
    expect(check.summary).toContain("`trade`");
    expect(check.data?.trade).toBe(true);
  });

  it("warns when `trade` is missing and the write tools are live", () => {
    const check = inspectTokenScope(["read"], {
      enabled: false,
      unrecognised: false,
    });
    expect(check.status).toBe("warn");
    expect(check.details.join("\n")).toContain("fail at the broker");
  });

  it("does not warn when read-only mode already withholds those tools", () => {
    const check = inspectTokenScope(["read"], {
      enabled: true,
      unrecognised: false,
    });
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain("nothing is affected");
  });

  it("notes the redundancy when the token can trade but read-only is on", () => {
    const check = inspectTokenScope(["read", "trade"], {
      enabled: true,
      unrecognised: false,
    });
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).toContain(READ_ONLY_ENV_VAR);
  });

  it("warns when the endpoint reported no scope at all", () => {
    const check = inspectTokenScope([], {
      enabled: false,
      unrecognised: false,
    });
    expect(check.status).toBe("warn");
    expect(check.data?.reported).toBe(false);
  });
});

describe("check 7b: reachable accounts", () => {
  const env = healthyEnv();
  const endpoint = inspectApiUrl(env);

  it("skips when no token was minted", async () => {
    const check = await inspectAccounts(
      makeDeps({ env }),
      endpoint,
      undefined,
      noRedaction,
    );
    expect(check.status).toBe("skip");
  });

  it("fetches through the real client and lists what it found", async () => {
    const http = healthyHttp();
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    expect(check.status).toBe("pass");
    expect(check.summary).toBe("1 account reachable");
    expect(check.details[0]).toContain("****0001");
    expect(check.details[0]).toContain("Margin");

    // The REAL request path: relative URL under the configured base, bearer
    // token from the injected provider, and the two headers the API demands.
    const req = http.requests[0];
    expect(req.url).toBe("/customers/me/accounts");
    expect(req.baseUrl).toBe(SANDBOX_API_URL);
    expect(req.headers.authorization).toBe("Bearer an-access-token");
    expect(req.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
    expect(req.headers["accept-version"]).toMatch(/^\d{8}$/);
    expect(check.data?.accounts).toEqual([
      {
        account_number: "****0001",
        nickname: undefined,
        margin_or_cash: "Margin",
        account_type: "Individual",
        is_closed: false,
      },
    ]);
  });

  // ---- shareable by default -----------------------------------------------
  //
  // The doctor exists to be pasted somewhere, and .github/ISSUE_TEMPLATE/
  // bug_report.yml makes "I have removed all credentials, account numbers, and
  // order IDs" a required checkbox. These pin the default output against the
  // template.

  it("masks the account number and withholds the nickname by default", async () => {
    const http = healthyHttp();
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    const rendered = `${check.details.join("\n")}\n${JSON.stringify(check.data)}`;
    expect(rendered).not.toContain("5WT00001");
    expect(rendered).not.toContain("Sandbox");
    expect(check.data?.redacted).toBe(true);
    // The diagnostic content survives: how many, and what kind.
    expect(check.summary).toBe("1 account reachable");
    expect(check.details[0]).toContain("[Margin, Individual]");
  });

  it("says how to un-mask, and warns against pasting that form", async () => {
    const http = healthyHttp();
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    const note = check.details[check.details.length - 1];
    expect(note).toContain(SHOW_ACCOUNTS_FLAG);
    expect(note).toContain("do not paste it in public");
  });

  it("prints the number and nickname in full when reveal is asked for", async () => {
    const http = healthyHttp();
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
      true,
    );
    // The caution comes FIRST, then the identifying lines. It would be on the
    // masked branch only: the shareable output said "do not paste this" and the
    // output naming a real brokerage account and a real person said nothing.
    // First rather than last so a truncated paste still carries it.
    expect(check.details[0]).toContain("UN-MASKED");
    expect(check.details[0]).toContain(SHOW_ACCOUNTS_FLAG);
    expect(check.details[0]).toMatch(/do not paste it into an issue/);
    expect(check.details[1]).toContain("5WT00001");
    expect(check.details[1]).toContain('"Sandbox"');
    expect(check.data?.redacted).toBe(false);
    expect(check.data?.accounts).toEqual([
      {
        account_number: "5WT00001",
        nickname: "Sandbox",
        margin_or_cash: "Margin",
        account_type: "Individual",
        is_closed: false,
      },
    ]);
  });

  it("masks whole when the number is no longer than the mask", () => {
    // Four characters or fewer would BE the account number, so nothing is kept.
    expect(maskAccountNumber("5WT00001")).toBe("****0001");
    expect(maskAccountNumber("0001")).toBe("****");
    expect(maskAccountNumber("1")).toBe("****");
    expect(maskAccountNumber("")).toBe("****");
  });

  it("warns when the credentials can see no accounts", async () => {
    const http = healthyHttp({
      accounts: { status: 200, data: { data: { items: [] } } },
    });
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    expect(check.status).toBe("warn");
    expect(check.details.join("\n")).toContain("not_found");
  });

  it("treats an unrecognised payload as no accounts rather than throwing", async () => {
    const http = healthyHttp({
      accounts: { status: 200, data: { data: { items: null } } },
    });
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    expect(check.status).toBe("warn");
  });

  it("describes a flat account object and flags a closed account", async () => {
    const http = healthyHttp({
      accounts: {
        status: 200,
        data: {
          data: {
            items: [{ "account-number": "5WT00002", "is-closed": true }, {}],
          },
        },
      },
    });
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    expect(check.status).toBe("pass");
    expect(check.summary).toBe("2 accounts reachable");
    expect(check.details[0]).toContain("****0002");
    expect(check.details[0]).toContain("CLOSED");
    // A missing number stays a legible placeholder rather than becoming "****".
    expect(check.details[1]).toContain("(no account-number)");
  });

  it("fails with the HTTP status when the fetch is refused", async () => {
    const http = healthyHttp({
      accounts: Object.assign(
        new Error("Request failed with status code 403"),
        {
          response: { status: 403, data: { error: { code: "forbidden" } } },
        },
      ),
    });
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    expect(check.status).toBe("fail");
    expect(check.details.join("\n")).toContain("HTTP 403");
    expect(check.details.join("\n")).toContain("`read` scope");
    expect(check.data?.http_status).toBe(403);
  });

  it("fails without a status when the transport dies", async () => {
    const http = healthyHttp({
      accounts: new Error("socket hang up"),
    });
    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );
    expect(check.status).toBe("fail");
    expect(check.details.join("\n")).toContain("socket hang up");
    expect(check.data?.http_status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Check 8 — the effective safety configuration
// ---------------------------------------------------------------------------

describe("check 8: safety configuration", () => {
  it("reports read-only mode off", () => {
    const check = inspectReadOnly(classifyReadOnly({}));
    expect(check.status).toBe("pass");
    expect(check.summary).toContain("disabled");
    expect(check.details.join("\n")).toContain("unset");
  });

  it("reports read-only mode on", () => {
    const check = inspectReadOnly(
      classifyReadOnly({ [READ_ONLY_ENV_VAR]: "1" }),
    );
    expect(check.status).toBe("pass");
    expect(check.summary).toContain("ENABLED");
    expect(check.summary).toContain("14 write and destructive tools");
  });

  it("reports the explicit off value rather than calling it unset", () => {
    const check = inspectReadOnly(
      classifyReadOnly({ [READ_ONLY_ENV_VAR]: "0" }),
    );
    expect(check.details.join("\n")).toContain('"0"');
  });

  it("warns that an unrecognised value fails closed to ENABLED", () => {
    const state = classifyReadOnly({ [READ_ONLY_ENV_VAR]: "yes" });
    const check = inspectReadOnly(state);
    expect(state.unrecognised).toBe(true);
    expect(check.status).toBe("warn");
    expect(check.summary).toContain("ENABLED");
    expect(check.details.join("\n")).toContain('"yes"');
  });

  it("reports the default notional cap", () => {
    const check = inspectNotionalCap({});
    expect(check.status).toBe("pass");
    expect(check.summary).toContain("$50,000");
    expect(check.data?.source).toBe("default");
  });

  it("reports a configured cap", () => {
    const check = inspectNotionalCap({ MAX_ORDER_NOTIONAL_USD: " 250000 " });
    expect(check.status).toBe("pass");
    expect(check.summary).toContain("$250,000");
    expect(check.data?.limit).toBe(250000);
  });

  it.each(["50k", "$50000", "50,000", "Infinity", "-1", "0", ""])(
    "warns that %s falls back to the default without disabling the cap",
    (raw) => {
      const check = inspectNotionalCap({ MAX_ORDER_NOTIONAL_USD: raw });
      expect(check.status).toBe("warn");
      expect(check.data?.limit).toBe(DEFAULT_MAX_ORDER_NOTIONAL_USD);
      expect(check.details.join("\n")).toContain("has NOT been disabled");
    },
  );

  it("passes when every vendored document is present", () => {
    const seen: string[] = [];
    const check = inspectVendoredDocs(
      makeDeps({
        fileExists: (p) => {
          seen.push(path.basename(p));
          return true;
        },
      }),
    );
    expect(check.status).toBe("pass");
    expect(seen).toEqual([...REQUIRED_DOCS]);
    expect(check.data?.missing).toEqual([]);
  });

  it("passes against the real repository checkout", () => {
    // No fake: the docs are a runtime dependency and they are in the tree.
    const check = inspectVendoredDocs(defaultDeps({}));
    expect(check.status).toBe("pass");
  });

  it("fails, naming the missing files, when a document is gone", () => {
    const check = inspectVendoredDocs(
      makeDeps({
        fileExists: (p) => !p.endsWith("order-flow.md"),
      }),
    );
    expect(check.status).toBe("fail");
    expect(check.summary).toBe("1 required document missing");
    expect(check.details.join("\n")).toContain("order-flow.md");
    expect(check.details.join("\n")).toContain("refuse to start");
  });

  it("pluralises when several are missing", () => {
    const check = inspectVendoredDocs(makeDeps({ fileExists: () => false }));
    expect(check.summary).toContain(
      `${REQUIRED_DOCS.length} required documents`,
    );
  });

  // The install path is diagnostic, the login name in it is not. `~` keeps the
  // first and drops the second, in a report written to be shared.
  it("prints the docs directory home-relative, not as an absolute path", () => {
    const home = path.dirname(path.dirname(REPO_ROOT));
    const check = inspectVendoredDocs(defaultDeps({ HOME: home }));
    expect(check.status).toBe("pass");
    const rendered = `${check.details.join("\n")}\n${JSON.stringify(check.data)}`;
    expect(rendered).not.toContain(home);
    expect(check.data?.docs_root).toMatch(/^~[\\/]/);
  });

  it("prints the docs directory home-relative when a document is missing too", () => {
    const home = path.dirname(path.dirname(REPO_ROOT));
    const check = inspectVendoredDocs({
      ...defaultDeps({ HOME: home }),
      fileExists: () => false,
    });
    expect(check.status).toBe("fail");
    expect(check.details.join("\n")).not.toContain(home);
  });
});

describe("abbreviateHome", () => {
  const sep = path.sep;

  it("replaces a leading home directory with ~", () => {
    expect(
      abbreviateHome(`${sep}home${sep}ada${sep}pkg`, {
        HOME: `${sep}home${sep}ada`,
      }),
    ).toBe(`~${sep}pkg`);
  });

  it("collapses the home directory itself", () => {
    expect(
      abbreviateHome(`${sep}home${sep}ada`, { HOME: `${sep}home${sep}ada` }),
    ).toBe("~");
  });

  it("tolerates a trailing separator on HOME", () => {
    expect(
      abbreviateHome(`${sep}home${sep}ada${sep}pkg`, {
        HOME: `${sep}home${sep}ada${sep}`,
      }),
    ).toBe(`~${sep}pkg`);
  });

  it("falls back to USERPROFILE when HOME is unset", () => {
    expect(
      abbreviateHome(`${sep}u${sep}ada${sep}pkg`, {
        USERPROFILE: `${sep}u${sep}ada`,
      }),
    ).toBe(`~${sep}pkg`);
  });

  it("leaves a path that is merely a prefix-lookalike alone", () => {
    // /home/adamant must not become ~mant.
    expect(
      abbreviateHome(`${sep}home${sep}adamant${sep}pkg`, {
        HOME: `${sep}home${sep}ada`,
      }),
    ).toBe(`${sep}home${sep}adamant${sep}pkg`);
  });

  it("leaves the path alone when there is no home to substitute", () => {
    expect(abbreviateHome(`${sep}srv${sep}app`, {})).toBe(`${sep}srv${sep}app`);
  });

  it("refuses a one-character home, which would swallow every absolute path", () => {
    expect(abbreviateHome(`${sep}srv${sep}app`, { HOME: sep })).toBe(
      `${sep}srv${sep}app`,
    );
  });
});

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

describe("runDoctor", () => {
  it("passes end to end on a healthy sandbox configuration", async () => {
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
    );
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.failedCheck).toBeUndefined();
    const statuses = report.checks.map((c) => `${c.id}:${c.status}`);
    expect(statuses).toEqual([
      "credentials:pass",
      "api-url:pass",
      "dns:pass",
      "connectivity:pass",
      "refresh-token-claims:pass",
      "token-grant:pass",
      "token-scope:pass",
      "accounts:pass",
      "read-only-mode:pass",
      "notional-cap:pass",
      "vendored-docs:pass",
    ]);
    // Exactly two HTTP calls, in order, and no orders.
    expect(http.requests.map((r) => r.url)).toEqual([
      `${SANDBOX_API_URL}/oauth/token`,
      "/customers/me/accounts",
    ]);
  });

  it("runs the checks in the documented order", async () => {
    const report = await runDoctor(makeDeps());
    expect(report.checks.map((c) => c.id)).toEqual([
      "credentials",
      "api-url",
      "dns",
      "connectivity",
      "refresh-token-claims",
      "token-grant",
      "token-scope",
      "accounts",
      "read-only-mode",
      "notional-cap",
      "vendored-docs",
    ]);
  });

  // The end-to-end version of the shareability contract. The two renderings are
  // asserted together because `--json` is the one that emits check `data`
  // verbatim, and that is the path a leak would take.
  it("leaks no account identifier into either rendering by default", async () => {
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
    );
    for (const rendered of [formatReport(report), reportToJson(report)]) {
      expect(rendered).not.toContain("5WT00001");
      expect(rendered).not.toContain("Sandbox");
      expect(rendered).toContain("****0001");
    }
    expect(byId(report, "accounts").summary).toBe("1 account reachable");
  });

  it("prints identifiers in full only when revealAccounts is set", async () => {
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
      { revealAccounts: true },
    );
    expect(reportToJson(report)).toContain("5WT00001");
    expect(formatReport(report)).toContain('"Sandbox"');
  });

  it("never skips a check in a passing run — a skip implies a failure", async () => {
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
    );
    expect(report.checks.some((c) => c.status === "skip")).toBe(false);
  });

  it("names the FIRST failure in the exit report", async () => {
    const report = await runDoctor(
      makeDeps({
        env: { TASTYTRADE_API_URL: "https://api.sandbox.tastyworks.com" },
        lookupHost: async () => {
          throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
        },
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    // Credentials are missing too, and that check runs first.
    expect(report.failedCheck).toBe("credentials");
  });

  it("skips the network checks when the URL will not parse", async () => {
    const report = await runDoctor(
      makeDeps({ env: healthyEnv({ TASTYTRADE_API_URL: "nope" }) }),
    );
    expect(byId(report, "api-url").status).toBe("fail");
    expect(byId(report, "dns").status).toBe("skip");
    expect(byId(report, "connectivity").status).toBe("skip");
    expect(byId(report, "token-grant").status).toBe("skip");
    // The stronger reason wins: an unparseable value is not a destination the
    // credentials may go to, which is decided before reachability is consulted.
    expect(byId(report, "token-grant").summary).toContain(
      "the endpoint may not receive the credentials",
    );
    // ...but the offline claims check and the local safety checks still run.
    expect(byId(report, "refresh-token-claims").status).not.toBe("skip");
    expect(byId(report, "vendored-docs").status).toBe("pass");
  });

  it("skips the connectivity probe when the host does not resolve", async () => {
    const report = await runDoctor(
      makeDeps({
        env: healthyEnv(),
        lookupHost: async () => {
          throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
        },
        probeConnection: async () => {
          throw new Error("the probe must not run when DNS failed");
        },
      }),
    );
    expect(byId(report, "dns").status).toBe("fail");
    expect(byId(report, "connectivity").status).toBe("skip");
    expect(byId(report, "token-grant").status).toBe("skip");
  });

  it("skips the grant when the credentials are incomplete", async () => {
    const report = await runDoctor(
      makeDeps({ env: { TASTYTRADE_CLIENT_ID: CLIENT_ID } }),
    );
    expect(byId(report, "credentials").status).toBe("fail");
    expect(byId(report, "token-grant").summary).toContain(
      "credentials are incomplete",
    );
    expect(byId(report, "token-scope").status).toBe("skip");
    expect(byId(report, "accounts").status).toBe("skip");
  });

  it("does not attempt the grant when the host is unreachable", async () => {
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({
        env: healthyEnv(),
        adapter: http.adapter,
        probeConnection: async () => {
          throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
        },
      }),
    );
    expect(byId(report, "connectivity").status).toBe("fail");
    expect(byId(report, "token-grant").status).toBe("skip");
    expect(http.requests).toHaveLength(0);
  });

  it("reconstructs the real-world broken credential set in one pass", async () => {
    // Every fault from the incident at once: the client id is actually a refresh
    // token, the API URL is the vendor-internal sandbox host, and the token's
    // issuer names that same unresolvable host.
    const token = makeJwt(
      { typ: "rt+jwt", alg: "RS256" },
      {
        iss: "https://api.sandbox.tastyworks.com",
        aud: "the-real-client-id",
        scope: "read trade",
        iat: Math.floor(NOW_MS / 1000) - 86_400,
      },
    );
    const report = await runDoctor(
      makeDeps({
        env: {
          TASTYTRADE_API_URL: "https://api.sandbox.tastyworks.com",
          TASTYTRADE_CLIENT_ID: token,
          TASTYTRADE_CLIENT_SECRET: CLIENT_SECRET,
          TASTYTRADE_REFRESH_TOKEN: token,
        },
        lookupHost: async () => {
          throw Object.assign(
            new Error("getaddrinfo ENOTFOUND api.sandbox.tastyworks.com"),
            { code: "ENOTFOUND" },
          );
        },
      }),
    );
    expect(report.ok).toBe(false);
    // The swapped-domain host is refused before anything is sent, so check 2 is
    // the first failure now. The DNS diagnosis is still in the report — that is
    // asserted below — because name resolution transmits no credential.
    expect(report.failedCheck).toBe("api-url");
    expect(byId(report, "dns").status).toBe("fail");

    const rendered = formatReport(report);
    // The mislabelled value...
    expect(rendered).toContain("TASTYTRADE_CLIENT_ID is itself a JWT");
    expect(rendered).toContain("header typ=rt+jwt");
    // ...the real client id, recovered from the token's own audience...
    expect(rendered).toContain("the-real-client-id");
    // ...the unresolvable host, and the domain that would have worked.
    expect(rendered).toContain("does not resolve");
    expect(rendered).toContain("https://api.sandbox.tastytrade.com");
    // ...and nothing that should not be there.
    expect(rendered).not.toContain(CLIENT_SECRET);
  });

  it("carries a token-endpoint rejection through to the exit report", async () => {
    const http = healthyHttp({
      token: {
        status: 401,
        data: {
          error: "invalid_client",
          error_description: "Client secret mismatch",
        },
      },
    });
    const report = await runDoctor(
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
    );
    expect(report.failedCheck).toBe("token-grant");
    expect(byId(report, "token-scope").status).toBe("skip");
    expect(byId(report, "accounts").status).toBe("skip");
    expect(formatReport(report)).toContain("Client secret mismatch");
  });

  // This asserted the DEFECT in its own title: a run with
  // three warnings and no failures exited 0, and `formatReport` printed "the
  // credentials, the endpoint and the safety configuration are verified" over
  // the top of them. Nothing failed, so nothing here is a fault — but "nothing
  // failed" and "verified" are not the same claim, and the exit code now says
  // which one happened.
  it("exits 3, not 0, when everything needed works but warnings remain", async () => {
    const http = healthyHttp({
      token: {
        status: 200,
        data: { access_token: "at-value", expires_in: 900, scope: "read" },
      },
    });
    const report = await runDoctor(
      makeDeps({
        env: healthyEnv({
          // Reachable sandbox host, token issued by the other sandbox name: a
          // warning, not a fault. Plus a scope with no `trade` and an unusable
          // notional cap.
          TASTYTRADE_API_URL: "https://api.sandbox.tastytrade.com",
          TASTYTRADE_REFRESH_TOKEN: makeJwt(
            { typ: "rt+jwt" },
            { iss: "https://api.sandbox.tastyworks.com", aud: CLIENT_ID },
          ),
          MAX_ORDER_NOTIONAL_USD: "lots",
        }),
        adapter: http.adapter,
      }),
    );
    // `ok` keeps its documented meaning — no check FAILED — and is why it is not
    // the field to gate on.
    expect(report.ok).toBe(true);
    expect(report.verdict).toBe("passed_with_warnings");
    expect(report.exitCode).toBe(EXIT_WARN);
    const warned = report.checks
      .filter((c) => c.status === "warn")
      .map((c) => c.id);
    expect(warned).toEqual([
      "refresh-token-claims",
      "token-scope",
      "notional-cap",
    ]);
    const text = formatReport(report);
    expect(text).toContain("PREFLIGHT PASSED WITH 3 WARNINGS");
    expect(text).not.toContain("verified");
  });

  it("fails a production endpoint holding a sandbox-issued token", async () => {
    // No network call is needed to know these credentials cannot work.
    const report = await runDoctor(
      makeDeps({
        env: healthyEnv({ TASTYTRADE_API_URL: PRODUCTION_API_URL }),
        adapter: healthyHttp().adapter,
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.failedCheck).toBe("refresh-token-claims");
    expect(formatReport(report)).toContain(
      "Sandbox credentials never work against production",
    );
  });
});

// ---------------------------------------------------------------------------
// Rendering and the CLI
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  const statuses: CheckStatus[] = ["pass", "warn", "fail", "skip"];

  function fakeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
    const checks: CheckResult[] = statuses.map((status, i) => ({
      id: `check-${i}`,
      title: `Check ${i}`,
      status,
      summary: `summary ${status}`,
      details: [`detail ${status}`],
    }));
    // `verdict` is derived with the real helper from the
    // EFFECTIVE check list — the overridden one when a test supplies its own —
    // so a fixture cannot quietly claim a verdict its own statuses contradict.
    // A test can still pin the verdict explicitly if that is the subject.
    const effective = overrides.checks ?? checks;
    return {
      ok: false,
      exitCode: 1,
      failedCheck: "check-2",
      version: "9.9.9",
      ...overrides,
      checks: effective,
      verdict: overrides.verdict ?? deriveVerdict(effective),
    };
  }

  it("renders one line per check with a status token and its details", () => {
    const text = formatReport(fakeReport());
    expect(text).toContain("preflight doctor (v9.9.9)");
    expect(text).toContain("[ ok ]");
    expect(text).toContain("[warn]");
    expect(text).toContain("[FAIL]");
    expect(text).toContain("[skip]");
    expect(text).toContain(" 1/4  Check 0");
    expect(text).toContain("detail pass");
    expect(text).toContain("Summary: 1 ok, 1 warning, 1 failed, 1 skipped.");
    expect(text).toContain('PREFLIGHT FAILED at check "check-2"');
  });

  // This asserted the OPPOSITE: that a detail's newlines
  // become report lines. That is the mechanism the report forgery used — a
  // network-supplied `error_description` is a detail, and `detail.split("\n")`
  // let it emit as many lines as it liked, including a column-0
  // "PREFLIGHT PASSED" and a dozen forged "N/11 [ ok ]" rows.
  //
  // Flattening costs nothing real: no server-authored detail in src/doctor.ts
  // contains a newline, so the only value that loop ever split in production was
  // network text. The multi-line detail this test constructed had no counterpart
  // in the code.
  it("flattens a multi-line detail onto one indented line", () => {
    const report = fakeReport();
    report.checks[0].details = ["first\nsecond"];
    const lines = formatReport(report).split("\n");
    expect(lines).toContain("         first second");
    expect(lines).not.toContain("         second");
    // One line per detail, always — which is what makes the line count
    // structural rather than a function of what the network sent.
    expect(lines.filter((l) => l.startsWith("         "))).toHaveLength(
      report.checks.reduce((n, c) => n + c.details.length, 0),
    );
  });

  it("declares a pass, and asks for the warnings to be read", () => {
    const report = fakeReport({
      ok: true,
      exitCode: 0,
      failedCheck: undefined,
      checks: [
        {
          id: "a",
          title: "A",
          status: "pass",
          summary: "fine",
          details: [],
        },
        {
          id: "b",
          title: "B",
          status: "warn",
          summary: "hmm",
          details: [],
        },
      ],
    });
    const text = formatReport(report);
    expect(text).toContain("PREFLIGHT PASSED");
    expect(text).toContain("Review the warnings");
    expect(text).toContain("Summary: 1 ok, 1 warning, 0 failed, 0 skipped.");
  });

  it("says nothing about warnings when there are none", () => {
    const report = fakeReport({
      ok: true,
      exitCode: 0,
      failedCheck: undefined,
      checks: [
        { id: "a", title: "A", status: "pass", summary: "fine", details: [] },
        { id: "b", title: "B", status: "pass", summary: "fine", details: [] },
      ],
    });
    const text = formatReport(report);
    expect(text).toContain("PREFLIGHT PASSED");
    expect(text).not.toContain("Review the warnings");
    expect(text).toContain("Summary: 2 ok, 0 warnings, 0 failed, 0 skipped.");
  });
});

// ---------------------------------------------------------------------------
// The aggregate verdict.
//
// `CheckStatus` has four members and an aggregate of
// `checks.find((c) => c.status === "fail")` names one, so `warn` cannot affect `ok`,
// the exit code, or the verdict line. A report whose ONLY check is a warning prints
// "the credentials, the endpoint and the safety configuration are verified" and exits
// 0.
//
// With an ambient proxy that is the report warning, in its own words, that "whatever
// terminates that connection sees the request" — and then saying `verified` four
// lines later, with `$? = 0` for the shell gate and `ok: true` for the --json
// consumer. The per-check layer is right: `inspectApiUrl` promotes pass to warn
// deliberately. The aggregate layer is what undoes it.
//
// Three states, one derivation, and the middle one has a name, an exit code and a
// field.
// ---------------------------------------------------------------------------

describe("the aggregate verdict has three states", () => {
  /** A report whose statuses are exactly `statuses`, verdict derived. */
  function reportOf(statuses: CheckStatus[]): DoctorReport {
    const checks: CheckResult[] = statuses.map((status, i) => ({
      id: `check-${i}`,
      title: `Check ${i}`,
      status,
      summary: `summary ${status}`,
      details: [],
    }));
    const verdict: DoctorVerdict = deriveVerdict(checks);
    return {
      verdict,
      ok: verdict !== "failed",
      exitCode: exitCodeFor(verdict),
      failedCheck: checks.find((c) => c.status === "fail")?.id,
      version: "9.9.9",
      checks,
    };
  }

  it("derives the verdict from the whole status tally", () => {
    expect(deriveVerdict([])).toBe("passed");
    expect(reportOf(["pass", "pass"]).verdict).toBe("passed");
    expect(reportOf(["pass", "warn"]).verdict).toBe("passed_with_warnings");
    // A skip counts with the warnings. Every skip reachable today follows a fail
    // or a warn, so this changes no current outcome — it means a future skip on
    // an otherwise clean run cannot be rendered as verified either.
    expect(reportOf(["pass", "skip"]).verdict).toBe("passed_with_warnings");
    expect(reportOf(["pass", "warn", "fail"]).verdict).toBe("failed");
    expect(reportOf(["fail"]).verdict).toBe("failed");
  });

  it("renders a warn-only report as PASSED WITH WARNINGS, never as verified", () => {
    const text = formatReport(reportOf(["warn"]));

    expect(text).toContain("PREFLIGHT PASSED WITH 1 WARNING");
    expect(text).toContain("NOT VERIFIED");
    expect(text).toContain("Review the warnings");
    expect(text).not.toContain("are verified");
    // Not the lower-case word anywhere, so a case-sensitive `grep verified` over
    // this output matches the genuine pass and nothing else.
    expect(text).not.toContain("verified");
  });

  it("serialises the verdict for a machine consumer", () => {
    const json = JSON.parse(reportToJson(reportOf(["warn"]))) as Record<
      string,
      unknown
    >;

    expect(json.verdict).toBe("passed_with_warnings");
    expect(json.exit_code).toBe(EXIT_WARN);
    // `ok` keeps its documented meaning — no check FAILED — which is exactly why
    // it is not the field to gate on, and why `verdict` had to exist.
    expect(json.ok).toBe(true);
  });

  it("still renders an all-pass report as verified, exit 0", () => {
    // The counterweight: exit 3 must not become the answer to everything.
    const report = reportOf(["pass", "pass"]);
    const text = formatReport(report);

    expect(report.exitCode).toBe(0);
    expect(text).toContain("are verified");
    expect(text).not.toContain("NOT VERIFIED");
    expect(text).not.toContain("Review the warnings");
    expect(JSON.parse(reportToJson(report)).verdict).toBe("passed");
  });

  it("still renders a failing report as FAILED, exit 1, naming the check", () => {
    const report = reportOf(["pass", "warn", "fail", "skip"]);
    const text = formatReport(report);

    expect(report.exitCode).toBe(1);
    expect(report.ok).toBe(false);
    expect(text).toContain('PREFLIGHT FAILED at check "check-2"');
    expect(text).not.toContain("verified");
    expect(JSON.parse(reportToJson(report)).verdict).toBe("failed");
  });

  it("exits 3 end to end when an ambient proxy warns the credential channel", async () => {
    // The finding's own configuration, composed with the: one line in the
    // client's env block. `https_proxy`, not `http_proxy` — against an https
    // endpoint the latter lands on the INFORMATIONAL channel a fix added,
    // which deliberately does not promote a check to `warn`, so it would produce
    // a zero-warning run and this test would pass for the wrong reason. The
    // non-vacuity assertions below are what make that visible.
    const report = await runDoctor(
      makeDeps({
        env: healthyEnv({ https_proxy: "http://appliance.example:8080" }),
        adapter: healthyHttp().adapter,
      }),
    );

    expect(
      report.checks.filter((c) => c.status === "warn").length,
    ).toBeGreaterThan(0);
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);

    expect(report.verdict).toBe("passed_with_warnings");
    expect(report.exitCode).toBe(EXIT_WARN);
    expect(report.ok).toBe(true);
    expect(formatReport(report)).not.toContain("are verified");
  });

  it("returns 3 from main() in both human and --json mode", async () => {
    const env = healthyEnv({ https_proxy: "http://appliance.example:8080" });
    let human = "";
    let machine = "";
    const humanCode = await main(
      [],
      makeDeps({ env, adapter: healthyHttp().adapter }),
      (t) => {
        human += t;
      },
    );
    const jsonCode = await main(
      ["--json"],
      makeDeps({ env, adapter: healthyHttp().adapter }),
      (t) => {
        machine += t;
      },
    );

    expect(humanCode).toBe(EXIT_WARN);
    expect(jsonCode).toBe(EXIT_WARN);
    expect(human).not.toContain("are verified");
    expect(JSON.parse(machine).verdict).toBe("passed_with_warnings");
  });

  it("returns 0 from main() when nothing warned at all", async () => {
    let human = "";
    const code = await main(
      [],
      makeDeps({ env: healthyEnv(), adapter: healthyHttp().adapter }),
      (t) => {
        human += t;
      },
    );

    expect(code).toBe(0);
    expect(human).toContain("are verified");
  });

  it("publishes exit code 3 in both places the contract is stated", () => {
    // The exit code is a published interface, so the tool's own --help and the
    // README have to agree about it. Read from the files rather than restated.
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const exitBlock = /Exit codes:[\s\S]{0,700}/.exec(USAGE)?.[0] ?? "";

    expect(exitBlock).toMatch(new RegExp(`^\\s*${EXIT_WARN}\\s`, "m"));
    expect(exitBlock).toMatch(/NOT verified/);
    expect(readme).toMatch(/Exit codes:[\s\S]{0,500}`3`/);
    expect(readme).toMatch(/not\*{0,2} verified/i);
  });
});

// ---------------------------------------------------------------------------
// The human report is structurally unforgeable.
//
// Four network taint sites feed formatReport, and until this suite existed
// nothing stopped any of them emitting an ESC, a CR, or a newline. The proof of
// concept used all three: erase-display plus cursor-home repainted the screen
// with 12 forged "N/11 [ ok ]" rows and a column-0 "PREFLIGHT PASSED", ending
// mid-parenthesis so the renderer's own trailing ")" closed it, while the real
// verdict was FAILED and the real exit code was 1.
// ---------------------------------------------------------------------------

const ESC = "\u001b";

const FORGED = [
  "tastytrade MCP server — preflight doctor (v1.0.0)",
  "",
  " 1/11  Credentials              [ ok ]  all three OAuth variables are set",
  " 2/11  API endpoint             [ ok ]  sandbox API — no real money at risk",
  " 3/11  DNS resolution           [ ok ]  api.cert.tastyworks.com resolves",
  "",
  "Summary: 11 ok, 0 warnings, 0 failed, 0 skipped.",
  "PREFLIGHT PASSED — the credentials, the endpoint and the safety configuration are verified. (sandbox",
].join("\n");

const PAYLOAD = `invalid_client: ${ESC}[2J${ESC}[H${FORGED}`;

function hostileReport(): DoctorReport {
  const checks: CheckResult[] = [
    {
      id: "credentials",
      title: "Credentials",
      status: "pass",
      summary: "all three OAuth variables are set",
      details: [],
    },
    {
      id: "token-grant",
      title: "Refresh-token grant",
      status: "fail",
      summary: PAYLOAD,
      details: [`The endpoint said: ${PAYLOAD}`],
    },
  ];
  return {
    verdict: deriveVerdict(checks),
    ok: false,
    exitCode: 1,
    failedCheck: "token-grant",
    version: "1.0.0",
    checks,
  };
}

/** The number of lines formatReport's own STRUCTURE calls for. */
function structuralLineCount(report: DoctorReport): number {
  const perCheck = report.checks.reduce((n, c) => n + 1 + c.details.length, 0);
  // The extra "Review the warnings" line belongs to the
  // middle verdict, not to `ok && warn > 0` — those agreed only because `ok`
  // ignored `warn`.
  return (
    2 +
    perCheck +
    2 +
    1 +
    (report.verdict === "passed_with_warnings" ? 1 : 0) +
    1
  );
}

/** Replays LF, CR, CSI nA/nB, CSI H and CSI 2J/2K the way a terminal would. */
function renderTerminal(text: string): string {
  const screen: string[] = [];
  let row = 0;
  let col = 0;
  const put = (ch: string): void => {
    while (screen.length <= row) screen.push("");
    const line = screen[row]!.padEnd(col, " ");
    screen[row] = line.slice(0, col) + ch + line.slice(col + 1);
    col += 1;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\n") {
      row += 1;
      col = 0;
      i += 1;
    } else if (ch === "\r") {
      col = 0;
      i += 1;
    } else if (ch === ESC && text[i + 1] === "[") {
      // Matched from PAST the two-character CSI introducer, so the pattern holds
      // no control character of its own — eslint's `no-control-regex` is right
      // that a control byte inside a regex literal is unreadable, and there is
      // no need for one here.
      const m = /^(\d*)([A-Za-z])/.exec(text.slice(i + 2));
      if (!m) {
        put(ch);
        i += 1;
        continue;
      }
      const n = m[1] === "" ? 1 : Number(m[1]);
      switch (m[2]) {
        case "J":
          screen.length = 0;
          row = 0;
          col = 0;
          break;
        case "K":
          while (screen.length <= row) screen.push("");
          screen[row] = "";
          break;
        case "H":
          row = 0;
          col = 0;
          break;
        case "A":
          row = Math.max(0, row - n);
          break;
        case "B":
          row += n;
          break;
        default:
          break;
      }
      i += 2 + m[0].length;
    } else {
      put(ch);
      i += 1;
    }
  }
  return screen.join("\n");
}

describe("the human report is structurally unforgeable", () => {
  it("emits not one display-hostile code point", () => {
    const text = formatReport(hostileReport());
    const offenders = [...text].filter((ch) =>
      isDisplayHostileCodepoint(ch.codePointAt(0) ?? 0),
    );
    // LF is the renderer's own line separator and is the one exception.
    expect(offenders.filter((ch) => ch !== "\n")).toEqual([]);
  });

  it("emits exactly the number of lines its own structure calls for", () => {
    const report = hostileReport();
    const lines = formatReport(report).split("\n");
    expect(lines).toHaveLength(structuralLineCount(report));
  });

  it("emits one N/M check row per check and not one more", () => {
    const report = hostileReport();
    const rows = formatReport(report)
      .split("\n")
      .filter((l) => /^\s*\d+\/\d+\s{2}/.test(l));
    expect(rows).toHaveLength(report.checks.length);
  });

  it("emits exactly one column-0 PREFLIGHT line", () => {
    const verdicts = formatReport(hostileReport())
      .split("\n")
      .filter((l) => l.startsWith("PREFLIGHT "));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatch(/^PREFLIGHT FAILED/);
  });

  it("keeps every line inside the line bound", () => {
    const report = hostileReport();
    report.checks[1]!.summary = `invalid_client: ${"Z".repeat(300_000)}`;
    report.checks[1]!.details = [`The endpoint said: ${"Z".repeat(300_000)}`];
    const lines = formatReport(report).split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(MAX_REPORT_LINE_CHARS);
    }
  });

  it("survives replay through a terminal with its verdict intact", () => {
    // The end-to-end statement of the finding: the bytes the doctor emits, run
    // through the escape sequences a real terminal honours, must still say what
    // the doctor decided.
    const screen = renderTerminal(formatReport(hostileReport()));
    const rows = screen.split("\n");
    // The forged text still SAYS "PREFLIGHT PASSED" — it is somebody else's
    // prose and this fix does not censor prose. What it cannot do is occupy a
    // line of its own, which is the only thing that reads as a verdict.
    expect(rows.filter((l) => l.startsWith("PREFLIGHT "))).toEqual([
      expect.stringMatching(/^PREFLIGHT FAILED/),
    ]);
    expect(rows.filter((l) => /^Summary: /.test(l))).toEqual([
      "Summary: 1 ok, 0 warnings, 1 failed, 0 skipped.",
    ]);
    expect(screen).toContain("[FAIL]");
  });
});

/** Strip line and block comments, so the scan reads code and not prose. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
}

/** Blank out every string and template literal, leaving the structure. */
function withoutLiterals(src: string): string {
  return src
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

describe("SOURCE INVARIANT — every line formatReport pushes is bounded", () => {
  const SRC = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/doctor.ts"),
    "utf8",
  );

  it("routes every lines.push in formatReport through the bound", () => {
    const start = SRC.indexOf("export function formatReport");
    const end = SRC.indexOf("export function reportToJson");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = codeOnly(SRC.slice(start, end));

    // Every statement that appends to `lines`, derived by scanning the function
    // — a literal count would let a new push slip past a stale number.
    const pushes: string[] = [];
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/\blines\.push\(/.test(lines[i]!)) continue;
      let stmt = "";
      for (let j = i; j < lines.length; j++) {
        stmt += lines[j]!;
        if (/\);\s*$/.test(lines[j]!)) break;
      }
      pushes.push(stmt);
    }
    expect(pushes.length).toBeGreaterThan(2);
    // Two legitimate shapes, and only two: a push routed through the bound, or
    // a push of nothing but string literals (the blank separator lines). A
    // third shape is a new unbounded interpolation and fails here.
    const unbounded = pushes.filter((stmt) => {
      if (stmt.includes("reportLine(")) return false;
      const args = withoutLiterals(stmt)
        .replace(/^\s*lines\.push\(/, "")
        .replace(/\);\s*$/, "");
      // Nothing but blanked-out literals, commas and whitespace: a separator
      // line, with no value from anywhere interpolated into it.
      return !/^[\s,"]*$/.test(args);
    });
    expect(unbounded).toEqual([]);
  });

  it("never splits a detail on a newline, so no detail can add a line", () => {
    const start = SRC.indexOf("export function formatReport");
    const end = SRC.indexOf("export function reportToJson");
    expect(codeOnly(SRC.slice(start, end))).not.toContain(
      'detail.split("\\n")',
    );
  });
});

// ---------------------------------------------------------------------------
// The operand caps at the taint sites. Bounded HERE and not only at the
// renderer, because the composite must survive: the surrounding prose is the
// diagnosis, and a cap on the whole line would delete it.
// ---------------------------------------------------------------------------

const HOSTILE = `${ESC}[2K${ESC}[1A${"Z".repeat(300_000)}`;

describe("every network operand the doctor renders is bounded", () => {
  it("bounds the token endpoint's error_description in the summary", async () => {
    const { inspectApiUrl, inspectCredentials, inspectTokenGrant } =
      await import("../src/doctor.js");
    const env: NodeJS.ProcessEnv = {
      TASTYTRADE_CLIENT_ID: "cid",
      TASTYTRADE_CLIENT_SECRET: "csec",
      TASTYTRADE_REFRESH_TOKEN: "a.b.c",
      TASTYTRADE_API_URL: "https://api.cert.tastyworks.com",
    };
    const outcome = await inspectTokenGrant(
      {
        env,
        lookupHost: async () => ["203.0.113.10"],
        probeConnection: async () => "ok",
        fileExists: () => true,
        now: () => 1_700_000_000_000,
        adapter: async () =>
          ({
            status: 401,
            statusText: "Unauthorized",
            headers: {},
            config: {} as never,
            data: { error: "invalid_client", error_description: HOSTILE },
          }) as never,
      },
      inspectApiUrl(env),
      inspectCredentials(env),
      (t) => t,
    );
    expect(outcome.check.summary.length).toBeLessThan(400);
    expect(outcome.check.summary).toMatch(/…\[truncated, \d+ chars\]/);
    expect(outcome.check.summary).toContain("HTTP 401");
    const rendered = outcome.check.details.join("\n");
    expect(rendered).toMatch(/…\[truncated, \d+ chars\]/);
    for (const text of [outcome.check.summary, rendered]) {
      expect([...text].some((c) => c === ESC)).toBe(false);
    }
  });

  it("bounds the scope list the token endpoint reported", async () => {
    const { inspectTokenScope } = await import("../src/doctor.js");
    const check = inspectTokenScope([`read${HOSTILE}`, "trade"], {
      enabled: false,
      unrecognised: false,
    });
    const rendered = check.details.join("\n");
    expect(rendered.length).toBeLessThan(600);
    expect([...rendered].some((c) => c === ESC)).toBe(false);
  });

  it("leaves a healthy report byte-identical", () => {
    // ANTI-OVERREACH. The table alignment, the status tokens and the tally line
    // are what an operator reads; a bound that shifts a column has cost more
    // than it saved.
    const report: DoctorReport = {
      verdict: "passed",
      ok: true,
      exitCode: 0,
      version: "9.9.9",
      checks: [
        {
          id: "a",
          title: "Credentials",
          status: "pass",
          summary: "all three OAuth variables are set",
          details: ["TASTYTRADE_CLIENT_ID is set"],
        },
      ],
    };
    expect(formatReport(report)).toBe(
      [
        "tastytrade MCP server — preflight doctor (v9.9.9)",
        "",
        " 1/1  Credentials              [ ok ]  all three OAuth variables are set",
        "         TASTYTRADE_CLIENT_ID is set",
        "",
        "Summary: 1 ok, 0 warnings, 0 failed, 0 skipped.",
        "PREFLIGHT PASSED — the credentials, the endpoint and the safety configuration are verified.",
        "",
      ].join("\n"),
    );
  });
});
describe("reportToJson", () => {
  it("emits one parseable object with snake_case keys", async () => {
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
    );
    const text = reportToJson(report);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as {
      ok: boolean;
      exit_code: number;
      failed_check: string | null;
      summary: Record<string, number>;
      checks: Array<Record<string, unknown>>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.exit_code).toBe(0);
    expect(parsed.failed_check).toBeNull();
    expect(parsed.summary).toEqual({ pass: 11, warn: 0, fail: 0, skip: 0 });
    expect(parsed.checks).toHaveLength(11);
    expect(parsed.checks[0]).toMatchObject({
      id: "credentials",
      status: "pass",
    });
    // Structured payload always present, even when a check has none.
    expect(parsed.checks.every((c) => typeof c.data === "object")).toBe(true);
    // The leak guard, over the machine-readable form.
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(GOOD_REFRESH_TOKEN);
  });

  it("reports the failed check by id", async () => {
    const report = await runDoctor(makeDeps());
    const parsed = JSON.parse(reportToJson(report)) as {
      failed_check: string;
      exit_code: number;
    };
    expect(parsed.failed_check).toBe("credentials");
    expect(parsed.exit_code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The --json surface.
//
// A DIFFERENT function from formatReport, selected by a different flag, so the
// report-forgery fix does not reach it. Its one protection was incidental —
// JSON.stringify escapes a raw ESC, which covers the control-sequence limb and
// nothing else — and `check.data` was copied with zero transformation: measured
// at 3,000,499 bytes of stdout for 1 MB of error_description.
// ---------------------------------------------------------------------------

function jsonSurfaceReport(
  overrides: Partial<DoctorReport> = {},
): DoctorReport {
  return {
    verdict: "failed",
    ok: false,
    exitCode: 1,
    failedCheck: "token-grant",
    version: "1.0.0",
    checks: [],
    ...overrides,
  };
}

function parseJsonSurface(report: DoctorReport): any {
  const text = reportToJson(report);
  expect(text.endsWith("\n")).toBe(true);
  return { text, value: JSON.parse(text) };
}

describe("the --json surface is bounded, not merely escaped", () => {
  const FLOOD = "Z".repeat(1_000_000);

  const flooded = (): DoctorReport =>
    jsonSurfaceReport({
      checks: [
        {
          id: "token-grant",
          title: "Refresh-token grant",
          status: "fail",
          summary: `the grant was rejected with HTTP 400 (${FLOOD})`,
          details: [`The endpoint said: ${FLOOD}`],
          data: { error: "invalid_client", error_description: FLOOD },
        },
      ],
    });

  it("bounds every string leaf of summary, details and data", () => {
    const { value } = parseJsonSurface(flooded());
    const check = value.checks[0];
    for (const leaf of [
      check.summary,
      check.details[0],
      check.data.error_description,
    ]) {
      expect(leaf.length).toBeLessThanOrEqual(MAX_REPORT_LINE_CHARS);
      expect(leaf).toMatch(/…\[truncated, \d+ chars\]/);
    }
  });

  it("turns 1 MB of upstream text into a report an operator can paste", () => {
    // Measured before the bound: 1 MB in, 3,000,499 bytes of --json out. The
    // doctor is explicitly written to be pasted into a bug report.
    const { text } = parseJsonSurface(flooded());
    expect(text.length).toBeLessThan(64 * 1024);
  });

  it("bounds a 4,000-entry scope array on the PASS path", () => {
    // parseScopeList applies no bound, and this arrives on a SUCCESSFUL grant,
    // so there is no failure for the operator to be suspicious of.
    const { text } = parseJsonSurface(
      jsonSurfaceReport({
        ok: true,
        exitCode: 0,
        failedCheck: undefined,
        checks: [
          {
            id: "token-scope",
            title: "Access-token scope",
            status: "pass",
            summary: "includes `trade` — order entry is permitted",
            details: ["Scopes: read trade"],
            data: {
              scopes: Array.from({ length: 4_000 }, (_, i) => `scope-${i}`),
              trade: true,
            },
          },
        ],
      }),
    );
    expect(text.length).toBeLessThan(64 * 1024);
  });

  it("strips the display-hostile classes rather than escaping them", () => {
    // JSON.stringify already made a raw ESC inert on the wire — that is this
    // surface's one existing protection and it is incidental. A consumer that
    // unescapes gets the control character back, so it is removed instead.
    const { text, value } = parseJsonSurface(
      jsonSurfaceReport({
        checks: [
          {
            id: "token-grant",
            title: "Refresh-token grant",
            status: "fail",
            summary: `rejected ${ESC}[2J${ESC}[H`,
            details: ["The endpoint said: line one\u2028line two"],
            data: { error_description: `x${ESC}[31my` },
          },
        ],
      }),
    );
    expect(text).not.toContain("\\u001b");
    expect(text).not.toContain("\\u2028");
    const leaves = [
      value.checks[0].summary,
      value.checks[0].details[0],
      value.checks[0].data.error_description,
    ].join("");
    expect(
      [...leaves].filter((c) =>
        isDisplayHostileCodepoint(c.codePointAt(0) ?? 0),
      ),
    ).toEqual([]);
  });

  it("declares what it had to cut, and says so when it cut nothing", () => {
    const cut = parseJsonSurface(flooded()).value;
    expect(cut.bounded).toBe(true);
    expect(typeof cut.truncation).toBe("object");
    expect(cut.truncation.strings_truncated).toBeGreaterThan(0);

    const intact = parseJsonSurface(
      jsonSurfaceReport({
        checks: [
          {
            id: "credentials",
            title: "Credentials",
            status: "pass",
            summary: "all three OAuth variables are set",
            details: ["TASTYTRADE_CLIENT_ID is set"],
          },
        ],
      }),
    ).value;
    expect(intact.bounded).toBe(false);
    expect(intact.truncation).toBeUndefined();
  });

  it("leaves a realistic report's payload untouched", () => {
    // ANTI-OVERREACH. --json is a documented scripting interface; a bound that
    // rewrote a healthy report would break every consumer of it.
    const report = jsonSurfaceReport({
      ok: true,
      exitCode: 0,
      failedCheck: undefined,
      checks: [
        {
          id: "credentials",
          title: "Credentials",
          status: "pass",
          summary: "all three OAuth variables are set",
          details: ["TASTYTRADE_CLIENT_ID is set"],
          data: { present: 3 },
        },
        {
          id: "accounts",
          title: "Reachable accounts",
          status: "pass",
          summary: "1 account reachable",
          details: ["****0001     [Margin, Individual]"],
          data: {
            fetched: true,
            count: 1,
            redacted: true,
            accounts: [
              {
                account_number: "****0001",
                margin_or_cash: "Margin",
                account_type: "Individual",
                is_closed: false,
              },
            ],
          },
        },
      ],
    });
    const { value } = parseJsonSurface(report);
    expect(value.ok).toBe(true);
    expect(value.exit_code).toBe(0);
    expect(value.version).toBe("1.0.0");
    expect(value.failed_check).toBeNull();
    expect(value.summary).toEqual({ pass: 2, warn: 0, fail: 0, skip: 0 });
    expect(value.checks).toEqual([
      {
        id: "credentials",
        title: "Credentials",
        status: "pass",
        summary: "all three OAuth variables are set",
        details: ["TASTYTRADE_CLIENT_ID is set"],
        data: { present: 3 },
      },
      {
        id: "accounts",
        title: "Reachable accounts",
        status: "pass",
        summary: "1 account reachable",
        details: ["****0001     [Margin, Individual]"],
        data: {
          fetched: true,
          count: 1,
          redacted: true,
          accounts: [
            {
              account_number: "****0001",
              margin_or_cash: "Margin",
              account_type: "Individual",
              is_closed: false,
            },
          ],
        },
      },
    ]);
  });
});

describe("SOURCE INVARIANT — reportToJson bounds what it serialises", () => {
  const SRC = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/doctor.ts"),
    "utf8",
  );

  it("routes the checks projection through the shared bound", () => {
    const start = SRC.indexOf("export function reportToJson");
    expect(start).toBeGreaterThan(0);
    const body = SRC.slice(start, SRC.indexOf("export const USAGE"));
    expect(body).toContain("boundedDeep(");
  });

  it("does not hand the raw projection to JSON.stringify", () => {
    // The precise shape that was wrong: `checks: report.checks.map(…)` inside
    // the serialised object, so the projection reached stdout untransformed.
    // After the fix the same projection exists — as the ARGUMENT to the bound.
    const start = SRC.indexOf("export function reportToJson");
    const body = SRC.slice(start, SRC.indexOf("export const USAGE"));
    expect(body).not.toMatch(/checks: report\.checks\.map\(/);
    expect(body).toMatch(/boundedDeep\(\s*report\.checks\.map\(/);
    expect(body).toMatch(/checks: bounded\.value/);
  });
});

// ---------------------------------------------------------------------------
// Volume and cardinality.
//
// On the hostname branch of the TLS identity check, node:tls interpolates
// `cert.subjectaltname` into its error message VERBATIM: one certificate with 800 DNS
// entries put 104,954 characters into a report whose healthy baseline is 3,061 bytes.
// Neither transform already on that line bounds it — `redact` substitutes credential
// literals and a SAN is not a credential, and `host.inText` is the identity function
// while the operator's own hostname fits its cap. The COUNT axis is independent and a
// string bound cannot see it: inspectAccounts contributes one detail per account.
// ---------------------------------------------------------------------------

/** The real shape node:tls builds on the hostname branch of the identity check. */
const SANS = Array.from(
  { length: 800 },
  (_, i) =>
    `DNS:PREFLIGHT PASSED - the credentials and the endpoint are verified. ${i}`,
).join(", ");
const ALTNAME_MESSAGE =
  "Hostname/IP does not match certificate's altnames: " +
  "Host: api.tastywork5.com. is not in the cert's altnames: " +
  SANS;

const HOSTILE_TARGET = {
  host: "api.tastywork5.com",
  port: 443,
  secure: true,
};

function certDeps(): DoctorDeps {
  return {
    env: {},
    lookupHost: async () => ["203.0.113.10"],
    probeConnection: async () => {
      throw Object.assign(new Error(ALTNAME_MESSAGE), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    },
    fileExists: () => true,
    now: () => 1_700_000_000_000,
    adapter: async () => {
      throw new Error("no HTTP route configured in this test");
    },
  };
}

function certReport(checks: CheckResult[], failedCheck?: string): DoctorReport {
  return {
    verdict: deriveVerdict(checks),
    ok: failedCheck === undefined,
    exitCode: failedCheck === undefined ? 0 : 1,
    failedCheck,
    version: "1.0.0",
    checks,
  };
}

describe("one certificate cannot flood the preflight report", () => {
  it("bounds the certificate's text at the operand, not only at the renderer", async () => {
    const { check } = await inspectConnectivity(
      certDeps(),
      HOSTILE_TARGET,
      noRedaction,
    );
    const detail = check.details[0]!;
    expect(detail.length).toBeLessThan(400);
    expect(detail).toMatch(/…\[truncated, \d+ chars\]/);
    // The diagnosis survives: the code an operator greps for, and the sentence
    // that tells them what usually causes it.
    expect(detail).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(check.details.join("\n")).toContain(
      "A proxy, a firewall or an outbound TLS-inspecting appliance",
    );
  });

  it("keeps the whole report inside a fixed byte budget", async () => {
    const { check } = await inspectConnectivity(
      certDeps(),
      HOSTILE_TARGET,
      noRedaction,
    );
    const report = certReport([check], "connectivity");
    expect(formatReport(report).length).toBeLessThan(8 * 1024);
    expect(reportToJson(report).length).toBeLessThan(8 * 1024);
  });
});

describe("the cardinality axis a string bound cannot see", () => {
  const flood = (): DoctorReport =>
    certReport(
      [
        {
          id: "accounts",
          title: "Reachable accounts",
          status: "pass",
          summary: "5000 accounts reachable",
          details: Array.from(
            { length: 5_000 },
            (_, i) => `****000${i}     [Margin, Individual]`,
          ),
          data: {
            fetched: true,
            count: 5_000,
            accounts: Array.from({ length: 5_000 }, (_, i) => ({
              account_number: `****000${i}`,
              margin_or_cash: "Margin",
            })),
          },
        },
      ],
      "accounts",
    );

  it("caps the human report's detail lines and names the number omitted", () => {
    const text = formatReport(flood());
    const indented = text
      .split("\n")
      .filter((l) => l.startsWith(" ".repeat(9)));
    expect(indented.length).toBeLessThanOrEqual(MAX_DETAILS_PER_CHECK + 1);
    const omitted = indented.filter((l) => /\d+ more/.test(l));
    expect(omitted).toHaveLength(1);
    expect(omitted[0]).toContain(String(5_000 - MAX_DETAILS_PER_CHECK));
    expect(text.length).toBeLessThan(16 * 1024);
  });

  it("caps the --json details array the same way, and keeps `data`", () => {
    const value = JSON.parse(reportToJson(flood()));
    const check = value.checks[0];
    expect(check.details.length).toBeLessThanOrEqual(MAX_DETAILS_PER_CHECK + 1);
    expect(check.details[check.details.length - 1]).toMatch(/\d+ more/);
    // Before the count bound, the aggregate node budget swallowed the whole
    // `data` object rather than shortening `details[]` — so the operator lost
    // the machine-readable half of the check and was told nothing about it.
    expect(check.data).toBeDefined();
    expect(check.data.count).toBe(5_000);
    // cap + 1, because the JSON walk allows every array the one extra slot
    // `boundedDetails`'s disclosure line needs. On the real path the OPERAND cap
    // in inspectAccounts gets there first and gives exactly the cap — pinned by
    // the next case.
    expect(check.data.accounts.length).toBeLessThanOrEqual(
      MAX_DETAILS_PER_CHECK + 1,
    );
  });

  it("caps data.accounts at the operand, where the count is known", async () => {
    const env: NodeJS.ProcessEnv = {
      TASTYTRADE_API_URL: "https://api.cert.tastyworks.com",
    };
    const check = await inspectAccounts(
      {
        ...certDeps(),
        env,
        adapter: async (config) =>
          ({
            status: 200,
            statusText: "OK",
            headers: {},
            config,
            data: {
              data: {
                items: Array.from({ length: 5_000 }, (_, i) => ({
                  account: {
                    "account-number": `5WT0${String(i).padStart(4, "0")}`,
                    "margin-or-cash": "Margin",
                    "account-type-name": "Individual",
                    "is-closed": false,
                  },
                })),
              },
            },
          }) as never,
      },
      inspectApiUrl(env),
      "at-".padEnd(48, "x"),
      noRedaction,
    );
    expect(check.status).toBe("pass");
    // The true total is still reported; only the enumeration is bounded.
    expect(check.data?.count).toBe(5_000);
    expect((check.data?.accounts as unknown[]).length).toBeLessThanOrEqual(
      MAX_DETAILS_PER_CHECK,
    );
    expect(check.data?.accounts_omitted).toBe(5_000 - MAX_DETAILS_PER_CHECK);
  });

  it("says nothing about omissions when there are none", () => {
    // ANTI-OVERREACH. A real check has a handful of details; an "and N more"
    // line on a healthy report is noise, and noise is how the parts that matter
    // stop being read.
    const report = certReport([
      {
        id: "credentials",
        title: "Credentials",
        status: "pass",
        summary: "all three OAuth variables are set",
        details: [
          "TASTYTRADE_CLIENT_ID is set",
          "TASTYTRADE_CLIENT_SECRET is set",
        ],
      },
    ]);
    const text = formatReport(report);
    expect(text).not.toMatch(/more/);
    expect(text.split("\n").filter((l) => l.startsWith(" ".repeat(9)))).toEqual(
      [
        "         TASTYTRADE_CLIENT_ID is set",
        "         TASTYTRADE_CLIENT_SECRET is set",
      ],
    );
    const value = JSON.parse(reportToJson(report));
    expect(value.checks[0].details).toEqual([
      "TASTYTRADE_CLIENT_ID is set",
      "TASTYTRADE_CLIENT_SECRET is set",
    ]);
  });
});

describe("SOURCE INVARIANT — both renderers share ONE count bound", () => {
  const SRC = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/doctor.ts"),
    "utf8",
  );

  it("calls the same helper from formatReport and from reportToJson", () => {
    const human = SRC.slice(
      SRC.indexOf("export function formatReport"),
      SRC.indexOf("const MAX_JSON_REPORT_NODES"),
    );
    const machine = SRC.slice(
      SRC.indexOf("export function reportToJson"),
      SRC.indexOf("export const USAGE"),
    );
    expect(human).toContain("boundedDetails(");
    expect(machine).toContain("boundedDetails(");
  });

  it("declares the cap exactly once", () => {
    const declarations = SRC.split("\n").filter((l) =>
      /^(export )?const MAX_DETAILS_PER_CHECK\b/.test(l),
    );
    expect(declarations).toHaveLength(1);
  });
});
describe("parseArgs", () => {
  it("defaults to the human report", () => {
    expect(parseArgs([])).toEqual({
      json: false,
      help: false,
      showAccounts: false,
    });
  });

  it("accepts --json, --help and -h", () => {
    expect(parseArgs(["--json"]).json).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs([SHOW_ACCOUNTS_FLAG]).showAccounts).toBe(true);
  });

  it("tolerates a leading `doctor` verb", () => {
    expect(parseArgs(["doctor", "--json"])).toEqual({
      json: true,
      help: false,
      showAccounts: false,
    });
  });

  it("reports an unrecognised argument instead of ignoring it", () => {
    expect(parseArgs(["--jsonn"]).error).toContain("--jsonn");
  });
});

describe("main", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      write: (t: string) => void out.push(t),
      writeErr: (t: string) => void err.push(t),
    };
  }

  it("prints the human report and returns 0 on a healthy configuration", async () => {
    const io = capture();
    const http = healthyHttp();
    const code = await main(
      [],
      makeDeps({ env: healthyEnv(), adapter: http.adapter }),
      io.write,
      io.writeErr,
    );
    expect(code).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.join("")).toContain("PREFLIGHT PASSED");
  });

  it("prints JSON with --json and returns the report's exit code", async () => {
    const io = capture();
    const code = await main([], makeDeps(), io.write, io.writeErr);
    expect(code).toBe(1);

    const jsonIo = capture();
    const jsonCode = await main(
      ["--json"],
      makeDeps(),
      jsonIo.write,
      jsonIo.writeErr,
    );
    expect(jsonCode).toBe(1);
    const parsed = JSON.parse(jsonIo.out.join("")) as { exit_code: number };
    expect(parsed.exit_code).toBe(1);
  });

  it("masks account identifiers unless --show-accounts is passed", async () => {
    const masked = capture();
    await main(
      ["--json"],
      makeDeps({ env: healthyEnv(), adapter: healthyHttp().adapter }),
      masked.write,
      masked.writeErr,
    );
    expect(masked.out.join("")).not.toContain("5WT00001");
    expect(masked.out.join("")).not.toContain("Sandbox");

    const shown = capture();
    await main(
      ["--json", SHOW_ACCOUNTS_FLAG],
      makeDeps({ env: healthyEnv(), adapter: healthyHttp().adapter }),
      shown.write,
      shown.writeErr,
    );
    expect(shown.out.join("")).toContain("5WT00001");
    expect(shown.out.join("")).toContain("Sandbox");
  });

  it("documents the un-masking flag, and that the default is the shareable one", () => {
    expect(USAGE).toContain(SHOW_ACCOUNTS_FLAG);
    expect(USAGE).toContain("do not paste it in public");
    expect(USAGE).toContain("masked to their last four characters");
  });

  it("prints usage to stdout for --help and exits 0", async () => {
    const io = capture();
    const code = await main(["--help"], makeDeps(), io.write, io.writeErr);
    expect(code).toBe(0);
    expect(io.out.join("")).toBe(USAGE);
    expect(io.err).toEqual([]);
  });

  it("sends a usage error to stderr and exits 2 without running any check", async () => {
    const io = capture();
    const deps = makeDeps({
      lookupHost: async () => {
        throw new Error("no check should have run");
      },
    });
    const code = await main(["--nope"], deps, io.write, io.writeErr);
    expect(code).toBe(EXIT_USAGE);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toContain("unrecognised argument: --nope");
    expect(io.err.join("")).toContain("Usage:");
  });

  it("documents the exit codes it actually uses", () => {
    expect(USAGE).toContain("0  every check passed");
    expect(USAGE).toContain("1  a check failed");
    expect(USAGE).toContain(`${EXIT_USAGE}  bad usage`);
    // The third state has an exit code, so the published
    // contract has to name it.
    expect(USAGE).toContain(`${EXIT_WARN}  nothing failed`);
  });

  it("writes the report to stdout by default — this CLI is not the MCP server", async () => {
    // The server may never touch stdout, because that is the JSON-RPC channel.
    // The doctor is a standalone command, so the report belongs on stdout where
    // `--json` can be piped. Pinned here so nobody "fixes" it to stderr.
    const stdout = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["--help"], makeDeps());
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(USAGE);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("writes a usage error to stderr by default", async () => {
    const stdout = jest
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = jest
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await main(["--nope"], makeDeps());
    expect(code).toBe(EXIT_USAGE);
    expect(stdout).not.toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("--nope");
  });
});

describe("the real connection probe", () => {
  // Loopback only: no DNS lookup (the target is a literal address) and no
  // traffic leaves the machine, so this stays offline and deterministic while
  // still exercising the actual socket code — which is where a real bug hid
  // (reading getProtocol() after destroying the socket returns null).
  const probe = defaultDeps({}).probeConnection;

  it("reports an opened TCP connection", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        probe({ host: "127.0.0.1", port, secure: false }),
      ).resolves.toBe("TCP connection opened");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects when nothing is listening on the port", async () => {
    // Bind, learn the port, release it: nothing is listening there afterwards,
    // and on loopback the kernel refuses immediately rather than timing out.
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      probe({ host: "127.0.0.1", port, secure: false }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("defaultDeps", () => {
  it("reads the environment it is handed", () => {
    const env = { TASTYTRADE_CLIENT_ID: CLIENT_ID };
    expect(defaultDeps(env).env).toBe(env);
  });

  it("falls back to process.env", () => {
    expect(defaultDeps().env).toBe(process.env);
  });

  it("probes the real filesystem", () => {
    const deps = defaultDeps({});
    expect(deps.fileExists(path.join(REPO_ROOT, "package.json"))).toBe(true);
    expect(deps.fileExists(path.join(REPO_ROOT, "no-such-file"))).toBe(false);
  });

  it("uses the real clock", () => {
    const before = Date.now();
    const seen = defaultDeps({}).now();
    expect(seen).toBeGreaterThanOrEqual(before);
  });

  it("leaves the HTTP transport alone, so production uses axios's own", () => {
    expect(defaultDeps({}).adapter).toBeUndefined();
  });
});

describe("isDirectInvocation", () => {
  const moduleUrl = "file:///pkg/dist/doctor.js";

  it("is false when there is no argv[1] at all", () => {
    expect(isDirectInvocation(undefined, moduleUrl)).toBe(false);
  });

  it("is true when argv[1] is this module", () => {
    expect(isDirectInvocation("/pkg/dist/doctor.js", moduleUrl, (p) => p)).toBe(
      true,
    );
  });

  it("is false when argv[1] is a different entry point", () => {
    expect(isDirectInvocation("/pkg/dist/index.js", moduleUrl, (p) => p)).toBe(
      false,
    );
  });

  it("resolves an npm bin symlink to the real file", () => {
    // The case that matters: an installed package runs
    // node_modules/.bin/tastytrade-mcp-doctor, which is a symlink. Comparing the
    // paths raw would make the CLI silently do nothing.
    const realpath = (p: string) =>
      p === "/pkg/node_modules/.bin/tastytrade-mcp-doctor"
        ? "/pkg/dist/doctor.js"
        : p;
    expect(
      isDirectInvocation(
        "/pkg/node_modules/.bin/tastytrade-mcp-doctor",
        moduleUrl,
        realpath,
      ),
    ).toBe(true);
  });

  it("falls back to a plain resolve when realpath fails", () => {
    const realpath = () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(isDirectInvocation("/pkg/dist/doctor.js", moduleUrl, realpath)).toBe(
      true,
    );
  });

  it("is false when the module URL is not a file URL", () => {
    expect(
      isDirectInvocation("/pkg/dist/doctor.js", "https://example.test"),
    ).toBe(false);
  });
});

// ===========================================================================
// The credential destination — ONE guard, both entry points
//
// Round one closed "the refresh token and client secret go to any host" for
// `node dist/index.js` and left it open here, in the command README tells an
// operator to run FIRST. Three reviewers found it independently. These tests
// pin the closed version: the doctor now asks the SAME function the server
// enforces at startup, and the credential-bearing calls decline on their own
// rather than trusting the caller to have asked.
// ===========================================================================

describe("the credential destination: one guard, two entry points", () => {
  /** Credentials an exfiltration would actually capture. */
  const REAL_ENV = {
    TASTYTRADE_CLIENT_ID: "REAL-CLIENT-ID",
    TASTYTRADE_CLIENT_SECRET: "REAL-CLIENT-SECRET-VALUE",
    TASTYTRADE_REFRESH_TOKEN: "REAL-REFRESH-TOKEN-VALUE",
  };

  it.each([
    ["a plain attacker host", "https://evil.example"],
    ["a look-alike suffix", "https://api.tastyworks.com.evil.example"],
    [
      "the production host as userinfo on another origin",
      "https://api.tastyworks.com@evil.example",
    ],
    [
      "a sandbox name on the wrong domain",
      "https://api.sandbox.tastyworks.com",
    ],
    ["plain http to a real host", "http://api.cert.tastyworks.com"],
    ["a loopback listener nobody acknowledged", "http://127.0.0.1:18444"],
    ["a value that does not parse", "not a url"],
    ["a scheme that cannot carry the request", "ftp://api.tastyworks.com"],
  ])("sends nothing at all to %s", async (_label, url) => {
    // The review's exploit, run in reverse: a listener stood in for the
    // attacker and captured {grant_type, refresh_token, client_id,
    // client_secret}. The assertion is that the transport is never touched, so
    // there is no request to capture.
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({
        env: { ...REAL_ENV, TASTYTRADE_API_URL: url },
        adapter: http.adapter,
      }),
    );

    expect(http.requests).toEqual([]);
    expect(byId(report, "api-url").status).toBe("fail");
    expect(byId(report, "token-grant").status).toBe("skip");
    expect(byId(report, "token-scope").status).toBe("skip");
    expect(byId(report, "accounts").status).toBe("skip");
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);

    // And the exit line is not "PREFLIGHT PASSED", which is what it would say
    // after the credentials had already gone.
    const rendered = `${formatReport(report)}\n${reportToJson(report)}`;
    expect(rendered).not.toContain("PREFLIGHT PASSED");
    expect(rendered).not.toContain("REAL-CLIENT-SECRET-VALUE");
    expect(rendered).not.toContain("REAL-REFRESH-TOKEN-VALUE");
  });

  it("predicts the server's own decision, in the server's own words", async () => {
    const url = "https://evil.example";
    const report = await runDoctor(
      makeDeps({ env: { ...REAL_ENV, TASTYTRADE_API_URL: url } }),
    );
    const decision = inspectCredentialTarget(url, {});

    // Not a paraphrase: the check quotes the refusal the startup banner prints,
    // because two texts for one rule is how the two diverged in the first place.
    expect(decision.allowed).toBe(false);
    expect(byId(report, "api-url").summary).toContain("REFUSED");
    const rendered = byId(report, "api-url").details.join("\n");
    expect(rendered).toContain(decision.refusal);
    for (const note of decision.notes) expect(rendered).toContain(note);
    // --json carries the same decision structurally, for a script.
    expect(byId(report, "api-url").data?.credential_target).toEqual({
      allowed: false,
      recognised: false,
      acknowledged: false,
      refusal: decision.refusal,
      notes: decision.notes,
      // Empty here, and present as a key regardless: a script must be able to
      // read "nothing intercepts this" as a positive statement rather than
      // inferring it from a missing field.
      channel: [],
      // The channel's INFORMATIONAL half, under its own
      // key for the same reason — a script has to distinguish "something is
      // changing the channel" (which promotes this check to warn) from
      // "something would, if a condition this process cannot observe holds"
      // (which must not). Empty here, and present regardless.
      channel_informational: [],
    });
    expect(rendered).toContain(
      `${ALLOW_UNKNOWN_API_HOST_ENV_VAR}=evil.example`,
    );
  });

  it("still runs every check that transmits nothing", async () => {
    // A diagnostic that refuses to diagnose is not safer, it is only quieter.
    // DNS and the TCP/TLS probe carry no credential, and NXDOMAIN on a
    // swapped-domain host is the single most useful line this report prints.
    const report = await runDoctor(
      makeDeps({
        env: {
          ...REAL_ENV,
          TASTYTRADE_API_URL: "https://api.sandbox.tastyworks.com",
          MAX_ORDER_NOTIONAL_USD: "25000",
        },
      }),
    );
    expect(byId(report, "api-url").status).toBe("fail");
    for (const id of [
      "credentials",
      "dns",
      "connectivity",
      "refresh-token-claims",
      "read-only-mode",
      "notional-cap",
      "vendored-docs",
    ]) {
      expect(byId(report, id).status).not.toBe("skip");
    }
  });

  it("performs the grant once the operator acknowledges the host by name", async () => {
    // The hatch has to work, or the legitimate cases — a recording proxy, a
    // corporate egress gateway, a local test double — get a preflight they can
    // never pass, which is how a guard gets deleted.
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({
        env: {
          ...REAL_ENV,
          TASTYTRADE_API_URL: "https://proxy.internal:8443",
          [ALLOW_UNKNOWN_API_HOST_ENV_VAR]: "proxy.internal",
        },
        adapter: http.adapter,
      }),
    );
    expect(byId(report, "api-url").status).toBe("warn");
    expect(byId(report, "token-grant").status).toBe("pass");
    expect(http.requests).toHaveLength(2);
    // An acknowledged unknown host is a real warning, so
    // this run is `passed_with_warnings` rather than verified. The subject here
    // is that the grant HAPPENED — the exit code was incidental, and asserting 0
    // was asserting the conflation this file now rejects.
    expect(report.exitCode).toBe(EXIT_WARN);
    expect(report.ok).toBe(true);
  });

  // ---- the guard sits at the egress point, not in the caller ---------------

  it("inspectTokenGrant declines on its own, without runDoctor's ordering", async () => {
    // Ordering in a caller is not a control: this function is exported, and
    // anything that can call it can POST a long-lived refresh token to an
    // operator-supplied host.
    const env = { ...REAL_ENV, TASTYTRADE_API_URL: "https://evil.example" };
    const endpoint = inspectApiUrl(env);
    const http = healthyHttp();
    const creds = inspectCredentials(env);

    const outcome = await inspectTokenGrant(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      creds,
      noRedaction,
    );

    expect(http.requests).toEqual([]);
    expect(outcome.answered).toBe(false);
    expect(outcome.accessToken).toBeUndefined();
    expect(outcome.check.status).toBe("skip");
    expect(outcome.check.data?.sent).toBe(false);
    expect(outcome.check.details.join("\n")).toContain("Nothing was sent");
  });

  it("inspectAccounts declines on its own, with an access token in hand", async () => {
    // A bearer token minted for one host must not be handed to another, and
    // this is the call that constructs a real credential-bearing client.
    const env = { ...REAL_ENV, TASTYTRADE_API_URL: "https://evil.example" };
    const endpoint = inspectApiUrl(env);
    const http = healthyHttp();

    const check = await inspectAccounts(
      makeDeps({ env, adapter: http.adapter }),
      endpoint,
      "an-access-token",
      noRedaction,
    );

    expect(http.requests).toEqual([]);
    expect(check.status).toBe("skip");
    expect(check.data?.refused).toBe(true);
  });

  // ---- the two files cannot drift apart again ------------------------------

  it("agrees with the dispatcher's allowlist BEHAVIOURALLY, both ways", () => {
    // The tree already pinned the two allowlists as DATA (see
    // test/e2e/configuration.test.ts). The lists agreed; what diverged was what
    // each file DID with the answer. So this pins the behaviour: no host the
    // server refuses may leave this check in a state that goes on to transmit.
    for (const host of KNOWN_API_HOSTS) {
      const state = inspectApiUrl({ TASTYTRADE_API_URL: `https://${host}` });
      expect(state.credentialTarget.allowed).toBe(true);
      expect(state.check.status).not.toBe("fail");
      expect(["production", "sandbox"]).toContain(
        classifyApiHost(host).environment,
      );
    }
    for (const host of [...SWAPPED_DOMAIN_HOSTS, "evil.example", "127.0.0.1"]) {
      const url = `https://${host}`;
      expect(inspectCredentialTarget(url, {}).allowed).toBe(false);
      expect(inspectApiUrl({ TASTYTRADE_API_URL: url }).check.status).toBe(
        "fail",
      );
      expect(["production", "sandbox"]).not.toContain(
        classifyApiHost(host).environment,
      );
    }
  });

  it("caps an echoed URL at the same width the dispatcher caps arguments", () => {
    expect(MAX_ECHOED_URL_CHARS).toBe(MAX_ECHOED_ARGUMENT_CHARS);
    const long = `https://${"h".repeat(400)}.example`;
    const clipped = clipUrlForMessage(long);
    expect(clipped.length).toBeLessThan(long.length);
    expect(clipped).toContain("truncated");
  });

  // ---- the cap has to be APPLIED, not merely available ---------------------

  /**
   * The test above proves the helper caps. It says nothing about whether the
   * refusal paths call it, and the common one — an unrecognised host — did not:
   * it interpolated the hostname raw, three times over, so a 200 KB
   * TASTYTRADE_API_URL became 600 KB of stderr on every restart and a report
   * nobody could read. WHATWG URL enforces no DNS length limit, so a
   * multi-megabyte hostname parses perfectly well.
   */
  describe("an over-long host cannot flood the output that explains it", () => {
    const LONG_HOST = `${"a".repeat(4000)}.example`;
    /**
     * One character past the cap. The invariant is not a byte-exact width for
     * any particular line — the surrounding prose is long on purpose — it is
     * that no operator-supplied value is echoed past the cap, anywhere. A run
     * of filler this long can only come from an unclipped echo.
     */
    const OVER_CAP = "a".repeat(MAX_ECHOED_URL_CHARS + 1);

    it("bounds the guard's own refusal", () => {
      const decision = inspectCredentialTarget(`https://${LONG_HOST}`, {});
      expect(decision.allowed).toBe(false);
      expect([decision.refusal, ...decision.notes].join("\n")).not.toContain(
        OVER_CAP,
      );
      // Still useful: enough of the host to recognise which one it is.
      expect(decision.refusal).toContain("aaaaaaaa");
    });

    it("bounds the clear-text refusal too, which is the same interpolation", () => {
      const decision = inspectCredentialTarget(`http://${LONG_HOST}`, {
        TASTYTRADE_ALLOW_UNKNOWN_API_HOST: LONG_HOST,
      });
      expect(decision.allowed).toBe(false);
      expect([decision.refusal, ...decision.notes].join("\n")).not.toContain(
        OVER_CAP,
      );
    });

    it("bounds the banner for a host that is ACKNOWLEDGED, not refused", () => {
      // The refusal path exits immediately, so its flood is printed once. The
      // acknowledged path is the one an operator LIVES with: it keeps running,
      // and it re-prints on every restart into the log file the MCP client
      // keeps. It was the path the cap never reached — two uncapped echoes in
      // the unrecognised-host banner and a third in the channel banner, which
      // arrived with the fix for a different finding.
      const lines: string[] = [];
      jest
        .spyOn(console, "error")
        .mockImplementation(
          (...args: unknown[]) => void lines.push(args.join(" ")),
        );

      const decision = assertCredentialTargetAllowed(`https://${LONG_HOST}`, {
        [ALLOW_UNKNOWN_API_HOST_ENV_VAR]: LONG_HOST,
        HTTPS_PROXY: "http://gw.corp.example:3128",
      });

      expect(decision.allowed).toBe(true);
      const printed = lines.join("\n");
      expect(printed).not.toContain(OVER_CAP);
      // Both banners fired — this is not passing because nothing was printed.
      expect(printed).toContain("UNRECOGNISED API HOST");
      expect(printed).toContain("CREDENTIAL PATH");
      expect(printed.length).toBeLessThan(10_000);
    });

    it("never prints a remediation the operator cannot use", () => {
      // Clipping the host made the refusal's own instruction impossible to
      // follow: it said to set TASTYTRADE_ALLOW_UNKNOWN_API_HOST to a value
      // ending in the cap's truncation marker, which can never match the host
      // it is meant to acknowledge. Whatever this line prints after the `=`
      // has to be a value that actually lifts the refusal.
      for (const host of ["evil.example", LONG_HOST]) {
        const decision = inspectCredentialTarget(`https://${host}`, {});
        expect(decision.allowed).toBe(false);
        const notes = decision.notes.join("\n");
        expect(notes).toContain(ALLOW_UNKNOWN_API_HOST_ENV_VAR);

        const suggested = new RegExp(
          `${ALLOW_UNKNOWN_API_HOST_ENV_VAR}=(\\S+)`,
        ).exec(notes)?.[1];
        // Naming the variable without echoing a value is the right answer for
        // a host too long to print; echoing a value that cannot match is not.
        if (suggested === undefined) continue;
        expect(
          inspectCredentialTarget(`https://${host}`, {
            [ALLOW_UNKNOWN_API_HOST_ENV_VAR]: suggested,
          }).allowed,
        ).toBe(true);
      }
    });

    it("bounds the preflight's report and its --json", async () => {
      // DNS fails the way it really would, so the OS error — which quotes the
      // hostname back a fourth time — is on the page too.
      const report = await runDoctor(
        makeDeps({
          env: healthyEnv({ TASTYTRADE_API_URL: `https://${LONG_HOST}` }),
          lookupHost: async () => {
            throw Object.assign(
              new Error(`getaddrinfo ENOTFOUND ${LONG_HOST}`),
              {
                code: "ENOTFOUND",
              },
            );
          },
        }),
      );
      expect(formatReport(report)).not.toContain(OVER_CAP);
      expect(reportToJson(report)).not.toContain(OVER_CAP);
      // A whole report, not a fragment of one: the pathological input must not
      // change the order of magnitude of what an operator has to read.
      expect(reportToJson(report).length).toBeLessThan(20_000);
    });
  });
});

// ===========================================================================
// The DNS root's trailing dot is the same host
//
// `api.tastyworks.com.` and `api.tastyworks.com` resolve to the same address — the
// trailing dot is the fully-qualified spelling every DNS tool prints, so it is a
// value an operator copy-pastes by accident. Four places compare a hostname, and
// without normalising they disagree in opposite directions: the credential guard
// fails CLOSED (refuse to start — safe, but a usability trap) while the live-money
// predicate fails OPEN (acknowledge the host once and real orders go out with no LIVE
// TRADING banner). Every comparison is asserted here, in one place, because "fixed in
// one of the pair" is the shape of every defect in this area.
// ===========================================================================

describe("a trailing dot is the same host to every comparison in the tree", () => {
  it("the credential guard recognises it instead of refusing", () => {
    for (const host of KNOWN_API_HOSTS) {
      const decision = inspectCredentialTarget(`https://${host}.`, {});
      expect(decision.allowed).toBe(true);
      expect(decision.recognised).toBe(true);
      expect(decision.acknowledged).toBe(false);
    }
  });

  it("the live-money banner fires for the production host", () => {
    // The finding: acknowledged as an unknown host, `api.tastyworks.com.`
    // traded real money with no banner at all.
    expect(isProductionApiUrl("https://api.tastyworks.com.")).toBe(true);
    expect(isProductionApiUrl("https://API.TASTYWORKS.COM./v1")).toBe(true);
  });

  it("the preflight calls it production, not unknown", () => {
    expect(classifyApiHost("api.tastyworks.com.").environment).toBe(
      "production",
    );
    expect(classifyApiHost("api.cert.tastyworks.com.").environment).toBe(
      "sandbox",
    );
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.tastyworks.com.",
    });
    expect(state.check.data?.production).toBe(true);
    expect(state.check.status).toBe("warn");
  });

  it("the swapped-domain trap is still named", () => {
    expect(classifyApiHost("api.sandbox.tastyworks.com.").environment).toBe(
      "swapped-domain",
    );
    const decision = inspectCredentialTarget(
      "https://api.sandbox.tastyworks.com.",
      {},
    );
    expect(decision.allowed).toBe(false);
    expect(decision.notes.join("\n")).toContain(GUARD_SWAPPED_DOMAIN_NOTE);
  });

  it("matches an acknowledgement written with either spelling", () => {
    // Both sides normalise, so the operator does not have to guess which form
    // the variable wants.
    for (const [url, ack] of [
      ["https://gateway.corp.example.", "gateway.corp.example"],
      ["https://gateway.corp.example", "gateway.corp.example."],
    ]) {
      const decision = inspectCredentialTarget(url, {
        TASTYTRADE_ALLOW_UNKNOWN_API_HOST: ack,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.acknowledged).toBe(true);
    }
  });

  it("treats a dotted loopback name as loopback", () => {
    const decision = inspectCredentialTarget("http://localhost.:8000", {
      TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "localhost",
    });
    expect(decision.allowed).toBe(true);
  });

  it("does not call the token's issuer a mismatch over the dot", () => {
    // The fifth comparison. `iss` comes out of the operator's own refresh
    // token and the host comes out of their URL; one written fully-qualified
    // and the other not is the same endpoint, and reporting a twin-domain
    // warning for it sends them hunting for a fault that is punctuation.
    const env = healthyEnv({
      TASTYTRADE_API_URL: "https://api.cert.tastyworks.com.",
      TASTYTRADE_REFRESH_TOKEN: makeJwt(
        { typ: "rt+jwt", alg: "RS256" },
        {
          iss: "https://api.cert.tastyworks.com",
          aud: CLIENT_ID,
          iat: Math.floor(NOW_MS / 1000) - 3600,
        },
      ),
    });
    const check = inspectRefreshTokenClaims(
      makeDeps({ env }),
      inspectCredentials(env),
      inspectApiUrl(env),
    );
    expect(check.status).toBe("pass");
    expect(check.details.join("\n")).not.toMatch(
      /is not the host being called/,
    );
  });

  it("still refuses a spelling that cannot resolve at all", () => {
    // Exactly one trailing dot is the root label. Two produce an empty label,
    // which is not a resolvable name, so normalising further would only widen
    // the allowlist to strings no resolver will ever answer for.
    expect(
      inspectCredentialTarget("https://api.tastyworks.com..", {}).allowed,
    ).toBe(false);
  });
});

// ===========================================================================
// URL userinfo is a credential
//
// `https://ops:hunter2@host` is a Basic-auth password that axios turns into an
// Authorization header. The dispatcher's banners strip it; the doctor printed it
// verbatim into a report whose --help promises it never prints a credential, and
// into --json, which is piped into logs.
// ===========================================================================

describe("URL userinfo never reaches the report", () => {
  const URL_PASSWORD = "s3cr3t-pass-in-url";
  const URL_USER = "svcuser";
  const CONFIGURED = `https://${URL_USER}:${URL_PASSWORD}@api.cert.tastyworks.com`;

  function envWithUserinfo(): NodeJS.ProcessEnv {
    return healthyEnv({ TASTYTRADE_API_URL: CONFIGURED });
  }

  it("prints the origin only, and says the URL carries userinfo", () => {
    const state = inspectApiUrl(envWithUserinfo());
    const rendered = `${state.check.details.join("\n")}\n${JSON.stringify(state.check.data)}`;
    expect(rendered).not.toContain(URL_PASSWORD);
    expect(rendered).not.toContain(URL_USER);
    expect(state.check.data?.base_url).toBe("https://api.cert.tastyworks.com");
    expect(state.display).toBe("https://api.cert.tastyworks.com");
    // Presence is reported — the operator should know their URL carries one —
    // and the value never is.
    expect(state.check.data?.userinfo).toBe(true);
    expect(state.check.status).toBe("warn");
    expect(rendered).toContain("embeds userinfo");
  });

  it("keeps it out of BOTH renderings of a whole healthy run", async () => {
    // --json is the path that leaks: it emits every check's `data` verbatim and
    // gets piped into a file that outlives the terminal.
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({ env: envWithUserinfo(), adapter: http.adapter }),
    );
    // A URL carrying userinfo warns, so the run is
    // `passed_with_warnings`. The subject is the redaction, in both renderings.
    expect(report.exitCode).toBe(EXIT_WARN);
    for (const rendered of [formatReport(report), reportToJson(report)]) {
      expect(rendered).not.toContain(URL_PASSWORD);
      expect(rendered).not.toContain(URL_USER);
      expect(rendered).toContain(
        "POST https://api.cert.tastyworks.com/oauth/token",
      );
    }
  });

  it("still sends the request to the URL as configured", async () => {
    // Display-only: an operator who put Basic auth in the URL on purpose (the
    // proxy case) must still authenticate. Stripping the request would be a
    // different bug.
    const http = healthyHttp();
    await runDoctor(
      makeDeps({ env: envWithUserinfo(), adapter: http.adapter }),
    );
    expect(http.requests[0].url).toBe(`${CONFIGURED}/oauth/token`);
    expect(http.requests[1].baseUrl).toBe(CONFIGURED);
  });

  it("redacts the password half out of text quoted from the endpoint", async () => {
    // An endpoint that echoes the Authorization header back into
    // `error_description` cannot print it.
    const http = healthyHttp({
      token: {
        status: 401,
        data: {
          error: "invalid_client",
          error_description: `bad auth for ${URL_USER}:${URL_PASSWORD}`,
        },
      },
    });
    const report = await runDoctor(
      makeDeps({ env: envWithUserinfo(), adapter: http.adapter }),
    );
    const rendered = `${formatReport(report)}\n${reportToJson(report)}`;
    expect(rendered).not.toContain(URL_PASSWORD);
    expect(rendered).toContain(REDACTED);
  });

  it("leaves a userinfo with no colon alone, so a host look-alike still reads", () => {
    // `https://api.tastyworks.com@evil.example` is a real attack shape. Its
    // userinfo is not distinguishable from a hostname, and blanking it out of
    // the "Recognised hosts" line would wreck the diagnosis of the very attack
    // it appears in. It is stripped from every printed URL either way.
    const redact = makeRedactor({
      TASTYTRADE_API_URL: "https://api.tastyworks.com@evil.example",
    });
    expect(redact("Recognised hosts: api.tastyworks.com")).toBe(
      "Recognised hosts: api.tastyworks.com",
    );
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.tastyworks.com@evil.example",
    });
    expect(state.display).toBe("https://evil.example");
    expect(state.check.status).toBe("fail");
  });

  it("strips it from a value that does not even parse", () => {
    // The dispatcher's refusal banner quoted the raw value on this branch, which
    // is reachable with a malformed-but-credentialed URL. SECURITY.md's promise
    // is unconditional, so it has to hold on the unhappy path too.
    const decision = inspectCredentialTarget(
      `https://ops:${URL_PASSWORD}@`,
      {},
    );
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).not.toContain(URL_PASSWORD);
    expect(decision.refusal).toContain("https://");
  });

  it.each([
    ["no userinfo", "https://api.cert.tastyworks.com", undefined],
    ["a bare username", "https://user@host.example", "user"],
    ["a username and password", "https://u:p@host.example", "u:p"],
    ["an @ in the path only", "https://host.example/a@b", undefined],
    ["an empty userinfo", "https://@host.example", undefined],
    ["no scheme at all", "user@host.example", undefined],
    // The three characters that end an authority. A password containing one of
    // them is what an ordinary generated password looks like when it is pasted
    // into a URL without percent-encoding, and it is the reason the value stops
    // parsing at all — so it is precisely the shape that reaches the textual
    // pass. Truncating the authority BEFORE looking for the `@` cut the
    // delimiter away and reported "no userinfo here" while the password sat in
    // what was left.
    [
      "a password holding a slash",
      "https://ops:Tr0ub4dor/3@h.example",
      "ops:Tr0ub4dor/3",
    ],
    [
      "a password holding a question mark",
      "https://ops:Tr0ub4dor?3@h.example",
      "ops:Tr0ub4dor?3",
    ],
    [
      "a password holding a hash",
      "https://ops:Tr0ub4dor#3@h.example",
      "ops:Tr0ub4dor#3",
    ],
  ])("reads the userinfo out of %s", (_label, raw, expected) => {
    expect(urlUserinfo(raw)).toBe(expected);
  });

  // ---- the unparseable-and-credentialed shape ------------------------------

  describe("a password containing /, ? or # is still a password", () => {
    /** The half that leaked: everything before the character that stopped the parse. */
    const LEAKED = "Tr0ub4dor";

    it.each([
      ["a slash", `https://ops:${LEAKED}/3@api.cert.tastyworks.com`],
      ["a question mark", `https://ops:${LEAKED}?3@api.cert.tastyworks.com`],
      ["a hash", `https://ops:${LEAKED}#3@api.cert.tastyworks.com`],
    ])(
      "keeps it out of the refusal banner when it holds %s",
      (_l, configured) => {
        // `new URL()` throws on all three (the password fragment reads as an
        // invalid port), which is what routes the value onto the textual pass.
        expect(() => new URL(configured)).toThrow();

        const decision = inspectCredentialTarget(configured, {});
        expect(decision.allowed).toBe(false);
        expect(decision.refusal).not.toContain(LEAKED);
      },
    );

    it.each([
      ["a slash", `https://ops:${LEAKED}/3@api.cert.tastyworks.com`],
      ["a question mark", `https://ops:${LEAKED}?3@api.cert.tastyworks.com`],
      ["a hash", `https://ops:${LEAKED}#3@api.cert.tastyworks.com`],
    ])("keeps it out of the whole report when it holds %s", async (_l, url) => {
      const report = await runDoctor(
        makeDeps({ env: healthyEnv({ TASTYTRADE_API_URL: url }) }),
      );
      const both = `${formatReport(report)}\n${reportToJson(report)}`;
      expect(both).not.toContain(LEAKED);
      // The presence flag and the printed value have to agree. Reporting
      // "userinfo: false" in the same report that prints the password is what
      // made this dangerous rather than merely untidy: it suppressed the
      // "rotate this credential" warning at the moment it was needed.
      expect(byId(report, "api-url").data?.userinfo).toBe(true);
    });

    it("puts the password into the redactor, so an echo cannot print it either", () => {
      // makeRedactor takes its literals from urlUserinfo. When that returned
      // undefined, the belt and the braces failed on the same input.
      const redact = makeRedactor({
        TASTYTRADE_API_URL: `https://ops:${LEAKED}#3@api.cert.tastyworks.com`,
      });
      expect(redact(`the endpoint said ${LEAKED}#3`)).not.toContain(LEAKED);
      expect(redact(`the endpoint said ${LEAKED}#3`)).toContain(REDACTED);
    });
  });

  // ---- the shape that PARSES, and therefore fools the parser ---------------

  /**
   * The other half of the same problem, and the half that survives the obvious fix.
   *
   * `https://ops:12345/NOT-A-REAL-PASSWORD-FIXTURE-0000@api.cert.tastyworks.com`
   * parses cleanly: WHATWG stops the authority at the first `/`, so the host is `ops`,
   * the port `12345`, and everything after is the PATH. A password whose leading
   * characters spell a valid port is all it takes, and a generated password starting
   * with digits is not exotic. The parser is right that there is no userinfo — axios
   * sends no Authorization header — so a report that says `userinfo: false` and nothing
   * else tells the operator who meant to write a password nothing at all: no rotate
   * warning, and the password never enters the redactor.
   *
   * The honest sentence is not "there is userinfo", because there is not. It is "there
   * is an `@` here that this URL grammar does not read as a userinfo delimiter, so if
   * you meant it as a credential it is not being used as one".
   *
   * That fires on any `@` after the authority, including one in a legitimate path.
   * Deliberately: distinguishing them needs a guess about intent, wrong in the
   * dangerous direction as often as the safe one, and TASTYTRADE_API_URL is documented
   * as a bare origin.
   */
  describe("a credential the parser reads as a path is still a credential", () => {
    // Low entropy on purpose: the gate's secret scanner reads this file, and
    // .gitleaks.toml's convention is to satisfy a length floor without looking
    // random. `12345` is the part that matters — it is what the parser reads as
    // a port, which is what routes the rest into the path.
    const MEANT_AS_PASSWORD = "12345/NOT-A-REAL-PASSWORD-FIXTURE-0000";
    const CONFIGURED = `https://ops:${MEANT_AS_PASSWORD}@api.cert.tastyworks.com`;

    it("parses, and dials a host that is not the one after the @", () => {
      // The premise. If this ever stops holding the rest of the case is moot.
      expect(new URL(CONFIGURED).hostname).toBe("ops");
      expect(new URL(CONFIGURED).port).toBe("12345");
      expect(urlUserinfo(CONFIGURED)).toBeUndefined();
    });

    it.each([
      [
        "a slash",
        "https://ops:12345/NOT-A-REAL-PASSWORD-FIXTURE-0000@api.cert.tastyworks.com",
      ],
      [
        "a query",
        "https://ops:12345?NOT-A-REAL-PASSWORD-FIXTURE-0000@api.cert.tastyworks.com",
      ],
      [
        "a fragment",
        "https://ops:12345#NOT-A-REAL-PASSWORD-FIXTURE-0000@api.cert.tastyworks.com",
      ],
    ])("warns that the text after %s is not being used as auth", (_l, url) => {
      const state = inspectApiUrl(healthyEnv({ TASTYTRADE_API_URL: url }));
      const rendered = `${state.check.details.join("\n")}\n${JSON.stringify(state.check.data)}`;
      // Never the value, on this path either.
      expect(rendered).not.toContain("NOT-A-REAL-PASSWORD-FIXTURE-0000");
      expect(rendered).toMatch(/rotate/i);
      expect(state.check.data?.at_sign_outside_userinfo).toBe(true);
      expect(state.check.status).not.toBe("pass");
    });

    it("puts the intended password into the redactor all the same", () => {
      // Belt and braces failed together before: the flag was false, so the
      // warning was withheld, AND the literal never reached the redactor — so
      // an endpoint that echoed it back would have printed it.
      const redact = makeRedactor({ TASTYTRADE_API_URL: CONFIGURED });
      const echoed = `the endpoint said ${MEANT_AS_PASSWORD}`;
      expect(redact(echoed)).not.toContain("NOT-A-REAL-PASSWORD-FIXTURE-0000");
      expect(redact(echoed)).toContain(REDACTED);
    });

    it("adds nothing to the redactor for a path that merely holds an @", () => {
      // The warning fires on `https://host/a@b`; the redactor must not, or a
      // report would start blanking out ordinary words. The existing rule —
      // only the half after a colon, only when it is at least eight characters
      // — is what keeps the two apart, and it is the same rule the parsed
      // userinfo goes through.
      const redact = makeRedactor({
        TASTYTRADE_API_URL: "https://api.cert.tastyworks.com/a@b",
      });
      expect(redact("Recognised hosts: api.cert.tastyworks.com")).toBe(
        "Recognised hosts: api.cert.tastyworks.com",
      );
    });

    it("says nothing when the parser already found the userinfo", () => {
      // That case has its own warning, and it is a different sentence: there
      // the credential IS being sent, as a Basic auth header. Printing both
      // for one fault reads as a report that is stuttering.
      expect(
        atSignOutsideUserinfo("https://ops:hunter2@api.cert.tastyworks.com"),
      ).toBeUndefined();
      expect(
        atSignOutsideUserinfo("https://api.cert.tastyworks.com"),
      ).toBeUndefined();
      expect(atSignOutsideUserinfo(CONFIGURED)).toBe(
        `ops:${MEANT_AS_PASSWORD}`,
      );
    });

    it("keeps it out of both renderings of a whole run", async () => {
      const report = await runDoctor(
        makeDeps({ env: healthyEnv({ TASTYTRADE_API_URL: CONFIGURED }) }),
      );
      const both = `${formatReport(report)}\n${reportToJson(report)}`;
      expect(both).not.toContain("NOT-A-REAL-PASSWORD-FIXTURE-0000");
    });
  });
});

// ===========================================================================
// Nothing else in the report identifies the operator
// ===========================================================================

describe("the shareable default, swept end to end", () => {
  it("publishes no home directory, login name or absolute local path", async () => {
    // HOME is set to this checkout's own root, so the one path the report prints
    // — the vendored-docs directory — is genuinely under it. A raw print would
    // publish the operator's login name and directory layout into a report the
    // README steers a stuck user toward pasting.
    const http = healthyHttp();
    const report = await runDoctor(
      makeDeps({
        env: healthyEnv({ HOME: REPO_ROOT }),
        adapter: http.adapter,
      }),
    );
    const rendered = `${formatReport(report)}\n${reportToJson(report)}`;
    expect(rendered).not.toContain(REPO_ROOT);
    expect(rendered).toContain("Directory: ~");
    // Nothing else in a healthy report is an absolute filesystem path.
    expect(rendered.match(/(?<![~\w])\/(home|Users)\//)).toBeNull();
  });

  it("carries the un-masking caution into the CLI's own output", async () => {
    const written: string[] = [];
    const code = await main(
      [SHOW_ACCOUNTS_FLAG],
      makeDeps({ env: healthyEnv(), adapter: healthyHttp().adapter }),
      (t) => void written.push(t),
      () => {},
    );
    expect(code).toBe(0);
    const out = written.join("");
    expect(out).toContain("5WT00001");
    // The identifying output now carries its own warning, ahead of the numbers.
    expect(out).toContain("UN-MASKED");
    expect(out).toMatch(/do not paste it into an issue/);
    expect(out.indexOf("UN-MASKED")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("UN-MASKED")).toBeLessThan(out.indexOf("5WT00001"));
  });
});
