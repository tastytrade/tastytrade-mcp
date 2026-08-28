/**
 * tastytrade API Client
 * Handles all HTTP requests to the tastytrade API
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import type { TastytradeConfig, Position } from "./types.js";
import { DEFAULT_USER_AGENT } from "./version.js";
import { InstrumentType, MARKET_DATA_TYPE_PARAMS } from "./enums.js";
import {
  TastytradeOAuthClient,
  HTTP_TIMEOUT_ENV_VAR,
  HTTP_WALL_CLOCK_ENV_VAR,
  MAX_RESPONSE_BYTES_ENV_VAR,
  isTimeoutErrorCode,
  resolveHttpTimeoutMs,
  resolveHttpWallClockMs,
  httpTransportLimits,
  httpWallClockSignal,
  transportBoundRefusal,
} from "./oauth-client.js";
import {
  isToolErrorException,
  registerSecrets,
  toolError,
} from "./safety/errors.js";
import {
  MAX_REQUEST_PATH_CHARS,
  MAX_UPSTREAM_BODY_TEXT_CHARS,
  boundedText,
} from "./safety/bounded-text.js";
import { chargeUpstreamCallDebt } from "./safety/rate-limit.js";

/**
 * Today's date as YYYYMMDD in UTC. Used as the default Accept-Version so
 * the server always targets the latest API revision available on or before
 * the current day. UTC is deliberate: it's deterministic, doesn't shift
 * mid-session due to local-timezone DST changes, and matches how server-side
 * version date comparisons are typically modeled.
 */
