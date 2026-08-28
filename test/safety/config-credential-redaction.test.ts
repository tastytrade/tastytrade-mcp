import { describe, it, expect, afterEach } from "@jest/globals";
import { TastytradeClient } from "../../src/api-client.js";
import {
  _resetRegisteredSecretsForTest,
  adaptError,
} from "../../src/safety/errors.js";

/**
 * Credentials supplied in the CONFIG OBJECT bypass the redactor.
 *
 * `configuredSecrets()` builds its match list from `process.env` alone, so a client
 * constructed with credentials in the config object and nothing in the environment
 * registers no secrets at all — and an upstream `error_description` echoing the
 * client secret back is relayed verbatim into `message`, `hint` and `upstream.body`.
 *
 * The shipped stdio server passes `process.env.*` into that config, so both sources
 * agree today and the gap is latent. It stops being latent the moment somebody embeds
 * `TastytradeClient` as a library. This repository is about to be public.
 *
 * The realistic harm is not a stranger stealing the token: it is the operator pasting
 * their own secret into a public issue because the server printed it.
 */

const API_URL = "https://api.cert.tastyworks.com";

// These three fixtures are deliberately low-entropy, per the convention in
// .gitleaks.toml: satisfy the redactor's 8-character length floor WITHOUT
// looking random. Written as random hex first, they tripped the gate's secret
// scan — the fourth time a redaction fixture has done that here. The literal
// value is irrelevant to what these tests prove (registration is by exact
// string match, not by shape), so there is nothing to gain from realism and a
// green gate to lose. Do not "improve" these into hex.
const CONFIG_SECRET = "NOT_A_REAL_CONFIG_CLIENT_SECRET_FIXTURE_0000";
const CONFIG_REFRESH = "NOT_A_REAL_CONFIG_REFRESH_TOKEN_FIXTURE_0000";

const PRIOR = {
  secret: process.env.TASTYTRADE_CLIENT_SECRET,
  refresh: process.env.TASTYTRADE_REFRESH_TOKEN,
  session: process.env.TASTYTRADE_SESSION_TOKEN,
};

afterEach(() => {
  // The registry is module-level, so a literal registered here would otherwise
  // stay registered for every later test file in the same worker — and a test
  // asserting that some unrelated string survives verbatim would fail for a
  // reason nowhere near itself. Clearing it keeps this file's state local.
  _resetRegisteredSecretsForTest();
  for (const [k, v] of [
    ["TASTYTRADE_CLIENT_SECRET", PRIOR.secret],
    ["TASTYTRADE_REFRESH_TOKEN", PRIOR.refresh],
    ["TASTYTRADE_SESSION_TOKEN", PRIOR.session],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Strip every credential env var, so the config object is the ONLY source. */
function clearCredentialEnv(): void {
  delete process.env.TASTYTRADE_CLIENT_SECRET;
  delete process.env.TASTYTRADE_REFRESH_TOKEN;
  delete process.env.TASTYTRADE_SESSION_TOKEN;
}

/**
 * A raw axios rejection shaped the way the client really throws one — the client
 * does NOT wrap it; `adaptError` runs at the dispatcher boundary.
 */
function upstream422(body: unknown) {
  const err = new Error("Request failed with status code 422") as Error & {
    response: unknown;
    isAxiosError: boolean;
  };
  err.isAxiosError = true;
  err.response = { status: 422, statusText: "422", headers: {}, data: body };
  return err;
}

/**
 * Construct a client whose credentials live ONLY in the config object, then
 * adapt an upstream error that echoes them back. Construction is the moment a
 * fix has to register those literals with the redactor; `adaptError` is where
 * the scrub happens.
 */
function envelopeFrom(
  body: unknown,
  creds: Partial<
    Record<"clientId" | "clientSecret" | "refreshToken", string>
  > = {
    clientId: "cfg-client-id",
    clientSecret: CONFIG_SECRET,
    refreshToken: CONFIG_REFRESH,
  },
) {
  new TastytradeClient(
    { apiUrl: API_URL, ...creds },
    { tokenProvider: () => "test-access-token" },
  );
  return adaptError(upstream422(body));
}

describe("a config-supplied credential is redacted like an env one", () => {
  it("does not relay a config-object client secret echoed in error_description", () => {
    clearCredentialEnv();
    const env = envelopeFrom({
      error: "invalid_client",
      error_description: `client_secret ${CONFIG_SECRET} was rejected`,
    });

    const whole = JSON.stringify(env);
    expect(whole).not.toContain(CONFIG_SECRET);
    expect(whole).toContain("[redacted]");
  });

  it("does not relay a config-object refresh token in free upstream text", () => {
    // Deliberately NOT under a `refresh_token` key. `redactDeep` already scrubs
    // by key NAME, so the keyed shape passes without any fix — measured. The gap
    // is the literal appearing where there is no credential key to match on,
    // which is exactly what a gateway's prose error does.
    clearCredentialEnv();
    const env = envelopeFrom({
      error: { detail: `the grant for ${CONFIG_REFRESH} has expired` },
    });

    expect(JSON.stringify(env)).not.toContain(CONFIG_REFRESH);
  });

  it("redacts the config secret in message and hint, not only in upstream.body", () => {
    clearCredentialEnv();
    const env = envelopeFrom({
      error_description: `secret ${CONFIG_SECRET}`,
    });

    // Named separately because the three operands are built at different sites;
    // a fix applied to one of them would pass a whole-envelope assertion only
    // by accident of where the echo happened to land.
    expect(env.message).not.toContain(CONFIG_SECRET);
    expect(String(env.hint ?? "")).not.toContain(CONFIG_SECRET);
    expect(JSON.stringify(env.upstream ?? {})).not.toContain(CONFIG_SECRET);
  });

  it("still redacts an env-supplied secret when the config carries none", () => {
    // The control. The env path is what the shipped stdio server uses, and it
    // must keep working — a fix that swapped one source for the other rather
    // than taking the union would pass every assertion above and regress this.
    // It shares `clientEchoing` deliberately: the only variable between this
    // case and the three above is WHERE the credential came from.
    const ENV_SECRET = "NOT_A_REAL_ENV_CLIENT_SECRET_FIXTURE_0000";
    clearCredentialEnv();
    process.env.TASTYTRADE_CLIENT_SECRET = ENV_SECRET;

    const env = envelopeFrom({ error_description: `secret ${ENV_SECRET}` }, {});

    expect(JSON.stringify(env)).not.toContain(ENV_SECRET);
  });
});
