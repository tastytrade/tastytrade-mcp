/**
 * Where the credentials actually GO, as opposed to where the URL says they go.
 *
 * `src/credential-target.ts` decides one thing — may the refresh token and client
 * secret be sent to this URL — by reading the URL's hostname. That is complete only
 * if the hostname determines the destination, and two generic environment variables
 * sitting in the same MCP-client `env` block the module's threat model is built
 * around break that without touching TASTYTRADE_API_URL: `HTTPS_PROXY` (and its
 * lowercase and `ALL_PROXY` spellings) moves the TCP connection to a host the guard
 * never sees, `NODE_EXTRA_CA_CERTS` makes that host's certificate verify cleanly, and
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` skips verification altogether.
 *
 * With the first two set the guard reports `allowed: true, recognised: true,
 * notes: []` and the server starts silently — the one outcome a module about
 * credential destinations must not produce: a claim stronger than what it checked.
 *
 * These pin VISIBILITY for the proxy variables and REFUSAL for disabled verification,
 * and that both entry points — the startup banner and the preflight report — say the
 * same thing, because "applied to the server and not the doctor" is the shape of
 * every defect in this area.
 *
 * They do NOT stand up a real MITM proxy: proving axios honours `HTTPS_PROXY` would
 * be a test of axios, and the interesting failure is whether this server says
 * anything when one is configured — a pure function of the environment.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  ALLOW_PROXY_ENV_VAR,
  CREDENTIAL_CHANNEL_ENV_VAR,
  nodeOptionFlagNames,
  trustStoreOverridden,
  inspectCredentialChannel,
  inspectCredentialTarget,
  assertCredentialTargetAllowed,
  PRODUCTION_API_URL,
  SANDBOX_API_URL,
} from "../src/credential-target.js";
import {
  inspectApiUrl,
  inspectConnectivity,
  runDoctor,
} from "../src/doctor.js";
import type { DoctorDeps, DoctorReport } from "../src/doctor.js";
import type { AxiosResponse } from "axios";
import { scrubAmbientEnv } from "./jest.setup.js";
import { CHANNEL_ENV_VARS } from "../src/credential-target.js";

const PROXY = "http://proxy.corp.example:3128";

afterEach(() => {
  jest.restoreAllMocks();
});

/** Everything the guard prints or hands to a caller, as one searchable string. */
function rendered(
  decision: ReturnType<typeof inspectCredentialTarget>,
): string {
  return [
    decision.refusal ?? "",
    ...decision.notes,
    ...decision.channelNotes,
  ].join("\n");
}

