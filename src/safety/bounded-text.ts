/**
 * ONE bound and ONE stripper for every agent-facing surface.
 *
 * Everything this server hands an agent — tool result, error envelope, resource
 * body, rendered prompt, broker note — lands in the same context window as the
 * server's own words, and most of it is text somebody else wrote. A second
 * stripper is the specific mistake this module exists to prevent, so this is the
 * only one and every chokepoint imports from here.
 *
 * "Display hostile" is TWO classes, treated differently because they do different
 * damage:
 *
 *   - BREAKS — category Cc plus U+2028/U+2029. They occupy space when rendered: a
 *     line break ends the server's sentence and starts somebody else's, so a value
 *     carrying "\n\n### SYSTEM NOTICE …" adds what looks like a section to a
 *     document the server wrote. They become a SPACE, because removing them would
 *     glue the surrounding words together and change what an operator reads.
 *   - INVISIBLE FORMAT — category Cf. These render as nothing, so
 *     `5WX<U+202E>54321<U+202C>` displays as one account number and IS another.
 *     They are REMOVED, so the visible characters join up as they appear.
 *
 * Matched as the CATEGORY (`\p{Cf}`), not as a list of codepoints some
 * proof-of-concept used: an enumeration covers U+202E and U+200B, then misses
 * U+2066, U+FEFF, U+00AD and whatever a future Unicode revision adds.
 *
 * Strong right-to-left LETTERS, homoglyphs, combining marks and fullwidth digits
 * survive this deliberately. Refusing them is a charset ALLOWLIST decision at the
 * surface that knows what shape its value should have — an account number is ASCII
 * by construction, a watchlist name is not — and does not belong in a
 * general-purpose text bound.
 */

/**
 * Is this a break codepoint — Cc, or a Unicode line/paragraph separator?
 *
 * Written as numeric comparisons rather than a character class so it stays
 * readable and eslint's `no-control-regex` has nothing to say about it. Cc is
 * exactly U+0000-U+001F and U+007F-U+009F.
 */
export function isBreakCodepoint(cp: number): boolean {
  return (
    cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029
  );
}

/** The lowest codepoint in general category Cf (U+00AD SOFT HYPHEN). */
const FIRST_FORMAT_CODEPOINT = 0x00ad;
const LAST_CODEPOINT = 0x10ffff;
const FORMAT_CATEGORY_RE = /\p{Cf}/u;

/**
 * Is this an invisible format codepoint (general category Cf)?
 *
 * The numeric guard is not an optimisation for its own sake: it means an ASCII
 * payload never builds a string or runs a regex, and this predicate is called
 * once per codepoint of every result this server emits.
 */
export function isInvisibleFormatCodepoint(cp: number): boolean {
  if (cp < FIRST_FORMAT_CODEPOINT || cp > LAST_CODEPOINT) return false;
  return FORMAT_CATEGORY_RE.test(String.fromCodePoint(cp));
}

/**
 * Is this a codepoint that changes how text displays without being legible as
 * itself? The union of the two classes above — the predicate a caller wants
 * when it only needs to ask "is this safe to show a human".
 */
export function isDisplayHostileCodepoint(cp: number): boolean {
  return isBreakCodepoint(cp) || isInvisibleFormatCodepoint(cp);
}

/**
 * One cheap scan that answers "is there anything in here to strip at all".
 *
 * Non-global so `lastIndex` cannot carry between calls. `\p{Cc}` is the same
 * set the numeric comparison above expresses; both spellings are here because
 * this one runs over a whole string and that one over a codepoint.
 */
const HOSTILE_PROBE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

interface StripResult {
  text: string;
  /** Break codepoints turned into a space. */
  flattened: number;
  /** Invisible format codepoints removed outright. */
  removed: number;
}

/**
 * Iterated by CODE POINT, not code unit: Cf reaches into plane 1, so a code-unit
 * walk would see two lone surrogates instead of one format character and keep
 * both.
 */
function stripHostile(text: string, allowLineBreaks: boolean): StripResult {
  if (!HOSTILE_PROBE_RE.test(text)) {
    return { text, flattened: 0, removed: 0 };
  }
  const out: string[] = [];
  let flattened = 0;
  let removed = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (allowLineBreaks && (cp === 0x0a || cp === 0x0d)) {
      out.push(ch);
    } else if (isBreakCodepoint(cp)) {
      out.push(" ");
      flattened++;
    } else if (isInvisibleFormatCodepoint(cp)) {
      removed++;
    } else {
      out.push(ch);
    }
  }
  return { text: out.join(""), flattened, removed };
}

