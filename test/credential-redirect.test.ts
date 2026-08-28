/**
 * The refresh token and the client secret must end up at the host they were aimed at,
 * and nowhere else.
 *
 * The token grant is the only request in this server that carries a credential in its
 * BODY; everything else carries a short-lived bearer in a header. That makes it the one
 * request where the destination is not merely a privacy question —
 * `src/credential-target.ts` exists to decide whether these credentials may be sent to
 * a given URL at all.
 *
 * A redirect defeats that decision completely. The guard inspects `apiUrl`, which is
 * only ever the FIRST hop; a `Location:` header chooses the second, and the guard never
 * sees it. axios follows up to 21 redirects by default, and follow-redirects preserves
 * both method and body on 307 and 308 — so without `maxRedirects: 0` a single header
 * re-POSTs a long-lived brokerage credential to a host of the redirector's choosing.
 * The first hop does not have to be hostile: anything terminating TLS in front of the
 * API can emit it.
 *
 * This cannot be tested through the `adapter` seam the rest of the suite uses. Redirect
 * following happens inside the transport, BELOW the adapter, so an adapter-based test
 * would pass whether the guard were present or absent. So these tests stand up real HTTP
 * servers on loopback and assert against what the second one received.
 *
 * The collector deliberately answers a redirected grant with a VALID-looking token
 * payload: if the credential ever reaches it, the client caches a token minted by the
 * wrong host and the flow otherwise looks healthy.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import { TastytradeOAuthClient } from "../src/oauth-client.js";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";

const REFRESH_TOKEN = "refresh-token-that-must-not-travel";
const CLIENT_SECRET = "client-secret-that-must-not-travel";
const CLIENT_ID = "client-id-abc";

/** Every status a redirect can arrive as, including the two that keep the body. */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
/** The two that re-send the POST body verbatim — the credential-leaking pair. */
const BODY_PRESERVING = [307, 308] as const;

interface Origin {
  url: string;
  /** Every request this origin received, oldest first. */
  hits: Array<{ method: string; url: string; body: string }>;
  close: () => Promise<void>;
}

const openOrigins: Origin[] = [];

async function origin(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Origin> {
  const hits: Origin["hits"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  const o: Origin = {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  openOrigins.push(o);
  return o;
}

/** An origin that mints a plausible access token — the "wrong host wins" case. */
function mintsAToken(label: string) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: `ACCESS-TOKEN-MINTED-BY-${label}`,
        token_type: "Bearer",
        expires_in: 900,
      }),
    );
  };
}

afterEach(async () => {
  await Promise.all(openOrigins.splice(0).map((o) => o.close()));
});

function client(apiUrl: string): TastytradeOAuthClient {
  return new TastytradeOAuthClient(
    {
      apiUrl,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
    },
    { timeoutMs: 5_000 },
  );
}

describe("the hazard these tests guard against is real", () => {
  /**
   * Pins the premise. If a future axios or follow-redirects stopped preserving
   * the body on a 307, `maxRedirects: 0` would still be correct but this
   * suite's other assertions would start passing for the wrong reason. This
   * test fails loudly if that day comes, instead of letting the guard quietly
   * become decoration.
   */
  it.each(BODY_PRESERVING)(
    "a default axios POST hands the body to the redirect target on %i",
    async (status) => {
      const collector = await origin(mintsAToken("COLLECTOR"));
      const redirector = await origin((_req, res) => {
        res.writeHead(status, { location: `${collector.url}/oauth/token` });
        res.end();
      });

      const res = await axios.post(
        `${redirector.url}/oauth/token`,
        { grant_type: "refresh_token", refresh_token: REFRESH_TOKEN },
        { headers: { "Content-Type": "application/json" }, timeout: 5_000 },
      );

      expect(collector.hits).toHaveLength(1);
      expect(collector.hits[0].body).toContain(REFRESH_TOKEN);
      expect(res.data.access_token).toBe("ACCESS-TOKEN-MINTED-BY-COLLECTOR");
    },
  );
});

