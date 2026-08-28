/**
 * MCP Resources registry — static markdown bundles plus dynamic API-backed
 * resources (computed, not just 1:1 endpoint proxies).
 *
 * STATIC_RESOURCES are concrete URIs with lazy `text()` thunks. RESOURCE_TEMPLATES
 * are parameterized URIs matched against incoming concrete URIs to extract
 * parameters. On read: a static hit returns `text()`; otherwise exactly one
 * matching template's `read()` runs, more than one match is REFUSED (arbitrating
 * by array position would silently serve the wrong resource — see
 * matchTemplateIn), and no match is a 404.
 *
 * FAILURE POLICY. A resource body is read by an agent as fact, and this one
 * describes a brokerage account, so: never emit a value a consumer cannot
 * distinguish from a successfully-read one. A number that could not be read is
 * `null`, never `0`; a collection is `null`, never `[]`.
 *
 * Two mechanisms, chosen per field. FAIL CLOSED (`throw toolError(...)`) when every
 * value in the body derives from the failed fetch, so there is nothing truthful
 * left to say — see computePnlToday. REPORT UNKNOWN when independent fetches are
 * aggregated and some succeeded: the failed field goes `null`, `partial-read`
 * flips true, and `unavailable-fields` names it with the taxonomy code — see
 * computeAccountSummary.
 *
 * All failure text routes through `adaptError`, never `String(e.message)`: that
 * assigns the taxonomy code a tool call would return, and it is the
 * credential-redaction gate.
 */

import type { TastytradeClient } from "../api-client.js";
import type { AccessClass } from "./annotations.js";
import { adaptError, toolError } from "../safety/errors.js";
import type { ToolError } from "../safety/errors.js";
import {
  MAX_FIELD_FAILURE_CHARS,
  boundedText,
} from "../safety/bounded-text.js";
import { STREAMING_REFERENCE_MD } from "../resources/static/streaming-reference.js";
import { SYMBOLOGY_REFERENCE_MD } from "../resources/static/symbology-reference.js";
import { ORDER_FLOW_REFERENCE_MD } from "../resources/static/order-flow-reference.js";

export interface StaticResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: () => string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  /**
   * How much this template's `read` is allowed to change — the same three-way
   * split the tool registry declares, so the operator's read-only posture can be
   * asked about a resource read with the same question it asks about a tool
   * call.
   *
   * REQUIRED, not defaulted to `"read"`. Every one of the twelve templates is a
   * GET today, so a default would be correct for all of them and correct for
   * the wrong reason: `resources/read` reached `client.get` without ever
   * consulting `readOnlyMode`, and the reason nothing escaped was that no
   * template had anything to escape with. A required field makes the first
   * non-GET template a compile error until somebody classifies it, instead of a
   * write that silently ignores TASTYTRADE_READ_ONLY.
   */
  accessClass: AccessClass;
  /** Compiled regex with capture groups, one per `{placeholder}`. */
  pattern: RegExp;
  /** Names of the captured placeholders, in capture order. */
  keys: string[];
  /** Fetcher invoked when a concrete URI matches. */
  read: (
    client: TastytradeClient,
    params: Record<string, string>,
  ) => Promise<unknown>;
}

export const STATIC_RESOURCES: StaticResource[] = [
  {
    uri: "tastytrade://streaming-reference",
    name: "Streaming reference",
    description:
      "Bundled DXLink quote streamer + Account Streamer protocol docs — hosts, message order, auth, " +
      "event types. Read before instructing a user to connect to either streamer.",
    mimeType: "text/markdown",
    text: () => STREAMING_REFERENCE_MD,
  },
  {
    uri: "tastytrade://symbology-reference",
    name: "Symbology + API reference",
    description:
      "OCC option symbology, futures/futures-option symbology, request headers, JSON case " +
      "conventions, API versioning. Read before constructing symbols or interpreting responses.",
    mimeType: "text/markdown",
    text: () => SYMBOLOGY_REFERENCE_MD,
  },
  {
    uri: "tastytrade://order-flow-reference",
    name: "Order flow reference",
    description:
      "Order lifecycle, status transitions, partial-fill semantics, complex-order " +
      "relationships (OTO/OCO/OTOCO/BLAST/PAIRS).",
    mimeType: "text/markdown",
    text: () => ORDER_FLOW_REFERENCE_MD,
  },
];