function todayYyyymmdd(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** A single watchlist entry: a symbol plus its instrument type (default Equity). */
interface WatchlistEntry {
  symbol: string;
  "instrument-type"?: string;
}

/**
 * The transport axios itself accepts for `adapter` — derived from the
 * installed axios types rather than re-declared, so a future axios upgrade
 * that widens or narrows the shape is a compile error here instead of a
 * silent runtime mismatch.
 */
export type HttpAdapter = NonNullable<AxiosRequestConfig["adapter"]>;

/** Supplies the bearer token for the `Authorization` header. */
export type AccessTokenProvider = () => string | Promise<string>;

/**
 * Optional injection seams, all off by default.
 *
 * Both hooks exist so the client can be exercised end-to-end with no
 * credentials and no network. Omit them and the client behaves exactly as it
 * always has: axios picks its own default transport, and the bearer token
 * comes from the real OAuth client.
 */
export interface TastytradeClientOptions {
  /**
   * Replaces the HTTP transport. It sits BELOW the request interceptor, so an
   * injected adapter observes the fully-decorated outbound request —
   * `Authorization`, `Accept-Version`, `User-Agent`, the resolved URL, and the
   * serialized body — which is exactly what a test needs to assert on.
   */
  adapter?: HttpAdapter;
  /**
   * Replaces the bearer-token source. The OAuth client talks to the token
   * endpoint through the module-level axios instance, which `adapter` cannot
   * reach, so stubbing the token is what keeps a test fully offline.
   */
  tokenProvider?: AccessTokenProvider;
}

// ---------------------------------------------------------------------------
// Surviving a broker that stops answering, or answers with nonsense
//
// Two failure modes handled here rather than at the ~90 call sites below, because
// a rule enforced in one place cannot be forgotten by the next method added:
//
//   1. A request whose fate is never established — it hung, the socket broke, or a
//      gateway answered for an origin it could not reach.
//   2. A 2xx whose body cannot be unwrapped at all. Every method reaches into
//      `.data.data`, so a null body or a proxy's HTML error page either threw a raw
//      TypeError — flattened into an opaque `upstream_error` carrying a JavaScript
//      diagnostic — or, on the methods that stop one level shallower, read as
//      `undefined` and returned as a SUCCESSFUL empty result. The second is the
//      quieter and worse: "your account has no balances", because a load balancer
//      answered.
//
// Both split on one question: could this request have changed something?
// ---------------------------------------------------------------------------

/**
 * A route's own declaration of whether requesting it can change broker state.
 *
 * Authored at the call site, which is the only place that KNOWS: the call site
 * chose the endpoint, so it can say what the endpoint does. Nothing a caller
 * sends can reach this value.
 */
export interface TastytradeRoute {
  readonly mutating: boolean;
}

// The tag rides on the request config, so both consumers of the classification
// — `isUnestablishedWrite` reading `error.config` and `assertReadableResponse`
// reading `response.config` — find it already attached. axios's `mergeConfig`
// routes an unrecognised property through `defaultToConfig2`, so it survives to
// both; that is asserted directly in
// test/api-client/mutation-classification.test.ts rather than assumed, so an
// axios upgrade that started dropping unknown keys fails there instead of
// silently reclassifying every pre-flight as a write.
declare module "axios" {
  interface AxiosRequestConfig {
    tastytradeRoute?: TastytradeRoute;
  }
}

/**
 * The per-request config a call site spreads to declare its route creates nothing,
 * so a failure on it leaves nothing in doubt and repeating it is as safe as
 * repeating a GET.
 *
 * The routes entitled to it rest on the vendored spec: per order-flow.md a
 * `…/dry-run` validates an order and returns its projected effect without creating
 * anything. test/api-client/mutation-classification.test.ts DERIVES that set from
 * the source on both sides, so a route cannot acquire the tag without dialling a
 * pre-flight and a new pre-flight cannot ship without it.
 *
 * NOT a suffix match on `config.url`, which would be an exemption keyed on
 * caller-influenced text: `dry-run` is entirely RFC 3986 unreserved characters, so
 * any route whose last segment is caller-supplied could be RENAMED into the exempt
 * set — `cancel_order{order_id: "dry-run"}` dialled `DELETE
 * /accounts/A/orders/dry-run`, and a 503 on it read as `retryable: true` with no
 * unknown-outcome warning. Reading a tag removes the caller from the decision.
 *
 * The watchlist and quote-alert writes are deliberately NOT tagged: they create an
 * addressable resource, so a resubmission really can leave two.
 */
const NON_MUTATING_ROUTE: { readonly tastytradeRoute: TastytradeRoute } =
  Object.freeze({
    tastytradeRoute: Object.freeze({ mutating: false }),
  });

/**
 * Whether a request could have altered broker state, and so whether a failure with
 * no reply leaves the outcome genuinely unknown.
 *
 * Anything that is not a GET is state-changing unless its call site tagged it
 * NON_MUTATING_ROUTE. UNTAGGED IS MUTATING, so a write method added later that
 * never thought about this is classified cautiously: the failure mode of forgetting
 * the tag is over-warning about a pre-flight, never falsely reassuring about a
 * cancel. When the verb cannot be read at all the answer is `true`.
 *
 * The request path is deliberately not consulted: it is the one input a caller can
 * influence, and the decision is safety-shaped.
 */
export function isMutatingRequest(
  config: { method?: string; tastytradeRoute?: TastytradeRoute } | undefined,
): boolean {
  const verb = config?.method?.toUpperCase();
  if (verb === undefined) return true;
  if (verb === "GET") return false;
  return config?.tastytradeRoute?.mutating !== false;
}

/**
 * What every failed state-changing request has to tell the agent.
 *
 * A hung `place_order` is worse than a plain error precisely because the tempting
 * reading — "it never got there" — is the dangerous one: the order may be live at
 * the exchange, and resubmitting doubles the position. So the envelope names the
 * ambiguity, forbids the resubmission, and points at the one action that resolves
 * it, which is a read rather than another write.
 *
 * Two wordings, because the ambiguity is one thing and the recovery another. The
 * order text names the tools that resolve it, the token that was spent and the
 * fill that may already have happened — all false on a watchlist PUT. Sending an
 * agent to `get_live_orders` after a failed `create_watchlist` costs it a call and
 * teaches it that this envelope does not mean what it says.
 */
const WRITE_OUTCOME_UNKNOWN_PREFIX =
  "The outcome is UNKNOWN: the request may already have been accepted upstream. ";

const WRITE_OUTCOME_UNKNOWN_ORDER =
  WRITE_OUTCOME_UNKNOWN_PREFIX +
  "Do NOT resubmit it — a resubmission could duplicate the order or the cancel. " +
  "Read the live state first (tastytrade_get_live_orders for this account, or " +
  "tastytrade_get_orders for a wider window, plus tastytrade_get_positions if a " +
  "fill is possible) and reconcile against what you find before doing anything else.";

const WRITE_OUTCOME_UNKNOWN_OTHER =
  WRITE_OUTCOME_UNKNOWN_PREFIX +
  "Do NOT resubmit it — a resubmission could apply the same change twice. Read " +
  "the resource this call was changing back first, and reconcile against what " +
  "you find before doing anything else. This endpoint routes no order, so no " +
  "position can have moved.";

/**
 * Why such an envelope carries `retryable: false`.
 *
 * `retryable` is a machine-readable instruction — "this identical call may be
 * repeated" — and for an unacknowledged write that is exactly what must not
 * happen. It is false because repeating is unsafe, NOT because the request can
 * never succeed. The recovery path is a different call, so leaving the flag true
 * would invite an agent to do the one thing that can double a position.
 */
const WRITE_RECONCILE_PREFIX =
  "retryable is false because repeating an unacknowledged state-changing request " +
  "is unsafe, not because it can never succeed. ";

const WRITE_RECONCILE_HINT_ORDER =
  WRITE_RECONCILE_PREFIX +
  "Establish what actually happened first: read the account's live orders, and " +
  "its positions if a fill was possible. If the order is absent from live state " +
  "it was never accepted and may be placed again from scratch — which needs a " +
  "fresh dry-run and a new confirmation token, since the one you used was " +
  "consumed before this request was sent. If it IS present, the request landed; " +
  "do not send it again.";

const WRITE_RECONCILE_HINT_OTHER =
  WRITE_RECONCILE_PREFIX +
  "Establish what actually happened first by reading back the resource this " +
  "call was changing. If the change is absent it was never accepted and may be " +
  "made again; if it is present, the request landed — do not send it again.";

/**
 * Whether an unacknowledged request could have created, replaced or cancelled
 * an ORDER, and so whether the advice above may name live orders and positions.
 *
 * Path-based rather than tool-based because this layer never sees a tool name:
 * every order endpoint in the vendored spec sits under `…/orders` or
 * `…/complex-orders`, and nothing else this client calls does.
 *
 * Unidentifiable paths fail into the order wording, not out of it. Over-warning
 * about an order costs a wasted read; under-warning about one costs a duplicated
 * position, and that asymmetry is the same one isMutatingRequest is built on.
 */
function isOrderEndpoint(config: { url?: string } | undefined): boolean {
  const path = (config?.url ?? "").split("?")[0];
  if (path === "") return true;
  return /\/(complex-)?orders(\/|$)/.test(path);
}

/** The unknown-outcome sentence appropriate to the endpoint that failed. */
function outcomeUnknown(config: { url?: string } | undefined): string {
  return isOrderEndpoint(config)
    ? WRITE_OUTCOME_UNKNOWN_ORDER
    : WRITE_OUTCOME_UNKNOWN_OTHER;
}

/** The reconciliation hint appropriate to the endpoint that failed. */
function reconcileHint(config: { url?: string } | undefined): string {
  return isOrderEndpoint(config)
    ? WRITE_RECONCILE_HINT_ORDER
    : WRITE_RECONCILE_HINT_OTHER;
}

/**
 * The three members this module reads off an axios rejection: what went wrong,
 * what was being asked, and what — if anything — came back. Declared once so the
 * predicate below and the envelope builder that consults it cannot drift.
 */
interface RequestFailure {
  code?: string;
  message?: string;
  config?: {
    method?: string;
    url?: string;
    maxContentLength?: number;
    tastytradeRoute?: TastytradeRoute;
  };
  response?: { status?: number; data?: unknown };
}

/**
 * Codes that PROVE the request never left this machine, so a write that ends this
 * way is not in doubt at all.
 *
 * Each fails at or before connection setup — DNS never resolved, the peer rejected
 * the SYN, or there was no route — so not one byte of the body was written to a
 * socket the broker was reading. The exception has to exist: an unknown-outcome
 * envelope that fires on a plainly unreachable host teaches an agent to discount
 * the one that fires on a real ambiguity.
 *
 * That proof is conditioned on ONE thing not local to this set: a connect-stage
 * code proves nothing was dispatched only if the connection that failed was the
 * FIRST one. Following redirects, an `ECONNREFUSED` can come from a later leg long
 * after the origin received and answered the order POST — identical-looking, and
 * the claim becomes false. `maxRedirects: 0` is what makes the first connection the
 * only connection. Adding a redirect hatch anywhere invalidates every code below.
 *
 * `ECONNRESET` and `EPIPE` are deliberately NOT here: both mean a connection
 * existed and then broke, which is the "request delivered, response lost" case.
 */
const NEVER_DISPATCHED_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/**
 * Whether a state-changing request ended without establishing what it did.
 *
 * A reset socket, a broken pipe and a 504 all leave the identical question open,
 * and a 504 leaves it wider than a timeout: an intermediary is confirming the
 * request reached at least as far as itself before the origin went quiet. Reporting
 * any of them as `retryable: true` tells an agent "this identical call may be
 * repeated", and the identical call is a second order.
 *
 * Two kinds of evidence close the question, and only two: the reply was a 4xx (the
 * origin understood and refused it, so nothing was created — a 429 belongs here),
 * or the transport failed before dispatch (see NEVER_DISPATCHED_ERROR_CODES).
 *
 * Everything else about a write is unestablished, including a code this set has
 * never heard of: being wrong here costs one extra read, being wrong the other way
 * costs a duplicated position. Reads are excluded outright.
 */
export function isUnestablishedWrite(error: unknown): boolean {
  // Already classified by a layer that had more context than this one — the
  // OAuth client's grant failures reach the response interceptor this way, and
  // re-dressing an `auth_failed` as an ambiguous write would be a lie.
  if (isToolErrorException(error)) return false;
  if (error === null || typeof error !== "object") return false;

  const e = error as RequestFailure;
  if (!isMutatingRequest(e.config)) return false;

  if (e.response) {
    const status = e.response.status;
    const refused = typeof status === "number" && status >= 400 && status < 500;
    return !refused;
  }

  // No reply at all. A transport code is what marks this as a dispatched
  // request that failed, as opposed to some unrelated value being rethrown
  // through the interceptor; without one there is nothing to attribute.
  return (
    typeof e.code === "string" && !NEVER_DISPATCHED_ERROR_CODES.has(e.code)
  );
}

/**
 * Convert an axios rejection into a ToolError when this client can say something
 * the shared taxonomy in src/safety/errors.ts cannot. Everything else is returned
 * untouched so that taxonomy keeps classifying it.
 *
 * Two things are knowable here and nowhere else, because only here is the request
 * still in hand: a timeout is `network`, never `upstream_error` (the broker did not
 * return an error, it returned nothing); and whether the failed call could have
 * changed anything, which decides whether `retryable` may be true at all — the
 * taxonomy sees a status code and cannot tell a balances GET from an order POST.
 */
export function adaptRequestFailure(
  error: unknown,
  timeoutMs: number,
): unknown {
  const e = error as RequestFailure;
  const timedOut = isTimeoutErrorCode(e?.code);
  // One of this server's OWN transfer bounds refused the reply. Without this
  // arm both landed on the shared taxonomy's 5xx-ish fallback and were reported
  // as `upstream_error` — blaming the broker for a decision this process made,
  // and giving an operator nothing to grep for.
  const bound = transportBoundRefusal(error);
  const inDoubt = isUnestablishedWrite(error);
  if (!timedOut && !bound && !inDoubt) return error;
  // `e` is necessarily an object past that guard: both predicates require one.

  const verb = e.config?.method?.toUpperCase() ?? "request";
  // BOUNDED AT THE OPERAND, because the operand is the CALLER'S OWN TEXT.
  //
  // Every message below interpolates this path, and `e.config.url` is the URL
  // this client built out of the arguments it was handed — so on a transport
  // failure the caller's `account_number` (or symbol, or order id) is reflected
  // back into agent-facing prose at whatever length the caller chose.
  // Path construction percent-encodes an argument and verifies the target it
  // builds; it does not BOUND the argument's length. Measured
  // before this line existed: a 2,007-character account number arrived verbatim
  // in a sentence that had already clipped the SAME value to 32 characters a few
  // words earlier, because the clip was applied to the account number and this
  // was applied to nothing.
  //
  // Bounding here rather than at the three messages is the point: one operand,
  // three templates, and any fourth added later inherits it.
  const path = boundedText(e.config?.url ?? "an unknown path", {
    maxChars: MAX_REQUEST_PATH_CHARS,
    collapseWhitespace: true,
  });

  if (inDoubt && e.response) {
    // The broker (or something in front of it) answered, but with a status that
    // reports its own failure rather than the request's fate. `upstream_error`
    // stays the honest code — a reply did arrive — while `retryable` must not.
    const status = e.response.status ?? 0;
    return toolError({
      code: "upstream_error",
      message:
        `The tastytrade API answered HTTP ${status} (${verb} ${path}), which reports a failure ` +
        `on its side without saying whether the request was applied. ${outcomeUnknown(e.config)}`,
      retryable: false,
      upstream: { status, body: e.response.data },
      hint: reconcileHint(e.config),
    });
  }

  // No reply at all. The raw axios code stays in the message: it is what an
  // operator greps for, and it distinguishes a response timeout (ECONNABORTED)
  // from a connect timeout (ETIMEDOUT) without adding a field agents would have
  // to learn. The timeout wording is true of both — an ECONNABORTED is our own
  // limit firing, whereas an OS-level connect ETIMEDOUT may well arrive sooner
  // than it — and a non-timeout code gets its own sentence, because "did not
  // answer in time" would be a false account of a socket that was reset.
  const cap = e.config?.maxContentLength;
  const stalled =
    bound === "size"
      ? `The tastytrade API's reply exceeded this server's response size limit of ` +
        `${cap ?? "the configured number of"} bytes (${verb} ${path} — ${e.code}), ` +
        `so it was refused while it was still arriving.`
      : bound === "wall-clock"
        ? `The tastytrade API did not finish answering within this server's ` +
          `wall-clock limit (${verb} ${path} — ${e.code}), so the request was aborted.`
        : timedOut
          ? `The tastytrade API did not answer in time (${verb} ${path} — ${e.code}); this client waits ${timeoutMs}ms.`
          : `The connection to the tastytrade API failed before any reply arrived (${verb} ${path} — ${e.code}).`;

  if (inDoubt) {
    // A bound firing while the RESPONSE was being read says nothing about
    // whether the request was applied, which is why neither code is in
    // NEVER_DISPATCHED_ERROR_CODES and why the unknown-outcome envelope stands.
    return toolError({
      code: "network",
      message: `${stalled} ${outcomeUnknown(e.config)}`,
      retryable: false,
      hint: reconcileHint(e.config),
    });
  }

  // A local bound, or a timeout, on a read: nothing was changed, so the same
  // call is safe again. The hint names the knob that fired — a LOCAL limit
  // reported without naming itself leaves an operator debugging the broker.
  const readHint =
    bound === "size"
      ? `This is a bound this server applied, not an error the broker returned: the reply was refused while it was still arriving, so nothing was parsed and no state was touched. If the endpoint legitimately returns payloads this large, raise ${MAX_RESPONSE_BYTES_ENV_VAR} (bytes); a reply far beyond it usually means something that is not tastytrade answered, so check TASTYTRADE_API_URL and anything terminating TLS in front of it.`
      : bound === "wall-clock"
        ? `This is a bound this server applied, not an error the broker returned: the connection was progressing but never finished, which a socket inactivity timeout cannot catch. No state was touched. Raise ${HTTP_WALL_CLOCK_ENV_VAR} (milliseconds, and it must exceed ${HTTP_TIMEOUT_ENV_VAR}) if the endpoint is merely slow.`
        : `The request was aborted client-side after ${timeoutMs}ms; no state was touched. If reads time out repeatedly, check reachability of the host in TASTYTRADE_API_URL, then raise ${HTTP_TIMEOUT_ENV_VAR} (milliseconds) if the endpoint is merely slow.`;
  return toolError({
    code: "network",
    message: `${stalled} Nothing was changed, so this read can safely be repeated.`,
    retryable: true,
    hint: readHint,
  });
}

/** Named so the DELETE carve-out below can test for this fault specifically. */
const EMPTY_BODY = "an empty body";

/**
 * Describe why a 2xx body cannot be unwrapped, or `undefined` if it can.
 *
 * The bar is deliberately low — this rejects only bodies that no method below
 * could read at all, and passes anything with a `data` member through untouched.
 * `{data: null}` and `{data: {items: null}}` in particular MUST reach the
 * handlers: a legitimately empty result is content, and the safety layer relies
 * on telling "the dry-run returned nothing" apart from "the dry-run failed".
 */
function unreadableBody(body: unknown): string | undefined {
  if (body === null || body === undefined) return EMPTY_BODY;
  if (typeof body === "string") {
    // A 204 lands here too: axios represents "no content" as an empty string.
    return body.length === 0 ? EMPTY_BODY : "a non-JSON text body";
  }
  if (typeof body !== "object") return `a bare JSON ${typeof body}`;
  if (Array.isArray(body)) return "a top-level JSON array";
  // Every documented tastytrade payload is wrapped as `{data: …}`; without that
  // member there is nothing for `.data.data` to reach.
  if (!("data" in body)) return "a JSON object with no `data` member";
  return undefined;
}

/**
 * Refuse a 2xx whose body cannot be unwrapped, instead of letting a `TypeError`
 * escape from `response.data.data.items` and reach the agent as an opaque
 * `upstream_error` with a JavaScript diagnostic for a message.
 *
 * On a state-changing request this fails closed and says the outcome is unknown,
 * which is the honest reading: the broker may well have applied the change and
 * merely failed to describe it.
 */
function assertReadableResponse(response: AxiosResponse): void {
  const fault = unreadableBody(response.data);
  if (fault === undefined) return;

  // A DELETE is the one verb whose success is fully expressed by the status
  // line — RFC 9110 §9.3.5 provides for 204 No Content, and tastytrade uses
  // exactly that for `DELETE /quote-alerts/{id}` (open-api-spec/quote-alerts.md).
  // An empty body there is the documented answer, and it is an ACKNOWLEDGED
  // one, so none of the unknown-outcome reasoning applies. Refusing it would
  // break a working tool against the live API — a failure no offline test could
  // have caught. Every other fault class (an HTML page, a bare array) is still
  // refused on a DELETE just as anywhere else, and so is an empty body on any
  // other verb: no documented tastytrade GET, POST, PUT or PATCH answers with
  // one.
  if (
    fault === EMPTY_BODY &&
    String(response.config.method).toUpperCase() === "DELETE"
  ) {
    return;
  }

  const mutating = isMutatingRequest(response.config);
  const preamble = `The tastytrade API answered HTTP ${response.status} with ${fault}, so its response could not be read.`;
  throw toolError({
    code: "upstream_error",
    message: mutating
      ? `${preamble} ${outcomeUnknown(response.config)}`
      : `${preamble} No state was changed.`,
    retryable: !mutating,
    upstream: {
      status: response.status,
      // A text body is usually an intermediary talking (a proxy interstitial, a
      // WAF block page), and knowing which one is the whole diagnosis. Kept
      // short so a full HTML page cannot flood the agent's context, and
      // sanitizeToolError scrubs it before it leaves.
      //
      // The figure lives in src/safety/bounded-text.ts and BOTH paths spend it — this
      // one and the error path below, which is the likelier one to carry a hostile
      // body — so the two cannot drift apart.
      ...(typeof response.data === "string"
        ? { body: response.data.slice(0, MAX_UPSTREAM_BODY_TEXT_CHARS) }
        : {}),
    },
    hint: mutating
      ? reconcileHint(response.config)
      : "The request itself was fine — the reply was not. This is usually an intermediary (proxy, WAF, load balancer) answering instead of tastytrade, so retrying is reasonable; if it persists, check TASTYTRADE_API_URL and anything terminating TLS in front of it.",
  });
}

// ---------------------------------------------------------------------------
// Reaching through the tastytrade envelope
//
// Every documented payload arrives wrapped as `{data: …}`, and a collection adds a
// second layer: `{data: {items: […]}}`. Ninety-two returns below reach through that
// wrapper, in two dialects, and BOTH are load-bearing — which is why there are four
// named functions instead of one:
//
//   - STRICT returns exactly what the envelope holds, so an explicit `null` comes
//     back as `null`. That distinction is a safety dependency: null is content,
//     undefined is not.
//   - TOLERANT falls back through the shallower layers, because a handful of
//     endpoints answer with the entity at `.data` and no `items` member. Dropping
//     the fallbacks would silently empty those.
//
// TOKEN-MINTING DRY-RUNS ARE STRICT — ALL OF THEM.
//
// The dispatcher mints a confirmation token when `isCleanDryRun(payload)` holds,
// which asks two things: is the payload a readable object, and does it report no
// `errors`. `null` fails the first, which is the entire reason a broker reply of
// `{data: null}` cannot authorise a live write. Read the same body tolerantly and
// `response.data?.data ?? response.data` hands back the truthy `{data: null}` — a
// readable object with no `errors` — so a token is minted against a dry-run that
// said nothing, and the flow proceeds as if the broker had approved it. Those
// tokens are then accepted: one live POST, one live PUT and two live PATCHes, with
// the complex-order submit reporting only that the notional cap "could not be
// applied" while the order went out.
//
//   Every dry-run whose payload can mint a confirmation token unwraps STRICTLY:
//   `dryRunOrder`, `dryRunReplaceOrEdit`, `dryRunComplexOrder` and
//   `dryRunEditComplexOrder`. A new one joins that list, not the tolerant one.
//
// It costs nothing elsewhere: `assertReadableResponse` has already refused any 2xx
// without a `data` member, so the tolerant fallback can only fire on the one shape
// it must not fire on. A file-wide invariant in
// test/api-client/injection-seam.test.ts pins the list.
//
// The strict dialect uses optional chaining because spelt bare,
// `response.data.data.items` throws a TypeError on a `{data: null}` body — a shape
// assertReadableResponse deliberately admits — which adaptError can only flatten
// into an `upstream_error` described by a JavaScript diagnostic.
//
// AND A SUBMIT IS STRICTER STILL. On a method that creates or changes an order, an
// envelope naming no order is a write whose result cannot be read — `{data: null}`,
// and equally `{data: {}}`, `{data: []}` and `{data: "OK"}`. Those five methods go
// through `writtenEntity` below, which requires a NON-EMPTY OBJECT and refuses
// anything else with the unknown-outcome envelope. The cancels and reads are
// deliberately outside that rule; see `writtenEntity`.
// ---------------------------------------------------------------------------

/**
 * A collection payload, strictly: `{data: {items: […]}}` → the array.
 *
 * `{data: {items: null}}` → `null`, because an explicit null is content.
 * `{data: null}` → `undefined`: there is no collection to speak of, and the
 * optional chain is what keeps that from being a thrown TypeError.
 *
 * `any`, because the tastytrade HTTP boundary is untyped by design — see the
 * `no-explicit-any` note in eslint.config.mjs.
 */
function envelopeItems(response: AxiosResponse): any {
  return response.data?.data?.items;
}

/**
 * A single-entity payload, strictly: `{data: {…}}` → the entity.
 *
 * `{data: null}` → `null`. The optional chain matters only when the body itself
 * is absent, which assertReadableResponse permits solely for a 204 on a DELETE.
 */
function envelopeData(response: AxiosResponse): any {
  return response.data?.data;
}

/**
 * A collection payload, tolerantly: the array if it is there, else the entity at
 * `.data`, else the body as it arrived.
 *
 * For the endpoints that answer without the `items` layer. The cost of the
 * fallbacks is that an explicit `{data: null}` comes back as the whole body
 * rather than as `null` — acceptable here, and exactly why the strict dialect
 * exists alongside it.
 */
function envelopeItemsOrBody(response: AxiosResponse): any {
  return response.data?.data?.items ?? response.data?.data ?? response.data;
}

/**
 * A single-entity payload, tolerantly: the entity at `.data`, else the body as
 * it arrived. Same trade-off as `envelopeItemsOrBody`, one layer shallower.
 */
function envelopeDataOrBody(response: AxiosResponse): any {
  return response.data?.data ?? response.data;
}

/**
 * The entity a state-changing 2xx is REQUIRED to carry, or a refusal.
 *
 * `assertReadableResponse` has already turned away any 2xx with no `data` member,
 * so what reaches here is an envelope that is PRESENT. The next question is not the
 * same one: does it hold an order to act on? A status line that says "done" over a
 * body naming nothing is, on a write, a missing order id.
 *
 * THE TEST IS "CARRIES SOMETHING", NOT "IS NOT NULL". A null-only check leaves the
 * hole one shape over:
 *
 *   - `{data: {}}` — present and empty. It passes the null test, the dispatcher
 *     spreads it, and `place_complex_order` answers `isError: false` with
 *     `{"sanity_warnings": []}` and nothing else. That tool's outputSchema requires
 *     only `sanity_warnings`, so even a client with its validator armed ACCEPTS it:
 *     a live multi-leg strategy reported as placed, with no id to cancel it by.
 *   - `{data: []}`, `{data: "OK"}`, `{data: 0}` — not an object at all. The
 *     dispatcher spreads whatever it is given, so these become `{}` and
 *     `{"0": "O", "1": "K"}`: silently mangled on the way past.
 *
 * So the predicate is a plain non-empty object. `Object.keys` and not `for…in`,
 * because an inherited key is not a field the broker sent; and an array is refused
 * explicitly, since a NON-empty one would pass the key count and spread into
 * `{"0": …}`.
 *
 * What all of these share with `{data: null}` is the part that matters: the agent
 * is told the write succeeded and given no way to act on it, and the natural
 * recovery — call the tool again — is the resubmission that duplicates a position,
 * because the token was consumed before the request went out. That is what the
 * unknown-outcome envelope exists for: do not resubmit, read the live orders,
 * reconcile.
 *
 * A non-empty object is returned UNINSPECTED. This does not require an `id` or any
 * named field, and must not: the five methods return four different entity shapes,
 * tastytrade adds fields over time, and a required-field list is the same mistake
 * as a `required` keyword in an output schema — a rejection rule applied to a
 * payload we do not author, on a call whose money has already moved.
 *
 * The route with least evidence is `editComplexOrder`: orders.md documents the
 * PAIRS PATCH with no response body and the live sweep skips it, so nothing
 * establishes what it answers with. Refusing an empty entity there is still right,
 * and not on a guess: that tool's outputSchema already requires `id`,
 * `account-number`, `type` and `orders`, so `{data:{}}` is rejected by any
 * validating client TODAY — as a bare `-32602` with no code and no reconcile hint.
 *
 * NOT applied to the cancels: an empty acknowledgement is ambiguous about nothing
 * (RFC 9110 §9.3.5), so those keep the plain unwrap. NOT to the reads, where
 * `{data: null}` is a legitimate "no data" the safety layer depends on telling
 * apart from a failure. NOT to the dry-runs, where `isCleanDryRun` refuses an
 * unreadable projection before any token is minted.
 */
function writtenEntity(response: AxiosResponse, what: string): any {
  const entity = response.data?.data;
  if (
    typeof entity === "object" &&
    entity !== null &&
    !Array.isArray(entity) &&
    Object.keys(entity).length > 0
  ) {
    return entity;
  }
  throw toolError({
    code: "upstream_error",
    message:
      `The tastytrade API answered HTTP ${response.status} to ${what}, but the ` +
      `body carried no order: there is no id and no status to act on. ` +
      // Routed through the same selector as the transport-failure path rather
      // than hardcoding the order wording. Every current call site is an order
      // route, so the two agree today; asking the selector means they still
      // agree when a non-order write starts using this guard, which is exactly
      // the drift that split these constants in the first place.
      outcomeUnknown(response.config),
    retryable: false,
    upstream: { status: response.status },
    hint: reconcileHint(response.config),
  });
}

// ---------------------------------------------------------------------------
// PATH CONSTRUCTION — the only way this module builds a path carrying caller
// data, and it verifies the target it built.
//
// `encodeURIComponent` is a COMPONENT escaper: it makes a value safe to sit INSIDE
// a component by escaping `/`, `?`, `#` and `%`. It cannot make a value safe to BE
// a path segment, because `.` and `..` are RFC 3986 unreserved characters and pass
// through byte-identical. Hand the result to axios and the WHATWG parser applies
// remove_dot_segments, so the value stops being data and becomes structure, on the
// wire, under the operator's live bearer:
//
//   get_account{account_number:".."}  names /customers/me/accounts/..
//                                     dials GET /customers/me/  — the Customer
//     record (tax number, birth date, address), which no tool exposes.
//   delete_watchlist{name:".."}       dials DELETE /            (root)
//   delete_watchlist{name:"."}        dials DELETE /watchlists/  (all)
//   update_watchlist{name:".."}       dials PUT /  with a caller-authored body
//
// Every one reported to the agent as an ordinary success.
//
// WHAT DOES NOT WORK, ruled out by measurement:
//
//   - ENCODING HARDER. WHATWG's dot-segment test is defined over the
//     PERCENT-DECODED form, so `%2e`, `.%2e` and `%2e%2e` are all recognised. No
//     encoding of `..` is not `..` to the parser.
//   - REJECTING `.` AND `..`. That enumerates today's payloads; the class is "a
//     caller value becomes a path SEGMENT and the URL layer may reinterpret it".
//   - A CHARSET ALLOWLIST. It breaks real symbology: futures start with a slash
//     (`/ESZ4`), equity symbols contain one (`BRK/B`), OCC options carry padding
//     spaces, and watchlist names are free text.
//
// WHAT DOES WORK is asking the transport's own parser what target the built string
// NAMES and refusing when it is not the intended one — a structural equivalence
// check against INTENT rather than a filter over values, so any value whose
// rendering changes segment COUNT, ORDER or IDENTITY is refused by construction.
// Same shape src/credential-target.ts uses for the credential destination.
//
// THE VERIFYING ORIGIN IS SYNTHETIC, DELIBERATELY. A base URL's path prefix cannot
// add or remove a dot segment inside the caller segments, so the mismatch shows
// either way. Keeping it synthetic keeps `apiPath` a pure module function every
// method can call without threading instance state, which is what makes "the only
// way to build a path" enforceable. Where the REAL base matters is `normaliseTarget`.
// ---------------------------------------------------------------------------

/**
 * One part of a path: a server-authored literal, or a caller-supplied segment.
 *
 * The distinction is the whole point of the type. A literal is template text
 * this module wrote and may span several segments (`"orders/live"`); a `seg(...)`
 * entry is data, is exactly one segment, and is what gets verified.
 */
type PathPart = string | { readonly name: string; readonly value: unknown };

/**
 * Mark a caller-supplied value as ONE path segment.
 *
 * `name` is this client's own path parameter, written in the snake_case the tool
 * schemas use. It is occasionally more specific than the tool argument it came
 * from (`watchlist_name`, where `tastytrade_get_watchlist` calls it `name`),
 * which is the right direction to err: the client cannot know which of the tools
 * sharing a method made the call, and the narrower name still points at the
 * value.
 */
function seg(name: string, value: unknown): PathPart {
  return { name, value };
}

/** The origin `apiPath` re-parses against. Never dialled; see the note above. */
const VERIFY_ORIGIN = "https://path-verify.invalid";

/** The refusal every fault on this path shares. */
function pathRefusal(name: string, reason: string): never {
  throw toolError({
    code: "validation",
    message:
      `The value supplied for \`${name}\` cannot be written into a request path: ` +
      `${reason}. No request was sent to tastytrade, so nothing was read or changed.`,
    retryable: false,
    hint:
      `This is a fault in the argument, not in the broker — repeating the identical call ` +
      `will fail the same way. Pass \`${name}\` as the broker reported it, as a plain ` +
      `string naming one thing, and call again.`,
  });
}

/**
 * Percent-encode one caller segment, or refuse it.
 *
 * `encodeURIComponent` is not total. It throws a `TypeError` on a value with no
 * primitive conversion — `{"toString": 1, "valueOf": 2}` parsed out of agent
 * JSON is enough, and it reaches this client unchanged, because a JSON Schema
 * `type: "string"` is advisory and the dispatcher forwards `args.account_number`
 * as it arrived — and a `URIError` on an unpaired UTF-16 surrogate. Left to
 * escape the client raw, `adaptError()` sees only an `Error` and classifies it
 * `upstream_error`: the broker is broken, described by a JavaScript internal
 * message. Nothing had been sent, the broker had said nothing, the argument was
 * wrong and no retry could help. Both refusals are kept verbatim, including the
 * two distinct reasons.
 */
function encodeSegment(name: string, value: unknown): string {
  try {
    return encodeURIComponent(value as string);
  } catch (e) {
    // Two distinct faults, and which one it is tells the caller what to change.
    pathRefusal(
      name,
      e instanceof URIError
        ? "it contains an unpaired UTF-16 surrogate, which has no percent-encoding"
        : "it cannot be converted to text",
    );
  }
}

/** Percent-decode a parsed segment, tolerating a form the parser kept as-is. */
function decodeSegmentSafely(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What one part of the path was MEANT to be, for the comparison after parsing. */
interface IntendedSegment {
  /** Server-authored template text, compared verbatim. */
  literal: boolean;
  /** For a caller segment: the parameter name, for the refusal. */
  name?: string;
  /** The value as intended, percent-decoded. */
  decoded: string;
}

/**
 * Build a request path from server-authored literals and caller segments, and
 * verify that the path built NAMES what it was meant to name.
 *
 * Rendering and verification are one operation on purpose: there is no way to get a
 * rendered segment out of this module without the check having run, which makes the
 * guarantee structural rather than remembered. A helper that returns a spliceable
 * segment is the shape this defect needs.
 *
 * Raised BEFORE the request is built, so a half-rendered path is never dispatched.
 *
 * What it still does NOT judge is a value that renders successfully AND names
 * exactly one segment: `undefined` becomes the literal `"undefined"`, because
 * requiredness and shape belong to the tool schema. The change is that "renders
 * successfully" is not the only test.
 */
function apiPath(parts: readonly PathPart[]): string {
  const rendered: string[] = [];
  const intended: IntendedSegment[] = [];
  /** The first caller segment, so a structural refusal can name a parameter. */
  let firstCallerName: string | undefined;

  for (const part of parts) {
    if (typeof part === "string") {
      // A literal may carry several segments; empty pieces come from the
      // leading slash this module writes and from nothing else.
      for (const piece of part.split("/")) {
        if (piece === "") continue;
        rendered.push(piece);
        intended.push({ literal: true, decoded: piece });
      }
      continue;
    }
    const encoded = encodeSegment(part.name, part.value);
    if (encoded === "") {
      // An empty segment is structure, not data: it collapses into the
      // separator beside it and addresses the collection instead of a member.
      pathRefusal(
        part.name,
        "it is empty, and an empty path segment addresses the collection rather " +
          "than one member of it",
      );
    }
    firstCallerName ??= part.name;
    rendered.push(encoded);
    intended.push({
      literal: false,
      name: part.name,
      decoded: String(part.value),
    });
  }

  const path = `/${rendered.join("/")}`;

  // THE CHECK. Ask the parser the transport will use what this string names.
  let parsed: URL;
  try {
    parsed = new URL(`${VERIFY_ORIGIN}${path}`);
  } catch {
    pathRefusal(
      firstCallerName ?? "path",
      "the request path it produces cannot be parsed as a URL path",
    );
  }
  const offender = firstCallerName ?? "path";
  if (parsed.origin !== VERIFY_ORIGIN) {
    pathRefusal(offender, "it moves the request to a different host");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    pathRefusal(
      offender,
      "it adds a query string or a fragment to the request path",
    );
  }
  const got = parsed.pathname.split("/").slice(1);
  if (got.length !== intended.length) {
    pathRefusal(
      offender,
      `it changes the shape of the request path: the path names ` +
        `${intended.length} segment(s) and the one that would be dialled has ` +
        `${got.length}. A value that is read as a path operator — \`.\`, \`..\` ` +
        `or an empty segment — is structure rather than data`,
    );
  }
  for (let i = 0; i < got.length; i++) {
    const want = intended[i];
    const actual = want.literal ? got[i] : decodeSegmentSafely(got[i]);
    if (actual === want.decoded) continue;
    pathRefusal(
      want.name ?? offender,
      `the request path that would be dialled does not name it: segment ` +
        `${i + 1} was meant to be ${JSON.stringify(want.decoded)} and resolves ` +
        `to ${JSON.stringify(actual)}. A value that is read as a path operator ` +
        `is structure rather than data`,
    );
  }
  return path;
}

// ---------------------------------------------------------------------------
// QUERY SERIALISATION — safe by DEFAULT, so the site count stops being the thing
// that has to be right.
//
// `client.get(url, { params })` with no `paramsSerializer` inherits AXIOS'S
// default, a nested-structure encoder: an array becomes `k[]=…` repeated and an
// OBJECT becomes `k[inner]=…` with the inner text supplied by the caller. Measured
// against a real loopback origin:
//
//   getSpanRows({date, exchange: ["CME","CFE"]})
//     -> ?date=…&exchange%5B%5D=CME&exchange%5B%5D=CFE, and the DECLARED
//        `exchange` parameter is not sent at all.
//   getTotalFees(acct, {date: {"per-page":"50000", injected:"1"}})
//     -> ?date%5Bper-page%5D=50000&date%5Binjected%5D=1, the caller authoring both
//        the key NAMES and the bracket text.
//
// The sink is an OMISSION, and an omission is invisible at review time — which is
// why thirteen sibling methods hand-wrote the fix and eleven did not. So safety is
// the DEFAULT and the exception is what you have to write, on the same object
// literal `timeout` and `maxRedirects: 0` sit on. The hand-written copies are
// DELETED rather than left: a per-request serializer OVERRIDES the instance
// default, so every survivor is a place the guarantee does not reach.
//
// REFUSING A NON-SCALAR rather than `String(v)`-ing it is what makes this a class
// fix: `String({...})` yields `[object Object]` — safe on the wire, and a request
// the agent did not ask for reported as a success.
// ---------------------------------------------------------------------------

/** Per-endpoint wire-shape variation. Server-authored; never caller-supplied. */
export interface ParamStyle {
  /**
   * Rename a key on the wire. Exists for exactly one endpoint —
   * GET /instruments/equities requires the literal `symbol[]` — and it is a
   * SERVER-authored function, so a caller can never influence a key name.
   */
  keyFor?: (key: string) => string;
}

/** Can this value be written as a query value at all? */
function isQueryScalar(value: unknown): boolean {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint";
}

/**
 * Serialise a query object: scalars and lists of scalars, nothing else.
 *
 * It can never manufacture a key: the key set is exactly `Object.keys(params)` and
 * the only transform allowed is the explicit server-authored `keyFor`.
 *
 * ONE DELIBERATE DEVIATION from `URLSearchParams.toString()`: a comma is written
 * raw. `,` is an RFC 3986 sub-delim, legal unescaped in a query, and axios's own
 * encoder leaves it raw — so `symbols=AAPL,MSFT` is sent before and after this
 * change. Escaping it would be the same value to any conformant server and a
 * changed request to a live trading API for no reason.
 */
export function serializeParams(
  params: Record<string, unknown>,
  style?: ParamStyle,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const wireKey = style?.keyFor ? style.keyFor(key) : key;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!isQueryScalar(item)) refuseQueryValue(key, "one of its elements");
        search.append(wireKey, String(item));
      }
      continue;
    }
    if (!isQueryScalar(value)) refuseQueryValue(key, "its value");
    search.append(wireKey, String(value));
  }
  return search.toString().replace(/%2C/gi, ",");
}