describe("the token grant refuses to follow a redirect", () => {
  it.each(REDIRECT_STATUSES)(
    "does not send the credentials onward on %i, and fails non-retryably",
    async (status) => {
      const collector = await origin(mintsAToken("COLLECTOR"));
      const redirector = await origin((_req, res) => {
        res.writeHead(status, { location: `${collector.url}/oauth/token` });
        res.end();
      });

      await expect(client(redirector.url).getAccessToken()).rejects.toThrow();

      // The assertion that matters: the second host never heard from us.
      expect(collector.hits).toEqual([]);
      // And the first one did, exactly once — proving the request really was
      // attempted and the empty collector is not a rig that never ran.
      expect(redirector.hits).toHaveLength(1);
      expect(redirector.hits[0].body).toContain(REFRESH_TOKEN);
    },
  );

  it("reports a redirect as a redirect, not as a rejected credential", async () => {
    const collector = await origin(mintsAToken("COLLECTOR"));
    const redirector = await origin((_req, res) => {
      res.writeHead(307, { location: `${collector.url}/oauth/token` });
      res.end();
    });

    const err = await client(redirector.url)
      .getAccessToken()
      .then(
        () => undefined,
        (e: unknown) => e as { toolError?: Record<string, unknown> },
      );

    const envelope = err?.toolError ?? {};
    // Non-retryable: an agent must not sit in a loop against this.
    expect(envelope.retryable).toBe(false);
    // The message has to say what actually happened. "The endpoint rejected
    // your credentials" would send the operator to rotate a secret that is
    // fine, and would not tell them a credential was nearly exfiltrated.
    expect(String(envelope.message)).toMatch(/redirect/i);
    expect(String(envelope.message)).toMatch(/NOT forwarded/);
    expect(String(envelope.message)).not.toMatch(/rejected the credentials/);
    // Nothing that travelled in the body may appear in what the agent sees.
    const rendered = JSON.stringify(envelope);
    expect(rendered).not.toContain(REFRESH_TOKEN);
    expect(rendered).not.toContain(CLIENT_SECRET);
  });

  it("still completes a grant when nobody redirects", async () => {
    // The control. Without it, a rig that fails to reach any origin at all
    // would satisfy every assertion above.
    const api = await origin(mintsAToken("REAL-API"));
    await expect(client(api.url).getAccessToken()).resolves.toBe(
      "ACCESS-TOKEN-MINTED-BY-REAL-API",
    );
    expect(api.hits).toHaveLength(1);
    expect(api.hits[0].body).toContain(REFRESH_TOKEN);
  });
});

describe("the preflight refuses the same redirect", () => {
  /**
   * The doctor sends a byte-identical POST, and round two's fix to the server's
   * credential guard was applied to the server and missed here — the same
   * two-implementations-of-one-rule split that produced the defect this suite
   * closes. So the preflight is asserted directly rather than by inspection.
   *
   * The environment acknowledges the loopback host, which is the realistic
   * shape of the threat: an operator who has legitimately pointed the server at
   * a local gateway or proxy, which then redirects.
   */
  function deps(apiUrl: string): DoctorDeps {
    return {
      env: {
        TASTYTRADE_API_URL: apiUrl,
        TASTYTRADE_ALLOW_UNKNOWN_API_HOST: "127.0.0.1",
        TASTYTRADE_CLIENT_ID: CLIENT_ID,
        TASTYTRADE_CLIENT_SECRET: CLIENT_SECRET,
        TASTYTRADE_REFRESH_TOKEN: REFRESH_TOKEN,
      },
      lookupHost: async () => ["127.0.0.1"],
      probeConnection: async () => "TCP connection opened",
      fileExists: () => true,
      now: () => Date.now(),
      // No adapter: the real transport, which is the only way a redirect can
      // be exercised at all.
    };
  }

  it("does not forward the credentials, and does not report PREFLIGHT PASSED", async () => {
    const collector = await origin(mintsAToken("COLLECTOR"));
    const redirector = await origin((_req, res) => {
      res.writeHead(307, { location: `${collector.url}/oauth/token` });
      res.end();
    });

    const report = await runDoctor(deps(redirector.url));

    expect(collector.hits).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);

    const grant = report.checks.find((c) => c.id === "token-grant");
    expect(grant?.status).toBe("fail");
    // The operator has to be able to tell this from a wrong secret.
    const text = JSON.stringify(grant);
    expect(text).toMatch(/redirect/i);
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain(CLIENT_SECRET);
  });
});
