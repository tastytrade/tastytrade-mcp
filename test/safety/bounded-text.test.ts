/**
 * The shared bound and the shared stripper.
 *
 * Two properties matter here and they pull in opposite directions, so both are
 * asserted for every case: the hostile classes must be closed by CATEGORY
 * (not by a list of the codepoints some proof-of-concept used), and the fix
 * must not overreach — an accented letter, a CJK character, an emoji and an
 * ordinary hyphen have to come through untouched, or the bound becomes a
 * correctness defect on every legitimate payload that carries one.
 */
import { describe, it, expect } from "@jest/globals";
import {
  BUDGET_MARKER,
  CIRCULAR_MARKER,
  DEPTH_MARKER,
  boundedDeep,
  boundedText,
  budgetExhausted,
  describeTally,
  emptyTally,
  isBreakCodepoint,
  isDisplayHostileCodepoint,
  isInvisibleFormatCodepoint,
  mergeTally,
  newWalkBudget,
  spendBudget,
  tallyIsEmpty,
} from "../../src/safety/bounded-text.js";

/** Every codepoint the class fix must cover, named. */
const INVISIBLE_FORMAT: Array<[string, string]> = [
  ["U+00AD SOFT HYPHEN", "\u00ad"],
  ["U+061C ARABIC LETTER MARK", "\u061c"],
  ["U+180E MONGOLIAN VOWEL SEPARATOR", "\u180e"],
  ["U+200B ZERO WIDTH SPACE", "\u200b"],
  ["U+200C ZERO WIDTH NON-JOINER", "\u200c"],
  ["U+200D ZERO WIDTH JOINER", "\u200d"],
  ["U+200E LEFT-TO-RIGHT MARK", "\u200e"],
  ["U+200F RIGHT-TO-LEFT MARK", "\u200f"],
  ["U+202A LEFT-TO-RIGHT EMBEDDING", "\u202a"],
  ["U+202B RIGHT-TO-LEFT EMBEDDING", "\u202b"],
  ["U+202C POP DIRECTIONAL FORMATTING", "\u202c"],
  ["U+202D LEFT-TO-RIGHT OVERRIDE", "\u202d"],
  ["U+202E RIGHT-TO-LEFT OVERRIDE", "\u202e"],
  ["U+2060 WORD JOINER", "\u2060"],
  ["U+2064 INVISIBLE PLUS", "\u2064"],
  ["U+2066 LEFT-TO-RIGHT ISOLATE", "\u2066"],
  ["U+2069 POP DIRECTIONAL ISOLATE", "\u2069"],
  ["U+FEFF ZERO WIDTH NO-BREAK SPACE", "\ufeff"],
  ["U+FFF9 INTERLINEAR ANNOTATION ANCHOR", "\ufff9"],
  // Plane 1, which is why the walk iterates code points and not code units.
  ["U+110BD KAITHI NUMBER SIGN", "\u{110bd}"],
  ["U+1D173 MUSICAL SYMBOL BEGIN BEAM", "\u{1d173}"],
];

/** Values that must survive byte-for-byte. The calibration half. */
const MUST_SURVIVE: Array<[string, string]> = [
  ["an accented letter", "café"],
  ["a CJK character", "中文"],
  ["an emoji", "\u{1f680}"],
  ["punctuation the API uses in keys", "buying-power_effect.value"],
  ["a slash and a colon", "SPX 240119C05000000/1:2"],
  ["a decimal-as-string price", "1234.5678"],
];

describe("isBreakCodepoint", () => {
  it.each([
    ["NUL", 0x00],
    ["TAB", 0x09],
    ["LF", 0x0a],
    ["CR", 0x0d],
    ["ESC", 0x1b],
    ["DEL", 0x7f],
    ["C1 NEL", 0x85],
    ["C1 APC", 0x9f],
    ["U+2028 LINE SEPARATOR", 0x2028],
    ["U+2029 PARAGRAPH SEPARATOR", 0x2029],
  ])("treats %s as a break", (_label, cp) => {
    expect(isBreakCodepoint(cp)).toBe(true);
  });

  it.each([
    ["space", 0x20],
    ["A", 0x41],
    ["~", 0x7e],
    ["U+00A0 NBSP", 0xa0],
    ["U+200B ZWSP", 0x200b],
    ["U+2027", 0x2027],
    ["U+202A", 0x202a],
  ])("does not treat %s as a break", (_label, cp) => {
    expect(isBreakCodepoint(cp)).toBe(false);
  });
});