describe("inspectCredentialChannel reads the variables that move the bytes", () => {
  it("finds a proxy under either case, and under ALL_PROXY", () => {
    for (const name of [
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      const channel = inspectCredentialChannel("https:", { [name]: PROXY });
      expect(channel.proxied).toBe(true);
      expect(channel.notes.join("\n")).toContain(name);
    }
  });

  it("ignores the proxy variable for the other scheme", () => {
    // axios picks the variable by the REQUEST's scheme: an https target never
    // reads HTTP_PROXY. Reporting one that cannot apply would be a false alarm
    // on every machine that has HTTP_PROXY set for unrelated traffic.
    expect(
      inspectCredentialChannel("https:", { HTTP_PROXY: PROXY }).proxied,
    ).toBe(false);
    expect(
      inspectCredentialChannel("http:", { HTTPS_PROXY: PROXY }).proxied,
    ).toBe(false);
    expect(
      inspectCredentialChannel("http:", { HTTP_PROXY: PROXY }).proxied,
    ).toBe(true);
  });

  it("never echoes the proxy's own userinfo", () => {
    // A proxy URL carries credentials as often as an API URL does, and this
    // note goes to the same stderr and the same pasted report.
    const channel = inspectCredentialChannel("https:", {
      HTTPS_PROXY: "http://ops:proxy-password-here@proxy.corp.example:3128",
    });
    expect(channel.notes.join("\n")).not.toContain("proxy-password-here");
    expect(channel.notes.join("\n")).toContain("proxy.corp.example");
  });

  it("reports an extra trust anchor separately from a proxy", () => {
    const channel = inspectCredentialChannel("https:", {
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-root.pem",
    });
    expect(channel.proxied).toBe(false);
    expect(channel.notes.join("\n")).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("names the OpenSSL trust store, which is the same door by another name", () => {
    // NODE_EXTRA_CA_CERTS was reported and this pair was not, and they enable
    // the same thing: with `--use-openssl-ca` Node stops using its bundled
    // trust store and uses OpenSSL's, which reads SSL_CERT_FILE and
    // SSL_CERT_DIR. SSL_CERT_FILE does not ADD an anchor the way
    // NODE_EXTRA_CA_CERTS does — it REPLACES the store — so a certificate
    // minted by an intercepting proxy is the only one that has to verify.
    const channel = inspectCredentialChannel(
      "https:",
      {
        NODE_OPTIONS: "--max-old-space-size=4096 --use-openssl-ca",
        SSL_CERT_FILE: "/etc/ssl/corp-root.pem",
      },
      [],
    );
    const text = channel.notes.join("\n");
    expect(text).toContain("--use-openssl-ca");
    expect(text).toContain("SSL_CERT_FILE");
  });

  it("finds the flag on the command line as well as in NODE_OPTIONS", () => {
    // `node --use-openssl-ca dist/index.js` is the same configuration, and an
    // MCP client config carries `args` next to `env`. Reading only one of the
    // two would report the variable's effect on half the ways to enable it.
    const channel = inspectCredentialChannel(
      "https:",
      { SSL_CERT_DIR: "/etc/ssl/corp" },
      ["--use-openssl-ca"],
    );
    expect(channel.notes.join("\n")).toContain("SSL_CERT_DIR");
  });

  it("says nothing about SSL_CERT_FILE while Node is on its own store", () => {
    // Without the flag Node ignores both variables outright, and they are set
    // machine-wide for curl and openssl on plenty of hosts. Reporting them
    // would be a false alarm about a setting that changes nothing here.
    expect(
      inspectCredentialChannel(
        "https:",
        { SSL_CERT_FILE: "/etc/ssl/corp-root.pem", SSL_CERT_DIR: "/etc/ssl" },
        [],
      ).notes,
    ).toEqual([]);
  });

  it("treats only Node's own spelling of a disabled check as disabled", () => {
    // Node's test is a strict `=== '0'` on the raw value. Anything else still
    // verifies, and refusing to start over ` 0 ` would be a refusal for a
    // configuration that is actually safe.
    expect(
      inspectCredentialChannel("https:", { NODE_TLS_REJECT_UNAUTHORIZED: "0" })
        .verificationDisabled,
    ).toBe(true);
    for (const value of [" 0 ", "false", "1", "", "00"]) {
      expect(
        inspectCredentialChannel("https:", {
          NODE_TLS_REJECT_UNAUTHORIZED: value,
        }).verificationDisabled,
      ).toBe(false);
    }
  });

  it("says nothing about a plain environment", () => {
    // The channel now also reports the proxy's HOSTNAME
    // and WHICH trust-store variables are in play, because rule 6 compares a
    // name against the named-proxy hatch and the refusal has to say which
    // override it refused. A plain environment still says nothing — every added
    // member is empty or absent, which is what this test is about.
    expect(inspectCredentialChannel("https:", {}, [])).toEqual({
      proxied: false,
      proxyVariable: undefined,
      proxyHostname: undefined,
      trustStoreOverrides: [],
      verificationDisabled: false,
      notes: [],
      // The channel has a second, non-promoting note
      // channel now. A plain environment produces nothing on either.
      informationalNotes: [],
    });
  });
});

describe("the guard stops claiming a destination it cannot vouch for", () => {
  it("still allows a recognised host behind a corporate proxy — and says so", () => {
    // The line this draws: a proxy is legitimate and common, so it must not
    // stop the server. What it must not do is pass in silence.
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, {
      HTTPS_PROXY: PROXY,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.recognised).toBe(true);
    expect(decision.channelNotes.length).toBeGreaterThan(0);
    expect(rendered(decision)).toContain("proxy.corp.example");
  });

  it("refuses when certificate verification is switched off for a remote host", () => {
    const decision = inspectCredentialTarget(SANDBOX_API_URL, {
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("does not let the host acknowledgement lift the unverified-channel refusal", () => {
    // Same shape as the clear-text rule: the hatch acknowledges a HOST, and an
    // unverified channel is not a host.
    const decision = inspectCredentialTarget("https://gateway.corp.example", {
      TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "gateway.corp.example",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("leaves loopback alone, for the same reason the clear-text rule does", () => {
    // An attacker who can answer on 127.0.0.1 can read the environment
    // variable, so verification adds nothing there — and a local test double
    // with a self-signed certificate is a legitimate setup.
    const decision = inspectCredentialTarget("https://127.0.0.1:8443", {
      TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "127.0.0.1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    });
    expect(decision.allowed).toBe(true);
  });

  it("names the host problem first when there is one", () => {
    // A proxy note must not bury the refusal, and an unrecognised host is the
    // more actionable of the two.
    const decision = inspectCredentialTarget("https://evil.example", {
      HTTPS_PROXY: PROXY,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain("evil.example");
  });
});

describe("both entry points say it, not just one", () => {
  it("the server prints a banner before it starts", () => {
    const lines: string[] = [];
    jest
      .spyOn(console, "error")
      .mockImplementation(
        (...args: unknown[]) => void lines.push(args.join(" ")),
      );

    const decision = assertCredentialTargetAllowed(PRODUCTION_API_URL, {
      HTTPS_PROXY: PROXY,
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-root.pem",
    });

    expect(decision.allowed).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("proxy.corp.example");
    expect(out).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("the preflight warns rather than passing the endpoint check in silence", () => {
    const state = inspectApiUrl({
      TASTYTRADE_API_URL: SANDBOX_API_URL,
      HTTPS_PROXY: PROXY,
    });
    expect(state.check.status).toBe("warn");
    const text = `${state.check.details.join("\n")}\n${JSON.stringify(state.check.data)}`;
    expect(text).toContain("proxy.corp.example");
  });

  it("the preflight's TLS probe stops certifying a session the grant does not use", async () => {
    // `probeConnectionForReal` calls tls.connect directly: it does not traverse
    // the proxy. Reporting "certificate verified" for a session the credentials
    // never cross is the strongest false claim in the whole report.
    const deps = {
      env: { TASTYTRADE_API_URL: SANDBOX_API_URL, HTTPS_PROXY: PROXY },
      lookupHost: async () => ["203.0.113.10"],
      probeConnection: async () => "TLS 1.3 handshake completed",
      fileExists: () => true,
      now: () => Date.now(),
    } as DoctorDeps;

    const { check } = await inspectConnectivity(
      deps,
      { host: "api.cert.tastyworks.com", port: 443, secure: true },
      (t) => t,
    );
    expect(check.details.join("\n")).toContain("HTTPS_PROXY");
    expect(check.data?.probed_directly).toBe(true);
  });

  it("does not report PREFLIGHT PASSED with verification switched off", async () => {
    const deps = {
      env: {
        TASTYTRADE_API_URL: SANDBOX_API_URL,
        TASTYTRADE_CLIENT_ID: "client-id",
        TASTYTRADE_CLIENT_SECRET: "client-secret-value",
        TASTYTRADE_REFRESH_TOKEN: "refresh-token-value",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      lookupHost: async () => ["203.0.113.10"],
      probeConnection: async () => "TLS 1.3 handshake completed",
      fileExists: () => true,
      now: () => Date.now(),
      adapter: async () => {
        throw new Error("the grant must not be attempted");
      },
    } as DoctorDeps;

    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    const endpoint = report.checks.find((c) => c.id === "api-url");
    expect(endpoint?.status).toBe("fail");
    expect(report.checks.find((c) => c.id === "token-grant")?.status).toBe(
      "skip",
    );
  });
});

// ===========================================================================
// A proxy must not turn the preflight green without testing the credentials
//
// Folding "a proxy is configured" into `inspectConnectivity`'s STATUS, with
// `runDoctor` deriving reachability from that status, means that on any machine with
// HTTPS_PROXY set, checks 6, 7 and 8 — the token grant, the token scope and the
// accounts fetch — are skipped with the reason "the API host is not reachable", which
// is untrue: the probe resolved and connected. The report then returns ok=true and
// exit 0, which `--help` documents as "every check needed to serve traffic passed",
// for a configuration whose credentials were never sent anywhere.
//
// A status is a judgement about what was found; reachability is a fact about whether
// there is anything to talk to. Conflating them means every future caveat on this
// check silently disables three others.
// ===========================================================================

/** DoctorDeps for an otherwise-healthy sandbox run, plus whatever a case needs. */
function doctorDeps(
  extraEnv: NodeJS.ProcessEnv = {},
  overrides: Partial<DoctorDeps> = {},
): DoctorDeps {
  return {
    env: {
      TASTYTRADE_API_URL: SANDBOX_API_URL,
      TASTYTRADE_CLIENT_ID: "client-id",
      TASTYTRADE_CLIENT_SECRET: "client-secret-value",
      TASTYTRADE_REFRESH_TOKEN: "refresh-token-value",
      ...extraEnv,
    },
    lookupHost: async () => ["203.0.113.10"],
    probeConnection: async () => "TLS 1.3 handshake completed",
    fileExists: () => true,
    now: () => Date.now(),
    // Fails closed: an HTTP call no case deliberately routed is an error, never
    // a real request to the internet.
    adapter: async () => {
      throw new Error("no HTTP route configured in this test");
    },
    ...overrides,
  };
}

/**
 * An adapter that records every URL it is handed and rejects the grant.
 *
 * A REJECTED grant is the point: the question is not whether the doctor can
 * report a success, it is whether a real credential failure still reaches the
 * operator when a proxy is configured. A 401 is the outcome that must survive.
 */
function grantRecorder(): { adapter: DoctorDeps["adapter"]; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    adapter: async (config) => {
      urls.push(String(config.url ?? ""));
      return {
        data: { error: "invalid_grant", error_description: "expired" },
        status: 401,
        statusText: "401",
        headers: {},
        config,
      } as AxiosResponse;
    },
  };
}

function check(report: DoctorReport, id: string) {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check with id "${id}"`);
  return found;
}

describe("a proxy must not certify credentials the preflight never sent", () => {
  it.each(["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])(
    "still performs the grant, and still fails on it, with %s set",
    async (variable) => {
      const http = grantRecorder();
      const report = await runDoctor(
        doctorDeps({ [variable]: PROXY }, { adapter: http.adapter }),
      );

      expect(http.urls.some((u) => u.includes("/oauth/token"))).toBe(true);
      expect(check(report, "token-grant").status).toBe("fail");
      expect(report.ok).toBe(false);
      expect(report.exitCode).toBe(1);
    },
  );

  it("keeps the caveat that the probe went around the proxy", async () => {
    // The fix must not be "stop warning". The probe genuinely measured a
    // session the credentials do not cross, and saying so is the whole reason
    // the caveat exists — what it must not do is stand in for "unreachable".
    const report = await runDoctor(
      doctorDeps({ HTTPS_PROXY: PROXY }, { adapter: grantRecorder().adapter }),
    );
    const tcp = check(report, "connectivity");
    expect(tcp.status).toBe("warn");
    expect(tcp.details.join("\n")).toContain("HTTPS_PROXY");
  });

  it("still skips the grant when the port genuinely does not answer", async () => {
    // The other half, so the fix cannot be "always attempt the grant": an
    // endpoint that does not answer must still stop the credentials leaving.
    const http = grantRecorder();
    const report = await runDoctor(
      doctorDeps(
        {},
        {
          probeConnection: async () => {
            throw Object.assign(new Error("connect ECONNREFUSED"), {
              code: "ECONNREFUSED",
            });
          },
          adapter: http.adapter,
        },
      ),
    );
    expect(http.urls).toEqual([]);
    expect(check(report, "token-grant").status).toBe("skip");
    expect(check(report, "token-grant").summary).toContain("not reachable");
  });

  it("still skips the grant when the destination is refused outright", async () => {
    // Precedence, unchanged: a host the server would refuse to start against
    // must not receive the credentials from the preflight either, however
    // reachable it is.
    const http = grantRecorder();
    const report = await runDoctor(
      doctorDeps(
        { TASTYTRADE_API_URL: "https://evil.example" },
        { adapter: http.adapter },
      ),
    );
    expect(http.urls).toEqual([]);
    expect(check(report, "token-grant").status).toBe("skip");
  });
});

// ===========================================================================
// The suite must not inherit the developer's own credential environment
//
// `TastytradeMCPServer`'s constructor calls `assertCredentialTargetAllowed` against
// `process.env`, which is correct — the refusal has to read the real environment or
// it is not a guard. The consequence is that the suite reads it too, so an engineer
// with `NODE_TLS_REJECT_UNAUTHORIZED=0` exported in their shell (a common workaround
// for a corporate TLS appliance, and exactly the population this module is written
// for) sees 23 suites and 964 tests fail with a refusal about nothing they changed,
// while two clean CI runners never see it.
//
// The same applies to `TASTYTRADE_*`: an engineer with real credentials exported
// would have `resolveApiUrl()` pick up their URL, and a test that forgot to inject
// would reach for their live account rather than failing. Scrubbing both families at
// startup is what makes a green suite mean the same thing on every machine.
// ===========================================================================

describe("the ambient environment is scrubbed before any test runs", () => {
  it("has already removed them from this process", () => {
    for (const name of CHANNEL_ENV_VARS) {
      expect(process.env[name]).toBeUndefined();
    }
    expect(
      Object.keys(process.env).filter((k) => k.startsWith("TASTYTRADE_")),
    ).toEqual([]);
  });

  it("removes every variable the channel inspection reads", () => {
    // The list the scrubber uses and the list the product reads are the same
    // list, so a new variable cannot be added to one and forgotten in the
    // other — which is the shape of the last four defects in this area.
    const dirty: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      TASTYTRADE_API_URL: "https://api.tastyworks.com",
      TASTYTRADE_REFRESH_TOKEN: "a-real-one",
    };
    for (const name of CHANNEL_ENV_VARS) dirty[name] = "set";

    scrubAmbientEnv(dirty);

    expect(dirty).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves everything else exactly as it found it", () => {
    // A scrubber that took out HOME or PATH would break the vendored-docs
    // check and the abbreviateHome test rather than fix anything.
    const env: NodeJS.ProcessEnv = { HOME: "/home/dev", CI: "1", LANG: "C" };
    scrubAmbientEnv(env);
    expect(env).toEqual({ HOME: "/home/dev", CI: "1", LANG: "C" });
  });
});

// ---------------------------------------------------------------------------
// The guard can REFUSE an interposed credential channel, not only
// note one.
//
// The defect was detection without enforcement, and the module's own asymmetry
// is what made it legible: NODE_TLS_REJECT_UNAUTHORIZED=0 becomes a refusal
// through rule 5, while the proxy and trust-store variables — the pair that
// together make an interception verify cleanly — became a note. The module knew
// how to say no and chose to say "noted".
// ---------------------------------------------------------------------------

const ATTACKER = "http://attacker.example:8080";

afterEach(() => {
  jest.restoreAllMocks();
});

/** The env an interception needs, plus whatever posture the case is testing. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { https_proxy: ATTACKER, ...extra };
}

const strict = { [CREDENTIAL_CHANNEL_ENV_VAR]: "strict" };

describe("strict posture refuses an interposed credential channel", () => {
  it("refuses a proxy, naming the variable that moved the bytes", () => {
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, env(strict));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toContain("https_proxy");
    expect(decision.refusal).toContain("attacker.example");
  });

  it("throws from the same wrapper that already refuses the sibling", () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      assertCredentialTargetAllowed(PRODUCTION_API_URL, env(strict)),
    ).toThrow(/Refusing to start/);
    try {
      assertCredentialTargetAllowed(PRODUCTION_API_URL, env(strict));
    } catch (e) {
      expect((e as { toolError: { code: string } }).toolError.code).toBe(
        "validation",
      );
    }
  });

  it("says that no_proxy is the HTTP client's rule and not re-implemented here", () => {
    const decision = inspectCredentialTarget(
      PRODUCTION_API_URL,
      env({ ...strict, no_proxy: "api.tastyworks.com" }),
    );
    expect(decision.allowed).toBe(false);
    expect(`${decision.refusal}\n${decision.notes.join("\n")}`).toContain(
      "no_proxy",
    );
  });

  it("refuses each trust-store override under strict, one at a time", () => {
    const overrides: Array<Record<string, string>> = [
      { NODE_EXTRA_CA_CERTS: "/etc/attacker/ca.pem" },
      {
        NODE_OPTIONS: "--use-openssl-ca",
        SSL_CERT_FILE: "/etc/attacker/ca.pem",
      },
      { NODE_OPTIONS: "--use-openssl-ca", SSL_CERT_DIR: "/etc/attacker/certs" },
    ];
    for (const override of overrides) {
      // No proxy at all: the trust-store half is refused on its own merits.
      const decision = inspectCredentialTarget(PRODUCTION_API_URL, {
        ...strict,
        ...override,
      });
      expect([override, decision.allowed]).toEqual([override, false]);
      // And permitted under the default posture, so this is a posture change
      // and not a new unconditional refusal.
      expect([
        override,
        inspectCredentialTarget(PRODUCTION_API_URL, override).allowed,
      ]).toEqual([override, true]);
    }
  });

  it("names the hatch in the refusal, so the enterprise operator has a way out", () => {
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, env(strict));
    expect(decision.notes.join("\n")).toContain(ALLOW_PROXY_ENV_VAR);
  });
});

describe("the hatch takes hostnames, and both sides must agree", () => {
  it("permits the proxy the operator named", () => {
    const decision = inspectCredentialTarget(
      PRODUCTION_API_URL,
      env({ ...strict, [ALLOW_PROXY_ENV_VAR]: "attacker.example" }),
    );
    expect(decision.allowed).toBe(true);
  });

  it("still refuses when the acknowledgement names a DIFFERENT host", () => {
    const decision = inspectCredentialTarget(
      PRODUCTION_API_URL,
      env({ ...strict, [ALLOW_PROXY_ENV_VAR]: "gw.corp.example" }),
    );
    expect(decision.allowed).toBe(false);
    // The whole reason the hatch takes names: a config that later retargets the
    // proxy fails closed again instead of being blessed by a boolean set once.
    expect(decision.refusal).toContain("attacker.example");
  });

  it("normalises both sides, so a trailing dot on either matches", () => {
    for (const [proxyHost, acknowledged] of [
      ["gw.corp.example.", "gw.corp.example"],
      ["gw.corp.example", "gw.corp.example."],
      ["GW.CORP.EXAMPLE", "gw.corp.example"],
    ]) {
      const decision = inspectCredentialTarget(PRODUCTION_API_URL, {
        ...strict,
        https_proxy: `http://${proxyHost}:3128`,
        [ALLOW_PROXY_ENV_VAR]: acknowledged,
      });
      expect([proxyHost, acknowledged, decision.allowed]).toEqual([
        proxyHost,
        acknowledged,
        true,
      ]);
    }
  });

  it("accepts a comma-separated list, and refuses a host outside it", () => {
    const list = {
      [ALLOW_PROXY_ENV_VAR]: "a.example, gw.corp.example ,b.example",
    };
    expect(
      inspectCredentialTarget(PRODUCTION_API_URL, {
        ...strict,
        ...list,
        https_proxy: "http://gw.corp.example:3128",
      }).allowed,
    ).toBe(true);
    expect(
      inspectCredentialTarget(PRODUCTION_API_URL, {
        ...strict,
        ...list,
        https_proxy: "http://c.example:3128",
      }).allowed,
    ).toBe(false);
  });

  it("does not let the hatch lift a trust-store override it says nothing about", () => {
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, {
      ...strict,
      NODE_EXTRA_CA_CERTS: "/etc/attacker/ca.pem",
      [ALLOW_PROXY_ENV_VAR]: "attacker.example",
    });
    expect(decision.allowed).toBe(false);
  });

  it("does not let the host acknowledgement double as a proxy acknowledgement", () => {
    // TASTYTRADE_ALLOW_UNKNOWN_API_HOST acknowledges a HOST, not a channel —
    // the same sentence rule 4 and rule 5 already carry.
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, {
      ...strict,
      https_proxy: ATTACKER,
      TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "attacker.example",
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("the default posture is unchanged", () => {
  it("still allows a proxy, with exactly the notes it produced before", () => {
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, env());
    expect(decision.allowed).toBe(true);
    expect(decision.refusal).toBeUndefined();
    expect(decision.channelNotes).toHaveLength(1);
  });

  it("still allows the whole interception — proxy plus a trusted CA", () => {
    const decision = inspectCredentialTarget(
      PRODUCTION_API_URL,
      env({ NODE_EXTRA_CA_CERTS: "/etc/attacker/ca.pem" }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.channelNotes).toHaveLength(2);
  });

  it("treats an unrecognised posture value as the default, not as strict", () => {
    // The same choice isReadOnlyModeEnabled makes: an unreadable value must not
    // silently become the stricter setting, or a typo takes the server down.
    for (const value of ["", " ", "STRICT?", "1", "true", "warn", "WARN"]) {
      expect([
        value,
        inspectCredentialTarget(PRODUCTION_API_URL, {
          ...env(),
          [CREDENTIAL_CHANNEL_ENV_VAR]: value,
        }).allowed,
      ]).toEqual([value, true]);
    }
  });

  it("accepts strict in any case, and with surrounding space", () => {
    for (const value of ["strict", "STRICT", " Strict "]) {
      expect([
        value,
        inspectCredentialTarget(PRODUCTION_API_URL, {
          ...env(),
          [CREDENTIAL_CHANNEL_ENV_VAR]: value,
        }).allowed,
      ]).toEqual([value, false]);
    }
  });
});

describe("the preflight reaches the same verdict", () => {
  function deps(e: NodeJS.ProcessEnv): DoctorDeps {
    return {
      env: { TASTYTRADE_API_URL: PRODUCTION_API_URL, ...e },
      lookupHost: async () => ["203.0.113.10"],
      probeConnection: async () => "TLS 1.3 handshake completed",
      fileExists: () => true,
      now: () => Date.now(),
    } as DoctorDeps;
  }

  it("fails the endpoint check under strict, quoting the refusal", async () => {
    const report = await runDoctor(deps(env(strict)));
    const endpoint = report.checks[1];
    expect(endpoint.status).toBe("fail");
    expect(
      `${endpoint.details.join("\n")}\n${JSON.stringify(endpoint.data)}`,
    ).toContain("https_proxy");
  });

  it("warns rather than fails under the default posture", async () => {
    const report = await runDoctor(deps(env()));
    expect(report.checks[1].status).toBe("warn");
  });
});

describe("the two new variables are posture, not channel", () => {
  it("adds neither to CHANNEL_ENV_VARS", () => {
    // CHANNEL_ENV_VARS is the list of variables that MOVE THE BYTES, and the
    // harness scrubber is pinned to it. These two decide what this server does
    // about those variables; they are not among them.
    expect([...CHANNEL_ENV_VARS]).not.toContain(CREDENTIAL_CHANNEL_ENV_VAR);
    expect([...CHANNEL_ENV_VARS]).not.toContain(ALLOW_PROXY_ENV_VAR);
  });

  it("is scrubbed from the ambient environment all the same", () => {
    // Not by being listed: by the TASTYTRADE_ prefix rule that already covers
    // every setting this server owns. Asserted rather than assumed, because a
    // developer with strict posture exported would otherwise change what this
    // whole suite measures.
    const dirty: NodeJS.ProcessEnv = {
      [CREDENTIAL_CHANNEL_ENV_VAR]: "strict",
      [ALLOW_PROXY_ENV_VAR]: "gw.corp.example",
    };
    scrubAmbientEnv(dirty);
    expect(Object.keys(dirty)).toEqual([]);
    expect(process.env[CREDENTIAL_CHANNEL_ENV_VAR]).toBeUndefined();
    expect(process.env[ALLOW_PROXY_ENV_VAR]).toBeUndefined();
  });

  it("names both variables with the TASTYTRADE_ prefix the convention requires", () => {
    for (const name of [CREDENTIAL_CHANNEL_ENV_VAR, ALLOW_PROXY_ENV_VAR]) {
      expect(name.startsWith("TASTYTRADE_")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// One process cannot read another's argv, so the report has to say so.
//
// Answering a question about "the channel" with `process.execArgv` describes only
// the process asking. The server, holding the flag in its `args`, reports it
// correctly; the doctor — a separate process, and the documented way to check the
// credential path — has the same `env` and an empty argv, and because SSL_CERT_FILE /
// SSL_CERT_DIR are named ONLY alongside the flag, the same failed condition silences
// the one signal that DOES cross the process boundary.
//
// The fix is not a better parser: with the flag in another process's `args` there is
// nothing in the shared channel to find. It is to report the CONDITION on a channel
// that does not promote status, name the blind spot on every run, and make the
// process that CAN see its own trust store the authoritative reporter.
// ---------------------------------------------------------------------------

const ATTACKER_CA = { SSL_CERT_FILE: "/etc/attacker/proxy-ca.pem" };

describe("the certificate variables are reported even when the flag is not visible", () => {
  it("says SSL_CERT_FILE is set, and exactly what would make it matter", () => {
    const channel = inspectCredentialChannel("https:", ATTACKER_CA, []);
    const informational = channel.informationalNotes.join("\n");
    expect(informational).toContain("SSL_CERT_FILE");
    expect(informational).toContain("--use-openssl-ca");
    // The one place the asking process cannot look, named so the operator can.
    expect(informational).toContain("args");
  });

  it("says the same for SSL_CERT_DIR, and names both when both are set", () => {
    expect(
      inspectCredentialChannel(
        "https:",
        { SSL_CERT_DIR: "/etc/attacker/certs" },
        [],
      ).informationalNotes.join("\n"),
    ).toContain("SSL_CERT_DIR");
    const both = inspectCredentialChannel(
      "https:",
      { ...ATTACKER_CA, SSL_CERT_DIR: "/etc/attacker/certs" },
      [],
    ).informationalNotes.join("\n");
    expect(both).toContain("SSL_CERT_FILE");
    expect(both).toContain("SSL_CERT_DIR");
  });

  it("does NOT promote the endpoint check, so a clean run stays clean", () => {
    // The whole reason for a second channel. `notes` promotes check 2 to warn;
    // an informational sentence must not, or every machine with SSL_CERT_FILE
    // exported for curl becomes a warning — and, with the three-state verdict, a
    // non-zero exit.
    const channel = inspectCredentialChannel("https:", ATTACKER_CA, []);
    expect(channel.notes).toEqual([]);
    expect(channel.informationalNotes.length).toBeGreaterThan(0);

    const state = inspectApiUrl({
      TASTYTRADE_API_URL: "https://api.cert.tastyworks.com",
      ...ATTACKER_CA,
    });
    expect(state.check.status).toBe("pass");
  });

  it("says nothing informational when neither variable is set", () => {
    expect(
      inspectCredentialChannel("https:", {}, []).informationalNotes,
    ).toEqual([]);
  });

  it("does not duplicate the sentence when the flag IS visible here", () => {
    // The server's own process. The REAL note is emitted, and the conditional
    // one must not also appear — it would be telling the operator to go and
    // check for a thing this process has just confirmed.
    const channel = inspectCredentialChannel("https:", ATTACKER_CA, [
      "--use-openssl-ca",
    ]);
    expect(channel.notes.join("\n")).toContain("--use-openssl-ca");
    expect(channel.notes.join("\n")).toContain("SSL_CERT_FILE");
    expect(channel.informationalNotes).toEqual([]);
  });

  it("carries the informational notes through the credential-target decision", () => {
    const decision = inspectCredentialTarget(PRODUCTION_API_URL, ATTACKER_CA);
    expect(decision.allowed).toBe(true);
    expect(decision.channelNotes).toEqual([]);
    expect(decision.channelInformationalNotes.join("\n")).toContain(
      "SSL_CERT_FILE",
    );
  });
});

describe("the report names its own blind spot, on every run", () => {
  function deps(env: NodeJS.ProcessEnv): DoctorDeps {
    return {
      env: { TASTYTRADE_API_URL: PRODUCTION_API_URL, ...env },
      lookupHost: async () => ["203.0.113.10"],
      probeConnection: async () => "TLS 1.3 handshake completed",
      fileExists: () => true,
      now: () => Date.now(),
    } as DoctorDeps;
  }

  it("says it cannot read another process's command line, even on a clean run", async () => {
    // A report that names what it did not look at is not evidence of a clean
    // channel; a silent one is not evidence of anything. So this sentence is
    // unconditional.
    const report = await runDoctor(deps({}));
    const endpoint = report.checks[1];
    expect(endpoint.details.join("\n")).toMatch(/command line/i);
    expect(endpoint.details.join("\n")).toContain("args");
  });

  it("prints the informational note without failing or warning the check", async () => {
    const report = await runDoctor(deps(ATTACKER_CA));
    const endpoint = report.checks[1];
    expect(endpoint.details.join("\n")).toContain("SSL_CERT_FILE");
    expect(endpoint.status).not.toBe("fail");
  });

  it("gives a --json consumer its own key, distinguishable from a warning", async () => {
    const report = await runDoctor(deps(ATTACKER_CA));
    const target = report.checks[1].data?.credential_target as {
      channel: string[];
      channel_informational: string[];
    };
    expect(target.channel).toEqual([]);
    expect(target.channel_informational.join("\n")).toContain("SSL_CERT_FILE");
  });
});

describe("the runtime is asked whether its own trust store was repointed", () => {
  it("answers about THIS process, or admits it cannot", () => {
    // `undefined` on a runtime without tls.getCACertificates, a boolean
    // otherwise. Never a throw: this is corroboration, and a probe that can
    // break the guard it corroborates is worse than no probe.
    const answer = trustStoreOverridden();
    expect(["boolean", "undefined"]).toContain(typeof answer);
  });

  it("says NO for this test process, which was launched with no flag", () => {
    // Non-vacuity for the row above: the probe has to be capable of a negative,
    // or "it did not throw" would be the whole assertion. Jest's workers carry
    // no --use-openssl-ca, so the honest answer here is false.
    const answer = trustStoreOverridden();
    if (answer !== undefined) expect(answer).toBe(false);
  });

  it("adds the note when the runtime says yes, whatever the spelling was", () => {
    // Injected rather than measured, because a spelling this parser does not
    // know is by definition one no test can produce through `env` — that is the
    // point of a second, source-independent signal. The flag is absent from both
    // string sources here.
    const channel = inspectCredentialChannel(
      "https:",
      ATTACKER_CA,
      [],
      () => true,
    );
    expect(channel.notes.join("\n")).toContain("--use-openssl-ca");
    expect(channel.notes.join("\n")).toContain("SSL_CERT_FILE");
    // And the conditional sentence is not also emitted: the condition is known.
    expect(channel.informationalNotes).toEqual([]);
  });

  it("never SUPPRESSES the note when the runtime says no", () => {
    // Fail-safe in the one direction that matters: the probe may only ADD.
    const channel = inspectCredentialChannel(
      "https:",
      ATTACKER_CA,
      ["--use-openssl-ca"],
      () => false,
    );
    expect(channel.notes.join("\n")).toContain("--use-openssl-ca");
  });

  it("falls back to the parse when the runtime cannot answer", () => {
    const channel = inspectCredentialChannel(
      "https:",
      ATTACKER_CA,
      ["--use-openssl-ca"],
      () => undefined,
    );
    expect(channel.notes.join("\n")).toContain("--use-openssl-ca");
    expect(
      inspectCredentialChannel("https:", ATTACKER_CA, [], () => undefined)
        .informationalNotes.length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The detector's answer must EQUAL the runtime's answer.
//
// An exact-token comparison against NODE_OPTIONS is strictly tighter than Node's own
// parser, which folds `_` to `-`, accepts `=value` on a boolean flag and ignores the
// value, and strips one surrounding pair of double quotes. The control then disagrees
// with the runtime in six spellings Node honours — and because SSL_CERT_FILE /
// SSL_CERT_DIR are named only alongside the flag, a miss silences the whole pair.
//
// Both directions are asserted, and the negative half matters as much: single quotes
// and any non-lower-case spelling must produce NOTHING, because Node does not honour
// them either. Every spelling in the tables below was measured in a real child
// process against tls.getCACertificates("default") vs ("bundled").
// ---------------------------------------------------------------------------

const CA = { SSL_CERT_FILE: "/etc/attacker/ca.pem" };

/** The parse alone: the probe would answer for THIS process, which has no flag. */
function noProbe(): undefined {
  return undefined;
}

/** Every spelling Node honours, measured in a child process by the exploit. */
const HONOURED = [
  "--use-openssl-ca",
  " --use-openssl-ca ",
  "--use_openssl_ca",
  "--use-openssl-ca=true",
  '"--use-openssl-ca"',
  "--use_openssl_ca=true",
  "--use-openssl-ca=1",
  // Node ignores the value on a boolean flag, so this turns the flag ON. A fix
  // that "honoured" the parsed value would be wrong in the same direction as the
  // bug it replaces.
  "--use-openssl-ca=false",
  '"--use_openssl_ca=false"',
];

/** Spellings Node does NOT honour. Silence here is the correct answer. */
const NOT_HONOURED = [
  "'--use-openssl-ca'",
  "--USE-OPENSSL-CA",
  "--Use-Openssl-Ca",
  "--use-openssl-cast",
  "use-openssl-ca",
  "--max-old-space-size=4096",
  "",
];

describe("nodeOptionFlagNames canonicalises a token the way Node does", () => {
  it("strips ONE surrounding pair of double quotes", () => {
    expect([...nodeOptionFlagNames('"--use-openssl-ca"')]).toEqual([
      "--use-openssl-ca",
    ]);
    // One pair, not all of them: a doubly-quoted token is not something Node
    // reduces to the bare flag, so neither does this.
    expect([...nodeOptionFlagNames('""--use-openssl-ca""')]).not.toContain(
      "--use-openssl-ca",
    );
  });

  it("does NOT strip single quotes, because Node does not either", () => {
    expect([...nodeOptionFlagNames("'--use-openssl-ca'")]).not.toContain(
      "--use-openssl-ca",
    );
  });

  it("splits on the FIRST = and discards the value", () => {
    for (const value of ["true", "false", "1", "", "a=b"]) {
      expect([
        value,
        nodeOptionFlagNames(`--use-openssl-ca=${value}`).has(
          "--use-openssl-ca",
        ),
      ]).toEqual([value, true]);
    }
  });

  it("folds underscores to dashes", () => {
    expect(
      nodeOptionFlagNames("--use_openssl_ca").has("--use-openssl-ca"),
    ).toBe(true);
  });

  it("does NOT case-fold, because Node refuses a non-lower-case flag", () => {
    expect(
      nodeOptionFlagNames("--USE-OPENSSL-CA").has("--use-openssl-ca"),
    ).toBe(false);
  });

  it("reads a whitespace-separated string and an argv array the same way", () => {
    const fromString = nodeOptionFlagNames(
      "  --use_openssl_ca=true   --max-old-space-size=4096 ",
    );
    const fromArray = nodeOptionFlagNames([
      "--use_openssl_ca=true",
      "--max-old-space-size=4096",
    ]);
    expect([...fromString].sort()).toEqual([...fromArray].sort());
    expect(fromString.has("--use-openssl-ca")).toBe(true);
    expect(fromString.has("--max-old-space-size")).toBe(true);
  });

  it("yields nothing for an empty or whitespace-only source", () => {
    for (const source of ["", "   ", [], [""]]) {
      expect([source, [...nodeOptionFlagNames(source)]]).toEqual([source, []]);
    }
  });
});

describe("every spelling Node honours produces the note", () => {
  it.each(HONOURED)("notes %j supplied through NODE_OPTIONS", (spelling) => {
    const channel = inspectCredentialChannel(
      "https:",
      { NODE_OPTIONS: spelling, ...CA },
      [],
      noProbe,
    );
    const notes = channel.notes.join("\n");
    expect(notes).toContain("--use-openssl-ca");
    // The pair, not just the flag: the whole consequence of a miss was that
    // SSL_CERT_FILE went unnamed with it.
    expect(notes).toContain("SSL_CERT_FILE");
    // And the conditional sentence is NOT also emitted — the condition is known.
    expect(channel.informationalNotes).toEqual([]);
  });

  it.each(HONOURED)("notes %j supplied through execArgv", (spelling) => {
    // A command line is written by whoever launches the process, so there is no
    // shell normalisation to evade — but the two sources go through one
    // canonicaliser, so neither can drift away from the other.
    const notes = inspectCredentialChannel(
      "https:",
      CA,
      spelling.trim().split(/\s+/),
      noProbe,
    ).notes.join("\n");
    expect(notes).toContain("--use-openssl-ca");
  });
});

describe("no spelling Node refuses produces a note", () => {
  it.each(NOT_HONOURED)("stays silent for %j", (spelling) => {
    // The fix must not be "fixed" into a false alarm: for each of these, the
    // runtime does nothing, so a note would be a claim about a setting that
    // changes nothing. Silence AGREES with the runtime here.
    const channel = inspectCredentialChannel(
      "https:",
      { NODE_OPTIONS: spelling, ...CA },
      [],
      noProbe,
    );
    expect(channel.notes.join("\n")).not.toContain("--use-openssl-ca");
    // But the conditional sentence IS emitted, because SSL_CERT_FILE is set and
    // the flag was not found — that is the channel, still working.
    expect(channel.informationalNotes.length).toBeGreaterThan(0);
  });
});

describe("the runtime probe remains the second, independent signal", () => {
  it("adds the note for a spelling the canonicaliser does not know", () => {
    // There is no such spelling today — that is the point of the canonical
    // parse — so the probe is what covers the one nobody has thought of yet.
    const notes = inspectCredentialChannel(
      "https:",
      { NODE_OPTIONS: "--some-future-alias-for-openssl-ca", ...CA },
      [],
      () => true,
    ).notes.join("\n");
    expect(notes).toContain("--use-openssl-ca");
    expect(notes).toContain("SSL_CERT_FILE");
  });

  it("never suppresses a note the parse found", () => {
    const notes = inspectCredentialChannel(
      "https:",
      { NODE_OPTIONS: "--use_openssl_ca", ...CA },
      [],
      () => false,
    ).notes.join("\n");
    expect(notes).toContain("--use-openssl-ca");
  });
});
