/**
 * Pre-submit sanity checks for live order placement.
 *
 * Three layers:
 *   1. The API enforces its own position limits.
 *   2. Those limits are re-checked locally, so an obvious bust returns a clean
 *      `sanity_check_failed` rather than a 422.
 *   3. An env-configurable notional cap (`MAX_ORDER_NOTIONAL_USD`, default
 *      $50K) catches a quantity off by a factor of a thousand, which no remote
 *      API will catch for us.
 *
 * Account state (`is-frozen`, `is-closing-only`, `is-in-margin-call`) is checked
 * here too, so orders are not shipped into accounts that will bounce them.
 *
 * Every branch fails CLOSED. A check that cannot be performed refuses the order
 * rather than waving it through: an unusable `MAX_ORDER_NOTIONAL_USD` falls back
 * to the default instead of disabling the cap, a leg quantity that is not a
 * positive finite number is refused rather than compared as `NaN`, and an
 * unreadable dry-run payload is a hard block — "we could not look" is not the
 * same claim as "we looked and it was fine".
 *
 * Where a check is genuinely soft — the account lookups, which the API enforces
 * server-side anyway — the caller is ALWAYS told which checks did not run. A
 * position-limit payload that is unreadable, that carries no usable ceiling for a
 * leg's instrument class, or a leg whose class has no published ceiling produces
 * a warning rather than something that reads like a clean pass. There is
 * deliberately no fallthrough onto another class's ceiling: comparing a quantity
 * against a limit that does not govern it is not a check, and it hides that none
 * ran. A partial payload is normal per the vendored spec
 * (open-api-spec/account-status.md), so a body carrying none of the flags is a
 * shape to expect.
 *
 * Account state is the one place a hard block degrades to a warning: if
 * GET /trading-status cannot be read, the API is the backstop. That is
 * acceptable only because the degradation is always stated.
 *
 * Anything this module says to the caller — warning as much as refusal — is an
 * egress path. BROKER-supplied text is scrubbed and bounded where it is rendered
 * (see describeDryRunNote), because it is written by a party that has seen this
 * server's `Authorization` header. AGENT-supplied echoes (describeSymbol,
 * describeInstrumentType, describeQuantity) are clipped but not scrubbed: they
 * repeat the caller's own argument back to it.
 *
 * TODO(open-question-2): per-account thresholds. Right now this is a single
 *   env var. If a margin account and a cash account need different caps,
 *   switch to MAX_ORDER_NOTIONAL_USD__<account>= overrides.
 */

import { TastytradeClient } from "../api-client.js";
import { boundedText } from "./bounded-text.js";
import { redactDeep, redactSecrets, toolError } from "./errors.js";
import { chargeUpstreamCallDebt } from "./rate-limit.js";

interface OrderLeg {
  "instrument-type"?: string;
  symbol?: string;
  action?: string;
  quantity?: number | string;
}

/**
 * The kebab-case body POSTed to the API. Single orders carry `legs[]`
 * directly; complex orders carry `trigger-order` and/or `orders[]` with
 * each component holding its own `legs[]`. flattenLegs handles both.
 */