/**
 * Clip to `maxChars`, reporting the ORIGINAL length rather than hiding it, so an
 * operator can tell a 40,000-character value from one that ended at the bound.
 *
 * ONE DELIBERATE DIFFERENCE from the clippers this replaces: the marker is inside
 * the budget, so the result is never longer than `maxChars` and clipping is
 * IDEMPOTENT. That matters because a value can legitimately meet two chokepoints
 * — a broker note bounded at 240 inside a tool result bounded again — and a marker
 * outside the budget re-clips an already-clipped value, nesting marker in marker.
 */
function clipCounted(
  text: string,
  maxChars: number,
): { text: string; dropped: number } {
  if (text.length <= maxChars) return { text, dropped: 0 };
  const marker = truncationMarker(text.length);
  const keep = Math.max(0, maxChars - marker.length);
  return {
    text: `${text.slice(0, keep)}${marker}`,
    dropped: text.length - keep,
  };
}

/**
 * The marker text, on its own — for a caller that keeps NONE of a value and
 * still has to say how much there was.
 *
 * Exported so there is one spelling of this sentence in the tree. `redactDeep`
 * refuses a string leaf outright when it is bigger than the walk budget left,
 * and a bare structural `[truncated]` there would drop the one fact an operator
 * needs: whether 50,000 characters arrived or 40.
 */
export function truncationMarker(originalLength: number): string {
  return `…[truncated, ${originalLength} chars]`;
}

export interface BoundedTextOptions {
  /** Longest result. Defaults to no length bound — strip only. */
  maxChars?: number;
  /**
   * Collapse runs of spaces to one and trim, so a flattened multi-line value
   * cannot be more than a fragment of the line it is interpolated into. What
   * `promptArg` has always done.
   */
  collapseWhitespace?: boolean;
  /**
   * Keep U+000A and U+000D. For the one argument designed to carry a whole
   * multi-line document (a fenced JSON block), where flattening the newlines
   * would defeat the thing being quoted. The invisible-format strip still runs.
   */
  allowLineBreaks?: boolean;
  /**
   * `"counted"` (default) appends `…[truncated, N chars]` within the budget.
   * `"ellipsis"` appends a bare `…` past the budget — the marker `promptArg`
   * has always used, kept so its output stays byte-identical.
   */
  truncationMarker?: "counted" | "ellipsis";
}

/** Bound one string: strip the hostile codepoints, then clip. */
export function boundedText(
  value: string,
  options: BoundedTextOptions = {},
): string {
  const {
    maxChars = Number.POSITIVE_INFINITY,
    collapseWhitespace = false,
    allowLineBreaks = false,
    truncationMarker = "counted",
  } = options;
  let text = stripHostile(value, allowLineBreaks).text;
  if (collapseWhitespace) text = text.replace(/ {2,}/g, " ").trim();
  if (truncationMarker === "ellipsis") {
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }
  return clipCounted(text, maxChars).text;
}

// ---------------------------------------------------------------------------
// The payload-shaped companion.
//
// `boundedText` is type-wrong on a composite: apply a character cap to the
// SERIALISED text of a tool result and the JSON stops being JSON, which the
// reference client rejects with -32600 — a working tool turned into a protocol
// failure. So a payload is bounded as a VALUE, string leaf by string leaf, and
// re-serialised afterwards.
// ---------------------------------------------------------------------------

/** Longest string leaf a bounded payload may carry, by default. */
export const DEFAULT_MAX_STRING_CHARS = 2_048;

/**
 * Longest text operand a ToolError envelope may carry: `message`, `hint`,
 * `upstream.code`, and each string leaf of `upstream.body`.
 *
 * Defined here rather than at the envelope because `sanitizeToolError` is not the
 * only place that bounds an envelope operand, and two of them disagreeing about
 * the number is what this module prevents.
 *
 * Sized from the tree: the longest server-authored `hint` is 551 characters and
 * the longest `message` 142, so 4,096 is a sevenfold margin and still turns a 4 MB
 * upstream paragraph into 4 KB. Deliberately LARGER than
 * DEFAULT_MAX_STRING_CHARS, because an envelope's `hint` is the whole diagnostic.
 *
 * The number that must NOT be used is 120: 24 of the 39 single-line `hint:`
 * literals here already exceed it, so that cap would delete the server's own
 * diagnostic and keep none of an attacker's text.
 */