describe("isInvisibleFormatCodepoint", () => {
  it.each(INVISIBLE_FORMAT)("recognises %s", (_label, ch) => {
    expect(isInvisibleFormatCodepoint(ch.codePointAt(0) ?? 0)).toBe(true);
  });

  it.each([
    // Below the first Cf codepoint, so the numeric fast path answers.
    ["LF", 0x0a],
    ["A", 0x41],
    ["U+00AC", 0x00ac],
    // At or above it, so the category test answers.
    ["U+00AE REGISTERED SIGN", 0x00ae],
    ["U+4E2D", 0x4e2d],
    ["U+1F680 ROCKET", 0x1f680],
    // Outside Unicode entirely — reachable only from a caller doing arithmetic
    // on a codepoint, and String.fromCodePoint would throw on it.
    ["one past the last codepoint", 0x110000],
    ["a negative codepoint", -1],
  ])("does not recognise %s", (_label, cp) => {
    expect(isInvisibleFormatCodepoint(cp)).toBe(false);
  });
});

describe("isDisplayHostileCodepoint", () => {
  it("is the union of the two classes", () => {
    expect(isDisplayHostileCodepoint(0x0a)).toBe(true);
    expect(isDisplayHostileCodepoint(0x200b)).toBe(true);
    expect(isDisplayHostileCodepoint(0x41)).toBe(false);
  });
});

describe("boundedText strips the invisible-format class", () => {
  // The point of removing rather than spacing: the visible characters must join
  // up the way they APPEAR, so a substring search for what the operator reads
  // finds it.
  it.each(INVISIBLE_FORMAT)(
    "removes %s so the visible text joins up",
    (_label, ch) => {
      expect(boundedText(`5WX${ch}99999`)).toBe("5WX99999");
    },
  );

  it("removes a bidi override so the account number reads as it is", () => {
    expect(boundedText("5WX\u202e54321\u202c")).toBe("5WX54321");
  });

  it("flattens a break to a SPACE rather than removing it", () => {
    // Removing it would glue the words together and change what a human reads.
    expect(boundedText("line one\nline two")).toBe("line one line two");
  });

  it("flattens the whole break class", () => {
    expect(boundedText("a\tb\u0085c\u2028d\u2029e\u001bf")).toBe("a b c d e f");
  });

  it.each(MUST_SURVIVE)("leaves %s untouched", (_label, text) => {
    expect(boundedText(text)).toBe(text);
  });

  it("takes the fast path when there is nothing to strip", () => {
    const clean = "account-number: 5WX00001";
    expect(boundedText(clean)).toBe(clean);
  });

  it("does not clip by default", () => {
    const long = "x".repeat(10_000);
    expect(boundedText(long)).toBe(long);
  });
});

describe("boundedText collapses and trims on request", () => {
  it("collapses runs of spaces and trims, as promptArg always has", () => {
    expect(boundedText("  a\n\n\nb   c  ", { collapseWhitespace: true })).toBe(
      "a b c",
    );
  });

  it("leaves interior spacing alone when not asked to collapse", () => {
    expect(boundedText(" a  b ")).toBe(" a  b ");
  });
});

describe("boundedText preserves line breaks on request", () => {
  const doc = '{\n  "symbol": "AAPL",\n  "qty": 1\n}';

  it("keeps every newline of a multi-line document", () => {
    const out = boundedText(doc, { allowLineBreaks: true });
    expect(out).toBe(doc);
    expect(out.split("\n")).toHaveLength(4);
  });

  it("keeps a CRLF pair", () => {
    expect(boundedText("a\r\nb", { allowLineBreaks: true })).toBe("a\r\nb");
  });

  it("still strips the invisible-format class inside the document", () => {
    const out = boundedText(`{\n  "s": "AA\u200bPL"\n}`, {
      allowLineBreaks: true,
    });
    expect(out).toContain("AAPL");
    expect(out.split("\n")).toHaveLength(3);
  });
});