/** Compile a `{key}`-style URI template into a regex + ordered key list. */
function compileTemplate(uriTemplate: string): {
  pattern: RegExp;
  keys: string[];
} {
  const keys: string[] = [];
  const escaped = uriTemplate.replace(
    /\{([^}]+)\}|([.*+?^${}()|[\]\\])/g,
    (_, key, special) => {
      if (key) {
        keys.push(key);
        return "([^/]+)";
      }
      return "\\" + special;
    },
  );
  return { pattern: new RegExp(`^${escaped}$`), keys };
}

/** Build a ResourceTemplate from a literal-template string + metadata. */
function template(
  uriTemplate: string,
  name: string,
  description: string,
  mimeType: string,
  accessClass: AccessClass,
  read: ResourceTemplate["read"],
): ResourceTemplate {
  const { pattern, keys } = compileTemplate(uriTemplate);
  return {
    uriTemplate,
    name,
    description,
    mimeType,
    accessClass,
    pattern,
    keys,
    read,
  };
}

/**
 * Bound a URI-derived parameter before echoing it into an error message. Every
 * value a template extracts is caller-controlled text of unbounded length.
 */
function clipParam(value: string): string {
  return value.length > 32 ? `${value.slice(0, 32)}…` : value;
}

/** Map a `range` ("1d"/"1w"/"1m"/"3m"/"6m"/"1y"/"all") → API `time-back` value. */
function rangeToTimeBack(range: string): string {
  const allowed = ["1d", "1w", "1m", "3m", "6m", "1y", "all"];
  if (!allowed.includes(range)) {
    // A rejected range is a caller mistake, not an upstream fault, so it carries
    // the `validation` code — which ReadResource maps onto JSON-RPC -32602
    // InvalidParams instead of -32603 InternalError. Thrown as a bare Error this
    // classified as `upstream_error`, telling an agent the broker had failed when
    // the URI it built was simply wrong.
    throw toolError({
      code: "validation",
      message: `Unsupported NLV range "${clipParam(range)}". Use one of: ${allowed.join(", ")}.`,
      retryable: false,
      hint: "Re-read the resource with one of the listed ranges in the final URI segment.",
    });
  }
  return range;
}

// ---------------------------------------------------------------------------
// Fetch-failure plumbing for the computed resources
// ---------------------------------------------------------------------------

/**
 * A field a resource could not read.
 *
 * Emitted INSTEAD of a plausible-looking value, never alongside one. `code` is
 * the same taxonomy a tool call would return for the same failure, and every
 * string here has been through `adaptError`'s credential redaction.
 */
export interface UnavailableField {
  /** The key in the resource body whose value could not be read. */
  field: string;
  code: ToolError["code"];
  message: string;
  retryable: boolean;
  /** Present only for an HTTP-level failure that reported a status. */
  "upstream-status"?: number;
}

/** The outcome of one of a computed resource's fetches. */
type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; failure: UnavailableField };