/** The refusal a non-scalar query value gets, before any request is built. */
function refuseQueryValue(name: string, which: string): never {
  throw toolError({
    code: "validation",
    message:
      `The value supplied for \`${name}\` cannot be written into a request query: ` +
      `${which} is an object, a nested list or a function rather than a value. ` +
      `A query parameter is a scalar or a list of scalars. No request was sent to ` +
      `tastytrade, so nothing was read or changed.`,
    retryable: false,
    hint:
      `This is a fault in the argument, not in the broker — repeating the identical call ` +
      `will fail the same way. Pass \`${name}\` as the value this tool's inputSchema ` +
      `declares: a string, a number, a boolean, or a list of those.`,
  });
}

// ---------------------------------------------------------------------------
// THE GATED ORDER ROUTES, RENDERED IN EXACTLY ONE PLACE.
//
// A confirmation token's guarantee is "the broker pre-flighted THIS request", and a
// request is a (method, URI, body) triple. Binding only the body half lets a value
// that normalises differently on the two legs pass the hash while dialling two
// endpoints: `order_id` of `.` renders `/accounts/A/orders/./dry-run`, collapsing to
// the PLACE-order pre-flight, and then `/accounts/A/orders/.`, collapsing to the
// collection. The broker would pre-flight one endpoint and the token authorise
// another.
//
// Closing that needs the two legs' targets to be COMPARABLE, which needs them
// rendered from one source. Each gated action declares its submit and pre-flight
// route here, the client's methods render from it, and `authorisationTargets` hands
// the same renderings to the confirmation gate.
// ---------------------------------------------------------------------------

