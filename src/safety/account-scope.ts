/**
 * Which accounts may this process act on?
 *
 * The bearer is customer-wide, so without this the account a call acts on is
 * decided entirely by a caller-supplied string — and the caller is a
 * prompt-injectable agent. The answer comes from `GET /customers/me/accounts`,
 * the credential describing its own reach; it promises only "this credential
 * holds that account", never "the operator meant it".
 *
 * Cached for the process, with two rules: a refused call must not cost the broker
 * (a miss re-asks only once the cached answer is
 * {@link ACCOUNT_SET_MIN_REFRESH_INTERVAL_MS} old), and a failed lookup must not
 * be cached as an answer (an unreadable list is not an empty one). Billed through
 * {@link chargeUpstreamCallDebt}, which cannot refuse a call already admitted.
 *
 * It does NOT authenticate the caller: on stdio there is no second principal.
 * That becomes a publish blocker the moment an HTTP or SSE transport is added —
 * see the README.
 */

import { monotonicNow } from "./clock.js";
import { adaptError, toolError } from "./errors.js";
import { chargeUpstreamCallDebt } from "./rate-limit.js";
import { boundedText } from "./bounded-text.js";

/**
 * The argument names that carry an account number into this server.
 *
 * Both surfaces use them: a tool argument bag and a resource template's
 * captured parameters. Asserted against the whole tool registry in
 * test/e2e/account-scope.test.ts, which derives the set of account-naming
 * schema properties from `tools/list` rather than trusting this list — a third
 * spelling arriving in a new tool's schema fails that test rather than passing
 * unchecked.
 */
export const ACCOUNT_ARGUMENT_FIELDS = [
  "account_number",
  "account_numbers",
] as const;

/**
 * How old a resolved account set may be before a MISS is allowed to re-ask.
 *
 * Not a TTL: the set does not expire, and a HIT never re-asks however old the
 * answer is. This bounds only the refresh-on-miss path, which is the one an
 * unauthorised caller can drive.
 */
export const ACCOUNT_SET_MIN_REFRESH_INTERVAL_MS = 60_000;

/** Longest account number this module will echo back into a refusal. */
const MAX_ECHOED_ACCOUNT_CHARS = 64;

/**
 * The upstream authority on which accounts a credential holds.
 *
 * Structural rather than the concrete `TastytradeClient`, so the unit suite can
 * answer the one question this control asks without an HTTP client, a token or
 * a network — and so this module stays free of the api-client import that would
 * make it the heaviest thing in src/safety/.
 */
export interface AccountDirectory {
  getAccounts(): Promise<unknown>;
}

/** What one `GET /customers/me/accounts` payload said. */
export interface AccountSetReading {
  /** Every account number the payload named, in first-seen order, deduplicated. */
  numbers: string[];
  /**
   * How many entries the payload carried, whether or not an account number
   * could be read from each.
   *
   * Kept separate from `numbers.length` so the two ways of arriving at "no
   * accounts" stay distinguishable: a credential that genuinely holds none
   * (`entries: 0`) is a real answer worth caching, while entries the reader
   * could not understand (`entries > 0, numbers: []`) is a payload-shape change
   * that must not be mistaken for one. Conflating them would turn an upstream
   * rename into a silent, cached lock-out of every account-scoped tool.
   */
  entries: number;
}

/**
 * Read the account numbers out of a `/customers/me/accounts` payload.
 *
 * Two shapes are accepted because two shapes occur: the accounts endpoint wraps
 * each account in a membership record (`{ account: { "account-number": … },
 * "authority-level": … }`), while several neighbouring endpoints return the
 * account object directly. Anything that is not a non-empty string is ignored
 * rather than coerced — an account number is the value that will be compared
 * against a caller's string, so `null` must not become `"null"`.
 */
export function readAccountSet(payload: unknown): AccountSetReading {
  const entries: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { items?: unknown[] } | null)?.items)
      ? ((payload as { items: unknown[] }).items ?? [])
      : [];
  const numbers: string[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const nested = record.account;
    const source =
      nested !== null && typeof nested === "object"
        ? (nested as Record<string, unknown>)
        : record;
    const value = source["account-number"];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !numbers.includes(value)
    )
      numbers.push(value);
  }
  return { numbers, entries: entries.length };
}

/**
 * The account numbers an argument bag names, whichever field carries them.
 *
 * Read off the BAG, not off the tool's input schema, and that is the load-bearing
 * choice in this module. Deriving the fields to check from each tool's schema
 * would make 84 schemas part of the control: the very defect this fix also
 * closes was a field (`account_numbers`) that reached the wire from a tool whose
 * schema never declared it, through a mapper shared with a tool whose schema
 * did. A caller that sends an account number under one of these names is
 * claiming to act on that account, and the claim is checked whether or not the
 * tool it sent it to admits the field.
 */
export function namedAccounts(args: unknown): string[] {
  if (args === null || typeof args !== "object") return [];
  const bag = args as Record<string, unknown>;
  const found: string[] = [];
  const single = bag.account_number;
  if (typeof single === "string" && single.length > 0) found.push(single);
  const many = bag.account_numbers;
  if (Array.isArray(many)) {
    for (const value of many) {
      if (typeof value === "string" && value.length > 0) found.push(value);
    }
  }
  return found;
}

/**
 * The credential's own account set, resolved once and asserted against.
 *
 * One instance per server. State is in-memory and per-process, which is correct
 * for a single-process stdio server for the same reason the confirmation store
 * is: there is one caller and one credential.
 */