describe("boundedText clipping", () => {
  it("reports the original length and stays inside the budget", () => {
    const out = boundedText("y".repeat(500), { maxChars: 100 });
    expect(out.length).toBe(100);
    expect(out).toContain("…[truncated, 500 chars]");
  });

  it("is idempotent — a clipped value re-clipped is unchanged", () => {
    const once = boundedText("y".repeat(500), { maxChars: 100 });
    expect(boundedText(once, { maxChars: 100 })).toBe(once);
  });

  it("emits only the marker when the budget is smaller than the marker", () => {
    const out = boundedText("y".repeat(500), { maxChars: 4 });
    expect(out).toBe("…[truncated, 500 chars]");
  });

  it("leaves a value at exactly the budget alone", () => {
    const exact = "y".repeat(100);
    expect(boundedText(exact, { maxChars: 100 })).toBe(exact);
  });

  it("uses a bare ellipsis in ellipsis mode, past the budget", () => {
    const out = boundedText("y".repeat(500), {
      maxChars: 10,
      truncationMarker: "ellipsis",
    });
    expect(out).toBe(`${"y".repeat(10)}…`);
  });

  it("leaves a short value alone in ellipsis mode", () => {
    expect(
      boundedText("short", { maxChars: 10, truncationMarker: "ellipsis" }),
    ).toBe("short");
  });
});

describe("the tally", () => {
  it("starts empty", () => {
    expect(tallyIsEmpty(emptyTally())).toBe(true);
    expect(describeTally(emptyTally())).toBeUndefined();
  });

  it("accumulates one tally into another", () => {
    const into = emptyTally();
    const from = emptyTally();
    from.stringsTruncated = 2;
    from.charactersDropped = 40;
    mergeTally(into, from);
    mergeTally(into, from);
    expect(into.stringsTruncated).toBe(4);
    expect(into.charactersDropped).toBe(80);
    expect(tallyIsEmpty(into)).toBe(false);
  });

  it("describes every axis it can report", () => {
    const tally = emptyTally();
    tally.stringsTruncated = 1;
    tally.charactersDropped = 9;
    tally.controlCharactersFlattened = 2;
    tally.formatCodepointsRemoved = 3;
    tally.arraysTruncated = 1;
    tally.itemsDropped = 7;
    tally.branchesTruncatedByDepth = 1;
    tally.nodesDroppedByBudget = 5;
    const text = describeTally(tally) ?? "";
    expect(text).toContain("1 value(s) truncated (9 characters dropped)");
    expect(text).toContain("2 control character(s) flattened");
    expect(text).toContain("3 invisible formatting code point(s) removed");
    expect(text).toContain("1 list(s) shortened (7 items dropped)");
    expect(text).toContain(`replaced by "${DEPTH_MARKER}"`);
    expect(text).toContain("5 node(s) dropped at the node budget");
  });
});