/** A rendered request target: the verb, and the path the transport will dial. */
export interface RequestTarget {
  method: string;
  path: string;
}

/** The five actions a confirmation token can authorise. */
export type GatedAction =
  | "place_order"
  | "replace_order"
  | "edit_order"
  | "place_complex_order"
  | "edit_complex_order";

/** Everything a gated action's routes interpolate. */
export interface OrderRouteArgs {
  accountNumber: string;
  orderId?: string;
  complexOrderId?: string;
}

// The routes are declared as PART LISTS rather than as strings, so a pre-flight
// route is its submit route's parts plus one literal and every one of them still
// goes through `apiPath` — composing verified strings by concatenation would put
// the spliceable-segment shape back in the one place it matters most.
const ordersParts = (a: OrderRouteArgs): PathPart[] => [
  "/accounts",
  seg("account_number", a.accountNumber),
  "orders",
];
const orderByIdParts = (a: OrderRouteArgs): PathPart[] => [
  ...ordersParts(a),
  seg("order_id", a.orderId),
];
const complexParts = (a: OrderRouteArgs): PathPart[] => [
  "/accounts",
  seg("account_number", a.accountNumber),
  "complex-orders",
];
const complexByIdParts = (a: OrderRouteArgs): PathPart[] => [
  ...complexParts(a),
  seg("complex_order_id", a.complexOrderId),
];
/** The literal segment every tastytrade pre-flight endpoint adds. */
const DRY_RUN = "dry-run";

/**
 * Each gated action's SUBMIT target and the PRE-FLIGHT target that authorises
 * it. `replace_order` and `edit_order` share one pre-flight endpoint, which is
 * the API's own arrangement (orders.md: "Same structure as Edit Order") and the
 * reason `dryRunReplaceOrEdit` is one method.
 *
 * That every gated action appears here, and that nothing else does, is asserted
 * in test/e2e/confirmation.test.ts against the dispatcher's own list of gated
 * tools — so a sixth gated tool cannot be added without a counterpart.
 */
export const GATED_ROUTES: Record<
  GatedAction,
  {
    submit: (a: OrderRouteArgs) => RequestTarget;
    dryRun: (a: OrderRouteArgs) => RequestTarget;
  }
> = {
  place_order: {
    submit: (a) => ({ method: "POST", path: apiPath(ordersParts(a)) }),
    dryRun: (a) => ({
      method: "POST",
      path: apiPath([...ordersParts(a), DRY_RUN]),
    }),
  },
  replace_order: {
    submit: (a) => ({ method: "PUT", path: apiPath(orderByIdParts(a)) }),
    dryRun: (a) => ({
      method: "POST",
      path: apiPath([...orderByIdParts(a), DRY_RUN]),
    }),
  },
  edit_order: {
    submit: (a) => ({ method: "PATCH", path: apiPath(orderByIdParts(a)) }),
    dryRun: (a) => ({
      method: "POST",
      path: apiPath([...orderByIdParts(a), DRY_RUN]),
    }),
  },
  place_complex_order: {
    submit: (a) => ({ method: "POST", path: apiPath(complexParts(a)) }),
    dryRun: (a) => ({
      method: "POST",
      path: apiPath([...complexParts(a), DRY_RUN]),
    }),
  },
  edit_complex_order: {
    submit: (a) => ({ method: "PATCH", path: apiPath(complexByIdParts(a)) }),
    dryRun: (a) => ({
      method: "POST",
      path: apiPath([...complexByIdParts(a), DRY_RUN]),
    }),
  },
};

export class TastytradeClient {
  private client: AxiosInstance;
  private config: TastytradeConfig;
  private oauthClient?: TastytradeOAuthClient;
  private tokenProvider?: AccessTokenProvider;

