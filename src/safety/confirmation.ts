/**
 * Dry-run-first confirmation token flow.
 *
 * Destructive order tools require a `confirmation_token` issued by the matching
 * dry-run tool. Tokens have a 60-second TTL and are bound to the action name, a
 * sha256 of the dry-run args, and a sha256 of the REQUEST TARGET the submit will
 * dial.
 *
 * The target is a SEPARATE binding because the guarantee is "the broker
 * pre-flighted THIS request", and a request is a (method, URI, body) triple. The
 * args hash covers the body, not the URI — and the URI is a function of the
 * arguments only AFTER the URL layer normalises them. An `order_id` of `.` is
 * byte-identical on both legs, so the args hash matches, while
 * `/accounts/A/orders/./dry-run` collapses to the PLACE-order pre-flight and
 * `/accounts/A/orders/.` to the collection: one endpoint pre-flighted, another
 * submitted to, on a hash that agreed.
 *
 * Two checks close it. AT MINT, the pre-flight target must be the declared
 * pre-flight OF the submit target — that is what catches two legs normalising
 * apart, because it compares them to each other. AT CONSUME, this submit's target
 * must equal the recorded one; implied today by the args hash, asserted anyway
 * and REQUIRED, so a future gated tool whose path draws on an unhashed argument
 * is a type error rather than a silent hole.
 *
 * This module parses no URLs and holds no route table. It compares opaque
 * already-normalised strings from the api-client and asserts one structural
 * relation: a pre-flight is its submit's path with `/dry-run` appended, by POST.
 *
 * The TTL is measured on BOTH clocks and expires on whichever fires first — see
 * `expiresAtMono` / `expiresAtWall`. State is in-memory only, which is correct
 * for one process per stdio session; a shared store is deliberately not used.
 */

import { createHash, randomUUID } from "node:crypto";
import { monotonicNow } from "./clock.js";
import { toolError } from "./errors.js";

const TTL_MS = 60_000;

/**
 * An already-normalised request target, as an opaque pair.
 *
 * Declared here rather than imported from the api-client so the dependency runs
 * one way only (the safety layer is imported BY the client, never the reverse)
 * and so this module gains no route knowledge. Structurally compatible with the
 * client's `RequestTarget` by design.
 */
export interface AuthorisedTarget {
  method: string;
  path: string;
}

/** The two legs of one authorisation, as the api-client rendered them. */
export interface Authorisation {
  /** The pre-flight this dry-run dialled. */
  dryRun: AuthorisedTarget;
  /** The submit this token authorises. */
  submit: AuthorisedTarget;
}

/**
 * The suffix a pre-flight endpoint adds to the endpoint it pre-flights.
 *
 * Every gated route in the tastytrade API is arranged this way — POST to the
 * submit path with `/dry-run` appended — so one relation covers all five
 * actions and no table is needed here. Stated as a comparison against INTENT
 * rather than as a list of endpoints: any value, encoding, or future route
 * whose two legs stop satisfying it is refused, including one nobody has
 * thought of yet.
 */
const DRY_RUN_SUFFIX = "/dry-run";

export interface ConfirmationToken {
  token: string;
  action: string;
  dryRunResult: unknown;
  /**
   * Deadline on the safety layer's MONOTONIC scale (src/safety/clock.ts) — not
   * a wall-clock epoch, so never render it as a date.
   *
   * The 60 seconds is the recency guarantee the whole handshake rests on: the
   * stored `dryRunResult` is what `runSanityChecks` measures the notional cap
   * and the dry-run verdict against, so "this projection is under a minute old"
   * has to be a statement about elapsed time. Timed off `Date.now()` alone it
   * was a statement about two readings of a settable clock instead: one
   * backward step of N ms extended every live token to 60s + N and nothing
   * reported it. This reading is what a settable clock cannot move.
   */
  expiresAtMono: number;
  /**
   * The same deadline on the wall clock, and the token is live only while NEITHER
   * deadline has passed.
   *
   * The monotonic reading closes the way a clock lies by being SET; this one closes
   * the way it lies by not MOVING. On Linux `performance.now()` derives from
   * CLOCK_MONOTONIC, which does not advance while the host is suspended — and a
   * stdio server on a laptop frozen for hours between dry-run and submit is
   * ordinary. On the monotonic reading alone that token is milliseconds old on
   * wake, and an hours-stale projection reaches runSanityChecks as fresh.
   *
   * AND is the safe direction because from inside the process the two failures are
   * indistinguishable: a wall clock that jumped forward and real time the monotonic
   * clock skipped look alike. Resolving that as "expired" costs one repeated
   * dry-run; resolving it as "live" gates a real order on an arbitrarily old
   * projection and reports nothing. `cachedAccessToken` in src/oauth-client.ts is
   * the same decision, not a second one.
   */
  expiresAtWall: number;
  argsHash: string;
  /** sha256 of the normalised (method, path) this token authorises. */
  targetHash: string;
}