/**
 * Describe a thrown fetch failure for inclusion in a resource body.
 *
 * `adaptError` rather than `String(e.message)` for three reasons. It assigns the
 * real taxonomy code, so an agent branches on `auth_failed` vs `upstream_error`
 * instead of grepping prose. It is the redaction gate: a resource body is an egress
 * path exactly as a ToolError is, and an axios message can carry the request URL —
 * which for a `TASTYTRADE_API_URL` containing userinfo carries credentials with it.
 *
 * AND IT IS THE SIZE GATE. That same URL contains the caller's own path segments,
 * so without a bound this field carries a caller-supplied value at unbounded length
 * while `clipParam` bounds the SAME value to 32 characters in the same sentence.
 *
 * The bound belongs here because this is the only function in the file that
 * constructs an `UnavailableField`, so one line covers both the throwing paths and
 * the 200-OK body path — the sharper of the two, since `unavailable-fields` is
 * named by the body's own `warning` in a success envelope.
 *
 * `MAX_FIELD_FAILURE_CHARS`, not `MAX_ENVELOPE_TEXT_CHARS`: a per-field line and a
 * whole envelope are different surfaces, and this one sits beside a 32-character
 * operand.
 */
function describeFailure(field: string, e: unknown): UnavailableField {
  const err = adaptError(e);
  const status = err.upstream?.status;
  return {
    field,
    code: err.code,
    message: boundedText(err.message, {
      maxChars: MAX_FIELD_FAILURE_CHARS,
      collapseWhitespace: true,
    }),
    retryable: err.retryable,
    ...(typeof status === "number" && status > 0
      ? { "upstream-status": status }
      : {}),
  };
}

/** Run one of a computed resource's fetches, capturing failure as data. */
async function settle<T>(
  field: string,
  fetch: () => Promise<T>,
): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fetch() };
  } catch (e) {
    return { ok: false, failure: describeFailure(field, e) };
  }
}

/**
 * Narrow a settled list fetch to a real array.
 *
 * "The call did not throw" is not evidence that a list came back: the client
 * reads `.data.data.items` with no fallback, so a 200 whose payload omits
 * `items` resolves to `undefined`. Coercing that to `[]` would report "no
 * positions" for a response that never contained the list at all — the same
 * fabrication as swallowing a 500, with no error anywhere to notice.
 */
function settledList(
  field: string,
  settled: Settled<unknown>,
): Settled<unknown[]> {
  if (!settled.ok) return settled;
  if (Array.isArray(settled.value)) return { ok: true, value: settled.value };
  return {
    ok: false,
    failure: {
      field,
      code: "upstream_error",
      message: `The ${field} request succeeded but its payload carried no item list, so the ${field} are unknown.`,
      retryable: true,
    },
  };
}

/** Collect the failures out of a set of settled fetches. */
function failuresOf(...settled: Array<Settled<unknown>>): UnavailableField[] {
  return settled
    .filter((s): s is { ok: false; failure: UnavailableField } => !s.ok)
    .map((s) => s.failure);
}

const PARTIAL_SUMMARY_WARNING =
  "INCOMPLETE READ. Every field named in `unavailable-fields` is null because its upstream " +
  "request failed: null means UNKNOWN, not zero and not empty. In particular a null " +
  "`position-count` does NOT mean the account is flat, and a null `open-position-symbols` " +
  "does NOT mean there is nothing open. Do not act on an unavailable field — retry, or call " +
  "the equivalent tool to see the failure directly.";

/**
 * Compute a one-page account summary from the live API — full balance object,
 * position count and trading-status state in a structure agents can render.
 *
 * The three fetches are independent, so one failure must not discard the two that
 * worked, and must not be invisible either: a failed fetch yields `null` for its
 * field, an entry under `unavailable-fields` naming it with the taxonomy code, and
 * `partial-read: true`.
 *
 * `position-count` and `open-position-symbols` are why this matters. Computed off
 * a `.catch(() => [])`, an outage produces `"position-count": 0` and an empty
 * symbol list — a body stating without qualification that the account holds
 * nothing, which an agent can act on: liquidate nothing, re-open a position it
 * already has, report a flat book to a human. `null` cannot be mistaken for a
 * count; `0` can.
 *
 * If all three fail there is no summary left, so the read fails closed with the
 * taxonomy of the first failure rather than returning a page of nulls.
 */