  constructor(config: TastytradeConfig, options: TastytradeClientOptions = {}) {
    this.config = config;
    // Tell the redactor which literals are credentials before any request can
    // fail. `configuredSecrets()` reads the environment, which is complete for
    // the shipped stdio server (index.ts passes process.env straight through)
    // and empty for an embedder that supplies them here instead — in which case
    // an upstream error echoing the client secret was relayed verbatim into
    // `message`, `hint` and `upstream.body`. Registering at construction closes
    // that without changing the environment path.
    registerSecrets(
      config.clientSecret,
      config.refreshToken,
      config.sessionToken,
    );
    this.tokenProvider = options.tokenProvider;
    // Per api-overview.md, every request MUST carry a User-Agent in
    // <product>/<version> form or it will be rejected. Env-overridable.
    const userAgent = process.env.TASTYTRADE_USER_AGENT ?? DEFAULT_USER_AGENT;
    // Resolved once, here, and shared with the OAuth client below so a
    // misconfigured value warns once per process rather than once per grant.
    const timeoutMs = resolveHttpTimeoutMs();
    // Resolved once, here, for the same reason `timeoutMs` is: a misconfigured
    // value warns once per process rather than once per request.
    const wallClockMs = resolveHttpWallClockMs();
    this.client = axios.create({
      baseURL: config.apiUrl,
      // TRANSFER-SIZE BOUND, spread from the module that owns this server's transport
      // safety values. axios defaults both keys to -1 (unlimited), and its Node adapter
      // buffers, concatenates, decodes and JSON-parses the WHOLE body before any response
      // interceptor runs — so `assertReadableResponse` and the upstream-body clip both run
      // too late by construction. `maxContentLength` is checked against streamed bytes,
      // the only point where "too big" is still sayable. Without it a 400 MB reply takes
      // the process out with SIGABRT and `Reached heap limit`: not an exception, so no
      // catch runs and every confirmation token and rate bucket in memory dies with it.
      ...httpTransportLimits(),
      // Axios ships with NO timeout, which on a money-moving path is the worst available
      // default: a broker that accepts the connection and never answers hangs the tool
      // call, the MCP request and the agent forever, with nothing reporting it.
      //
      // Enforced inside axios's transport (`req.setTimeout`), which an injected `adapter`
      // replaces — a test adapter owns its own timing, and classifying the resulting
      // error is this module's job either way. And `req.setTimeout` is a socket
      // INACTIVITY timeout, so an upstream dribbling a byte every few seconds is not
      // bounded by it; that remaining hole is covered by the wall-clock ceiling.
      timeout: timeoutMs,
      // SAFE QUERY SERIALISATION, ON THE INSTANCE. Without this, every
      // `client.get(url, { params })` that writes no serializer of its own
      // inherits axios's nested-structure encoder — see the note above
      // `serializeParams` for what that put on the wire. On the instance for
      // the same reason `timeout` and `maxRedirects` are: the exception is
      // what a method has to write, not the safety.
      paramsSerializer: (p) => serializeParams(p),
      // Axios follows up to 21 redirects by default, and on a money-moving path that is
      // a hole in the one proof this module makes. A broker API has no legitimate reason
      // to redirect this client: every path is a documented tastytrade endpoint addressed
      // absolutely, so a 3xx means something that is not tastytrade answered.
      //
      // Two failures observed against local origins, both silent:
      //   - The origin answered `POST /accounts/{n}/orders` with 302; axios re-issued to
      //     the second host, which replied 200, and `placeOrder` RESOLVED with the second
      //     host's body — no warning, an order id that was not the broker's.
      //   - The origin answered 302 toward an unreachable port. It HAD received, parsed
      //     and answered the order POST, but the failure came from the redirect leg's
      //     connect stage — an `ECONNREFUSED` in NEVER_DISPATCHED_ERROR_CODES — so the
      //     write was reported `retryable: true` with no unknown-outcome envelope. That
      //     set's proof holds only for the FIRST connection, which this setting
      //     guarantees is the only one.
      //
      // With no redirect leg a 3xx is simply a non-2xx reply, so a redirected write gets
      // `retryable: false`, the unknown-outcome message and the reconcile hint.
      //
      // Enforced by the transport, so an injected `adapter` does not see it applied —
      // same as `timeout`: the value travels on every request config either way.
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": userAgent,
      },
      // Spread, not `adapter: options.adapter` — with no override the key is
      // absent entirely and axios resolves its own default transport, so the
      // production request path is untouched.
      ...(options.adapter ? { adapter: options.adapter } : {}),
    });

    // Initialize OAuth client if credentials provided
    if (config.clientId && config.clientSecret) {
      this.oauthClient = new TastytradeOAuthClient(config, { timeoutMs });
    }

    // Per-request interceptor: auth token + Accept-Version.
    //
    // Accept-Version is computed at request time (not at construction time)
    // so a long-running server crossing midnight automatically picks up the
    // new day. Per tastytrade engineering guidance this should track the
    // current date — the API selects the closest released version ≤ that
    // date, so "today" always lands on the latest available revision.
    // Override with TASTYTRADE_ACCEPT_VERSION (YYYYMMDD) if you need to pin
    // a specific revision.
    this.client.interceptors.request.use(async (config) => {
      // Injected bearer-token source (tests); absent in production.
      if (this.tokenProvider) {
        const token = await this.tokenProvider();
        config.headers.Authorization = `Bearer ${token}`;
      }
      // OAuth authentication
      else if (this.oauthClient && this.config.refreshToken) {
        const token = await this.oauthClient.getAccessToken();
        config.headers.Authorization = `Bearer ${token}`;
      }
      // Legacy session token authentication (deprecated)
      else if (this.config.sessionToken) {
        config.headers.Authorization = this.config.sessionToken;
      }

      config.headers["Accept-Version"] =
        process.env.TASTYTRADE_ACCEPT_VERSION ?? todayYyyymmdd();

      // WALL-CLOCK BOUND, per request, because a signal is single-use: one on
      // the instance would abort every request after the first `wallClockMs` of
      // process life. This closes the hole the `timeout` note above names and
      // declined to guess at — `req.setTimeout` is a socket INACTIVITY timeout,
      // so an upstream dribbling a byte every few seconds forever is not
      // bounded by it. A byte cap alone leaves that unbounded in TIME; a wall
      // clock alone leaves a fast oversized body unbounded in SPACE.
      config.signal = httpWallClockSignal(wallClockMs);

      return config;
    });