const tokens = new Map<string, ConfirmationToken>();

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable JSON stringify — sorts object keys recursively so logically equal
 * args produce identical hashes even if the agent reorders fields between
 * dry-run and live submit.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, function replacer(_k, v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Has either clock reached this entry's deadline?
 *
 * Expiry is the OR of the two deadlines because liveness is the AND of the two
 * windows. Both comparisons are strict, so the final millisecond of the TTL is
 * still valid on each scale — pinned from both sides in
 * test/e2e/confirmation.test.ts ("still accepts a token at exactly 60s" and
 * "refuses a token one millisecond past the TTL"), because an off-by-one here
 * kills confirmations an agent obtained legitimately.
 */
function isExpired(
  entry: ConfirmationToken,
  nowMono: number,
  nowWall: number,
): boolean {
  return entry.expiresAtMono < nowMono || entry.expiresAtWall < nowWall;
}

/**
 * Drop every entry whose TTL has passed.
 *
 * Called from both ends of the flow, for two different reasons. `issueToken`
 * sweeps so a dry-run that is never submitted cannot grow the store forever;
 * `consumeToken` sweeps so an expired token is reliably ABSENT by the time it
 * is looked up, which is what makes its refusal code deterministic — see the
 * long note there.
 */
function sweep(nowMono: number, nowWall: number) {
  for (const [k, v] of tokens) {
    if (isExpired(v, nowMono, nowWall)) tokens.delete(k);
  }
}

/**
 * Issue a single-use confirmation token. The dry-run tool calls this *only*
 * when the dry-run itself returned no errors.
 */
export function issueToken(
  action: string,
  dryRunResult: unknown,
  args: unknown,
  authorisation: Authorisation,
): ConfirmationToken {
  assertPreflightAuthorises(authorisation);
  const nowMono = monotonicNow();
  const nowWall = Date.now();
  sweep(nowMono, nowWall);
  const entry: ConfirmationToken = {
    token: randomUUID(),
    action,
    dryRunResult,
    expiresAtMono: nowMono + TTL_MS,
    expiresAtWall: nowWall + TTL_MS,
    argsHash: sha256(canonicalize(args)),
    targetHash: targetHashOf(authorisation.submit),
  };
  tokens.set(entry.token, entry);
  return entry;
}

/** One spelling of the target hash, so mint and consume cannot disagree. */
function targetHashOf(target: AuthorisedTarget): string {
  return sha256(
    canonicalize({ method: target.method.toUpperCase(), path: target.path }),
  );
}

/**
 * Refuse to mint unless the pre-flight that ran is the pre-flight OF the submit
 * being authorised.
 *
 * Raised at MINT and not at submit, deliberately: nothing should hold a token
 * that authorises an endpoint the broker never pre-flighted, and the dry-run is
 * the last moment at which no live write has been contemplated. The refusal is
 * `validation` because the fault is in the arguments — an identifier that
 * renders as path structure rather than as data — and no retry of the identical
 * call can fix it.
 */
function assertPreflightAuthorises(authorisation: Authorisation): void {
  const { dryRun, submit } = authorisation;
  const expected = `${submit.path}${DRY_RUN_SUFFIX}`;
  if (dryRun.method.toUpperCase() === "POST" && dryRun.path === expected)
    return;
  throw toolError({
    code: "validation",
    message:
      "The dry-run this token would be issued for does not pre-flight the request it would " +
      "authorise: the broker was asked about " +
      `${dryRun.method} ${dryRun.path} while the token would approve ` +
      `${submit.method} ${submit.path}. No token was issued and nothing was changed.`,
    retryable: false,
    hint:
      "This happens when an identifier renders as path STRUCTURE rather than as data — `.`, " +
      "`..` and an empty value all do, because the URL layer removes dot segments after " +
      "decoding. Pass the identifier exactly as the broker reported it and dry-run again.",
  });
}

/**
 * The dry-run tool that mints a token for `action`.
 *
 * Only the `place_` prefix is dropped, because every other gated action is
 * named after its own dry-run tool: `place_order` → `tastytrade_dry_run_order`
 * and `place_complex_order` → `tastytrade_dry_run_complex_order`, but
 * `replace_order` → `tastytrade_dry_run_replace_order`, `edit_order` →
 * `tastytrade_dry_run_edit_order`, `edit_complex_order` →
 * `tastytrade_dry_run_edit_complex_order`. Stripping the first word instead
 * (the earlier rule) named `tastytrade_dry_run_order` for all three of the
 * edit and replace actions — a tool that exists, mints a token bound to the
 * wrong action, and sends the agent straight back to this refusal.
 */
function dryRunToolFor(action: string): string {
  return `tastytrade_dry_run_${action.replace(/^place_/, "")}`;
}

/**
 * Consume a token. Throws a ToolError when no usable token backs this call
 * (missing, already spent, expired, or issued for a different action), or when
 * the args no longer match the ones that were dry-run. On success the token is
 * removed (single-use).
 *
 * SINGLE-USE IS ATOMIC by shape: the lookup and the delete sit in one
 * synchronous stretch with no `await` between them, so two overlapping submits
 * of one token cannot both get past. Callers must not defer the burn past their
 * own `await runSanityChecks(...)` — that reopens the window and duplicates a
 * live order. A shared store would make the lookup async and break it.
 */
export function consumeToken(
  token: string,
  action: string,
  args: unknown,
  submit: AuthorisedTarget,
): ConfirmationToken {
  const nowMono = monotonicNow();
  const nowWall = Date.now();

  // Sweep BEFORE the lookup, so an expired token has exactly ONE outcome.
  //
  // Otherwise an expired entry still in the map is refused as
  // `confirmation_expired`, while the same entry, once some unrelated tool's
  // `issueToken` has swept it, is refused as `dry_run_required` — a code that
  // turns on other tools' traffic. `dry_run_required` wins because it is the only
  // one the swept case can produce: once the entry is gone, an expired token is
  // indistinguishable from a fabricated one. The TTL moves into the hint so no
  // diagnostic is lost. `confirmation_expired` keeps the one case where a live
  // token exists but does not cover this request — the args-binding refusal below.
  sweep(nowMono, nowWall);

  const entry = tokens.get(token);
  if (!entry) {
    throw toolError({
      code: "dry_run_required",
      message:
        "No usable confirmation token for this call: it was never issued, has already been used, or has expired. Run the corresponding dry-run tool first.",
      retryable: false,
      hint: `Call ${dryRunToolFor(action)} with the exact args you intend to submit, and pass the confirmation_token it returns. A token is single-use and lives 60 seconds.`,
    });
  }
  if (entry.action !== action) {
    tokens.delete(token);
    // Deliberately NOT `validation`. A wrong-action token is not a malformed
    // argument, and `validation` is what an agent also gets for a bad leg
    // action, a bad quantity and a dozen schema failures — all of which it
    // answers by correcting the args and retrying, which can never work here.
    // No edit to this call's arguments turns a `place_order` approval into a
    // `replace_order` one; the only remedy is a fresh dry-run of the action
    // actually being attempted, which is exactly what `dry_run_required` tells
    // the agent to do. The message still names both actions, so the distinction
    // from "no token at all" survives — it simply does not route the agent
    // somewhere that cannot help.
    throw toolError({
      code: "dry_run_required",
      message: `Confirmation token was issued for "${entry.action}", not "${action}".`,
      retryable: false,
      hint: `Tokens are bound to one action. Call ${dryRunToolFor(action)} and pass the token it returns.`,
    });
  }
  if (entry.argsHash !== sha256(canonicalize(args))) {
    tokens.delete(token);
    throw toolError({
      code: "confirmation_expired",
      message:
        "Order parameters changed since dry-run. Re-run the dry-run with the exact args you intend to submit.",
      retryable: false,
      hint: "The argsHash binding prevents dry-running a small order and submitting a larger one.",
    });
  }
  if (entry.targetHash !== targetHashOf(submit)) {
    tokens.delete(token);
    throw toolError({
      code: "confirmation_expired",
      message:
        `This token authorises a different request than the one being made (${submit.method} ` +
        `${submit.path}). Re-run the dry-run for the request you intend to submit.`,
      retryable: false,
      hint: "The target binding is on the normalised (method, path) the transport will dial, not on the arguments, so a value that renders as a different endpoint is refused even when the arguments match.",
    });
  }
  tokens.delete(token);
  return entry;
}

/** For tests / introspection. Not for production use paths. */
export function _resetTokensForTest(): void {
  tokens.clear();
}

/**
 * Live entry count, for tests only.
 *
 * Expiry answers the same way whether or not the entry is still in the map —
 * which is the point — so eviction needs its own window, or a neutered sweep would
 * grow the store by one abandoned dry-run at a time with nothing to notice.
 */
export function _tokenCountForTest(): number {
  return tokens.size;
}