export const MAX_ENVELOPE_TEXT_CHARS = 4_096;

/**
 * Longest REQUEST PATH this client will reflect back into a failure message.
 *
 * With real values substituted the longest path this client builds is 78
 * characters and the longest literal prefix is 59, so 128 is comfortable headroom
 * — and still 15x below the 2,007 characters a caller can put in one, because
 * path construction percent-encodes an argument without bounding its length.
 *
 * Separate from the caps above because on a transport failure
 * `adaptRequestFailure` interpolates `e.config.url`, so the value being bounded is
 * the CALLER'S text echoed back, not the broker's. That makes it the one cap here
 * whose threat model is a hostile tool argument, and the reason it is an order of
 * magnitude tighter: a request path has a known shape and length.
 */
export const MAX_REQUEST_PATH_CHARS = 128;

/**
 * Longest PER-FIELD failure diagnostic a resource body may carry — the
 * `unavailable-fields[].message` of a computed resource.
 *
 * Deliberately NOT `MAX_ENVELOPE_TEXT_CHARS`, and named for its surface rather
 * than its size. That one bounds the WHOLE diagnostic an agent acts on; this
 * bounds ONE FIELD's failure line, of which a computed resource emits up to one
 * per fan-out read, and one is then interpolated into a sentence whose other
 * operand is bounded at 32 characters.
 *
 * 1,024 because the longest legitimate composed message here is the 550-character
 * unknown-outcome envelope; a 240 cap would delete the most important sentence
 * this server sends and keep none of an attacker's text.
 */
export const MAX_FIELD_FAILURE_CHARS = 1_024;

/**
 * Longest string leaf of an UPSTREAM RESPONSE BODY this server relays.
 *
 * Not chosen — hoisted from `src/api-client.ts`, which caps a 2xx-unreadable text
 * body at 200 characters because such a body is usually an intermediary talking
 * (a proxy interstitial, a WAF block page) and knowing which is the whole
 * diagnosis.
 *
 * Twenty times tighter than `MAX_ENVELOPE_TEXT_CHARS`, and the gap is the point
 * of two names: that one bounds text this SERVER wrote, where the cap must not
 * delete the diagnostic; this one bounds a leaf somebody else wrote, where 200
 * characters is enough to report a field name and a reason.
 */
export const MAX_UPSTREAM_BODY_TEXT_CHARS = 200;

/**
 * Longest run of UPSTREAM PROSE this server will interpolate into a sentence of
 * its own.
 *
 * `MAX_ENVELOPE_TEXT_CHARS` bounds a COMPOSITE — one finished `message` or `hint`
 * — and cannot tell the broker's share from the server's: against ~85 characters
 * of server sentence it leaves roughly four thousand for whatever the broker
 * sent, on a field an agent reads as advice. Bounding the OPERAND before
 * interpolation is the only bound that can fix the ratio, because once the
 * composite exists the two halves are one string.
 *
 * 240 rather than 120 because this operand is prose and, on the grant path, is
 * the operator's only diagnostic for a total outage: `invalid_client: Client
 * authentication failed for this application` is 65 characters and must survive
 * whole. `MAX_BROKER_NOTE_CHARS` reached the same figure for the same class of
 * text; they stay separate names because the rule is one cap per SURFACE.
 */
export const MAX_UPSTREAM_PROSE_CHARS = 240;

/** Deepest level walked before a branch is replaced by a marker. */
export const DEFAULT_MAX_DEPTH = 16;
/** Most nodes visited before the walk stops. */
export const DEFAULT_NODE_BUDGET = 200_000;

/** Substituted for a branch below the depth bound — redactDeep's vocabulary. */
export const DEPTH_MARKER = "[truncated]";
/** Substituted for a value already seen on this walk — likewise. */
export const CIRCULAR_MARKER = "[circular]";
/** Substituted for everything past the node budget. */
export const BUDGET_MARKER = "[truncated: node budget]";

/**
 * Did the walk SUBSTITUTE for this value rather than return it? All three
 * markers are strings, so the only safe use of this is against a value whose
 * original was not a string — see the array branch of `boundedDeep`.
 */
function isWalkMarker(v: unknown): boolean {
  return v === BUDGET_MARKER || v === DEPTH_MARKER || v === CIRCULAR_MARKER;
}