async function computeAccountSummary(
  client: TastytradeClient,
  accountNumber: string,
) {
  const [balances, rawPositions, status] = await Promise.all([
    settle("balances", () => client.getBalances(accountNumber)),
    settle("positions", () =>
      client.getPositions(accountNumber, { "include-marks": true }),
    ),
    settle("trading-status", () => client.getAccountStatus(accountNumber)),
  ]);
  const positions = settledList("positions", rawPositions);
  const unavailable = failuresOf(balances, positions, status);

  if (unavailable.length === 3) {
    throw toolError({
      code: unavailable[0].code,
      message: `Could not read any part of the summary for account ${clipParam(accountNumber)}: ${unavailable[0].message}`,
      retryable: unavailable.some((u) => u.retryable),
      hint: "All three upstream reads (balances, positions, trading status) failed, so nothing about this account could be established. Treat its state as UNKNOWN — not as empty, flat or unfunded — and retry, or call the equivalent tools to see each failure.",
    });
  }

  return {
    "account-number": accountNumber,
    "partial-read": unavailable.length > 0,
    "unavailable-fields": unavailable,
    ...(unavailable.length > 0 ? { warning: PARTIAL_SUMMARY_WARNING } : {}),
    balances: balances.ok ? balances.value : null,
    "trading-status": status.ok ? status.value : null,
    "position-count": positions.ok ? positions.value.length : null,
    "open-position-symbols": positions.ok
      ? positions.value
          .map((p: any) => p?.symbol)
          .filter((s: unknown): s is string => typeof s === "string")
      : null,
  };
}

/**
 * Parse an API numeric, or null when it cannot be read as a finite number.
 *
 * The API string-encodes decimals ("185.25"), so strings are accepted — but only
 * strings and numbers. `Number([])` is 0 and `Number(true)` is 1, so coercing
 * anything else would invent a price out of a malformed payload.
 */
function finiteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A running sum is only a number if at least one row fed it. A total of `0` over
 * rows that were ALL unreadable is indistinguishable from a genuine "made nothing
 * today", so it is reported as unknown. A zero-row account is a real,
 * successfully-read flat book and keeps its `0`.
 *
 * The sum goes through `finiteOrNull` because a total of individually finite rows
 * can still be unrepresentable: `(Infinity).toFixed(2)` is the string
 * `"Infinity"`, and `JSON.stringify` renders it as the JSON literal `null`, which
 * is this module's encoding for UNKNOWN. Callers distinguish the two nulls with
 * `rows > 0 && contributors > 0`.
 */
function sumOrNull(
  sum: number,
  contributors: number,
  rows: number,
): number | null {
  if (rows > 0 && contributors === 0) return null;
  return finiteOrNull(Number(sum.toFixed(2)));
}

const PARTIAL_PNL_WARNING =
  "INCOMPLETE ESTIMATE. Every entry under `positions-excluded-from-estimate` names what could not " +
  "be computed and why: `unreadable-fields` for a field the API did not supply, " +
  "`non-finite-fields` for a derived figure whose arithmetic did not produce a finite number, and " +
  "`non-finite-total` for an account total that did not. Those figures carry null (UNKNOWN, not " +
  "zero), and the account totals omit exactly those figures — so a total here is a lower bound on " +
  "the day's activity, not a complete P&L, and a null total means nothing could be computed at all.";