describe("boundedDeep", () => {
  it("passes non-string scalars through untouched", () => {
    expect(boundedDeep(7).value).toBe(7);
    expect(boundedDeep(true).value).toBe(true);
    expect(boundedDeep(null).value).toBeNull();
    expect(boundedDeep(undefined).value).toBeUndefined();
  });

  it("bounds a bare string, so a caller need not special-case one", () => {
    const out = boundedDeep("z".repeat(500), { maxStringChars: 100 });
    expect(String(out.value).length).toBe(100);
    expect(out.tally.stringsTruncated).toBe(1);
    // The marker is inside the budget, so what survives is the budget minus the
    // marker — 500 characters in, 77 kept, 423 dropped. The count is the
    // characters of the ORIGINAL that did not survive, not the size of the
    // difference in rendered length.
    expect(out.tally.charactersDropped).toBe(
      500 - (100 - "…[truncated, 500 chars]".length),
    );
  });

  it("clones rather than mutating its input", () => {
    const input = { a: ["x\u200by"] };
    const out = boundedDeep(input);
    expect(out.value).not.toBe(input);
    expect(input.a[0]).toBe("x\u200by");
    expect((out.value as { a: string[] }).a[0]).toBe("xy");
  });

  it("strips and clips every string leaf, however deep", () => {
    const out = boundedDeep(
      {
        items: [
          { name: `AAPL\u202eX${"!".repeat(300)}` },
          { name: "clean" },
          [null, 3, false],
        ],
      },
      { maxStringChars: 32 },
    );
    const value = out.value as { items: Array<Record<string, string>> };
    expect(value.items[0].name.length).toBe(32);
    expect(value.items[0].name).not.toContain("\u202e");
    expect(value.items[1].name).toBe("clean");
    expect(out.tally.stringsTruncated).toBe(1);
    expect(out.tally.formatCodepointsRemoved).toBe(1);
  });

  it("counts flattened control characters separately from removed ones", () => {
    const out = boundedDeep({ note: "a\nb\u200bc" });
    expect(out.tally.controlCharactersFlattened).toBe(1);
    expect(out.tally.formatCodepointsRemoved).toBe(1);
    expect((out.value as { note: string }).note).toBe("a bc");
  });

  it("keeps newlines in the payload when asked", () => {
    const out = boundedDeep({ doc: "a\nb" }, { allowLineBreaks: true });
    expect((out.value as { doc: string }).doc).toBe("a\nb");
  });

  it("does not bound an array's length by default", () => {
    const wide = Array.from({ length: 5_000 }, (_, i) => i);
    const out = boundedDeep(wide);
    expect((out.value as number[]).length).toBe(5_000);
    expect(out.tally.arraysTruncated).toBe(0);
  });

  it("bounds an array's length when a caller asks for it", () => {
    const out = boundedDeep(
      Array.from({ length: 10 }, (_, i) => i),
      {
        maxArrayItems: 4,
      },
    );
    expect((out.value as number[]).length).toBe(4);
    expect(out.tally.arraysTruncated).toBe(1);
    expect(out.tally.itemsDropped).toBe(6);
  });

  it("leaves an array at exactly the item bound alone", () => {
    const out = boundedDeep([1, 2, 3], { maxArrayItems: 3 });
    expect(out.tally.arraysTruncated).toBe(0);
  });

  it("marks a branch past the depth bound instead of recursing forever", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 12; i++) deep = { down: deep };
    const out = boundedDeep(deep, { maxDepth: 3 });
    expect(JSON.stringify(out.value)).toContain(DEPTH_MARKER);
    expect(out.tally.branchesTruncatedByDepth).toBe(1);
  });

  it("marks a cycle instead of hanging", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const out = boundedDeep(cyclic);
    expect((out.value as Record<string, unknown>).self).toBe(CIRCULAR_MARKER);
  });

  it("stops at the node budget and says so", () => {
    const out = boundedDeep([1, 2, 3, 4, 5, 6], { nodeBudget: 4 });
    const value = out.value as unknown[];
    // The tail is DROPPED, not marked in band: a marker element would change the
    // element type and break the outputSchemas that declare what these arrays
    // hold. "Says so" is therefore the tally's job, and only the tally's.
    expect(value.length).toBeLessThan(6);
    expect(value).not.toContain(BUDGET_MARKER);
    expect(out.tally.nodesDroppedByBudget).toBeGreaterThan(0);
    expect(out.tally.arraysTruncated).toBe(1);
  });

  it("returns the budget marker for the whole value when the budget is zero", () => {
    const out = boundedDeep({ anything: true }, { nodeBudget: 0 });
    expect(out.value).toBe(BUDGET_MARKER);
    expect(out.tally.nodesDroppedByBudget).toBe(1);
  });

  it("leaves a realistic payload byte-identical", () => {
    // The whole recorded corpus fits inside the default bounds — the longest
    // string in it is 135 characters and the deepest nesting is 7 levels — so a
    // legitimate payload must come back untouched or the bound is a defect.
    const payload = {
      items: [
        {
          account: {
            "account-number": "5WX00001",
            nickname: "Growth",
            "day-trader-status": false,
            "margin-or-cash": "Margin",
          },
          "authority-level": "owner",
        },
      ],
    };
    const out = boundedDeep(payload);
    expect(out.value).toEqual(payload);
    expect(tallyIsEmpty(out.tally)).toBe(true);
  });
});