export class AccountScope {
  private permitted: Set<string> | undefined;
  private resolvedAtMs = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<Set<string>> | undefined;
  private lookups = 0;

  constructor(
    private readonly directory: AccountDirectory,
    private readonly minRefreshIntervalMs = ACCOUNT_SET_MIN_REFRESH_INTERVAL_MS,
  ) {}

  /**
   * How many times the broker has been asked. For the suite that pins the
   * cache: "resolved once" is a claim about upstream traffic, and the only
   * honest way to assert it is to count the requests.
   */
  upstreamLookups(): number {
    return this.lookups;
  }

  /**
   * Refuse unless every account named is one this credential holds.
   *
   * Naming no account is not a bypass: the tools that name none — a quote, an
   * option chain, the account LIST itself — are not account-scoped, so there is
   * nothing to compare and no upstream lookup is made for them.
   */
  async assertPermitted(
    named: readonly string[],
    subject: string,
  ): Promise<void> {
    if (named.length === 0) return;

    let permitted = await this.resolve();
    let missing = named.filter((account) => !permitted.has(account));
    if (
      missing.length > 0 &&
      monotonicNow() - this.resolvedAtMs >= this.minRefreshIntervalMs
    ) {
      // An account opened, or granted to this credential, since the set was
      // resolved. Re-ask ONCE, and only once per interval — see the header for
      // why a miss cannot be allowed to re-ask freely.
      permitted = await this.resolve(true);
      missing = named.filter((account) => !permitted.has(account));
    }
    if (missing.length === 0) return;

    const shown = missing
      .map((account) =>
        boundedText(account, { maxChars: MAX_ECHOED_ACCOUNT_CHARS }),
      )
      .join(", ");
    throw toolError({
      code: "auth_failed",
      message:
        `${subject} names ${missing.length === 1 ? "an account" : "accounts"} this ` +
        `server's credential does not hold: ${shown}. The configured refresh ` +
        `token covers ${permitted.size} account${permitted.size === 1 ? "" : "s"}, ` +
        `and the request was not sent.`,
      retryable: false,
      hint: "Call tastytrade_get_accounts (or read tastytrade://accounts) for the accounts this credential can act on, and use one of those numbers. Retrying with the same number will not help: this is not a transient upstream failure, it is the account not being one this credential holds.",
    });
  }

  /**
   * The account set, from the cache unless `force`.
   *
   * Concurrent first calls share one request: a burst of six account-scoped
   * tool calls on a cold cache is one `/customers/me/accounts`, not six.
   */
  private async resolve(force = false): Promise<Set<string>> {
    if (!force && this.permitted !== undefined) return this.permitted;
    if (this.inFlight) return this.inFlight;
    const attempt = this.lookup();
    this.inFlight = attempt;
    try {
      return await attempt;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async lookup(): Promise<Set<string>> {
    this.lookups += 1;
    let payload: unknown;
    try {
      payload = await this.directory.getAccounts();
    } catch (e) {
      // A broker request WAS made, so it is billed even though it failed —
      // the debt records traffic, not success.
      chargeUpstreamCallDebt();
      const upstream = adaptError(e);
      throw toolError({
        code: upstream.code,
        message:
          "This server could not read which accounts its credential holds, so it " +
          "cannot confirm that the account named in this call is one of them, and " +
          `the call was not made. The account lookup failed: ${upstream.message}`,
        retryable: upstream.retryable,
        retry_after_ms: upstream.retry_after_ms,
        hint: "The account list at GET /customers/me/accounts is what every account-scoped call is checked against, so it fails closed. Check the credential and the API endpoint with `node dist/doctor.js`, then retry — the answer is not cached, so a recovered endpoint works on the next call.",
      });
    }
    // UNKEYED, and deliberately, even though `accounts` is a published 1/sec
    // ceiling and this is exactly that endpoint. Keying it would spend the whole
    // per-second budget for GET /customers/me/accounts inside the pre-flight of
    // the first account-scoped call, so `tastytrade_get_accounts` — the tool the
    // refusal tells an agent to call to find out which accounts it MAY use —
    // would come back `rate_limit_exceeded` for the rest of that second.
    // Refusing the remedy a refusal recommends is a worse outcome than
    // attributing one request per process to the global bucket alone, and the
    // ceiling exists to stop a POLL: this is resolved once and refreshed at most
    // once per interval, so there is no poll to stop.
    chargeUpstreamCallDebt();

    const reading = readAccountSet(payload);
    if (reading.entries > 0 && reading.numbers.length === 0) {
      // Entries the reader did not understand. Refusing here rather than
      // caching an empty set is the difference between one failed call and a
      // process that has locked every account-scoped tool out until restart.
      throw toolError({
        code: "upstream_error",
        message:
          `The account list carried ${reading.entries} entr${reading.entries === 1 ? "y" : "ies"} ` +
          "and no account number could be read from any of them, so the account " +
          "named in this call could not be checked and the call was not made.",
        retryable: false,
        hint: "This is a payload-shape mismatch rather than a permissions problem: GET /customers/me/accounts answered with entries this server could not read an `account-number` out of. Check the API version this server sends (Accept-Version) against the endpoint's current response shape.",
      });
    }
    this.permitted = new Set(reading.numbers);
    this.resolvedAtMs = monotonicNow();
    return this.permitted;
  }
}
