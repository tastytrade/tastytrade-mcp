# Recorded API payloads

Twenty-one real responses captured from the tastytrade **sandbox** API
(`api.cert.tastyworks.com`). They exist so the response _shape_ can be checked
without credentials or a network — the payloads are the reference corpus for
what the API actually returns, as opposed to what the docs say it returns.

## These are test inputs, not reference data — do not delete them

`./build.sh` depends on this directory. Two things read it, both offline:

| Reader                          | What it does with them                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `../harness.ts` (`loadFixture`) | Serves a recorded body from the fake transport, so a suite asserts against a real API response instead of a hand-written stand-in. |
| `../output-schemas.test.ts`     | Enumerates this directory and validates every payload against the `outputSchema` the server advertises, through the SDK's own ajv. |

`output-schemas.test.ts` derives its case list from `readdirSync` here, so
removing a file silently removes its schema check and the suite still passes.
That is the whole reason these sit in `test/e2e/` rather than under
the live sweep's own directory, where they would be filed next to credentialed
sweep they read as deletable reference material, and deleting them would take a
layer of the offline suite with them.

They have been modified in two deliberate ways. Both are recorded here so
nobody mistakes a processed fixture for a verbatim capture.

## 1. Credentials and identifiers scrubbed

315 replacements across 7 files:

| What                                            | Why                                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A real sandbox account number (159 occurrences) | Not a credential, but it identifies an account, so it does not belong in a public repository — including in this table. The scrubbed value is visible in the payloads themselves. |
| A `confirmation_token` UUID                     | An expired single-use dry-run token with a 60-second TTL — worthless, but high-entropy enough to trip `generic-api-key` on every secret scan.                                     |
| `global-request-id` trace ids                   | The suffix encodes a backend instance hash.                                                                                                                                       |

Swept for and **not** found: JWTs, bearer tokens, base64 secret shapes, and
person-identifying fields (user, email, customer, name, phone, address).

Left intentionally intact: instrument reference data, prices, timestamps,
numeric order ids, and `ext-client-order-id` (opaque per-order handles, tied to
an account number that is now fake).

Verified with `gitleaks dir .` — 1 leak before, 0 after. The gate re-runs that
scan over the whole tree on every build, so a future re-recording that forgets
the scrub fails rather than lands.

## 2. Long arrays truncated to 4 items

Four option-chain payloads were 43.15 MB combined, one of them 37 MB on its own
(20,404 strikes). That is roughly a hundred times the size of all the source in
this repository, and it added seconds to `prettier --check` on every gate run
and every CI run, forever.

Arrays longer than four entries were truncated **recursively**, and nothing
else was changed: no key is added, removed, or renamed, so a schema check sees
exactly the structure it saw before. Only repetition is gone — the 20,405th
strike exercises no field the 4th does not.

| Fixture                     | Before   | After   | Largest array                     |
| --------------------------- | -------- | ------- | --------------------------------- |
| `futures_option_chain_full` | 37.24 MB | 0.01 MB | `items`: 20,404 → 4               |
| `futures_option_chains`     | 2.83 MB  | 0.01 MB | `expirations[0].strikes`: 153 → 4 |
| `option_chain`              | 2.59 MB  | 0.00 MB | `items`: 3,704 → 4                |
| `option_chain_nested`       | 0.49 MB  | 0.01 MB | `expirations[0].strikes`: 75 → 4  |

**Total: 43.15 MB → 0.03 MB.** The other 17 payloads were already small and are
untouched.

If you need a full-volume capture — to load-test a client, or to measure
pagination — record a fresh one against the sandbox rather than trying to
reconstruct these. The originals were not kept in the repository; the truncated
form is the tracked form.