describe("the node budget bounds the OUTPUT, not just the walk", () => {
  // The budget would substitute a marker for EVERY node
  // past it, one marker per node. On the shape the budget exists for — a wide
  // array of short strings — that inflated the payload instead of bounding it:
  // measured 1,600,012 input bytes to 10,777,058 output bytes at a 1,000-node
  // budget, and 1.6 MB to 6.2 MB at the shipped 200,000-node default.
  const wide = { errors: Array.from({ length: 400_000 }, () => "a") };

  it("never returns more bytes than it was given", () => {
    const before = JSON.stringify(wide)!.length;
    const after = JSON.stringify(
      boundedDeep(wide, { nodeBudget: 1_000 }).value,
    )!.length;
    expect(after).toBeLessThan(before);
  });

  it("truncates the array with NO marker and reports the count", () => {
    // Was "with ONE marker": the tail would end in a marker element, which is
    // still bounded (that is what this test was protecting) but is a STRING
    // where the schema promises an entity. Dropping the tail keeps the bound and
    // keeps the array homogeneous; the count moves entirely into the tally.
    //
    // `wide` is an array of STRINGS, so this also pins the narrower rule: the
    // marker is gone because the tail is dropped, not because the elements
    // happened to be strings.
    const out = boundedDeep(wide, { nodeBudget: 1_000 });
    const kept = (out.value as { errors: unknown[] }).errors;
    expect(kept.length).toBeLessThan(1_100);
    expect(kept.filter((v) => v === BUDGET_MARKER)).toHaveLength(0);
    expect(out.tally.nodesDroppedByBudget).toBeGreaterThan(398_000);
    expect(out.tally.arraysTruncated).toBe(1);
  });

  it("keeps a truncated array HOMOGENEOUS — no string marker among objects", () => {
    // A marker pushed into the array as a final element is a STRING, and every array in
    // this server's outputSchemas that carries upstream entities declares
    // `items: { type: "object" }` — so it makes the bounding layer emit a payload its own
    // advertised schema forbids, and the SDK rejects the whole successful response with
    // -32602. Found by a live read sweep against the sandbox:
    //
    //   tastytrade_get_futures_option_chain_full
    //   MCP error -32602: ... data/items/3514 must be object
    //
    // /ES returns 19,654 contracts of ~30 fields, so the 200,000-node default is
    // exhausted every time and that tool was unusable, not degraded. The tail is dropped
    // instead, and truncation is reported out of band in the tally.
    const objects = {
      items: Array.from({ length: 5_000 }, (_, i) => ({ symbol: `S${i}` })),
    };
    const out = boundedDeep(objects, { nodeBudget: 100 });
    const kept = (out.value as { items: unknown[] }).items;

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(5_000);
    // The invariant the schema depends on.
    for (const [i, item] of kept.entries()) {
      expect({ i, type: typeof item, isArray: Array.isArray(item) }).toEqual({
        i,
        type: "object",
        isArray: false,
      });
    }
    expect(kept).not.toContain(BUDGET_MARKER);
    // ...and it is not a SILENT cap: the count still has to be reported.
    expect(out.tally.nodesDroppedByBudget).toBeGreaterThan(4_000);
  });

  it("drops a too-deep array ELEMENT rather than replacing it with a marker", () => {
    // Depth and circularity substitute a marker per element, not for the tail,
    // so they are a second route to a string sitting where the schema promises
    // an object. `maxDepth: 2` puts the element's own body past the cap.
    const out = boundedDeep(
      { items: [{ nested: { deeper: 1 } }] },
      { maxDepth: 2 },
    );
    const kept = (out.value as { items: unknown[] }).items;
    expect(kept).not.toContain(DEPTH_MARKER);
    for (const item of kept) expect(typeof item).toBe("object");
    expect(out.tally.branchesTruncatedByDepth).toBeGreaterThan(0);
  });

  it("drops a circular array ELEMENT rather than replacing it with a marker", () => {
    const shared: Record<string, unknown> = { a: 1 };
    // `shared` is walked once as a sibling, so the second occurrence — as an
    // array element — is the one the circular guard substitutes for.
    const out = boundedDeep({ first: shared, items: [shared] });
    const kept = (out.value as { items: unknown[] }).items;
    expect(kept).not.toContain(CIRCULAR_MARKER);
    for (const item of kept) expect(typeof item).toBe("object");
    expect(out.tally.arraysTruncated).toBe(1);
  });

  it("KEEPS an upstream string that merely reads like a marker", () => {
    // The drop is guarded on the ORIGINAL element's type for this reason: a
    // broker field whose value happens to be the marker text is data, and
    // dropping it would be the bounding layer silently editing the payload.
    const out = boundedDeep({ items: [DEPTH_MARKER, BUDGET_MARKER, "ok"] });
    expect((out.value as { items: unknown[] }).items).toEqual([
      DEPTH_MARKER,
      BUDGET_MARKER,
      "ok",
    ]);
    expect(out.tally.arraysTruncated).toBe(0);
  });

  it("still reports an array truncated by the budget as a truncated array", () => {
    // `arraysTruncated: 0` alongside `nodesDroppedByBudget: 16150` is what the
    // live provenance block actually said. Both axes truncate an array; only one
    // was owning up to it, so a reader checking "was any array shortened?" got
    // the wrong answer.
    const out = boundedDeep(
      { items: Array.from({ length: 5_000 }, (_, i) => ({ symbol: `S${i}` })) },
      { nodeBudget: 100 },
    );
    expect(out.tally.arraysTruncated).toBeGreaterThan(0);
  });

  it("truncates an object with ONE marker entry carrying the dropped count", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 5_000; i += 1) many[`k${i}`] = "v";
    const out = boundedDeep(many, { nodeBudget: 100 });
    const emitted = out.value as Record<string, unknown>;
    expect(Object.keys(emitted).length).toBeLessThan(200);
    expect(emitted[BUDGET_MARKER]).toBeGreaterThan(4_800);
  });

  it("spends the character axis on keys and string leaves alike", () => {
    // One 200,000-character leaf is a single node, so a node budget cannot see
    // it. `charsLeft` is the axis that can.
    const budget = newWalkBudget({ chars: 1_000 });
    const out = boundedDeep({ a: "x".repeat(200_000), b: "kept?" }, { budget });
    expect(budgetExhausted(budget)).toBe(true);
    const emitted = out.value as Record<string, unknown>;
    // `b` is dropped with its key, and the count says so — an object's keys are
    // names, and emitting a marker under each dropped one is the amplification
    // this block exists to prevent.
    expect("b" in emitted).toBe(false);
    expect(emitted[BUDGET_MARKER]).toBe(1);
  });

  it("is unbounded on an axis the caller did not ask for", () => {
    // newWalkBudget defaults each axis to Infinity, so adding the parameter to
    // an existing walk cannot silently start truncating.
    const budget = newWalkBudget();
    expect(budgetExhausted(budget)).toBe(false);
    spendBudget(budget, 10_000_000);
    expect(budgetExhausted(budget)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A KEY is emitted text too.
//
// The walk bounded every string leaf and copied object key names through
// untouched, which left the two renderings of one payload carrying different
// bytes: `JSON.stringify` escapes a control byte inside a key exactly as it
// escapes one inside a value, so the text rendering was inert while the
// structured mirror was live. Both axes are bounded now.
// ---------------------------------------------------------------------------

const ESC = "\u001b";
const ZWSP = "\u200b";

describe("boundedDeep bounds KEY NAMES as well as string leaves", () => {
  it("flattens a break code point inside a key", () => {
    const out = boundedDeep({ [`${ESC}[2Jnickname`]: "x" });
    expect(Object.keys(out.value as object)).toEqual([" [2Jnickname"]);
    expect(out.tally.controlCharactersFlattened).toBe(1);
  });

  it("removes an invisible-format code point from a key", () => {
    const out = boundedDeep({ [`quan${ZWSP}tity`]: 1 });
    expect(Object.keys(out.value as object)).toEqual(["quantity"]);
    expect(out.tally.formatCodepointsRemoved).toBe(1);
  });

  it("clips an over-long key at the same cap as a value", () => {
    const out = boundedDeep({ ["k".repeat(500)]: 1 }, { maxStringChars: 64 });
    const key = Object.keys(out.value as object)[0];
    expect(key.length).toBe(64);
    expect(key).toContain("…[truncated, 500 chars]");
    expect(out.tally.stringsTruncated).toBeGreaterThan(0);
  });

  it("leaves a legitimate kebab-case key byte-identical", () => {
    const out = boundedDeep({
      "account-number": "5WX00001",
      "buying-power-effect": { value: "-1.5" },
    });
    expect(Object.keys(out.value as object)).toEqual([
      "account-number",
      "buying-power-effect",
    ]);
    expect(out.tally.controlCharactersFlattened).toBe(0);
    expect(out.tally.formatCodepointsRemoved).toBe(0);
  });

  it("never lets a BOUNDED key displace a key that arrived intact", () => {
    // The attack the collision rule exists for: two upstream keys that bound to
    // one name. Whichever order they arrive in, the value under the clean key is
    // the one that survives — a modified key is upstream-authored structure, and
    // it does not get to overwrite a field a schema declares.
    const attackerFirst = boundedDeep({
      [`quantity${ZWSP}`]: 1,
      quantity: 100,
    });
    expect((attackerFirst.value as Record<string, unknown>).quantity).toBe(100);

    const attackerSecond = boundedDeep({
      quantity: 100,
      [`quantity${ZWSP}`]: 1,
    });
    expect((attackerSecond.value as Record<string, unknown>).quantity).toBe(
      100,
    );

    // Asserted through the sentence rather than the counter so this test
    // compiles against both shapes of the tally and every failure it records is
    // behavioural rather than a missing field.
    expect(describeTally(attackerFirst.tally)).toContain("1 duplicate key");
    expect(describeTally(attackerSecond.tally)).toContain("1 duplicate key");
  });

  it("says so in the tally sentence, so a dropped field is never silent", () => {
    const out = boundedDeep({ quantity: 100, [`quantity${ZWSP}`]: 1 });
    expect(describeTally(out.tally)).toContain("1 duplicate key");
  });
});