export interface OutboundOrderBody {
  legs?: OrderLeg[];
  "trigger-order"?: { legs?: OrderLeg[]; [k: string]: unknown };
  orders?: Array<{ legs?: OrderLeg[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Flatten every leg in an order body, regardless of whether it's a single
 * order or a complex (OTO/OCO/OTOCO/BLAST/PAIRS) order. Used by the
 * per-leg position-limit check so the same logic covers both shapes.
 */
function flattenLegs(body: OutboundOrderBody): OrderLeg[] {
  if (Array.isArray(body.legs) && body.legs.length > 0) return body.legs;
  const out: OrderLeg[] = [];
  if (body["trigger-order"]?.legs) out.push(...body["trigger-order"].legs);
  if (Array.isArray(body.orders)) {
    for (const o of body.orders) {
      if (Array.isArray(o.legs)) out.push(...o.legs);
    }
  }
  return out;
}

/**
 * The per-order size ceilings this check compares a leg against.
 *
 * One field per instrument class the API publishes a ceiling for
 * (open-api-spec/risk-parameters.md, PositionLimit). Every class needs its own
 * field: with none to select, a "Future Option" leg falls through to
 * `equity-option-order-size`, a ceiling typically orders of magnitude looser, on
 * the highest-notional class this server supports.
 */
export const PUBLISHED_ORDER_SIZE_FIELDS = [
  "equity-order-size",
  "equity-option-order-size",
  "future-order-size",
  "future-option-order-size",
] as const;

type OrderSizeField = (typeof PUBLISHED_ORDER_SIZE_FIELDS)[number];

interface PositionLimit {
  "equity-order-size"?: number;
  "equity-option-order-size"?: number;
  "future-order-size"?: number;
  "future-option-order-size"?: number;
  "underlying-opening-order-limit"?: number;
  [k: string]: unknown;
}

interface TradingStatus {
  "is-frozen"?: boolean;
  "is-closing-only"?: boolean;
  "is-in-margin-call"?: boolean;
  "is-risk-reducing-only"?: boolean;
  [k: string]: unknown;
}

/**
 * The account-state flags this module actually reads off a trading status.
 *
 * Declared as data because two things need the list: the checks themselves and
 * the disclosure that fires when a payload carries none of them. A flag added to
 * the chain but not the list is a check nobody is told did not run; a flag added
 * to the list but not the chain SUPPRESSES the disclosure for a payload where
 * nothing was checked. The second is the dangerous direction, so the list is
 * exactly the flags that are read.
 *
 * All four are named under "Pre-trade validation" in
 * tastytrade-llms-txt-docs/docs/open-api-spec/account-status.md.
 */
const ACCOUNT_STATE_FLAGS = [
  "is-frozen",
  "is-closing-only",
  "is-in-margin-call",
  "is-risk-reducing-only",
] as const;

/**
 * Did this trading-status payload carry a readable value for ANY account-state
 * flag?
 *
 * `null` counts as absent, not `false`. A JSON null in a boolean field is not a
 * broker saying "no"; reading it as "not frozen" is the same fail-open as never
 * looking.
 *
 * ANY rather than ALL, and deliberately not mirroring the position-limit half's
 * per-ceiling warning: the vendored spec says only fields relevant to the
 * account's current configuration are returned, so a healthy account legitimately
 * omits individual flags and a warning per absent flag would fire on nearly every
 * order — noise that stops carrying information. What ANY catches is the case
 * where there is no evidence the payload is a trading status at all: `{}`, a body
 * of nulls, or an envelope skew nesting the real status one level down.
 */
function readsAnyAccountStateFlag(status: Record<string, unknown>): boolean {
  return ACCOUNT_STATE_FLAGS.some((flag) => {
    const v = status[flag];
    return v !== undefined && v !== null;
  });
}

interface DryRunLike {
  errors?: unknown;
  // Both of these are `unknown` for the same reason: they come off the wire,
  // and the declared shape is what the API documents rather than what a proxy,
  // a version skew or an error page will actually hand us. Every read of them
  // goes through describeDryRunNote, which is total for any shape.
  warnings?: unknown;
  "buying-power-effect"?: {
    "change-in-buying-power"?: number | string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * Is this something we can actually read fields off? The API returns JSON
 * objects; `null`, a scalar, or an array means either the upstream shape
 * changed or a proxy mangled the response. In every one of those cases we have
 * no answer, and per this module's rule the only safe reading is "we could not
 * look" — never "we looked and it was fine".
 *
 * Used for all three payloads this function is handed from the network: the
 * dry-run verdict (a hard block), the account position limits (a warning) and
 * the account trading status (a warning). All three go through the same
 * predicate on purpose. The trading status is the payload carrying the only
 * checks in here that HARD-BLOCK on account state, so it is where the rule bites
 * hardest: a payload that cannot be read must never read as a check that passed.
 * One predicate for all three is what makes that unbranchable.
 */
function isReadablePayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Name the offending shape, so the operator can diagnose it. */
function describeUnreadablePayload(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "an array, not an object";
  return `not an object (${typeof value})`;
}

/**
 * Does one member of a dry-run payload carry anything at all?
 *
 * The API documents both as arrays, but an `errors` OBJECT has no `.length`, so
 * an `errors?.length` test reads it as falsy and treats an errored dry-run as
 * clean. This covers every shape: absent or null is nothing; an empty array,
 * object or string is nothing; anything else, including a scalar, is SOMETHING.
 *
 * A scalar is a shape we do not understand, and both callers want the same answer
 * — `errors: 1` is an error we cannot read, `buying-power-effect: 1` an effect we
 * cannot read but which the broker stated. Unrecognised counts as content, which
 * is the cautious reading in both directions.
 *
 * Shared rather than written twice: the two questions the token gate asks are the
 * same question about different members, and must not drift.
 */
function carriesContent(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * Does the payload's `errors` field carry anything at all?
 *
 * Errs toward "errored": refusing an order we cannot vet costs one repeated
 * dry-run; accepting it can cost money.
 */
function hasDryRunErrors(dryRun: Record<string, unknown>): boolean {
  return carriesContent(dryRun.errors);
}

/**
 * The members whose presence PROVES the broker actually looked at the order.
 *
 * From `PlacedOrderResponse` in the vendored spec (open-api-spec/orders.md):
 * `order` for a single order, `complex-order` for a complex one,
 * `buying-power-effect` for the projected impact of either. They are
 * ALTERNATIVES, not a set — a complex dry-run carries `complex-order` and
 * `buying-power-effect` and no `order` at all, so demanding a single named field
 * would make a whole order class untradeable.
 *
 * Nothing else qualifies: `warnings` is routinely `[]` on a good order, and
 * `notes` and `fee-calculation` are decoration. None says the broker priced
 * anything.
 */
const DRY_RUN_ORDER_EVIDENCE = [
  "order",
  "complex-order",
  "buying-power-effect",
] as const;

/**
 * Did this dry-run describe an order, or merely fail to complain about one?
 *
 * The absence of `errors` is not a verdict. An empty `{}`, a `{warnings: []}`,
 * a body a proxy rewrote — each is a readable object with no errors, and each
 * would mint a confirmation token authorising a LIVE order the broker never saw.
 * `MAX_ORDER_NOTIONAL_USD` is computed from `buying-power-effect`, so a placement
 * built on a contentless dry-run runs with the notional ceiling downgraded to a
 * warning string — the last mechanical guard against a quantity multiplied by a
 * thousand, on exactly the payload that proves nothing was checked.
 *
 * The rule lives here rather than in the output schema so that it applies to
 * every client, whether it validates or not.
 */
function describedAnOrder(dryRun: Record<string, unknown>): boolean {
  return DRY_RUN_ORDER_EVIDENCE.some((field) => carriesContent(dryRun[field]));
}

/**
 * Most broker notes this module will repeat back from one dry-run.
 *
 * The COUNT axis, and it is a separate bound from the per-note one for a reason
 * that was measured rather than assumed: `clipBrokerNote` caps ONE note at 240
 * characters and applies faithfully to every note, which leaves N notes free to
 * cost N x 263 characters. Measured with the count unbounded at N = 5,000 — every
 * element individually inside the per-note cap — the note list came out at 653,890
 * characters in a 668,959-byte envelope, with the server's own findings buried
 * five thousand elements down. Tightening MAX_BROKER_NOTE_CHARS does nothing
 * about that; only bounding the count does.
 *
 * 20 notes at 240 characters caps the channel at roughly 5 KB — two orders of
 * magnitude below the measured exposure, and generous against real tastytrade
 * behaviour, whose documented warnings are one or two prose sentences per
 * condition (order-submission.md, quoted in the comment on
 * MAX_BROKER_NOTE_CHARS below). The recorded sandbox dry-run carries two.
 *
 * Exported so the tests derive the bound from the source rather than restating
 * it — a literal in a test is how a stale figure passes a green run.
 */
export const MAX_DRY_RUN_NOTES = 20;

/** What a note container held, and how much of it did not fit. */
interface DryRunNoteBatch {
  notes: unknown[];
  /** How many notes were dropped at MAX_DRY_RUN_NOTES. Zero when none were. */
  omitted: number;
}

/**
 * Split an `errors` or `warnings` field into the individual notes it holds, up to
 * MAX_DRY_RUN_NOTES of them, and say how many did not fit.
 *
 * The documented shape is an array; everything else still has to be accounted for,
 * and a single note handed over bare is one note, not zero. Callers gate on
 * `carriesContent` first, so an absent field never reaches here.
 *
 * The bound lives HERE rather than at either call site, and the return TYPE makes
 * that structural: this is the single splitter for both fields, so a bound here is
 * one both inherit, and the function cannot be consumed without acknowledging
 * `omitted` — forgetting the disclosure is a compile error.
 *
 * Returning the count instead of silently slicing mirrors `clipBrokerNote`: on a
 * safety-verdict channel, a bound the caller cannot see silently shortens a
 * verdict, which is worse than a long one.
 */
function dryRunNotes(value: unknown): DryRunNoteBatch {
  const all = Array.isArray(value) ? value : [value];
  return all.length <= MAX_DRY_RUN_NOTES
    ? { notes: all, omitted: 0 }
    : {
        notes: all.slice(0, MAX_DRY_RUN_NOTES),
        omitted: all.length - MAX_DRY_RUN_NOTES,
      };
}

/**
 * The server's own line saying what it dropped, and how much there was.
 *
 * Authored by THIS SERVER, so it belongs in `warnings` and never in
 * `upstreamNotes` — see SanityCheckOutcome. On the errors path, which renders
 * into one thrown message rather than into an array, it is appended to that
 * message for the same reason.
 */
function describeOmittedNotes(omitted: number, total: number): string {
  return `[${omitted} further broker note(s) omitted; ${total} were sent]`;
}

/**
 * Longest broker-supplied note this module will repeat back.
 *
 * Deliberately NOT `MAX_ECHO_CHARS` (40), which bounds an echoed IDENTIFIER — a
 * symbol, an instrument type — inside a refusal sentence. A broker note is prose:
 * warnings "give you a heads up that your order will be rejected if you were to
 * try to route it" (order-submission.md). Clipping that at 40 characters throws
 * away the actionable half of the only channel that tells a human why a live order
 * is about to be refused. 240 holds two full sentences and still bounds what an
 * unrecognised blob can inject.
 */
const MAX_BROKER_NOTE_CHARS = 240;

/**
 * Bound one broker note: strip what makes it look like something it is not,
 * then clip, reporting the real length rather than hiding it.
 *
 * Bounding length alone is not enough, and the STRIP is not cosmetic: a single
 * note containing "\n- Account is closing-only." would arrive as ONE array
 * element rendering as TWO list items, and a note carrying U+202E does the same
 * trick to an account number. `boundedText` flattens the break class to spaces
 * and removes the invisible-format class outright.
 *
 * The shared helper rather than a second local stripper, deliberately. One
 * stripper per surface is a shape where the chokepoint you happen to be reading
 * tells you nothing about the others; `boundedText` is the single spelling of
 * this rule, so reading it once is reading every surface that applies it.
 */
function clipBrokerNote(text: string): string {
  return boundedText(text, { maxChars: MAX_BROKER_NOTE_CHARS });
}

/**
 * Render one broker-supplied note — an element of `errors` or of `warnings` —
 * into a single human-readable line, for every shape it can arrive in.
 *
 * Shared by both fields deliberately. An `if (w.message)` test throws a raw
 * TypeError on a null element and silently drops a note carrying only `code`,
 * while the documented shape is `[{code, message}]`. Two renderers for two fields
 * of one payload is how they drift, so there is one.
 *
 * Nothing readable is discarded: an unrecognised shape is stringified rather than
 * dropped, because a note the broker sent and this server swallowed is
 * indistinguishable to the caller from a note never sent.
 *
 * THE REDACTION AND THE BOUND LIVE HERE, not at the call sites, because the two
 * fields leave by routes with different protection: an `errors` rendering becomes
 * a ToolError and passes the dispatcher's mandatory `sanitizeToolError`, while a
 * `warnings` rendering is returned in the SUCCESS body and passes nothing. The
 * same upstream object would otherwise come out `Bearer [redacted]` down one path
 * and verbatim down the other. `redactSecrets` is idempotent, so scrubbing the
 * errors path twice costs nothing.
 *
 * Total by construction: `JSON.stringify` throws on a circular structure and on a
 * BigInt. Neither comes out of `JSON.parse`, so neither is reachable from the wire
 * today — but this payload is typed `unknown` precisely because we do not get to
 * assume where it came from, and a throw here lands on the agent as a raw V8
 * diagnostic AFTER `consumeToken` has burned its token.
 */
function describeDryRunNote(value: unknown): string {
  return clipBrokerNote(redactSecrets(renderDryRunNote(value)));
}

/** The rendering half of `describeDryRunNote`; scrubbing and bounding is its. */
function renderDryRunNote(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const rec = value as { message?: unknown; code?: unknown };
    if (typeof rec.message === "string" && rec.message) return rec.message;
    if (typeof rec.code === "string" && rec.code) return rec.code;
    try {
      return JSON.stringify(redactDeep(value)) ?? "an unrenderable object";
    } catch {
      return "an unrenderable object";
    }
  }
  if (value === undefined) return "unknown";
  // No guard around this `String()`, deliberately, where `describeQuantity` and
  // the dispatcher's `clipForMessage` both have one. Their input can be an
  // OBJECT that shadows `toString` and `valueOf` with non-callables, leaving it
  // with no primitive conversion and making `String()` itself throw. Nothing
  // like that reaches here: every object and every null went to a branch above,
  // so what is left is a number, a boolean, a bigint or a symbol, and `String()`
  // is total on all four.
  return String(value);
}

/**
 * Render an `errors` value of any shape into one human-readable line.
 *
 * Bounded on the count axis like its `warnings` twin, and it gets the bound even
 * though `assertNoDryRunErrors` is unreachable from the wire today — a payload
 * carrying `errors` never mints a token, because `isCleanDryRun` and
 * `assertNoDryRunErrors` call the same `hasDryRunErrors` predicate. Defence in
 * depth, in the same shape step 1c of `runSanityChecks` already applies, and the
 * count bound costs nothing here. It is also the more dangerous of the two to
 * leave unbounded: this rendering is JOINED INTO ONE STRING and becomes a
 * `sanity_check_failed` message, measured with the count unbounded at 338,905
 * characters of refusal for 5,000 notes.
 */
function describeDryRunErrors(errors: unknown): string {
  const batch = dryRunNotes(errors);
  const rendered = batch.notes
    .map(describeDryRunNote)
    .filter((note) => note.length > 0);
  if (batch.omitted > 0) {
    rendered.push(
      describeOmittedNotes(batch.omitted, batch.omitted + batch.notes.length),
    );
  }
  return rendered.length > 0 ? rendered.join("; ") : "unknown";
}

/**
 * The single gate on "may this dry-run mint a confirmation token?".
 *
 * Three questions, and all three have to be answered yes: the payload can be
 * read at all, it reports no errors, and it describes an order. The third is
 * what stops "the broker did not complain" being accepted as "the broker
 * approved" — see `describedAnOrder`.
 *
 * Exported so the dispatcher's issuance check and `runSanityChecks`' own
 * re-check are literally the same predicate. Two hand-written
 * `!dryRun?.errors?.length` tests, one per site, are a pair that can drift from
 * what the submit path enforces; one exported predicate cannot.
 */
export function isCleanDryRun(dryRun: unknown): boolean {
  return (
    isReadablePayload(dryRun) &&
    !hasDryRunErrors(dryRun) &&
    describedAnOrder(dryRun)
  );
}

/**
 * The documented default notional cap, in dollars.
 *
 * Used both when `MAX_ORDER_NOTIONAL_USD` is unset and when it is set to
 * something unusable. There is deliberately NO sentinel that disables the cap:
 * this is the last mechanical guard against a quantity that got multiplied by a
 * thousand, and an env var that can silently mean "unlimited" is exactly the
 * thing that gets copy-pasted between shells and config files. An operator who
 * genuinely wants a higher ceiling writes a bigger finite number — which is
 * self-documenting, greppable, and still bounded.
 */
export const DEFAULT_MAX_ORDER_NOTIONAL_USD = 50_000;

/**
 * Resolve `MAX_ORDER_NOTIONAL_USD` into a positive dollar figure.
 *
 * Anything unusable — `50k`, `$50000`, `50,000`, `Infinity`, an empty string, a
 * negative, a zero — falls back to the documented default and reports itself.
 * Falling back rather than declining to compare is the whole point: a guard that
 * simply skips the check on a value it cannot parse lets a fat-fingered env var
 * remove the ceiling the operator believes they configured, and say nothing.
 */
function resolveNotionalCap(): { limit: number; warning?: string } {
  const raw = process.env.MAX_ORDER_NOTIONAL_USD;
  if (raw === undefined) return { limit: DEFAULT_MAX_ORDER_NOTIONAL_USD };

  const parsed = Number(raw.trim());
  if (Number.isFinite(parsed) && parsed > 0) return { limit: parsed };

  const warning =
    `MAX_ORDER_NOTIONAL_USD is not a usable positive dollar amount ` +
    `(got ${JSON.stringify(raw)}) — falling back to the documented ` +
    `$${DEFAULT_MAX_ORDER_NOTIONAL_USD} default. The cap has NOT been ` +
    `disabled. Set a plain number of dollars, digits only (e.g. 50000).`;
  // stderr, never stdout: stdout carries the MCP protocol.
  console.error(`[tastytrade-mcp] WARNING: ${warning}`);
  return { limit: DEFAULT_MAX_ORDER_NOTIONAL_USD, warning };
}

/**
 * Read the dry-run's buying-power impact.
 *
 * `measured` is reported separately from the figure because "the impact is $0"
 * and "there was no impact figure to read" are different claims, and only the
 * first of them means the notional cap actually checked something. Without it, a
 * payload carrying no usable `change-in-buying-power` reads as $0 and sails under
 * any cap silently.
 */
function parseBuyingPowerEffect(bpe: unknown): {
  amount: number;
  measured: boolean;
} {
  if (bpe === null || typeof bpe !== "object" || Array.isArray(bpe)) {
    return { amount: 0, measured: false };
  }
  const raw = (bpe as Record<string, unknown>)["change-in-buying-power"];
  if (raw == null || (typeof raw !== "string" && typeof raw !== "number")) {
    return { amount: 0, measured: false };
  }
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n)
    ? { amount: n, measured: true }
    : { amount: 0, measured: false };
}

/** Longest run of an untrusted string echoed back in a refusal message. */
const MAX_ECHO_CHARS = 40;

/** Clip an untrusted string so a hostile payload cannot become the message. */
function clip(text: string): string {
  return text.length > MAX_ECHO_CHARS
    ? `${text.slice(0, MAX_ECHO_CHARS)}…`
    : text;
}

/**
 * Name an unusable quantity in a refusal message.
 *
 * Total by construction: a hostile leg can carry a value whose own `toString`
 * throws (`{"toString":1}` is enough — `String()` on it raises TypeError), so
 * this describes the shape rather than stringifying it, and never lets the
 * message itself become the payload.
 */
function describeQuantity(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(clip(value));
  if (typeof value === "number" || typeof value === "boolean")
    return `${value}`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** A leg symbol, clipped, for a refusal message. Never trusted to be a string. */
function describeSymbol(symbol: unknown): string {
  return typeof symbol === "string" && symbol.length > 0
    ? clip(symbol)
    : "<unknown>";
}

/**
 * A leg's `instrument-type` as a string, or `""` when it carries none this
 * module can read.
 *
 * Total on purpose, for the same reason `describeQuantity` is. The field arrives
 * from an agent and the tool schema's `enum` is advisory — the MCP SDK does not
 * validate arguments against it — so a numeric or object value reaches this
 * module untouched. A bare `(leg["instrument-type"] ?? "").includes(…)` raises a
 * TypeError on one, which would reach the agent as `upstream_error:
 * "type.includes is not a function"` from inside the module whose whole job is to
 * keep raw JavaScript diagnostics out of the taxonomy, and AFTER `consumeToken`
 * has already burned the confirmation token. Here an unreadable type is simply a
 * type with no published ceiling, and is disclosed as one.
 */
function instrumentTypeOf(leg: OrderLeg): string {
  const raw: unknown = leg["instrument-type"];
  return typeof raw === "string" ? raw.trim() : "";
}

/** Name an instrument type in a warning, clipped, never trusted. */
function describeInstrumentType(type: string): string {
  return type.length > 0 ? `"${clip(type)}"` : "an absent instrument-type";
}

/**
 * Might this leg OPEN a position?
 *
 * Fail-closed, and the direction is the whole point: this decides whether an
 * order may enter a closing-only account, so "we could not read the action" has
 * to count as "it might open". A bare `leg.action?.includes("to Open")` gets that
 * wrong twice over — a non-string action raises a TypeError, the same shape the
 * instrument-type read above rules out, and merely guarding the call would leave
 * an unreadable action reading as a CLOSING leg, waved into an account that may
 * not open positions. So the type test comes first and its failure means "might
 * open".
 */
function mayOpenPosition(leg: OrderLeg): boolean {
  const action: unknown = leg.action;
  return typeof action !== "string" || action.includes("to Open");
}

/**
 * A leg's quantity as a number the position-limit check can compare, or `null`
 * when the leg legitimately carries none.
 *
 * Anything else throws. `Number(leg.quantity ?? 0)` is the wrong shape of guard:
 * `{"q":1}`, `"NaN"` and `"1_000"` all coerce to `NaN`, and `NaN > limit` is
 * FALSE, so the check reports "under the limit" having compared nothing. The
 * shapes that coerce to a plausible number are no better — `true` and `[1]` become
 * `1`, `null` and `""` become `0` — so the check would vet a quantity the caller
 * never asked for and submit the original garbage. "We compared NaN" is not "we
 * looked and it was fine".
 *
 * Numeric STRINGS are accepted, decimals included: the API sends and accepts
 * decimal strings, and crypto quantities are fractional.
 *
 * The `null` case is a Notional Market order, not a hole. Such an order carries
 * one leg which MUST NOT include a quantity (order-submission.md): its size is a
 * dollar `value`, so there is no share count to compare, and
 * MAX_ORDER_NOTIONAL_USD bounds it below.
 *
 * `validation`, not `sanity_check_failed`, and the code is load-bearing: the
 * dispatcher's boundary guard refuses this exact condition as `validation`, and
 * one mistake must not present two different codes depending on which layer
 * caught it. `sanity_check_failed` means the order was checked against live
 * account state and failed; an unreadable quantity fails before any account fact
 * is involved.
 */
function usableLegQuantity(leg: OrderLeg, index: number): number | null {
  const raw: unknown = leg.quantity;
  if (raw === undefined) return null;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw.trim())
        : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw toolError({
    code: "validation",
    message:
      `Leg ${index} (${describeSymbol(leg.symbol)}): quantity must be a ` +
      `positive, finite number, got ${describeQuantity(raw)}. Refusing to ` +
      `submit: the per-leg order-size check cannot compare a quantity it ` +
      `cannot read.`,
    retryable: false,
    hint: 'quantity is the number of shares / contracts / units and must be a positive, finite number; a numeric string such as "1.5" is fine, and fractional quantities are allowed (cryptocurrency). Direction comes from `action`, never from the sign of quantity. Omit quantity only for a Notional Market order, which is sized by `value` instead.',
  });
}

/**
 * Which published order-size ceiling a leg is measured against, or `null` when
 * the API publishes none for that instrument class.
 *
 * One field per class, and the mapping is deliberately asymmetric. The
 * Future/Option substring tests are KEPT rather than tightened to exact matches:
 * those two ceilings are the tightest published, so a future variant of either
 * name landing on them is the conservative direction. `Equity` alone claims
 * `equity-order-size`, because that one is the LOOSEST of the four — falling
 * through to it refuses LESS, not more.
 *
 * Anything unrecognised returns `null`, and the caller warns rather than passing
 * silently. The API publishes no ceiling for Cryptocurrency, and
 * open-api-spec/orders.md lists Event Contract, Fixed Income Security and
 * Liquidity Pool as valid leg types that are not in the order tools' schema enum
 * — and the MCP SDK does not validate arguments against an `inputSchema` enum, so
 * they arrive here untouched. Measuring an event contract against a share cap is
 * not a check; neither is comparing crypto unit counts against a share cap. Those
 * orders are bounded by MAX_ORDER_NOTIONAL_USD and by the API's own enforcement.
 */
function orderSizeFieldForLeg(leg: OrderLeg): OrderSizeField | null {
  const type = instrumentTypeOf(leg);
  const isFuture = type.includes("Future");
  const isOption = type.includes("Option");
  if (isFuture && isOption) return "future-option-order-size";
  if (isFuture) return "future-order-size";
  if (isOption) return "equity-option-order-size";
  if (type === "Equity") return "equity-order-size";
  // Cryptocurrency, Event Contract, Fixed Income Security, Liquidity Pool, an
  // absent type, a type this module cannot read: the API publishes no per-order
  // size ceiling for any of them. The caller is told which, at the call site.
  return null;
}

/**
 * Every instrument type a live order leg may carry, transcribed from the
 * vendored specification: `open-api-spec/orders.md`, the `instrument-type` row
 * of the order-leg schema. Pinned to that document, character for character, by
 * test/safety/sanity-checks.test.ts — so the vendored spec gaining a type is a
 * red build here rather than a silent gap in the list below.
 *
 * Not the same thing as `InstrumentType` in src/enums.ts. That enum is what the
 * TOOL SCHEMAS offer an agent, and it names five of these eight. The MCP SDK
 * does not validate arguments against an `inputSchema` enum, so the other three
 * reach this module unchallenged, which is exactly why the ceiling check has to
 * have an answer for them.
 */
export const ORDER_LEG_INSTRUMENT_TYPES = [
  "Cryptocurrency",
  "Equity",
  "Equity Option",
  "Event Contract",
  "Fixed Income Security",
  "Future",
  "Future Option",
  "Liquidity Pool",
] as const;

/**
 * The order-leg instrument types the four published ceilings do not cover —
 * DERIVED by asking `orderSizeFieldForLeg`, never written down.
 *
 * Two published documents describe this gap to a reader deciding whether the
 * server will catch an oversized order, and a prose guard cannot keep them
 * honest: pinning VOCABULARY is defeated by a document that carries every
 * required word while claiming the reverse.
 *
 * So the README's safety section is written from this
 * array instead. Change `orderSizeFieldForLeg` and the array changes with the
 * code; the documents then fail until they say the new truth. The one member with
 * no name — a leg whose `instrument-type` is absent — cannot appear here and is
 * checked separately.
 */
export const UNCEILINGED_ORDER_LEG_INSTRUMENT_TYPES: readonly string[] =
  ORDER_LEG_INSTRUMENT_TYPES.filter(
    (type) => orderSizeFieldForLeg({ "instrument-type": type }) === null,
  );

/**
 * A published order-size ceiling as a number the check can compare against, or
 * `null` when the payload does not carry a usable one.
 *
 * Numeric STRINGS are accepted for exactly the reason `usableLegQuantity`
 * accepts them — the API sends and accepts decimal strings — so both sides of
 * the comparison speak one dialect. That symmetry is load-bearing: a quantity
 * side that parses `"100"` against a limit side that demands a JSON number turns
 * a string-typed ceiling into no ceiling at all for that leg, and the check then
 * reports nothing at all.
 *
 * Zero is usable and BINDING: an account capped at zero for an instrument class
 * may not trade it, and reading that as "no limit configured" would invert the
 * check. A negative or non-finite figure is not a ceiling at all and is
 * reported as unreadable rather than compared.
 */
function usableOrderSizeLimit(raw: unknown): number | null {
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    // `Number("")` is 0, which would read as a hard "you may not trade".
    if (trimmed.length === 0) return null;
    parsed = Number(trimmed);
  } else {
    return null;
  }
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * What actually bounds a leg whose instrument class publishes no size cap.
 *
 * The claim is CONDITIONAL, and it has to be. An unqualified "these legs are
 * bounded by MAX_ORDER_NOTIONAL_USD and server-side enforcement" asserts that the
 * notional cap bounded them, and that can be false in the very same response:
 * `applyNotionalCap` runs immediately after this loop and may append "Dry-run
 * reported no usable change-in-buying-power, so the MAX_ORDER_NOTIONAL_USD cap
 * could not be applied to this order." Both land in one `sanity_warnings` array,
 * in that order, and a reader who stopped at the first would be told the opposite
 * of the truth.
 *
 * So it is conditional here, the way it is in the tool descriptions. One constant
 * for both warnings, for the same reason STATUS_BACKSTOP is one constant: they
 * are the same fact.
 */
const UNCAPPED_LEG_BOUNDS =
  "Legs with no published size ceiling are left to MAX_ORDER_NOTIONAL_USD and " +
  "server-side enforcement — and the notional cap applies only when the dry-run " +
  "supplied a buying-power figure, so a 'cap could not be applied' warning here " +
  "leaves server-side enforcement as the only bound.";

/** Told to the caller when a ceiling could not be applied to a leg. */
const SERVER_SIDE_BACKSTOP = "relying on server-side enforcement.";

/**
 * Told to the caller when the account-state checks could not be run.
 *
 * One constant for both trading-status warnings — the endpoint that threw and
 * the endpoint that answered with something unreadable. They are the same fact
 * from the caller's side ("this account was not checked"), and two independent
 * spellings of one fact are two things to keep in step. The way that drift shows
 * up is one of the two paths disclosing nothing, which is the single outcome this
 * module rules out.
 */
const STATUS_BACKSTOP = "submit may still bounce upstream.";

/**
 * The account-state checks, named one by one, for the two warnings that report
 * they did not run.
 *
 * Built from ACCOUNT_STATE_FLAGS rather than written out as prose, for two
 * reasons. A flag added to the checks cannot then go unnamed in the disclosure
 * that they were skipped — the same drift STATUS_BACKSTOP exists to prevent,
 * one field further in. And the wire field names are what an operator holding
 * the raw response can actually match against: "the margin call check" tells
 * them nothing about which key to look for.
 */
const ACCOUNT_STATE_CHECKS = ACCOUNT_STATE_FLAGS.join(" / ");

/**
 * Every pre-submit check this module can run, under the id it is DISCLOSED as.
 *
 * DATA because the alternative is prose, and prose goes out of sync.
 * `runSanityChecks` pushes a warning for every way its checks can fail to run,
 * but a warning list cannot by itself carry the difference between "checked,
 * nothing found" and "never checked" — and those are the two answers that matter
 * most. The three legless routes run a strict subset by design, so on a warning
 * list alone `sanity_warnings: []` from an edit that would OPEN a position on a
 * closing-only account would be byte-identical to the same from a fully checked
 * healthy one — that check reads the order's legs, and those bodies carry none.
 *
 * Each entry point accumulates the ids it evaluated and the difference travels
 * back as `checksNotRun`, so a route that skips a check discloses it by
 * construction, and a check added here without a producer shows up as not-run
 * everywhere until it has one.
 */
export const SANITY_CHECK_IDS = [
  /** The stored dry-run payload is a shape the checks can be run against. */
  "dry_run_readable",
  /** The broker's own dry-run reported no errors. */
  "dry_run_errors",
  /** The dry-run described an order, so there is something to measure. */
  "dry_run_described_order",
  /** Buying-power impact against MAX_ORDER_NOTIONAL_USD. */
  "notional_cap",
  /** Per-leg quantity against the account's published order-size ceiling. */
  "per_leg_order_size",
  /** Order price against the increment tastytrade publishes for the instrument. */
  "tick_size",
  /** The account is not frozen. A HARD BLOCK; needs no legs. */
  "account_frozen",
  /** No leg opens a position on a closing-only account. Needs legs. */
  "account_closing_only",
  /** The account is not in a margin call. Advisory. */
  "account_margin_call",
  /** The account is not restricted to risk-reducing trades. Advisory. */
  "account_risk_reducing_only",
] as const;

/** One member of {@link SANITY_CHECK_IDS}. */
export type SanityCheckId = (typeof SANITY_CHECK_IDS)[number];

/** The catalogue minus what a route says it ran, in catalogue order. */
function deriveChecksNotRun(ran: ReadonlySet<SanityCheckId>): SanityCheckId[] {
  return SANITY_CHECK_IDS.filter((id) => !ran.has(id));
}

/**
 * The three payload questions a DRY-RUN route evaluates, and nothing else.
 *
 * `isCleanDryRun` — the predicate the dispatcher gates token minting on — is
 * exactly `isReadablePayload && !hasDryRunErrors && describedAnOrder`, which is
 * these three ids. Everything else in the catalogue belongs to the submit: the
 * notional cap is measured when the token is spent, and no account read happens
 * on a pre-flight at all.
 *
 * Listed here rather than at the dispatcher so the two cannot drift, and so a
 * check added to the catalogue shows up as not-run on a dry-run route until
 * somebody decides otherwise.
 */
const DRY_RUN_ROUTE_CHECKS_RUN: readonly SanityCheckId[] = [
  "dry_run_readable",
  "dry_run_errors",
  "dry_run_described_order",
];

/**
 * What a dry-run route discloses as not-run.
 *
 * A pre-flight returns the broker's projection and mints a token; it reaches no
 * local safety finding of its own. Saying so is what stops an empty
 * `sanity_warnings` on that route from reading as "the server checked and found
 * nothing" — which an upstream-planted empty list would otherwise say.
 */
export function dryRunRouteChecksNotRun(): SanityCheckId[] {
  return deriveChecksNotRun(new Set(DRY_RUN_ROUTE_CHECKS_RUN));
}

/**
 * How long either of the two ADVISORY broker reads below may take before the
 * pre-submit checks stop waiting on it.
 *
 * This bounds a clock nobody here owns. One `place_order` makes three sequential
 * broker requests, each with its own 30s ceiling and no ceiling on the total,
 * while the MCP client runs its own timer — 60s by default in the reference SDK,
 * often lower. When that fires the client rejects with a bare `-32001 Request
 * timed out`, carrying none of the unknown-outcome language, and the server, which
 * never saw the timer, carries on and submits. Two slow reads at 30s reach 60s
 * before the POST is attempted, so the agent is told "timed out" for an order
 * about to go live, having burnt its token — and the natural recovery of
 * re-dry-running places a SECOND order.
 *
 * The reads that stall are the SOFT ones: a failure of either only pushes a
 * warning and the submit proceeds, so spending tens of seconds on them buys
 * nothing. Five seconds is far above what either endpoint takes when healthy and
 * far below any plausible client timeout. It does not close the window — see the
 * abort check in the dispatcher for the irreducible remainder, the POST itself.
 *
 * Reordering is the wrong answer, worth naming so it is not proposed again:
 * putting the POST first would stop the reads spending the caller's budget and
 * would also stop them being checks. Both can HARD-BLOCK, and a check that runs
 * after the order is at the exchange has refused nothing.
 *
 * Enforced here rather than by lowering the transport timeout: these two GETs are
 * the only requests that want a short deadline, and a race in this module is
 * honoured whatever transport is underneath — axios's `timeout` is applied by its
 * http adapter, so an injected test adapter never sees it, and a guard no offline
 * test can observe is a guard that rots.
 */
export const ADVISORY_READ_BUDGET_MS = 5_000;

/** Thrown by {@link withAdvisoryBudget} when the read outran its budget. */
class AdvisoryReadTimeout extends Error {
  constructor() {
    super("advisory read exceeded its budget");
    this.name = "AdvisoryReadTimeout";
  }
}

/**
 * Resolve `work`, or give up on it after {@link ADVISORY_READ_BUDGET_MS}.
 *
 * Giving up abandons the request rather than cancelling it — the socket is left
 * to settle on its own and its answer is discarded. That is acceptable only
 * because these two reads are advisory: nothing downstream is waiting on the
 * value, and `Promise.race` has already subscribed to `work`, so a late
 * rejection is handled and cannot surface as an unhandled rejection.
 */
function withAdvisoryBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AdvisoryReadTimeout()),
      ADVISORY_READ_BUDGET_MS,
    );
    // A pending timer keeps Node alive; this one must never be the reason a
    // stdio server outlives its client.
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The two channels a pre-submit check produces, and they are two on purpose.
 *
 * One `string[]` with two authors is a forgery primitive. This module states its
 * own verdicts ("Account is in margin call.", "Account is closing-only."), and an
 * agent reads `sanity_warnings` as THIS SERVER'S verdict on whether the order is
 * safe. Share the array with broker prose and a party able to shape the dry-run
 * body can author an entry byte-identical to this module's own literal, in the
 * same array, in arrival order, as the same type — and no test an agent could run
 * would tell the forgery from the finding.
 *
 * Neither transform at the sink is a provenance control: `redactSecrets` is a
 * credential scrubber and `clipBrokerNote` a length bound, and neither cares who
 * wrote the sentence.
 *
 * Two differently-named arrays rather than one array of `{source, text}` records,
 * for two reasons. `sanity_warnings` is declared `items: {type: "string"}` on five
 * published output schemas and is `required` on two, so changing its element type
 * breaks a declared contract on a money path. And the broker's own `warnings[]` /
 * `errors[]` already travel under their own names in the live-submit payload, so
 * "upstream content travels under an upstream name" is the convention in force.
 *
 * `upstreamNotes` is a REQUIRED member, which is what makes this enforceable
 * rather than aspirational: every consumer is a compile error until it is routed,
 * and a route added later cannot silently emit a half-populated envelope.
 */
export interface SanityCheckOutcome {
  /** Findings THIS SERVER reached. Never upstream text. */
  warnings: string[];
  /** Notes the broker sent. Never a server verdict. */
  upstreamNotes: string[];
  /**
   * Which of {@link SANITY_CHECK_IDS} this route did NOT evaluate.
   *
   * REQUIRED, for the reason `upstreamNotes` is: every consumer is a compile
   * error until it routes the value, so a sixth gated route cannot emit a
   * result that reads as fully checked when it is not. An empty array is a
   * claim — "everything in the catalogue ran" — and is only ever produced by a
   * path that actually ran everything.
   */
  checksNotRun: SanityCheckId[];
}

/**
 * Hard-fail on a dry-run payload the checks cannot be run against, and hand
 * back the readable one.
 *
 * The notional cap and the error check both live on this object, so an
 * unreadable payload means the checks did not run — which must refuse, not
 * proceed.
 */
function assertReadableDryRun(dryRun: unknown): DryRunLike {
  if (!isReadablePayload(dryRun)) {
    throw toolError({
      code: "sanity_check_failed",
      message:
        `The dry-run response was ${describeUnreadablePayload(dryRun)}, so the ` +
        `pre-submit checks could not be performed. Refusing to submit.`,
      retryable: false,
      hint: "Re-run the matching dry_run_* tool; submit only once it returns a payload.",
    });
  }
  return dryRun as DryRunLike;
}

/** Hard-fail on dry-run errors (the API already said no). */
function assertNoDryRunErrors(dry: DryRunLike): void {
  if (hasDryRunErrors(dry)) {
    throw toolError({
      code: "sanity_check_failed",
      message: `Dry-run blocked: ${describeDryRunErrors(dry.errors)}`,
      retryable: false,
      hint: "Fix the order parameters and call the dry-run again.",
    });
  }
}

/**
 * The notional cap from the environment. Always enforced: resolveNotionalCap()
 * cannot return a non-positive or non-finite limit, so there is no input to
 * this server that turns this check off.
 */
function applyNotionalCap(dry: DryRunLike, warnings: string[]): void {
  const cap = resolveNotionalCap();
  if (cap.warning) warnings.push(cap.warning);
  const impact = parseBuyingPowerEffect(dry["buying-power-effect"]);
  const bp = Math.abs(impact.amount);
  if (bp > cap.limit) {
    throw toolError({
      code: "sanity_check_failed",
      message: `Order buying-power impact $${bp.toFixed(2)} exceeds MAX_ORDER_NOTIONAL_USD ($${cap.limit}).`,
      retryable: false,
      hint: "Set MAX_ORDER_NOTIONAL_USD env var higher (digits only, e.g. 100000) to allow this order.",
    });
  }
  if (!impact.measured) {
    // Not a hard block: some payload shapes legitimately carry no figure, and
    // refusing them would make an instrument class untradeable. But the cap
    // compared nothing, so say so rather than implying a $0 order passed it.
    warnings.push(
      "Dry-run reported no usable change-in-buying-power, so the " +
        "MAX_ORDER_NOTIONAL_USD cap could not be applied to this order.",
    );
  }
}

/**
 * Push every dry-run warning onto `warnings`, through the same total renderer AND
 * the same container handling `errors` uses.
 *
 * `if (w.message)` reads a property off whatever the array holds: a null element
 * throws a raw TypeError out of the one module whose job is keeping V8 diagnostics
 * out of the taxonomy — and throws AFTER consumeToken has burned the token, so
 * every retry costs a fresh dry-run.
 *
 * The CONTAINER is the other half: `if (Array.isArray(dry.warnings))` drops a
 * non-array whole, so `warnings: {message: "your order will be rejected"}` comes
 * back as `sanity_warnings: []` while the byte-identical value in `errors`
 * hard-blocks the submit. A broker note is not less true for arriving without
 * brackets, and this is the field a human reads to find out why a live order is
 * about to bounce.
 *
 * A helper rather than two copies: there are two gated routes into it, and one
 * field of one payload handled two ways is the exact shape both hazards above
 * take.
 */
function collectDryRunWarnings(
  dry: DryRunLike,
  warnings: string[],
  upstreamNotes: string[],
): void {
  if (!carriesContent(dry.warnings)) return;
  const batch = dryRunNotes(dry.warnings);
  for (const w of batch.notes) {
    const note = describeDryRunNote(w);
    // An empty rendering is the one thing worth dropping — it is not a note, it
    // is a blank line in the caller's warning list. Same filter `errors`
    // applies for the same reason.
    if (note.length > 0) upstreamNotes.push(note);
  }
  // The disclosure is the SERVER's statement about what IT did, not the
  // broker's, so it goes in the server's array. Both parameters exist for this
  // one line, and that is the right trade: the alternative is a bound the
  // caller cannot see.
  if (batch.omitted > 0) {
    warnings.push(
      describeOmittedNotes(batch.omitted, batch.omitted + batch.notes.length),
    );
  }
}

/**
 * The account-state checks, for EVERY path that spends a confirmation token.
 *
 * Shared by every gated route, not just submission: a frozen account that
 * `place_order` refuses outright must not be reachable through `edit_order`,
 * `replace_order` — where `order_type` is settable, so a resting Limit could
 * become a MARKET order — or `edit_complex_order`.
 *
 * The per-leg ceiling and the closing-only GATE read `legs`, and by design none of
 * those three bodies has legs. But `is-frozen` reads ONE BOOLEAN off the account,
 * needs no legs at all, and is a hard block rather than an advisory — so the
 * argument about a legless body does not apply to it.
 *
 * `legs` is therefore optional, and its absence changes exactly one outcome: the
 * closing-only gate cannot be evaluated, so the flag is reported as a warning and
 * `account_closing_only` disclosed as not-run. Everything else is identical on
 * both kinds of route, because one implementation is what makes the block
 * unbranchable.
 *
 * One broker call, and the only one added to the legless routes. The
 * position-limit GET stays absent: it would fetch ceilings nothing could be
 * compared against.
 *
 * Charged as a DEBT that cannot refuse — an exhausted bucket must not abandon a
 * submit whose token has already been consumed — and bounded by the advisory
 * budget, so a slow status read degrades to a disclosed warning.
 */
export async function runAccountStateChecks(
  client: TastytradeClient,
  accountNumber: string,
  legs?: readonly OrderLeg[],
): Promise<{ warnings: string[]; ran: SanityCheckId[] }> {
  const warnings: string[] = [];
  const ran = new Set<SanityCheckId>();
  const done = () => ({ warnings, ran: [...ran] });

  // GET /accounts/{n}/trading-status has a published 1/sec ceiling, and this
  // line reaches it on every live submit — a request NO TOOL CHARGES,
  // because it belongs to no tool: the destructive schemas do document that it
  // happens, but a tool's pre-flight bills the tool's own bucket, not this one. Charged here so the ceiling governs it:
  // an unbilled request is a request the limiter does not know about.
  chargeUpstreamCallDebt({ rateKey: "trading_status" });
  let rawStatus: unknown;
  try {
    rawStatus = await withAdvisoryBudget(
      client.getAccountStatus(accountNumber),
    );
  } catch (e) {
    warnings.push(
      e instanceof AdvisoryReadTimeout
        ? `Account trading status did not answer within ${ADVISORY_READ_BUDGET_MS}ms, ` +
            `so the submit went ahead without it — ${STATUS_BACKSTOP}`
        : `Could not fetch account trading status — ${STATUS_BACKSTOP}`,
    );
    return done();
  }

  if (!isReadablePayload(rawStatus)) {
    // Fetched, but not something fields can be read off — exactly the treatment
    // the position-limit half above gets, and it matters most here, on the one
    // pair of checks that HARD BLOCK. A 200 `{"data": null}` — a shape the strict
    // envelope deliberately admits — resolves to null, so a bare `if (status)`
    // would skip the frozen and closing-only blocks with an empty warning list.
    // `{data: []}`, `{data: "frozen"}` and `{data: 5}` are worse still: truthy,
    // so every field read comes back undefined and the account reports healthy.
    // The throwing path warns and so does this one; the module header admits no
    // asymmetry between them — the caller is ALWAYS told which checks did not
    // run.
    warnings.push(
      `Account trading status came back ${describeUnreadablePayload(rawStatus)}, ` +
        `so the ${ACCOUNT_STATE_CHECKS} checks did not run — ${STATUS_BACKSTOP}`,
    );
    return done();
  }

  const status = rawStatus as TradingStatus;

  // An object, and still no evidence any account-state check ran.
  //
  // The shape guard above is one level short: `{}` is a readable object, so every
  // flag below reads undefined, every `if` is false, and the account reports healthy
  // with an EMPTY warning list. Same for a body of nulls and for an envelope skew
  // nesting the real status one level down as `{"trading-status": {"is-frozen":
  // true}}` — an actually-frozen account sailing through the HARD BLOCK reporting
  // nothing.
  //
  // Not an exotic shape: the vendored spec says only fields relevant to the
  // account's current configuration are returned (account-status.md), so a payload
  // missing flags is documented behaviour, and one missing ALL of them is what a
  // version skew or a proxy rewrite looks like from here.
  //
  // The checks still run underneath this warning rather than being skipped by it. A
  // guard that decides for itself that a check is pointless is how a check stops
  // running for a reason nobody rechecks. The disclosure says instead that none of
  // the four was EVALUATED.
  const flagsReadable = readsAnyAccountStateFlag(status);
  if (!flagsReadable) {
    warnings.push(
      `Account trading status carried no readable ${ACCOUNT_STATE_CHECKS}, ` +
        `so those checks did not run — ${STATUS_BACKSTOP}`,
    );
  }

  if (flagsReadable) ran.add("account_frozen");
  if (status["is-frozen"]) {
    throw toolError({
      code: "sanity_check_failed",
      message: "Account is frozen — no trading permitted.",
      retryable: false,
    });
  }
  if (legs === undefined) {
    // The GATE needs an action to read and there is none, so it is disclosed as
    // not-run. The FLAG is still reported: the restriction is real, this route
    // simply cannot decide locally whether the change offends it.
    if (status["is-closing-only"]) {
      warnings.push(
        "Account is closing-only, and this route's body carries no legs, so " +
          "whether the change opens a position could not be determined " +
          "locally — submit may still bounce upstream.",
      );
    }
  } else {
    if (flagsReadable) ran.add("account_closing_only");
    if (status["is-closing-only"]) {
      const opening = legs.some(mayOpenPosition);
      if (opening) {
        throw toolError({
          code: "sanity_check_failed",
          message: "Account is closing-only — cannot open new positions.",
          retryable: false,
          hint: "Use a 'Buy to Close' / 'Sell to Close' action instead.",
        });
      }
      warnings.push("Account is closing-only.");
    }
  }
  if (flagsReadable) ran.add("account_margin_call");
  if (status["is-in-margin-call"]) {
    warnings.push("Account is in margin call.");
  }
  if (flagsReadable) ran.add("account_risk_reducing_only");
  if (status["is-risk-reducing-only"]) {
    // A WARNING and deliberately not a block, unlike its closing-only neighbour,
    // because the two restrictions are not the same shape. "Closing-only" is
    // decidable from the order body — every leg carries an action. "Risk-reducing" is
    // a property of the order against the existing portfolio: buying a protective put
    // opens a position AND reduces risk, so refusing every opening leg would refuse
    // exactly the orders the restriction permits, and this module has no position
    // book to tell them apart. So it goes out under the same rule as the other soft
    // conditions: the API makes the check server-side, and the caller is told rather
    // than left to read silence as a clean pass.
    warnings.push(
      "Account is restricted to risk-reducing trades only, and whether this " +
        "order reduces risk cannot be determined locally — submit may still " +
        "bounce upstream.",
    );
  }

  return done();
}

/**
 * The pre-submit checks for the three routes whose body carries no legs:
 * replace_order, edit_order and edit_complex_order.
 *
 * They consume a confirmation token and then submit, so what they check is all
 * that stands between a spent token and a live money-moving request.
 *
 * Of the dry-run half, MAX_ORDER_NOTIONAL_USD is the guard with no server-side
 * counterpart — the broker enforces position limits and the frozen /
 * closing-only states itself, but nothing upstream knows this operator's notional
 * ceiling. Without it an agent could dry-run a small order and edit it past the
 * cap; worse, `order_type` is settable on two of these routes, so a resting limit
 * could become a MARKET order through a path that checked nothing.
 *
 * Still NOT the full runSanityChecks: the difference is exactly the two checks
 * that read `legs` — the per-leg ceiling and the closing-only gate — and both are
 * DISCLOSED as not-run rather than silently absent. The position-limit GET stays
 * absent with them; it would fetch ceilings nothing could be compared against,
 * and it is one of the reads that put the money call at the far end of a sequence
 * with no total budget (see ADVISORY_READ_BUDGET_MS).
 *
 * Same thrown code as the full checks, so an agent branching on `code` sees one
 * story from every gated route.
 */
export async function runStoredDryRunChecks(
  client: TastytradeClient,
  accountNumber: string,
  dryRun: unknown,
): Promise<SanityCheckOutcome> {
  const warnings: string[] = [];
  const upstreamNotes: string[] = [];
  const ran = new Set<SanityCheckId>();

  const dry = assertReadableDryRun(dryRun);
  ran.add("dry_run_readable");
  assertNoDryRunErrors(dry);
  ran.add("dry_run_errors");
  applyNotionalCap(dry, warnings);
  ran.add("notional_cap");
  collectDryRunWarnings(dry, warnings, upstreamNotes);

  // The same helper, and the same hard block, place_order runs. `legs` is
  // omitted because these bodies have none, which is the only difference.
  const state = await runAccountStateChecks(client, accountNumber, undefined);
  warnings.push(...state.warnings);
  for (const id of state.ran) ran.add(id);

  return { warnings, upstreamNotes, checksNotRun: deriveChecksNotRun(ran) };
}

// ---------------------------------------------------------------------------
// Tick size
//
// tastytrade publishes the price increment per instrument, as an array where an
// entry carrying a `threshold` applies BELOW that threshold and the single entry
// without one is the fallback at and above every threshold. An equity leg reads
// `tick-sizes`; an equity option leg reads `option-tick-sizes` off the SAME
// underlying equity, which is why one instrument read covers both.
//
// Deliberately narrow. A multi-leg order prices against `spread-tick-sizes`, a
// different schedule, and futures carry their own — guessing with the
// single-leg equity schedule would be worse than saying nothing, so those cases
// are named in checks_not_run instead. Anything unreadable lands there too: a
// price this module could not check must never read as a price it approved.
// ---------------------------------------------------------------------------

/** Integer scale for the modulo. Eight places covers the 0.00005 futures tick. */
const TICK_SCALE = 1e8;

/** A finite scaled integer, or null when the value is not a usable decimal. */
function scaledDecimal(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * TICK_SCALE);
}

/**
 * The increment that applies to `price` under `schedule`, as a scaled integer.
 *
 * Returns null when the schedule is not an array of readable entries, or when it
 * has no entry that applies — both of which mean "not checked", never "fine".
 */
export function tickForPrice(
  schedule: unknown,
  scaledPrice: number,
): number | null {
  if (!Array.isArray(schedule) || schedule.length === 0) return null;

  let fallback: number | null = null;
  const banded: Array<{ threshold: number; tick: number }> = [];

  for (const entry of schedule) {
    if (entry === null || typeof entry !== "object") return null;
    const tick = scaledDecimal((entry as Record<string, unknown>).value);
    if (tick === null || tick <= 0) return null;
    const rawThreshold = (entry as Record<string, unknown>).threshold;
    if (rawThreshold === undefined || rawThreshold === null) {
      fallback = tick;
      continue;
    }
    const threshold = scaledDecimal(rawThreshold);
    if (threshold === null) return null;
    banded.push({ threshold, tick });
  }

  banded.sort((a, b) => a.threshold - b.threshold);
  for (const band of banded) {
    if (scaledPrice < band.threshold) return band.tick;
  }
  return fallback;
}

/** The schedule field an instrument payload publishes for this leg's type. */
function tickScheduleField(instrumentType: string): string | null {
  if (instrumentType === "Equity") return "tick-sizes";
  if (instrumentType === "Equity Option") return "option-tick-sizes";
  return null;
}

/**
 * The underlying equity symbol an OCC option symbol is written against.
 *
 * The root occupies the first six characters, space-padded. Returned trimmed, or
 * null when there is nothing there to read.
 */
function occRoot(symbol: unknown): string | null {
  if (typeof symbol !== "string") return null;
  const root = symbol.slice(0, 6).trim();
  return root.length > 0 ? root : null;
}

/** Human-readable form of a scaled integer, for the refusal message. */
function unscale(scaled: number): string {
  return String(scaled / TICK_SCALE);
}

/**
 * Run pre-submit checks. Throws a ToolError on hard-block conditions, returns
 * the accumulated soft-warning list otherwise. Caller should attach the
 * warnings to the live-submit response so the human can see them.
 *
 * `dryRun` is typed `unknown` on purpose: it arrives from the network via the
 * confirmation token's stored payload, so this function — not its callers — owns
 * proving it is a shape the checks can actually be run against.
 *
 * Thrown codes: `sanity_check_failed` for an order that was checked and failed,
 * `validation` for a leg quantity that could not be read at all (see
 * usableLegQuantity for why the distinction is deliberate).
 */
export async function runSanityChecks(
  client: TastytradeClient,
  accountNumber: string,
  args: OutboundOrderBody,
  dryRun: unknown,
): Promise<SanityCheckOutcome> {
  const warnings: string[] = [];
  const upstreamNotes: string[] = [];
  const ran = new Set<SanityCheckId>();

  // 1a. Hard-fail on a dry-run payload we cannot read.
  const dry = assertReadableDryRun(dryRun);
  ran.add("dry_run_readable");

  // 1b. Hard-fail on dry-run errors (the API already said no).
  assertNoDryRunErrors(dry);
  ran.add("dry_run_errors");

  // 1c. Hard-fail on a dry-run that described no order. Defence in depth, in
  // the same shape as 1b: `isCleanDryRun` already refuses to mint a token from
  // one, so the dispatcher cannot hand this function such a payload today. The
  // guard is stated at both layers anyway, because the check immediately below —
  // the notional cap — reads its figure off the very member this one insists on.
  // A submit that reached step 3 with nothing to measure would downgrade
  // MAX_ORDER_NOTIONAL_USD to a warning, which is the loudest thing
  // this module knows how to say about an order it could not check, and it is
  // still only a string in an array.
  if (!describedAnOrder(dry)) {
    throw toolError({
      code: "sanity_check_failed",
      message:
        `The dry-run response reported no errors but described no order ` +
        `either — no ${DRY_RUN_ORDER_EVIDENCE.join(", no ")} — so nothing was ` +
        `validated and nothing could be measured against ` +
        `MAX_ORDER_NOTIONAL_USD. Refusing to submit.`,
      retryable: false,
      hint: "Re-run the matching dry_run_* tool; submit only once it returns the order or its buying-power effect. A persistently contentless dry-run usually means an intermediary (proxy, WAF, load balancer) is answering instead of tastytrade — check TASTYTRADE_API_URL and anything terminating TLS in front of it.",
    });
  }
  ran.add("dry_run_described_order");

  // 2a. Every leg quantity must be a number a limit CAN be compared against,
  // and that is settled before anything else — including before the limits are
  // fetched, so an unreadable quantity is refused even when the position-limit
  // endpoint is down and the loop below never runs. See usableLegQuantity: this
  // is what stops a NaN comparison passing for a check.
  const legs = flattenLegs(args);
  const quantities = legs.map((leg, i) => usableLegQuantity(leg, i));

  // 2b. Per-leg quantity vs. account position limits.
  //
  // This GET is the first of the three broker requests one place_order makes,
  // and the tool pre-flight only charged for one of them. Bill it here, as a
  // debt that cannot refuse — see chargeUpstreamCallDebt.
  chargeUpstreamCallDebt();
  let rawLimits: unknown;
  let limitsFetched = false;
  try {
    rawLimits = await withAdvisoryBudget(
      client.getPositionLimit(accountNumber),
    );
    limitsFetched = true;
  } catch (e) {
    // Don't hard-fail if the position-limit endpoint is unreachable or slow;
    // the API will still enforce server-side. Surface a warning so it's
    // visible, and distinguish the two: "did not answer in time" is a fact
    // about this server's own deadline, not about the endpoint being down, and
    // an operator reading the warnings needs to be able to tell them apart.
    warnings.push(
      e instanceof AdvisoryReadTimeout
        ? `Account position limits did not answer within ${ADVISORY_READ_BUDGET_MS}ms, ` +
            `so the submit went ahead without them — ${SERVER_SIDE_BACKSTOP}`
        : `Could not fetch account position limits — ${SERVER_SIDE_BACKSTOP}`,
    );
  }

  if (limitsFetched && !isReadablePayload(rawLimits)) {
    // Fetched, but not something fields can be read off — `{data: null}` from
    // the API maps straight to null, and a 200 whose body is not the expected
    // envelope yields undefined. Skipping the per-leg loop silently would make
    // a response that checked nothing read like a successful check; the
    // throwing path warns, and so does this. Same claim, same disclosure.
    warnings.push(
      `Account position limits came back ${describeUnreadablePayload(rawLimits)}, ` +
        `so no per-leg order-size ceiling could be applied — ${SERVER_SIDE_BACKSTOP}`,
    );
  } else if (limitsFetched) {
    // Fetched AND readable, so the ceiling was applied to every leg the payload
    // publishes one for. The per-type gaps below are reported individually; the
    // check itself ran.
    ran.add("per_leg_order_size");
    const limits = rawLimits as PositionLimit;
    // Reported once per distinct gap rather than once per leg: a four-leg
    // order missing one ceiling is one fact, not four.
    const unusableFields = new Set<OrderSizeField>();
    let sawCryptoLeg = false;
    // Instrument types the API publishes no order-size ceiling for, other than
    // crypto — which has its own long-standing wording below. Collected as a set
    // for the same reason `unusableFields` is: one fact per distinct gap, not
    // one per leg.
    const unboundedTypes = new Set<string>();

    for (let i = 0; i < legs.length; i++) {
      const qty = quantities[i];
      // A Notional Market leg carries no quantity; nothing to compare.
      if (qty === null) continue;
      const leg = legs[i];
      const field = orderSizeFieldForLeg(leg);
      if (field === null) {
        const type = instrumentTypeOf(leg);
        if (type === "Cryptocurrency") sawCryptoLeg = true;
        else unboundedTypes.add(type);
        continue;
      }
      const limit = usableOrderSizeLimit(limits[field]);
      if (limit === null) {
        unusableFields.add(field);
        continue;
      }
      if (qty > limit) {
        throw toolError({
          code: "sanity_check_failed",
          message:
            `Leg quantity ${qty} for ${describeSymbol(leg.symbol)} exceeds ` +
            `account order limit ${limit} (${field}).`,
          retryable: false,
        });
      }
    }

    for (const field of unusableFields) {
      warnings.push(
        `Account position limits carry no usable "${field}", so the matching ` +
          `leg(s) were not checked against a per-order size ceiling — ${SERVER_SIDE_BACKSTOP}`,
      );
    }
    if (sawCryptoLeg) {
      warnings.push(
        "Cryptocurrency has no published per-order size limit, so this order's " +
          "crypto leg(s) were not checked against a per-order size ceiling.",
      );
    }
    for (const type of unboundedTypes) {
      warnings.push(
        `The API publishes no per-order size limit for instrument type ` +
          `${describeInstrumentType(type)}, so the matching leg(s) were not ` +
          `checked against a per-order size ceiling.`,
      );
    }
    // Once, not per type. The per-type lines say what was not checked; this
    // says what is left, and it is the same sentence every time. Keeping it out
    // of them also keeps each one inside the length bound that stops a hostile
    // instrument-type from being echoed at size.
    if (sawCryptoLeg || unboundedTypes.size > 0) {
      warnings.push(UNCAPPED_LEG_BOUNDS);
    }
  }

  // 2c. Order price against the published increment.
  //
  // A live read, like the limits above, and it fails the same way: a price off
  // the increment is a HARD BLOCK, and a schedule that could not be read is
  // named in checks_not_run rather than passed. Narrow by design — see the
  // note above tickForPrice for why a spread and a futures leg are skipped
  // rather than guessed at.
  const scaledPrice = scaledDecimal(
    (args as unknown as Record<string, unknown>).price,
  );
  const tickLeg = legs.length === 1 ? legs[0] : null;
  const tickField = tickLeg
    ? tickScheduleField(instrumentTypeOf(tickLeg))
    : null;

  if (scaledPrice === null || tickLeg === null || tickField === null) {
    // Nothing to check, or nothing this module knows how to check. Silent: the
    // absence is already reported by tick_size appearing in checks_not_run, and
    // a warning on every market order would be noise.
  } else {
    const underlying =
      tickField === "option-tick-sizes"
        ? occRoot(tickLeg.symbol)
        : typeof tickLeg.symbol === "string"
          ? tickLeg.symbol
          : null;
    let schedule: unknown = null;
    let read = false;
    if (underlying !== null) {
      try {
        // GET /instruments/equities/{symbol} has a published 3/sec ceiling. The
        // limiter has to know this endpoint is reached, for the same reason the
        // trading-status charge above exists: an unbilled request is a request
        // the ceiling does not govern.
        chargeUpstreamCallDebt({ rateKey: "single_equity" });
        const instrument = await client.getInstrument(underlying);
        schedule = (instrument as Record<string, unknown> | null)?.[tickField];
        read = true;
      } catch {
        read = false;
      }
    }
    const tick = read ? tickForPrice(schedule, scaledPrice) : null;
    if (tick === null) {
      warnings.push(
        `The price increment for ${describeSymbol(tickLeg.symbol)} could not be ` +
          `read, so this order's price was not checked against a tick ` +
          `schedule — ${SERVER_SIDE_BACKSTOP}`,
      );
    } else if (scaledPrice % tick !== 0) {
      throw toolError({
        code: "sanity_check_failed",
        message:
          `Leg 0 (${describeSymbol(tickLeg.symbol)}): price ` +
          `${unscale(scaledPrice)} is not a multiple of the published ` +
          `increment ${unscale(tick)}.`,
        retryable: false,
        hint: "Round the price to the instrument's increment and re-run the matching dry_run_* tool for a fresh token. The schedule is published as tick-sizes (equities) and option-tick-sizes (options on that equity) on GET /instruments/equities/{symbol}.",
      });
    } else {
      ran.add("tick_size");
    }
  }

  // 3. Notional cap from env — the same check, and the same code path, the
  // three legless routes run through runStoredDryRunChecks.
  applyNotionalCap(dry, warnings);
  ran.add("notional_cap");

  // 4. Surface any dry-run warnings — into the UPSTREAM channel, never into
  // this server's own. See SanityCheckOutcome for why one array with two
  // authors cannot carry this.
  collectDryRunWarnings(dry, warnings, upstreamNotes);

  // 5. Account state — the same helper, and the same hard block, the three
  // legless routes run through runStoredDryRunChecks. `legs` is passed here and
  // omitted there, which is the only difference between the two.
  const state = await runAccountStateChecks(client, accountNumber, legs);
  warnings.push(...state.warnings);
  for (const id of state.ran) ran.add(id);

  return { warnings, upstreamNotes, checksNotRun: deriveChecksNotRun(ran) };
}
