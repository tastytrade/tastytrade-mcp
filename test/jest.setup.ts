/**
 * Scrub the developer's own environment before any test module loads.
 *
 * `TastytradeMCPServer`'s constructor calls `assertCredentialTargetAllowed` against
 * `process.env`, and it has to: a guard that reads an injected environment is not
 * guarding the process that will send the credentials. The consequence is that every
 * test constructing a server reads the ambient environment too. An engineer with
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` exported in their shell — a common workaround for a
 * corporate TLS appliance, and precisely the population `src/credential-target.ts` is
 * written for — sees 23 suites and 964 tests fail with a credential refusal, none of it
 * about their change, while two clean CI runners never reproduce it.
 *
 * `TASTYTRADE_*` is scrubbed for a second reason: those are real credentials on a real
 * machine, and `resolveApiUrl()` reads `process.env`, so a test that forgot to inject a
 * URL would silently pick up the developer's — which on an unlucky day is production.
 *
 * It does not change what the product reads, and it does not stop a test setting any of
 * these itself. It only removes the ones nobody asked for, so a green run means the same
 * thing on every machine.
 */

import { CHANNEL_ENV_VARS } from "../src/credential-target.js";

/**
 * Remove every variable that changes what this server does but that no test
 * asked for. Exported and taking the environment as an argument so the
 * behaviour is assertable rather than merely applied.
 */
export function scrubAmbientEnv(env: NodeJS.ProcessEnv): void {
  for (const name of CHANNEL_ENV_VARS) delete env[name];
  for (const name of Object.keys(env)) {
    if (name.startsWith("TASTYTRADE_")) delete env[name];
  }
}

scrubAmbientEnv(process.env);