// ---------------------------------------------------------------------------
// The walk budget — ONE primitive, shared by both recursive walks in this repo.
//
// `boundedDeep` and `redactDeep` (src/safety/errors.ts) recurse over the same
// upstream values, and must not each grow their own notion of "too much work".
//
// TWO AXES, because neither bounds the other and both are attacker-chosen. NODES
// catches a wide payload — 8,000,000 one-character members two levels down, where
// a depth cap never fires. CHARACTERS catches the opposite shape, which a node
// count cannot see: one 8 MB string leaf is exactly ONE node.
//
// A budget is MUTABLE and threaded through the whole walk by reference, not reset
// per level. That is what makes it a bound: per-level checks let breadth
// substitute for depth, whereas one budget spent across the walk means every
// mixture of wide, deep and long costs the same finite total.
// ---------------------------------------------------------------------------

export interface WalkBudget {
  /** Values left to visit. */
  nodesLeft: number;
  /** Emitted characters left; every key and every string leaf charges it. */
  charsLeft: number;
}

/**
 * A fresh budget. Either axis omitted means "unbounded on that axis" — the
 * caller opts in, so adding this parameter to an existing walk cannot silently
 * start truncating.
 */
export function newWalkBudget(
  limits: { nodes?: number; chars?: number } = {},
): WalkBudget {
  return {
    nodesLeft: limits.nodes ?? Number.POSITIVE_INFINITY,
    charsLeft: limits.chars ?? Number.POSITIVE_INFINITY,
  };
}

/** Is either axis spent? Checked before a value is visited, never after. */
export function budgetExhausted(budget: WalkBudget): boolean {
  return budget.nodesLeft <= 0 || budget.charsLeft <= 0;
}

/**
 * Charge one value and `chars` characters against the budget.
 *
 * Charged BEFORE the value is walked, which is what makes this a bound rather
 * than a report: a size check applied afterwards would have to build the whole
 * copy first, and building the copy is the cost being bounded.
 */
export function spendBudget(budget: WalkBudget, chars = 0): void {
  budget.nodesLeft -= 1;
  budget.charsLeft -= chars;
}

export interface BoundedTally {
  stringsTruncated: number;
  charactersDropped: number;
  controlCharactersFlattened: number;
  formatCodepointsRemoved: number;
  arraysTruncated: number;
  itemsDropped: number;
  branchesTruncatedByDepth: number;
  nodesDroppedByBudget: number;
  /**
   * Entries dropped because bounding their KEY collided with another key.
   *
   * Reported rather than inferred for the same reason `nodesDroppedByBudget` is:
   * a field that vanishes between the broker and the agent must be visible as a
   * fact, not as an object that happens to be one key short.
   */
  keysDropped: number;
}

export function emptyTally(): BoundedTally {
  return {
    stringsTruncated: 0,
    charactersDropped: 0,
    controlCharactersFlattened: 0,
    formatCodepointsRemoved: 0,
    arraysTruncated: 0,
    itemsDropped: 0,
    branchesTruncatedByDepth: 0,
    nodesDroppedByBudget: 0,
    keysDropped: 0,
  };
}

/** Did anything actually get bounded? */
export function tallyIsEmpty(tally: BoundedTally): boolean {
  return Object.values(tally).every((n) => n === 0);
}

/** Accumulate `from` into `into`, so one result can carry several blocks. */
export function mergeTally(into: BoundedTally, from: BoundedTally): void {
  for (const key of Object.keys(into) as Array<keyof BoundedTally>) {
    into[key] += from[key];
  }
}

/**
 * One sentence an agent (or an operator reading a transcript) can act on, or
 * `undefined` when nothing was bounded.
 *
 * A bound the caller cannot see is a bound that silently shortens the thing it
 * was asked about, which is worse than a long answer.
 */
