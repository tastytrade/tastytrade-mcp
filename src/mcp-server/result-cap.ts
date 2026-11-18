/**
 * The size limit on what a READ tool, or a resource read, may hand back in one
 * result, and the hint that tells the agent which narrower call to make instead.
 *
 * Why a limit at all. The result bounds in index.ts (`boundResultContent`) are per
 * leaf: they cap the length of any one string and the depth and node count of the
 * parsed value, but not the total. A broad request can still come back as several
 * megabytes of valid, well-bounded JSON (a full option chain, a year of
 * transactions), and the transport allows far more than any client can use. A
 * result that size fills an agent's context for one answer, or is dropped by the
 * client with an error that names no remedy. The limit makes the failure early,
 * explicit and actionable.
 *
 * Reads only. A write or destructive tool's result is never measured here: by the
 * time it exists the change has already happened, and telling an agent that a call
 * "failed" because its answer was long invites it to repeat the change.
 */

import type { ToolError } from "../safety/errors.js";

/** One tool result, or one resource body, may not exceed this many bytes (1 MiB). */
export const RESULT_LIMIT_BYTES = 1_048_576;

/**
 * The bytes a tool result puts on the wire: every text block (the provenance
 * notice included, once it has been appended), plus the structured mirror of the
 * same payload. All are sent, so all count; measuring the text alone would let a
 * result of just under the limit double past it. `_meta` is not counted.
 */
export function measureToolResult(result: {
  content?: unknown;
  structuredContent?: unknown;
}): number {
  let bytes = 0;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        bytes += Buffer.byteLength((block as { text: string }).text, "utf8");
      }
    }
  }
  if (result.structuredContent !== undefined) {
    bytes += Buffer.byteLength(
      JSON.stringify(result.structuredContent) ?? "",
      "utf8",
    );
  }
  return bytes;
}

/** Which narrower call to suggest, for which tools. */
export interface CapHintRow {
  /** The tools this row answers for. */
  readonly tools: readonly string[];
  /** Every tool name `hint` mentions. A test keeps this equal to the text. */
  readonly names: readonly string[];
  readonly hint: string;
}

const CHAIN_TOOLS = [
  "tastytrade_get_option_chain",
  "tastytrade_get_option_chain_nested",
];

/**
 * Rows are checked in order and the first match wins. Tools that take `per_page`
 * are listed explicitly; a test derives the same set from the tool list, so a new
 * paged read tool fails until it is placed in a row.
 */
export const CAP_HINT_ROWS: readonly CapHintRow[] = [
  {
    tools: CHAIN_TOOLS,
    names: [
      "tastytrade_get_option_chain_compact",
      "tastytrade_get_equity_option",
    ],
    hint: "Call tastytrade_get_option_chain_compact instead, or fetch specific contracts with tastytrade_get_equity_option.",
  },
  {
    tools: ["tastytrade_get_futures_option_chain_full"],
    names: [
      "tastytrade_get_futures_option_chains",
      "tastytrade_get_future_option",
    ],
    hint: "Call tastytrade_get_futures_option_chains instead, or tastytrade_get_future_option for specific contracts.",
  },
  {
    // Lists that take both a page size and a date range.
    tools: [
      "tastytrade_get_balance_snapshots",
      "tastytrade_get_orders",
      "tastytrade_search_orders",
      "tastytrade_search_customer_orders",
      "tastytrade_get_transactions",
    ],
    names: [],
    hint: "Ask for less: a smaller per_page, or a narrower start_date and end_date.",
  },
  {
    // Lists that take a page size only.
    tools: [
      "tastytrade_get_active_equities",
      "tastytrade_get_complex_orders",
      "tastytrade_get_future_option_products",
      "tastytrade_get_future_products",
      "tastytrade_get_futures",
      "tastytrade_get_span_rows",
    ],
    names: [],
    hint: "Ask for less: a smaller per_page.",
  },
];

/** The hint for anything no row names. */
export const GENERIC_CAP_HINT =
  "Ask for less: name a specific account, symbol or contract, or narrow the request in whatever other way this tool allows.";

/** The hint for `toolName`: the first row that lists it, else the generic one. */
export function capHintFor(toolName: string | undefined): string {
  const row = CAP_HINT_ROWS.find((r) => toolName && r.tools.includes(toolName));
  return row?.hint ?? GENERIC_CAP_HINT;
}

const withSeparators = (n: number): string => n.toLocaleString("en-US");

/**
 * The refusal for a result of `bytes` bytes. The size is given in bytes, not
 * MiB, so a result one byte over the limit never reads "1.00 MiB, over the
 * 1.00 MiB limit". Not retryable: the same call would
 * produce the same oversize answer. Pass the tool name to get its narrower-call
 * hint. Omit it for a resource read, which gets the generic hint and says
 * "resource read" instead of "tool result".
 */
export function resultTooLargeError(
  bytes: number,
  toolName?: string,
): ToolError {
  const what = toolName === undefined ? "resource read" : "tool result";
  return {
    code: "result_too_large",
    message: `The result is ${withSeparators(bytes)} bytes, over the ${withSeparators(RESULT_LIMIT_BYTES)}-byte (1 MiB) limit for one ${what}, so it was not returned.`,
    retryable: false,
    hint:
      `The read itself worked and changed nothing; repeating it unchanged will give the same answer. ` +
      capHintFor(toolName),
  };
}

/**
 * The refusal for a tool result, or `undefined` when it is within the limit.
 * Exactly {@link RESULT_LIMIT_BYTES} passes; one byte more is refused.
 */
export function resultCapRefusal(
  result: { content?: unknown; structuredContent?: unknown },
  toolName: string,
): ToolError | undefined {
  const bytes = measureToolResult(result);
  return bytes > RESULT_LIMIT_BYTES
    ? resultTooLargeError(bytes, toolName)
    : undefined;
}

/** The refusal for the text of a resource read, or `undefined` within the limit. */
export function resourceCapRefusal(text: string): ToolError | undefined {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > RESULT_LIMIT_BYTES ? resultTooLargeError(bytes) : undefined;
}