/**
 * Compute today's P&L for the account from live positions: `realized-day-gain`
 * plus (mark-price − close-price) × quantity × multiplier as the unrealized
 * estimator. A best-effort computed view; use the transactions endpoint for
 * reconciliation.
 *
 * Every number derives from the single positions fetch, so a failed fetch leaves
 * nothing truthful to return and the read FAILS CLOSED. A `.catch(() => [])` would
 * answer an outage with zeros and an empty `positions` — a confident "you are flat
 * and made nothing today". An error is recoverable; a fabricated zero is not.
 *
 * Per-position pricing is held to the same standard. `mark-price` and `close-price`
 * are both optional (the vendored spec's own example payload carries neither), and
 * a missing price must not default to `0`: with `close-price` absent — routine for
 * a position opened today — that turns the whole position value into a fabricated
 * day gain. Such a row reports `null`, is excluded from the totals, and is named
 * in `positions-excluded-from-estimate`.
 *
 * A row can fail for a second reason and is disclosed separately: four finite
 * inputs can multiply to `Infinity` or, via `Infinity * 0`, to `NaN`. Those go
 * `null` under `non-finite-fields` / `non-finite-total` rather than
 * `unreadable-fields`, so the body says which happened rather than asserting a
 * cause — keying the disclosure on input readability alone leaves an overflowed
 * row with `partial-read: false` and a note claiming a missing input beside a row
 * whose inputs were all present.
 *
 * There is deliberately no `mark-price` → `mark` fallback: `mark` is the position's
 * TOTAL value, so feeding it to an estimator that multiplies by quantity ×
 * multiplier again overstates the result by that factor.
 */