    // One response interceptor, so the two "misbehaving upstream" rules apply to
    // every method below without any of them opting in — see the block comment
    // above this class.
    this.client.interceptors.response.use(
      (response) => {
        assertReadableResponse(response);
        return response;
      },
      (error) => {
        // A 401 or 403 is the provider's own statement that the bearer this request
        // carried is no longer good (oauth2.md). Without an invalidation entry point on the
        // OAuth cache nothing can act on it: a token that dies upstream is re-presented on
        // every subsequent call until the process restarts.
        //
        // Scoped to the bearer THIS request sent, read back off its own config, so a 401
        // arriving after a concurrent refresh cannot discard the new token. Invalidate only
        // — the next tool call re-grants, which is one grant per call rather than a loop
        // against the token endpoint — and the error still travels, so the agent sees
        // `auth_failed` rather than a silent re-grant.
        const status = (error as RequestFailure)?.response?.status;
        if (status === 401 || status === 403) {
          const sent = (
            error as { config?: { headers?: Record<string, unknown> } }
          )?.config?.headers?.["Authorization"];
          if (typeof sent === "string" && sent.startsWith("Bearer ")) {
            this.oauthClient?.invalidate(sent.slice("Bearer ".length));
          }
        }
        throw adaptRequestFailure(error, timeoutMs);
      },
    );
  }

  // Authentication is environment-driven only: the refresh token arrives in
  // the constructor config (from TASTYTRADE_REFRESH_TOKEN) and the request
  // interceptor above mints access tokens from it. There is no interactive
  // authorization-code flow and no runtime credential setter — see
  // src/oauth-client.ts for why.

  // PATH-BUILDING INVARIANT: `apiPath` is the ONLY way this module builds a request
  // path carrying caller data, and it VERIFIES THE TARGET IT BUILT. No method
  // interpolates a path itself, no helper returns a spliceable segment, and there is
  // exactly one `encodeURIComponent` in the file. A source-scanning test asserts all
  // three from a list it derives at test time.
  //
  // Encoding alone was never enough, and the values are why: equity symbols may
  // contain `/` (BRK/B), futures symbols START with one (/ESU9), OCC option symbols
  // carry padding spaces, and watchlist names are free text. And encoding is not
  // enough EVEN WHEN IT SUCCEEDS: `.` and `..` are RFC 3986 unreserved, so they pass
  // through byte-identical and the URL layer reads them as operators.
  //
  // Query params are axios's job and must NOT be pre-encoded here, or they arrive
  // double-escaped.

  /**
   * The two targets that make up one gated action's authorisation: the pre-flight
   * this client would dial and the submit it authorises — both NORMALISED, i.e. the
   * pathname the transport will actually request.
   *
   * The normalisation is load-bearing. `encodeURIComponent` leaves `.` and `..`
   * byte-identical, and WHATWG dot-segment removal is defined over the DECODED form,
   * so the string handed to axios is not the path the socket sees. Asking the
   * transport's own parser what a built string names is what makes the two legs
   * comparable at all.
   *
   * Composed exactly the way axios composes it, so the answer is right even when
   * TASTYTRADE_API_URL carries a path prefix.
   */
  authorisationTargets(
    action: GatedAction,
    routeArgs: OrderRouteArgs,
  ): { dryRun: RequestTarget; submit: RequestTarget } {
    const pair = GATED_ROUTES[action];
    return {
      dryRun: this.normaliseTarget(pair.dryRun(routeArgs)),
      submit: this.normaliseTarget(pair.submit(routeArgs)),
    };
  }

  /** One target, resolved to the pathname the transport will dial. */
  private normaliseTarget(target: RequestTarget): RequestTarget {
    const base = (this.config.apiUrl ?? "").replace(/\/+$/, "");
    const combined = `${base}/${target.path.replace(/^\/+/, "")}`;
    let pathname: string;
    try {
      pathname = new URL(combined).pathname;
    } catch {
      // An unparseable base is a configuration fault, and the honest answer is
      // to refuse rather than to authorise a target nobody can name. The
      // credential-target check (src/credential-target.ts) already refuses such
      // a value at startup, so this is defence in depth rather than a live path.
      throw toolError({
        code: "validation",
        message:
          "TASTYTRADE_API_URL is not a URL this server can resolve a request path against, " +
          "so the endpoint a confirmation token would authorise cannot be determined. " +
          "No request was sent.",
        retryable: false,
        hint: "Set TASTYTRADE_API_URL to an absolute https URL — `https://api.tastyworks.com` (production) or `https://api.cert.tastyworks.com` (sandbox).",
      });
    }
    return { method: target.method, path: pathname };
  }

  // ============================================================================
  // Account Information
  // ============================================================================

  async getAccounts() {
    const response = await this.client.get("/customers/me/accounts");
    return envelopeItems(response);
  }

  async getAccount(accountNumber: string) {
    const response = await this.client.get(
      apiPath([
        "/customers/me/accounts/",
        seg("account_number", accountNumber),
      ]),
    );
    return envelopeData(response);
  }

  async getBalances(accountNumber: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/balances",
      ]),
    );
    return envelopeData(response);
  }

  async getBalanceByCurrency(accountNumber: string, currency = "USD") {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/balances/",
        seg("currency", currency),
      ]),
    );
    return envelopeDataOrBody(response);
  }

  /**
   * Balance snapshots with the full documented filter set: snapshot-date,
   * start-date, end-date (range), time-of-day (BOD/EOD), currency,
   * pagination.
   */
  async getBalanceSnapshots(
    accountNumber: string,
    params?: Record<string, unknown>,
  ) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/balance-snapshots",
      ]),
      { params: params ?? {} },
    );
    return envelopeItemsOrBody(response);
  }

  async getNetLiquidatingValueHistory(
    accountNumber: string,
    params?: {
      "time-back"?: string;
      "start-time"?: string;
      "end-time"?: string;
      interval?: string;
    },
  ) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/net-liq/history",
      ]),
      { params },
    );
    return envelopeItems(response);
  }

  async getPositionLimit(accountNumber: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/position-limit",
      ]),
    );
    return envelopeData(response);
  }

  async getAccountStatus(accountNumber: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/trading-status",
      ]),
    );
    return envelopeData(response);
  }

  async getEffectiveMarginRequirements(accountNumber: string, symbol: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/margin-requirements/",
        seg("symbol", symbol),
        "/effective",
      ]),
    );
    return envelopeData(response);
  }

  // ============================================================================
  // Positions
  // ============================================================================

  /**
   * Positions with the full documented filter set.
   * Note: `include-marks` defaults to true here (vs. the API default of
   * false) because agents almost always want mark prices for dashboards.
   * This is a documented breaking change vs. the prior default.
   *
   * `underlying-symbol` is an array filter, serialized as a REPEATED BARE key
   * (`underlying-symbol=AAPL&underlying-symbol=SPY`) — not with a `[]` suffix.
   * open-api-spec/balances-and-positions.md documents the bare form
   * (`underlying-symbol=AAPL`), which is what the serializer below emits.
   * Contrast the orders endpoints, whose docs do show `status[]=…`.
   */
  async getPositions(accountNumber: string, params?: Record<string, unknown>) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/positions",
      ]),
      {
        params: params ?? {},
      },
    );
    return envelopeItemsOrBody(response);
  }

  /**
   * Single position by symbol — client-side filter of the list endpoint.
   * Per docs there is no GET /accounts/{n}/positions/{symbol}.
   */
  async getPosition(accountNumber: string, symbol: string) {
    const positions = await this.getPositions(accountNumber, {
      symbol,
      "include-marks": true,
    });
    return Array.isArray(positions)
      ? positions.find((p: Position) => p.symbol === symbol)
      : positions;
  }

  // ============================================================================
  // Market Data
  // ============================================================================

  /**
   * Snapshot quote(s) via `GET /market-data/by-type`.
   *
   * Per the openapi spec:
   * - Param name MUST be singular hyphenated: `equity`, `equity-option`,
   *   `future`, `future-option`, `cryptocurrency`, `index`. Sending plural
   *   (`equities`, `equity-options`) silently returns nothing.
   * - Response is **kebab-case** (`bid`, `ask`, `mid`, `mark`, `last`,
   *   `day-high-price`, `day-low-price`, `is-trading-halted`, `updated-at`,
   *   etc.) — the same convention as the rest of the API. Prices/sizes/volumes
   *   are string-decimals (e.g. "312.0151"); bid/ask/mid/volume are absent for
   *   instruments that do not quote them (e.g. an index).
   * - 100-symbol combined limit per request.
   * - `halt-start-time`, `halt-end-time` are epoch milliseconds and return the
   *   sentinel -1 when not halted; gate on `is-trading-halted`. `updated-at` is
   *   an ISO 8601 string. There is no `close` or `last-trade-time` field.
   */
  async getQuote(
    symbols: string | string[],
    instrumentType: InstrumentType = InstrumentType.Equity,
    opts?: { include_instrument?: boolean },
  ) {
    const symbolArray = Array.isArray(symbols) ? symbols : [symbols];
    // Argument problems are the CALLER's, not the broker's. A bare
    // `new Error` would fall through adaptError's default branch and be
    // reported to the agent as a retryable `upstream_error`, so the agent
    // would keep re-sending the same bad request instead of fixing it.
    if (symbolArray.length === 0) {
      throw toolError({
        code: "validation",
        message: "getQuote: at least one symbol required.",
        retryable: false,
      });
    }
    if (symbolArray.length > 100) {
      throw toolError({
        code: "validation",
        message: `getQuote: ${symbolArray.length} symbols exceeds the 100-symbol /market-data/by-type limit.`,
        retryable: false,
        hint: "Split the symbol list across multiple calls, or switch to the DXLink streamer for high-frequency needs.",
      });
    }

    // THE INSTRUMENT TYPE SELECTS A PARAMETER; IT NEVER NAMES ONE.
    //
    // This endpoint takes the symbol list under a parameter named after the instrument
    // class, so the value lands in a KEY position. It must not get there through
    // `instrumentType.toLowerCase().replace(/ /g, "-")`: that makes a well-formed
    // parameter name out of anything, so it cannot fail and therefore cannot validate.
    // On the wire, `"X Injected Key"` became `?x-injected-key=SPY`, `"PER-PAGE"` a key
    // from a different API dimension, and `"Include Instrument"` collided with this
    // method's own parameter so the request carried NO symbol filter — each reported to
    // the agent as an ordinary success.
    //
    // The `instrumentType: InstrumentType` annotation cannot be relied on: TypeScript
    // types are erased at build time, and the MCP SDK does not validate `tools/call`
    // arguments against `inputSchema`.
    //
    // `hasOwnProperty`, not a bare index, because the value crosses the trust boundary
    // and a plain object literal answers `toString` and `constructor` with an
    // Object.prototype member.
    if (
      !Object.prototype.hasOwnProperty.call(
        MARKET_DATA_TYPE_PARAMS,
        instrumentType,
      )
    ) {
      throw toolError({
        code: "validation",
        message:
          `getQuote: ${JSON.stringify(String(instrumentType).slice(0, 40))} is not an ` +
          `instrument type this endpoint publishes a symbol parameter for, so no ` +
          `request was sent — nothing was read and nothing was changed. Accepted ` +
          `values: ${Object.keys(MARKET_DATA_TYPE_PARAMS).join(", ")}.`,
        retryable: false,
        hint:
          `This is a fault in the argument, not in the broker — repeating the identical ` +
          `call will fail the same way. Pass \`instrument_type\` as one of the values ` +
          `this tool's inputSchema declares.`,
      });
    }
    const paramName = MARKET_DATA_TYPE_PARAMS[instrumentType];

    const params: Record<string, unknown> = { [paramName]: symbolArray };
    if (opts?.include_instrument) params["include-instrument"] = true;

    const response = await this.client.get(`/market-data/by-type`, {
      params,
    });

    // The /market-data/by-type response is `{ data: { items: [...] }, context }`
    // — same outer envelope as the rest of the API, but the *items* are
    // camelCase. Earlier code grabbed `response.data.items` which never
    // matched and silently fell through to returning the whole envelope.
    return response.data?.data?.items ?? response.data?.items ?? [];
  }

  async getOptionChain(symbol: string) {
    const response = await this.client.get(
      apiPath(["/option-chains/", seg("symbol", symbol)]),
    );
    return envelopeData(response);
  }

  async getOptionChainCompact(symbol: string) {
    const response = await this.client.get(
      apiPath(["/option-chains/", seg("symbol", symbol), "/compact"]),
    );
    return envelopeData(response);
  }

  async getOptionChainNested(symbol: string) {
    const response = await this.client.get(
      apiPath(["/option-chains/", seg("symbol", symbol), "/nested"]),
    );
    return envelopeData(response);
  }

  async getOptionExpirations(symbol: string) {
    const response = await this.client.get(
      apiPath(["/option-chains/", seg("symbol", symbol), "/expirations"]),
    );
    return envelopeData(response);
  }

  /**
   * Nested futures-option chain.
   *
   * Per the openapi spec: endpoint is
   * `GET /futures-option-chains/{product_code}/nested`. The `{product_code}`
   * is the **product code** (`ES`, `CL`, `GC`), NOT an individual contract
   * symbol like `/ESM6`. The previous v2 implementation hit
   * `/futures-option-chains?symbol[]=…` which is not a documented endpoint
   * shape and silently returned nothing useful.
   */
  async getFuturesOptionChainNested(productCode: string) {
    const response = await this.client.get(
      apiPath([
        "/futures-option-chains/",
        seg("product_code", productCode),
        "/nested",
      ]),
    );
    return envelopeDataOrBody(response);
  }

  // ============================================================================
  // Orders
  // ============================================================================

  /**
   * Search account orders, per the openapi spec.
   * `params` keys are kebab-case to match the API; the dispatcher does the
   * snake→kebab translation. `status` is an array serialized as repeated
   * `status[]=…` per docs.
   */
  async searchOrders(accountNumber: string, params?: Record<string, unknown>) {
    const response = await this.client.get(
      apiPath(["/accounts/", seg("account_number", accountNumber), "/orders"]),
      {
        params: params ?? {},
      },
    );
    return envelopeItemsOrBody(response);
  }

  /** Backward-compat thin wrapper. Same endpoint as searchOrders. */
  async getOrders(accountNumber: string, params?: Record<string, unknown>) {
    return this.searchOrders(accountNumber, params);
  }

  /**
   * Customer-level order search — same query shape as
   * account search plus `account-numbers[]` to scope across multiple
   * accounts owned by the customer.
   */
  async searchCustomerOrders(
    customerId: string,
    params?: Record<string, unknown>,
  ) {
    const response = await this.client.get(
      apiPath(["/customers/", seg("customer_id", customerId), "/orders"]),
      {
        params: params ?? {},
      },
    );
    return envelopeItemsOrBody(response);
  }

  /**
   * Customer-level live orders. "Live" here means "placed today (any
   * status)" — same convention as the account-level live endpoint, NOT
   * "currently working." Per orders.md.
   */
  async getCustomerLiveOrders(
    customerId: string,
    params?: Record<string, unknown>,
  ) {
    const response = await this.client.get(
      apiPath(["/customers/", seg("customer_id", customerId), "/orders/live"]),
      {
        params: params ?? {},
      },
    );
    return envelopeItemsOrBody(response);
  }

  async getOrder(accountNumber: string, orderId: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/orders/",
        seg("order_id", orderId),
      ]),
    );
    return envelopeData(response);
  }

  async getLiveOrders(accountNumber: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/orders/live",
      ]),
    );
    return envelopeItems(response);
  }

  async placeOrder(accountNumber: string, orderData: any) {
    const response = await this.client.post(
      GATED_ROUTES.place_order.submit({ accountNumber }).path,
      orderData,
    );
    return writtenEntity(response, "the order submission");
  }

  async dryRunOrder(accountNumber: string, orderData: any) {
    const response = await this.client.post(
      GATED_ROUTES.place_order.dryRun({ accountNumber }).path,
      orderData,
      NON_MUTATING_ROUTE,
    );
    return envelopeData(response);
  }

  /**
   * Pre-flight an order replace or edit. Single endpoint serves both
   * operations per orders.md ("Same structure as Edit Order"). The body
   * is the change set you'd send to PUT (full body minus legs) or PATCH
   * (partial). Two distinct dry-run TOOLS sit on top of this method —
   * they construct the appropriate body and bind tokens to different
   * actions ("replace_order" vs "edit_order"), but the underlying API
   * call is identical.
   */
  async dryRunReplaceOrEdit(
    accountNumber: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.client.post(
      // replace_order and edit_order share this endpoint; either entry renders
      // the same path, and the table is why that is a fact rather than a habit.
      GATED_ROUTES.replace_order.dryRun({ accountNumber, orderId }).path,
      body,
      NON_MUTATING_ROUTE,
    );
    // Strict: every token-minting dry-run is — see TOKEN-MINTING DRY-RUNS ARE
    // STRICT above the envelope helpers. replace_order and edit_order re-check
    // this payload at submit time and nothing else (runStoredDryRunChecks): the
    // MAX_ORDER_NOTIONAL_USD ceiling on those two routes is measured against
    // this figure alone, so a token minted from `{data: null}` would submit
    // with the cap compared against nothing.
    return envelopeData(response);
  }

  async replaceOrder(accountNumber: string, orderId: string, orderData: any) {
    const response = await this.client.put(
      GATED_ROUTES.replace_order.submit({ accountNumber, orderId }).path,
      orderData,
    );
    return writtenEntity(response, "the order replacement");
  }

  async editOrder(
    accountNumber: string,
    orderId: string,
    orderData: { price?: string; quantity?: number },
  ) {
    const response = await this.client.patch(
      GATED_ROUTES.edit_order.submit({ accountNumber, orderId }).path,
      orderData,
    );
    return writtenEntity(response, "the order edit");
  }

  async cancelOrder(accountNumber: string, orderId: string) {
    const response = await this.client.delete(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/orders/",
        seg("order_id", orderId),
      ]),
    );
    // Unwrap to .data.data so the cancelled Order is returned at the same depth
    // as getOrder/placeOrder/editOrder/replaceOrder (was returning .data).
    return envelopeData(response);
  }

  async reconfirmOrder(accountNumber: string, orderId: string) {
    const response = await this.client.post(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/orders/",
        seg("order_id", orderId),
        "/reconfirm",
      ]),
    );
    return envelopeData(response);
  }

  // ============================================================================
  // Complex Orders
  // ============================================================================
  //
  // Complex orders combine multiple component orders into a strategy with
  // defined execution relationships:
  //   - OTO    — One-Triggers-Other (trigger fills → child activates)
  //   - OCO    — One-Cancels-Other (multi live; one fills → others cancel)
  //   - OTOCO  — Trigger fills → OCO group activates
  //   - BLAST  — All orders submitted simultaneously (no conditional)
  //   - PAIRS  — Pairs trade with ratio-based price threshold

  async getComplexOrders(
    accountNumber: string,
    params?: { "page-offset"?: number; "per-page"?: number },
  ) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/complex-orders",
      ]),
      { params: params ?? {} },
    );
    return envelopeItemsOrBody(response);
  }

  async getLiveComplexOrders(accountNumber: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/complex-orders/live",
      ]),
    );
    return envelopeItemsOrBody(response);
  }

  async getComplexOrder(accountNumber: string, complexOrderId: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/complex-orders/",
        seg("complex_order_id", complexOrderId),
      ]),
    );
    return envelopeDataOrBody(response);
  }

  async placeComplexOrder(
    accountNumber: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.client.post(
      GATED_ROUTES.place_complex_order.submit({ accountNumber }).path,
      body,
    );
    return writtenEntity(response, "the complex-order submission");
  }

  async dryRunComplexOrder(
    accountNumber: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.client.post(
      GATED_ROUTES.place_complex_order.dryRun({ accountNumber }).path,
      body,
      NON_MUTATING_ROUTE,
    );
    // Strict: every token-minting dry-run is — see TOKEN-MINTING DRY-RUNS ARE
    // STRICT above the envelope helpers. place_complex_order DOES run sanity
    // checks, but this payload is the only place the buying-power figure comes
    // from: a truthy `{data: null}` mints a token and then downgrades the
    // notional cap to a warning, so the order goes out uncapped.
    return envelopeData(response);
  }

  async cancelComplexOrder(accountNumber: string, complexOrderId: string) {
    const response = await this.client.delete(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/complex-orders/",
        seg("complex_order_id", complexOrderId),
      ]),
    );
    // Strict, matching cancelOrder, and it is not cosmetic. The tolerant
    // dialect ends `?? response.data`, and axios represents a 204's "no
    // content" as the empty STRING — so on the 204 an intermediary can answer a
    // DELETE with, this method returned `""`. A scalar is the one payload the
    // dispatcher cannot mirror into structuredContent at all, so a SUCCESSFUL
    // cancel reached the agent as `-32600`. Unwrapped strictly the same body is
    // `undefined`, which the dispatcher renders as the empty acknowledgement
    // `{}`.
    return envelopeData(response);
  }

  /**
   * PATCH a complex order. Per orders.md the only supported edit today is
   * the PAIRS ratio threshold update — body is just `ratio-price-comparator`
   * and `ratio-price-threshold`.
   */
  async editComplexOrder(
    accountNumber: string,
    complexOrderId: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.client.patch(
      GATED_ROUTES.edit_complex_order.submit({ accountNumber, complexOrderId })
        .path,
      body,
    );
    return writtenEntity(response, "the complex-order edit");
  }

  /** Pre-flight a complex-order edit. Same body shape as editComplexOrder. */
  async dryRunEditComplexOrder(
    accountNumber: string,
    complexOrderId: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.client.post(
      GATED_ROUTES.edit_complex_order.dryRun({ accountNumber, complexOrderId })
        .path,
      body,
      NON_MUTATING_ROUTE,
    );
    // Strict: every token-minting dry-run is — see TOKEN-MINTING DRY-RUNS ARE
    // STRICT above the envelope helpers. This payload is also the only figure
    // edit_complex_order's submit-time notional check has to work from
    // (runStoredDryRunChecks), so a token minted against `{data: null}` would
    // put the PATCH through with the cap compared against nothing.
    return envelopeData(response);
  }

  // ============================================================================
  // Symbols
  // ============================================================================

  async searchSymbols(symbol: string) {
    const response = await this.client.get(
      apiPath(["/symbols/search/", seg("symbol", symbol)]),
    );
    return envelopeItems(response);
  }

  async getInstrument(symbol: string) {
    const response = await this.client.get(
      apiPath(["/instruments/equities/", seg("symbol", symbol)]),
    );
    return envelopeData(response);
  }

  async getInstruments(symbols: string[]) {
    const response = await this.client.get("/instruments/equities", {
      params: { symbol: symbols },
      // The one endpoint whose wire shape differs: GET /instruments/equities
      // requires the literal `symbol[]`. Declared as a STYLE handed to the one
      // serializer rather than as a second serializer, because a per-request
      // serializer overrides the instance default and a hand-written one is a
      // place the guarantee does not reach.
      paramsSerializer: (p) => serializeParams(p, { keyFor: (k) => `${k}[]` }),
    });
    return envelopeItems(response);
  }

  /**
   * Equity option definition by OCC symbol. Same endpoint as
   * `getEquityOption`; this method is the legacy name of that one — the
   * tool `tastytrade_get_equity_definition` is kept as a deprecated alias
   * for backward compatibility.
   */
  async getEquityDefinition(symbol: string, opts?: { active?: boolean }) {
    return this.getEquityOption(symbol, opts);
  }

  /** GET /instruments/equity-options/{symbol} with optional `active` filter. */
  async getEquityOption(symbol: string, opts?: { active?: boolean }) {
    const response = await this.client.get(
      apiPath(["/instruments/equity-options/", seg("symbol", symbol)]),
      { params: opts?.active === undefined ? {} : { active: opts.active } },
    );
    return envelopeDataOrBody(response);
  }

  /** GET /instruments/equities/active with paging + lendability filter. */
  async getActiveEquities(params?: {
    "page-offset"?: number;
    "per-page"?: number;
    lendability?: "Easy To Borrow" | "Locate Required" | "Preborrow";
  }) {
    const response = await this.client.get("/instruments/equities/active", {
      params: params ?? {},
    });
    return envelopeItemsOrBody(response);
  }

  /** Full option chain — same endpoint the existing `getOptionChain` hits.
   *  Exposed under a clearer name. */
  async getOptionChainFull(symbol: string) {
    return this.getOptionChain(symbol);
  }

  /**
   * GET /instruments/futures with array-shaped filters (`symbol[]`,
   * `product-code[]`, `security-id[]`).
   */
  async getFutures(params?: Record<string, unknown>) {
    const response = await this.client.get("/instruments/futures", {
      params: params ?? {},
    });
    return envelopeItemsOrBody(response);
  }

  async getFuture(symbol: string) {
    const response = await this.client.get(
      apiPath(["/instruments/futures/", seg("symbol", symbol)]),
    );
    return envelopeDataOrBody(response);
  }

  async getFutureProducts(params?: {
    "page-offset"?: number;
    "per-page"?: number;
  }) {
    const response = await this.client.get("/instruments/future-products", {
      params: params ?? {},
    });
    return envelopeItemsOrBody(response);
  }

  async getFutureProduct(exchange: string, code: string) {
    const response = await this.client.get(
      apiPath([
        "/instruments/future-products/",
        seg("exchange", exchange),
        "/",
        seg("code", code),
      ]),
    );
    return envelopeDataOrBody(response);
  }

  async getFutureOption(symbol: string) {
    const response = await this.client.get(
      apiPath(["/instruments/future-options/", seg("symbol", symbol)]),
    );
    return envelopeDataOrBody(response);
  }

  /** Full futures-option chain. `productCode` is the futures product code
   *  (e.g. "ES"), NOT a contract symbol. Companion to the nested variant
   *  registered as `tastytrade_get_futures_option_chains`. */
  async getFuturesOptionChainFull(productCode: string) {
    const response = await this.client.get(
      apiPath(["/futures-option-chains/", seg("product_code", productCode)]),
    );
    return envelopeDataOrBody(response);
  }

  async getFutureOptionProducts(params?: {
    "page-offset"?: number;
    "per-page"?: number;
  }) {
    const response = await this.client.get(
      "/instruments/future-option-products",
      {
        params: params ?? {},
      },
    );
    return envelopeItemsOrBody(response);
  }

  /**
   * Future option product by root symbol. The docs expose two path forms:
   *   GET /instruments/future-option-products/{root_symbol}
   *   GET /instruments/future-option-products/{exchange}/{root_symbol}
   * Pass `exchange` to use the two-segment form; otherwise root-symbol only.
   */
  async getFutureOptionProduct(rootSymbol: string, exchange?: string) {
    const path = exchange
      ? apiPath([
          "/instruments/future-option-products/",
          seg("exchange", exchange),
          "/",
          seg("root_symbol", rootSymbol),
        ])
      : apiPath([
          "/instruments/future-option-products/",
          seg("root_symbol", rootSymbol),
        ]);
    const response = await this.client.get(path);
    return envelopeDataOrBody(response);
  }

  async getCryptocurrencies(params?: { symbol?: string | string[] }) {
    const response = await this.client.get("/instruments/cryptocurrencies", {
      params: params ?? {},
    });
    return envelopeItemsOrBody(response);
  }

  async getCryptocurrency(symbol: string) {
    const response = await this.client.get(
      apiPath(["/instruments/cryptocurrencies/", seg("symbol", symbol)]),
    );
    return envelopeDataOrBody(response);
  }

  async getWarrants(params?: { symbol?: string | string[] }) {
    const response = await this.client.get("/instruments/warrants", {
      params: params ?? {},
    });
    return envelopeItemsOrBody(response);
  }

  async getWarrant(symbol: string) {
    const response = await this.client.get(
      apiPath(["/instruments/warrants/", seg("symbol", symbol)]),
    );
    return envelopeDataOrBody(response);
  }

  /**
   * Quantity decimal-precision rules for every instrument type.
   *
   * Unwrapped to `.data.data.items` like every other list endpoint here, so
   * the caller gets the bare `QuantityDecimalPrecision[]` its tool
   * description and outputSchema promise. Returning `.data.data` handed the
   * agent the `{items:[…]}` wrapper instead, so `result[0]` was undefined.
   */
  async getQuantityDecimalPrecisions() {
    const response = await this.client.get(
      "/instruments/quantity-decimal-precisions",
    );
    return envelopeItemsOrBody(response);
  }

  // ============================================================================
  // Transactions
  // ============================================================================

  async getTransactions(
    accountNumber: string,
    params?: Record<string, unknown>,
  ) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/transactions",
      ]),
      {
        params: params ?? {},
        // Repeated-key serialization for array filters (types[], sub-type[]).
      },
    );
    return response.data?.data?.items ?? [];
  }

  async getTransaction(accountNumber: string, transactionId: string) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/transactions/",
        seg("transaction_id", transactionId),
      ]),
    );
    return envelopeData(response);
  }

  // The endpoint summarizes fees for a SINGLE day; `date` defaults to today
  // when omitted. It does NOT accept a date range.
  async getTotalFees(accountNumber: string, params?: { date?: string }) {
    const response = await this.client.get(
      apiPath([
        "/accounts/",
        seg("account_number", accountNumber),
        "/transactions/total-fees",
      ]),
      { params },
    );
    return envelopeData(response);
  }

  // ============================================================================
  // Watchlists
  // ============================================================================

  async getWatchlists() {
    const response = await this.client.get("/watchlists");
    return envelopeItems(response);
  }

  async getWatchlist(watchlistName: string) {
    const response = await this.client.get(
      apiPath(["/watchlists/", seg("watchlist_name", watchlistName)]),
    );
    return envelopeData(response);
  }

  async createWatchlist(name: string, entries: WatchlistEntry[]) {
    const response = await this.client.post("/watchlists", {
      name,
      "watchlist-entries": entries.map((e) => ({
        symbol: e.symbol,
        "instrument-type": e["instrument-type"] ?? "Equity",
      })),
    });
    return envelopeData(response);
  }

  // PUT is a FULL REPLACEMENT: any entry not present in `entries` is removed.
  // The watchlist name is included in the body (the API entity carries it).
  async updateWatchlist(watchlistName: string, entries: WatchlistEntry[]) {
    const response = await this.client.put(
      apiPath(["/watchlists/", seg("watchlist_name", watchlistName)]),
      {
        name: watchlistName,
        "watchlist-entries": entries.map((e) => ({
          symbol: e.symbol,
          "instrument-type": e["instrument-type"] ?? "Equity",
        })),
      },
    );
    return envelopeData(response);
  }

  /**
   * DELETE /watchlists/{name} — returns the deleted Watchlist per
   * open-api-spec/watchlists.md.
   *
   * Unwrapped to `.data.data` so the deleted Watchlist arrives at the same
   * depth as getWatchlist / createWatchlist / updateWatchlist. This method
   * rather than `response.data`, which would leak the `{data:{…}}` transport
   * envelope.
   */
  async deleteWatchlist(watchlistName: string) {
    const response = await this.client.delete(
      apiPath(["/watchlists/", seg("watchlist_name", watchlistName)]),
    );
    // Strict, like every other watchlist method and like cancelOrder: this
    // tool's own outputSchema says it returns the deleted Watchlist unwrapped
    // "to .data.data, the same depth as get_watchlist / create_watchlist". The
    // tolerant dialect's `?? response.data` fallback contradicted that on the
    // one shape it can fire on — a 200 `{data: null}` came back as the object
    // `{data: null}`, which is not a Watchlist at any depth — and on a 204 it
    // returned axios's empty STRING, which the dispatcher cannot mirror into
    // structuredContent at all. Unwrapped strictly, an empty acknowledgement is
    // `undefined` and the dispatcher renders it as `{}`.
    return envelopeData(response);
  }

  /**
   * Add a symbol to a watchlist: the tastytrade API has NO
   * `POST /watchlists/{name}/entries`, so this is a client-side GET-modify-PUT round
   * trip. NOT atomic; concurrent modifications can lose entries.
   *
   * TWO BROKER REQUESTS, AND THE SECOND IS BILLED. The dispatcher's pre-flight
   * charges once per `tools/call`, which is true only for a method making one
   * request; on one token this would spend two of the broker's, against every
   * published ceiling and the global aggregate alike. The debt is charged here
   * because the dispatcher cannot know a method fanned out — and in the FAN-OUT
   * method rather than inside `getWatchlist`, so a direct `get_watchlist` that
   * already paid admission is not billed twice.
   *
   * Idempotent in effect: re-adding the same symbol is a no-op.
   *
   * `instrumentType` is required, deliberately. A default here as well as in the
   * dispatcher — which passes `args.instrument_type ?? "Equity"` — would be
   * unreachable, and two defaults for one decision is how they disagree. The single
   * source is the agent-facing boundary, where the tool schema declares it.
   */
  async addSymbolToWatchlist(
    watchlistName: string,
    symbol: string,
    instrumentType: string,
  ) {
    const wl = await this.getWatchlist(watchlistName);
    const entries: Array<{ symbol: string; "instrument-type": string }> =
      Array.isArray(wl?.["watchlist-entries"])
        ? [...wl["watchlist-entries"]]
        : [];
    const already = entries.some(
      (e) => e.symbol === symbol && e["instrument-type"] === instrumentType,
    );
    if (!already) entries.push({ symbol, "instrument-type": instrumentType });
    // The second broker request of this call, billed before it goes out. A DEBT
    // rather than a second admitting charge: the GET has already happened and
    // the modification is already computed, so a refusal here would abandon
    // work in flight — `chargeUpstreamCallDebt` never refuses, and the
    // overspend is repaid by the next admission finding the bucket short.
    // Unkeyed: /watchlists has no published per-endpoint ceiling, so the global
    // aggregate is the only bucket this draws on.
    chargeUpstreamCallDebt();
    const response = await this.client.put(
      apiPath(["/watchlists/", seg("watchlist_name", watchlistName)]),
      {
        name: watchlistName,
        "watchlist-entries": entries,
      },
    );
    return envelopeDataOrBody(response);
  }

  /**
   * Remove a symbol from a watchlist. Same client-side GET-modify-PUT pattern
   * as addSymbolToWatchlist; not atomic. Idempotent: removing a symbol that
   * isn't there is a no-op.
   *
   * Two broker requests, and the second one is billed — same as
   * addSymbolToWatchlist.
   *
   * `instrumentType` is required for the same reason as on addSymbolToWatchlist,
   * and it matters more here: a removal matches on the (symbol, instrument-type)
   * pair, so a default quietly filled in at the wrong layer does not fail loudly
   * — it silently removes nothing, or removes the wrong entry.
   */
  async removeSymbolFromWatchlist(
    watchlistName: string,
    symbol: string,
    instrumentType: string,
  ) {
    const wl = await this.getWatchlist(watchlistName);
    const entries: Array<{ symbol: string; "instrument-type": string }> =
      Array.isArray(wl?.["watchlist-entries"])
        ? [...wl["watchlist-entries"]]
        : [];
    const filtered = entries.filter(
      (e) => !(e.symbol === symbol && e["instrument-type"] === instrumentType),
    );
    // The second broker request, billed — see addSymbolToWatchlist above for
    // why it is a debt and why it is charged here rather than in getWatchlist.
    chargeUpstreamCallDebt();
    const response = await this.client.put(
      apiPath(["/watchlists/", seg("watchlist_name", watchlistName)]),
      {
        name: watchlistName,
        "watchlist-entries": filtered,
      },
    );
    return envelopeDataOrBody(response);
  }

  // ============================================================================
  // Market Metrics
  // ============================================================================

  /**
   * Symbols are passed as a comma-joined string per docs. axios URL-encodes
   * the value as a unit, so symbols containing `/` (e.g. `BRK/B`) → `%2F`
   * and the comma separator → `%2C` — both decode correctly server-side.
   */
  async getMarketMetrics(symbols: string[]) {
    const response = await this.client.get("/market-metrics", {
      params: { symbols: symbols.join(",") },
    });
    return envelopeItemsOrBody(response);
  }

  async getHistoricalDividends(symbol: string) {
    const response = await this.client.get(
      apiPath([
        "/market-metrics/historic-corporate-events/dividends/",
        seg("symbol", symbol),
      ]),
    );
    return envelopeItemsOrBody(response);
  }

  /**
   * `start-date` is REQUIRED by this endpoint (see
   * open-api-spec/market-metrics.md); the API rejects a call without it.
   */
  async getEarningsReports(
    symbol: string,
    params?: { "start-date"?: string; "end-date"?: string },
  ) {
    const response = await this.client.get(
      apiPath([
        "/market-metrics/historic-corporate-events/earnings-reports/",
        seg("symbol", symbol),
      ]),
      { params },
    );
    return envelopeItemsOrBody(response);
  }

  // ============================================================================
  // Streaming handoff
  // ============================================================================

  /**
   * GET /api-quote-tokens — DXLink streamer credentials.
   *
   * Returns `{ token, dxlink-url, level }`. Tokens are valid for 24 hours.
   * The server hands these off rather
   * than maintaining its own polling loops; clients connect to the
   * dxlink-url WebSocket directly.
   */
  async getApiQuoteToken() {
    const response = await this.client.get("/api-quote-tokens");
    return envelopeDataOrBody(response);
  }

  /**
   * GET /market-data/by-type with pre-bucketed symbols — supports MIXED
   * instrument types in a single request. Used by the agent-facing
   * tastytrade_get_quote_snapshot tool which accepts a heterogenous
   * array and buckets it client-side.
   *
   * `buckets` keys are already the singular hyphenated API param names
   * (`equity`, `equity-option`, `future`, `future-option`,
   * `cryptocurrency`, `index`).
   *
   * Caller is responsible for the 100-symbol combined cap.
   */
  // ============================================================================
  // Risk parameters
  // ============================================================================

  /**
   * Public margin configuration. Endpoint is unauthenticated per docs but
   * the existing axios client will still send the bearer token — that's
   * harmless. Returns the global config including the risk-free rate.
   */
  async getMarginConfig() {
    const response = await this.client.get(
      "/margin-requirements-public-configuration",
    );
    return envelopeDataOrBody(response);
  }

  /** Convenience wrapper extracting just the risk-free rate. */
  async getRiskFreeRate(): Promise<number | null> {
    const cfg = await this.getMarginConfig();
    const raw = cfg?.["risk-free-rate"];
    if (raw == null) return null;
    const n = typeof raw === "string" ? Number(raw) : raw;
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Raw SPAN data rows for futures/futures-options margin calculations.
   * Defaults: per-page=1000, max=50000.
   */
  async getSpanRows(params: {
    date: string;
    exchange: "CME" | "CFE";
    "page-offset"?: number;
    "per-page"?: number;
  }) {
    const response = await this.client.get("/span/rows", { params });
    return envelopeItemsOrBody(response);
  }

  // ============================================================================
  // Margin requirements — dry-run
  // ============================================================================

  /**
   * Estimate the margin/buying-power impact of a prospective order without
   * placing it. NOT the same endpoint as the order dry-run (POST /orders/
   * dry-run) — this one focuses on capital impact only and does not issue
   * a confirmation token.
   */
  async dryRunMarginImpact(
    accountNumber: string,
    body: Record<string, unknown>,
  ) {
    const response = await this.client.post(
      apiPath([
        "/margin/accounts/",
        seg("account_number", accountNumber),
        "/dry-run",
      ]),
      body,
      NON_MUTATING_ROUTE,
    );
    // Tolerant, and deliberately outside the "token-minting dry-runs are
    // strict" rule above: nothing gates on this payload. It is not reachable
    // from `issueToken`, `isCleanDryRun` never sees it, and the dispatcher
    // returns it straight to the caller as an estimate. If that ever changes —
    // if some flow starts deriving authority from this figure — it joins the
    // strict list.
    return envelopeDataOrBody(response);
  }

  async getMarketDataByType(
    buckets: Record<string, string[]>,
    opts?: { include_instrument?: boolean },
  ) {
    const params: Record<string, unknown> = { ...buckets };
    if (opts?.include_instrument) params["include-instrument"] = true;
    const response = await this.client.get("/market-data/by-type", {
      params,
    });
    return response.data?.data?.items ?? response.data?.items ?? [];
  }

  // ============================================================================
  // Market Sessions
  // ============================================================================
  //
  // The 11 market-time endpoints
  // collapse into 3 parameterized tools. The api-client exposes each
  // parameterized method below; the dispatcher in mcp-server picks the
  // right one based on the agent's input.

  /**
   * GET /market-time/sessions — date-range sessions, max 9-month window.
   * Default `instrument-collection` is `Equity` per docs.
   */
  async getSessionsRange(params: {
    "to-date": string;
    "from-date"?: string;
    "instrument-collection"?: "Equity" | "CME" | "CFE" | "Zero Hash CLOB";
  }) {
    const response = await this.client.get("/market-time/sessions", { params });
    return envelopeItemsOrBody(response);
  }

  /**
   * GET /market-time/sessions/current — multi-collection current snapshot.
   * `collections` serializes as repeated `instrument-collections[]=…`.
   * Per docs values are CFE / CME / Equity (no Zero Hash CLOB here).
   */
  async getCurrentSessionsMulti(collections: Array<"CFE" | "CME" | "Equity">) {
    const response = await this.client.get("/market-time/sessions/current", {
      params: { "instrument-collections": collections },
    });
    return envelopeDataOrBody(response);
  }

  /** GET /market-time/equities/sessions/{when}. */
  async getEquitiesSession(when: "current" | "next" | "previous") {
    const response = await this.client.get(
      apiPath(["/market-time/equities/sessions/", seg("when", when)]),
    );
    return envelopeDataOrBody(response);
  }

  /** GET /market-time/futures/sessions/{when}/{collection}. */
  async getFuturesSession(
    when: "current" | "next" | "previous",
    collection: "CME" | "CFE" | "Zero Hash CLOB",
  ) {
    const response = await this.client.get(
      apiPath([
        "/market-time/futures/sessions/",
        seg("when", when),
        "/",
        seg("collection", collection),
      ]),
    );
    return envelopeDataOrBody(response);
  }

  /** GET /market-time/equities/holidays. */
  async getEquityHolidays() {
    const response = await this.client.get("/market-time/equities/holidays");
    return envelopeDataOrBody(response);
  }

  /** GET /market-time/futures/holidays/{collection}. */
  async getFuturesHolidays(collection: "CME" | "CFE") {
    const response = await this.client.get(
      apiPath([
        "/market-time/futures/holidays/",
        seg("collection", collection),
      ]),
    );
    return envelopeDataOrBody(response);
  }

  // ============================================================================
  // Quote Alerts
  // ============================================================================

  async getQuoteAlerts() {
    const response = await this.client.get("/quote-alerts");
    return envelopeItemsOrBody(response);
  }

  async createQuoteAlert(body: Record<string, unknown>) {
    const response = await this.client.post("/quote-alerts", body);
    return envelopeDataOrBody(response);
  }

  async deleteQuoteAlert(alertExternalId: string) {
    const response = await this.client.delete(
      apiPath(["/quote-alerts/", seg("alert_external_id", alertExternalId)]),
    );
    // Strict, for the same reason as deleteWatchlist. This is the tool whose
    // DOCUMENTED answer is 204 No Content (open-api-spec/quote-alerts.md), so
    // the empty acknowledgement is not an edge case here, it is the happy path.
    return envelopeData(response);
  }

  // ============================================================================
  // Public + Pairs Watchlists (read-only)
  // ============================================================================

  async getPublicWatchlists(opts?: { counts_only?: boolean }) {
    const response = await this.client.get("/public-watchlists", {
      params: opts?.counts_only ? { "counts-only": true } : {},
    });
    return envelopeItemsOrBody(response);
  }

  async getPublicWatchlist(watchlistName: string) {
    const response = await this.client.get(
      apiPath(["/public-watchlists/", seg("watchlist_name", watchlistName)]),
    );
    return envelopeDataOrBody(response);
  }

  async getPairsWatchlists() {
    const response = await this.client.get("/pairs-watchlists");
    return envelopeItemsOrBody(response);
  }

  async getPairsWatchlist(pairsWatchlistName: string) {
    const response = await this.client.get(
      apiPath([
        "/pairs-watchlists/",
        seg("pairs_watchlist_name", pairsWatchlistName),
      ]),
    );
    return envelopeDataOrBody(response);
  }
}