export function describeTally(tally: BoundedTally): string | undefined {
  if (tallyIsEmpty(tally)) return undefined;
  const parts: string[] = [];
  if (tally.stringsTruncated > 0) {
    parts.push(
      `${tally.stringsTruncated} value(s) truncated (${tally.charactersDropped} characters dropped)`,
    );
  }
  if (tally.controlCharactersFlattened > 0) {
    parts.push(
      `${tally.controlCharactersFlattened} control character(s) flattened to spaces`,
    );
  }
  if (tally.formatCodepointsRemoved > 0) {
    parts.push(
      `${tally.formatCodepointsRemoved} invisible formatting code point(s) removed`,
    );
  }
  if (tally.arraysTruncated > 0) {
    parts.push(
      `${tally.arraysTruncated} list(s) shortened (${tally.itemsDropped} items dropped)`,
    );
  }
  if (tally.branchesTruncatedByDepth > 0) {
    parts.push(
      `${tally.branchesTruncatedByDepth} branch(es) replaced by "${DEPTH_MARKER}" at the depth bound`,
    );
  }
  if (tally.nodesDroppedByBudget > 0) {
    parts.push(
      `${tally.nodesDroppedByBudget} node(s) dropped at the node budget`,
    );
  }
  if (tally.keysDropped > 0) {
    parts.push(
      `${tally.keysDropped} duplicate key(s) dropped after their names were bounded`,
    );
  }
  return `This server bounded the data above: ${parts.join("; ")}.`;
}

export interface BoundedDeepOptions {
  maxStringChars?: number;
  /**
   * Defaults to NO item bound, and that default is deliberate. This runs on a
   * trading server whose legitimate payloads include a full option chain
   * (thousands of strikes, measured at 2,632 items in the recorded corpus), and
   * a silently shortened chain is a correctness defect on a money path — worse
   * than a large one. The aggregate axis is held by `nodeBudget` instead, which
   * bounds a pathological node COUNT without picking a plausible-looking number
   * that a real instrument can exceed.
   */
  maxArrayItems?: number;
  maxDepth?: number;
  nodeBudget?: number;
  /**
   * A budget to spend, shared with whatever else is walking the same value.
   * Takes precedence over `nodeBudget`, which is the convenience spelling for
   * "give me a fresh node-only budget".
   */
  budget?: WalkBudget;
  allowLineBreaks?: boolean;
}

export interface BoundedDeepResult {
  value: unknown;
  tally: BoundedTally;
}

/**
 * Bound one KEY NAME, on the same axes and with the same counters as a string
 * leaf.
 *
 * A key is not a lesser kind of text. `JSON.stringify` escapes a control byte
 * inside a key exactly as it escapes one inside a value, and `JSON.parse`
 * restores it exactly the same way — so a walk that bounded leaves and copied
 * key names through left the higher-trust rendering of a payload carrying live
 * control bytes while the text rendering beside it carried inert literals. One
 * value, two renderings, two different payloads. Bounding the key is what makes
 * "the mirror says what the text says" true on both axes.
 */
function boundKey(
  key: string,
  maxStringChars: number,
  allowLineBreaks: boolean,
  tally: BoundedTally,
): string {
  const stripped = stripHostile(key, allowLineBreaks);
  tally.controlCharactersFlattened += stripped.flattened;
  tally.formatCodepointsRemoved += stripped.removed;
  const clipped = clipCounted(stripped.text, maxStringChars);
  if (clipped.dropped > 0) {
    tally.stringsTruncated += 1;
    tally.charactersDropped += clipped.dropped;
  }
  return clipped.text;
}

/**
 * Recursively bound a payload: every string leaf stripped and clipped, depth and
 * node count capped, cycle-safe, cloning rather than mutating.
 *
 * Shaped on `redactDeep` (src/safety/errors.ts) on purpose — the two run over
 * the same values for the same reason, and a reader who knows one should
 * recognise the other. As there, a value seen twice on one walk becomes
 * `[circular]` even when the second sighting is a sibling rather than an
 * ancestor; nothing that comes out of `JSON.parse` can share a reference, so the
 * distinction is unreachable from the wire.
 */