async function computePnlToday(
  client: TastytradeClient,
  accountNumber: string,
) {
  const positions = settledList(
    "positions",
    await settle("positions", () =>
      client.getPositions(accountNumber, { "include-marks": true }),
    ),
  );
  if (!positions.ok) {
    throw toolError({
      code: positions.failure.code,
      message: `Could not read positions for account ${clipParam(accountNumber)}, so no P&L could be computed: ${positions.failure.message}`,
      retryable: positions.failure.retryable,
      hint: "Day P&L is derived entirely from the positions read, so a failed read leaves nothing to report. Treat the P&L and the position list as UNKNOWN — not as zero and not as flat — and retry.",
    });
  }
  const list = positions.value;

  let realized = 0;
  let realizedRows = 0;
  let unrealized = 0;
  let unrealizedRows = 0;
  const perPosition: Array<Record<string, unknown>> = [];
  const excluded: Array<Record<string, unknown>> = [];

  for (const raw of list) {
    // A row that is not an object at all (a truncated or hostile payload) says
    // nothing about anything, so every one of its fields is unknown. It must not
    // inherit the absent-field defaults below: those read a missing key on a real
    // position as information, which a non-position cannot supply.
    const readable = raw !== null && typeof raw === "object";
    const p = (readable ? raw : {}) as Record<string, unknown>;
    const symbol = typeof p.symbol === "string" ? p.symbol : null;
    const direction = String(p["quantity-direction"] ?? "Long");
    const sign = direction === "Short" ? -1 : 1;
    const qty = finiteOrNull(p.quantity);
    const mark = finiteOrNull(p["mark-price"]);
    const close = finiteOrNull(p["close-price"]);
    // An ABSENT multiplier is 1 by API convention (equities); a present but
    // unreadable one is unknown and must not silently become 1.
    const mult = !readable
      ? null
      : p.multiplier === undefined || p.multiplier === null
        ? 1
        : finiteOrNull(p.multiplier);

    const unreadable: string[] = [];
    if (qty === null) unreadable.push("quantity");
    if (mult === null) unreadable.push("multiplier");
    if (mark === null) unreadable.push("mark-price");
    if (close === null) unreadable.push("close-price");

    // `Number.isFinite` on four operands says nothing about their product, so
    // the product goes through the same guard the inputs did. Two ordinary
    // IEEE-754 outcomes escape otherwise: overflow (1 * 99 * 1e308 * 1e10 is
    // `Infinity`) and `Infinity * 0` (a huge finite price difference on a
    // zero-quantity row is `NaN`). Both are admitted by a bare null check, because
    // `NaN !== null` and `Infinity !== null` are both true — which would also count
    // the poisoned row as a good contributor and defeat `sumOrNull`'s contributor
    // test.
    const inputsReadable =
      qty !== null && mult !== null && mark !== null && close !== null;
    const nonFinite: string[] = [];
    const positionUnrealized = inputsReadable
      ? finiteOrNull(sign * (mark - close) * qty * mult)
      : null;
    if (inputsReadable && positionUnrealized === null) {
      nonFinite.push("estimated-unrealized-day-pnl");
    }
    if (positionUnrealized !== null) {
      unrealized += positionUnrealized;
      unrealizedRows += 1;
    }

    // An absent realized-day-gain reads as "no realized activity today", which
    // is what the API means by omitting it — and unlike a price it is not
    // multiplied by anything, so a wrong 0 cannot be amplified. A field that IS
    // present but unreadable is unknown.
    const rawRealized = p["realized-day-gain"];
    const realizedMagnitude = !readable
      ? null
      : rawRealized === undefined || rawRealized === null
        ? 0
        : finiteOrNull(rawRealized);
    if (realizedMagnitude === null) unreadable.push("realized-day-gain");
    const realizedEffect = String(p["realized-day-gain-effect"] ?? "None");
    const realizedSigned =
      realizedMagnitude === null
        ? null
        : realizedEffect === "Debit"
          ? -realizedMagnitude
          : realizedMagnitude;
    if (realizedSigned !== null) {
      realized += realizedSigned;
      realizedRows += 1;
    }

    // The row's own total is a second derived figure, so it gets the same
    // treatment: two finite addends can overflow.
    const rowTotal =
      realizedSigned === null || positionUnrealized === null
        ? null
        : finiteOrNull(realizedSigned + positionUnrealized);
    if (
      realizedSigned !== null &&
      positionUnrealized !== null &&
      rowTotal === null
    ) {
      nonFinite.push("estimated-total-day-pnl");
    }

    // One entry per dropped row, naming BOTH reasons separately, because the
    // body's `note` and `warning` assert a cause and the two causes are not the
    // same claim: `unreadable-fields` means the API did not supply the input,
    // `non-finite-fields` means it did and the arithmetic could not be
    // represented.
    if (unreadable.length > 0 || nonFinite.length > 0) {
      excluded.push({
        symbol,
        ...(unreadable.length > 0 ? { "unreadable-fields": unreadable } : {}),
        ...(nonFinite.length > 0 ? { "non-finite-fields": nonFinite } : {}),
      });
    }

    perPosition.push({
      symbol,
      "instrument-type": p["instrument-type"] ?? null,
      "quantity-direction": readable ? direction : null,
      quantity: qty,
      "close-price": close,
      "mark-price": mark,
      "realized-day-gain": realizedSigned,
      "estimated-unrealized-day-pnl": positionUnrealized,
      "estimated-total-day-pnl": rowTotal,
    });
  }

  const realizedTotal = sumOrNull(realized, realizedRows, list.length);
  const unrealizedTotal = sumOrNull(unrealized, unrealizedRows, list.length);

  // A total can be unrepresentable even when every row that fed it was finite,
  // and no per-row entry can name that. `sumOrNull` returns null for exactly two
  // reasons and they are distinguishable here: with contributors > 0 the null is
  // the non-finite one, so the body says so instead of emitting a bare null next
  // to `partial-read: false`.
  if (realizedRows > 0 && realizedTotal === null) {
    excluded.push({ "non-finite-total": "realized-day-pnl" });
  }
  if (unrealizedRows > 0 && unrealizedTotal === null) {
    excluded.push({ "non-finite-total": "estimated-unrealized-day-pnl" });
  }
  const grandTotal =
    realizedTotal === null || unrealizedTotal === null
      ? null
      : finiteOrNull(Number((realizedTotal + unrealizedTotal).toFixed(2)));
  if (
    realizedTotal !== null &&
    unrealizedTotal !== null &&
    grandTotal === null
  ) {
    excluded.push({ "non-finite-total": "estimated-total-day-pnl" });
  }

  return {
    "account-number": accountNumber,
    "computed-at": new Date().toISOString(),
    "partial-read": excluded.length > 0,
    "positions-excluded-from-estimate": excluded,
    ...(excluded.length > 0 ? { warning: PARTIAL_PNL_WARNING } : {}),
    "realized-day-pnl": realizedTotal,
    "estimated-unrealized-day-pnl": unrealizedTotal,
    "estimated-total-day-pnl": grandTotal,
    note:
      "Unrealized component is an estimate from mark-price - close-price * quantity * multiplier; " +
      "for institutional reconciliation use the transactions endpoint. A null figure means the " +
      "value is UNKNOWN — unknown, not zero — for one of two reasons: an input was missing or " +
      "unreadable in the API payload, or a derived figure could not be represented as a finite " +
      "number. `positions-excluded-from-estimate` says which reason applied to which row.",
    positions: perPosition,
  };
}