export function boundedDeep(
  value: unknown,
  options: BoundedDeepOptions = {},
): BoundedDeepResult {
  const maxStringChars = options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS;
  const maxArrayItems = options.maxArrayItems ?? Number.POSITIVE_INFINITY;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const allowLineBreaks = options.allowLineBreaks ?? false;
  const budget =
    options.budget ??
    newWalkBudget({ nodes: options.nodeBudget ?? DEFAULT_NODE_BUDGET });
  const tally = emptyTally();
  const seen = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (budgetExhausted(budget)) {
      tally.nodesDroppedByBudget += 1;
      return BUDGET_MARKER;
    }
    spendBudget(budget, typeof node === "string" ? node.length : 0);

    if (typeof node === "string") {
      const stripped = stripHostile(node, allowLineBreaks);
      tally.controlCharactersFlattened += stripped.flattened;
      tally.formatCodepointsRemoved += stripped.removed;
      const clipped = clipCounted(stripped.text, maxStringChars);
      if (clipped.dropped > 0) {
        tally.stringsTruncated += 1;
        tally.charactersDropped += clipped.dropped;
      }
      return clipped.text;
    }
    if (node === null || typeof node !== "object") return node;

    const obj = node as object;
    if (seen.has(obj)) return CIRCULAR_MARKER;
    if (depth >= maxDepth) {
      tally.branchesTruncatedByDepth += 1;
      return DEPTH_MARKER;
    }
    seen.add(obj);

    if (Array.isArray(node)) {
      let items = node;
      // One array, at most one `arraysTruncated`, whichever axis fires — the
      // counter reports "was this array shortened", not "how many ways".
      let countedTruncation = false;
      if (node.length > maxArrayItems) {
        items = node.slice(0, maxArrayItems);
        tally.arraysTruncated += 1;
        countedTruncation = true;
        tally.itemsDropped += node.length - items.length;
      }
      // EXHAUSTION TRUNCATES THE CONTAINER; it does not substitute per element.
      //
      // `items.map(walk)` would make every value past the budget its own marker, which
      // INFLATES a wide array of short strings by up to 6.7x — a bound whose worst case
      // is larger than its input is not a bound.
      //
      // And a marker is a STRING. Putting one in place of a non-string element changes
      // that element's TYPE, and every array of upstream entities in this server's
      // outputSchemas declares `items: { type: "object" }` — so an in-band marker makes
      // the bounding layer emit a payload our own advertised schema forbids, and the
      // SDK rejects the entire successful response with -32602.
      //
      // The tail is dropped and the count goes in the tally, which the provenance block
      // already carries. That is the ONLY channel for it, so the counters are asserted.
      const kept: unknown[] = [];
      const countTruncation = () => {
        if (!countedTruncation) {
          tally.arraysTruncated += 1;
          countedTruncation = true;
        }
      };
      for (const item of items) {
        if (budgetExhausted(budget)) {
          tally.nodesDroppedByBudget += items.length - kept.length;
          countTruncation();
          break;
        }
        const walked = walk(item, depth + 1);
        // Depth and circularity substitute a marker too, and they fire per
        // element rather than for the tail — so drop this one and keep going.
        // Guarded on the ORIGINAL element's type: an upstream string that
        // happens to read "[truncated]" is data, and data is kept.
        if (typeof item !== "string" && isWalkMarker(walked)) {
          countTruncation();
          continue;
        }
        kept.push(walked);
      }
      return kept;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    // Which emitted keys arrived exactly as they are. A key that had to be
    // bounded is upstream-authored structure, and it does not get to displace a
    // field that came through intact — see the collision rule below.
    const intact = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      if (budgetExhausted(budget)) {
        // Same rule for an object: one marker entry, not one per remaining key.
        // The key names are dropped along with their values, which is why the
        // count is reported rather than left to be inferred from a short object.
        const dropped = entries.length - i;
        tally.nodesDroppedByBudget += dropped;
        out[BUDGET_MARKER] = dropped;
        break;
      }
      const [key, sub] = entries[i];
      // A key is emitted text and charges the character axis exactly as a string
      // leaf does. Only that axis: the node is charged when its VALUE is walked.
      budget.charsLeft -= key.length;
      const boundedKey = boundKey(key, maxStringChars, allowLineBreaks, tally);
      if (boundedKey !== key) {
        // BOUNDING A KEY CAN COLLIDE, and which side wins is a security decision.
        //
        // `{"quantity<U+200B>": 1, "quantity": 100}` and the same pair reversed both
        // bound to one name. Keeping the first lets an attacker who writes early own the
        // field; keeping the last lets one who writes late own it. So neither position
        // decides: the entry whose key had to be MODIFIED loses, always, and the count is
        // reported.
        if (Object.prototype.hasOwnProperty.call(out, boundedKey)) {
          tally.keysDropped += 1;
          continue;
        }
      } else if (
        Object.prototype.hasOwnProperty.call(out, boundedKey) &&
        !intact.has(boundedKey)
      ) {
        // The mirror image: this key arrived intact and an earlier bounded key
        // is sitting on its name. The intact one takes it back.
        tally.keysDropped += 1;
      }
      if (boundedKey === key) intact.add(boundedKey);
      out[boundedKey] = walk(sub, depth + 1);
    }
    return out;
  };

  return { value: walk(value, 0), tally };
}