export const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  template(
    "tastytrade://accounts",
    "Accounts",
    "All accounts for the authenticated user (raw GET /customers/me/accounts).",
    "application/json",
    "read",
    async (client) => client.getAccounts(),
  ),
  template(
    "tastytrade://accounts/{account_number}/summary",
    "Account summary",
    "One-page computed view: balances + trading status + open-position count + position symbols.",
    "application/json",
    "read",
    async (client, p) => computeAccountSummary(client, p.account_number),
  ),
  template(
    "tastytrade://accounts/{account_number}/positions",
    "Account positions",
    "Current open positions with mark prices (include_marks defaults to true).",
    "application/json",
    "read",
    async (client, p) =>
      client.getPositions(p.account_number, { "include-marks": true }),
  ),
  template(
    "tastytrade://accounts/{account_number}/orders/live",
    "Today's orders",
    "Today's orders for the account (any status).",
    "application/json",
    "read",
    async (client, p) => client.getLiveOrders(p.account_number),
  ),
  template(
    "tastytrade://accounts/{account_number}/pnl-today",
    "Today's P&L (computed)",
    "Realized + estimated unrealized day P&L. Computed view, not a 1:1 API proxy.",
    "application/json",
    "read",
    async (client, p) => computePnlToday(client, p.account_number),
  ),
  template(
    "tastytrade://accounts/{account_number}/nlv-history/{range}",
    "NLV history",
    "Net liquidating value over time. Range: 1d, 1w, 1m, 3m, 6m, 1y, all.",
    "application/json",
    "read",
    async (client, p) =>
      client.getNetLiquidatingValueHistory(p.account_number, {
        "time-back": rangeToTimeBack(p.range),
      }),
  ),
  template(
    "tastytrade://watchlists",
    "User watchlists",
    "All user watchlists.",
    "application/json",
    "read",
    async (client) => client.getWatchlists(),
  ),
  template(
    "tastytrade://watchlists/{name}",
    "User watchlist",
    "Single user watchlist by name.",
    "application/json",
    "read",
    async (client, p) => client.getWatchlist(p.name),
  ),
  template(
    "tastytrade://public-watchlists",
    "Public watchlists",
    "tastytrade's curated public watchlists.",
    "application/json",
    "read",
    async (client) => client.getPublicWatchlists(),
  ),
  template(
    "tastytrade://public-watchlists/{name}",
    "Public watchlist",
    "Single curated public watchlist.",
    "application/json",
    "read",
    async (client, p) => client.getPublicWatchlist(p.name),
  ),
  template(
    "tastytrade://market/session",
    "Current market session",
    "Current session state across Equity / CME / CFE.",
    "application/json",
    "read",
    async (client) => client.getCurrentSessionsMulti(["Equity", "CME", "CFE"]),
  ),
  template(
    "tastytrade://market/holidays",
    "Equity holiday calendar",
    "Equity market holidays. Use tastytrade_get_market_holidays for futures-exchange-specific lists.",
    "application/json",
    "read",
    async (client) => client.getEquityHolidays(),
  ),
];

/** Find a static resource by exact URI match. */
export function findStaticResource(uri: string): StaticResource | undefined {
  return STATIC_RESOURCES.find((r) => r.uri === uri);
}

/** A template that claimed a URI, with the parameters it extracted. */
export interface TemplateMatch {
  template: ResourceTemplate;
  params: Record<string, string>;
}

/**
 * Find the ONE template in `templates` that claims `uri`, or null if none does.
 *
 * Order-independent on purpose. Returning the FIRST match makes array order
 * load-bearing: the day two templates overlap, whichever is listed second becomes
 * silently unreachable and its URIs are served by its neighbour's `read()`. Nothing
 * about that is visible from outside — the reply is a well-formed body for the
 * wrong resource, which here means one account's figures under a URI naming
 * something else.
 *
 * So every pattern is tried and an ambiguous URI is REFUSED rather than
 * arbitrated. An overlap is a registry defect, and picking a winner by array
 * position answers neither honest question.
 *
 * @param templates the registry to search. A parameter only so the ambiguity
 * branch is reachable from a test.
 */
export function matchTemplateIn(
  templates: readonly ResourceTemplate[],
  uri: string,
): TemplateMatch | null {
  const claimants: Array<{ template: ResourceTemplate; m: RegExpExecArray }> =
    [];
  for (const t of templates) {
    const m = t.pattern.exec(uri);
    if (m) claimants.push({ template: t, m });
  }

  if (claimants.length === 0) return null;
  if (claimants.length > 1) {
    throw toolError({
      code: "upstream_error",
      message:
        `Resource URI ${clipParam(uri)} is claimed by more than one registered template ` +
        `(${claimants.map((c) => c.template.uriTemplate).join(", ")}), so which resource it names is undefined.`,
      // Nothing about the request is wrong and nothing about it will change, so
      // a retry is a wasted round-trip.
      retryable: false,
      hint: "This is a defect in the server's own resource registry, not in the request: two templates were registered with overlapping URI patterns, so this URI has no single meaning. Retrying will not help. Use the equivalent tool call for the data, and report the overlapping templates named above.",
    });
  }

  const { template, m } = claimants[0];
  const params: Record<string, string> = {};
  template.keys.forEach((k, i) => {
    params[k] = decodeSegment(k, m[i + 1]);
  });
  return { template, params };
}

/**
 * Percent-decode one captured URI segment, or refuse the read.
 *
 * `decodeURIComponent` is not total: a bare `%`, or a truncated escape like `%zz`,
 * throws `URIError`. Uncaught, a malformed URI escapes as a bare JSON-RPC `-32603
 * "URI malformed"` — no taxonomy code, never through `sanitizeToolError` — which a
 * client cannot branch on and which reads as "the server broke" when the caller's
 * URI is simply wrong.
 *
 * The mirror of `pathParam` in src/api-client.ts, which catches the same on the
 * OUTBOUND side: an argument fault must not be reported as a broker fault.
 */
function decodeSegment(key: string, raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw toolError({
      code: "validation",
      message:
        `The "${key}" segment of the resource URI is not valid percent-encoding: ` +
        `${clipParam(raw)}`,
      // The URI is malformed. It will be malformed on the next attempt too.
      retryable: false,
      hint: 'Percent-encode the segment properly — a "%" must introduce two hex digits (encodeURIComponent does this) — or send a segment with no "%" in it at all.',
    });
  }
}

/**
 * Match `uri` against the templates registry and return the matched
 * template + extracted params, or null if no template matches. Throws when the
 * registry is ambiguous about it — see {@link matchTemplateIn}.
 */
export function matchResourceTemplate(uri: string): TemplateMatch | null {
  return matchTemplateIn(RESOURCE_TEMPLATES, uri);
}
