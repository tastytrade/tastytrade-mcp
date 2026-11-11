/**
 * Three rules for every description the server lists (tool, input and output schema):
 * 1. Every identifier with an underscore is a ToolError code, a tool or schema name,
 *    or one of OTHER_IDENTIFIERS.
 * 2. No refusal name (forbidden, unauthorized, not permitted, permission denied,
 *    access denied) appears, in any case or spacing.
 * 3. An `errors[...]` array is only the broker's: `upstream.errors[]` or the placed
 *    order field list.
 * Out of scope: a made-up one-word code, and an error shape that names no array.
 */

import { describe, it, expect } from "@jest/globals";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  TastytradeMCPServer,
  decorateTool,
} from "../../src/mcp-server/index.js";
import { TOOL_ERROR_CODES } from "../../src/safety/errors.js";

/**
 * Identifiers in descriptions that are not error codes or schema names: a ToolError
 * field, the broker's own error names, the ids of the checks a dry-run route reports
 * as not run, a configuration variable and streaming message names.
 */
const OTHER_IDENTIFIERS = [
  "retry_after_ms",
  "validation_error",
  "preflight_check_failure",
  "invalid_oco_order_type_combo",
  "quote_streamer",
  "customer_not_found_error",
  "customer_id",
  "pairs_watchlist_name",
  "dry_run_readable",
  "dry_run_errors",
  "dry_run_described_order",
  "notional_cap",
  "per_leg_order_size",
  "account_frozen",
  "account_closing_only",
  "account_margin_call",
  "account_risk_reducing_only",
  "MAX_ORDER_NOTIONAL_USD",
  "SHORT_TERM",
  "CHANNEL_REQUEST",
  "FEED_SETUP",
  "FEED_SUBSCRIPTION",
];

const IDENTIFIER =
  /(?<![A-Za-z0-9_])[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9_])/g;
const REFUSAL_NAME =
  /(?<![a-z0-9])(?:forbidden|un[\s_-]*authori[sz]ed|not[\s_-]*permitted|(?:permission|access)[\s_-]*(?:(?:is|was|are)[\s_-]*)?denied)(?![a-z0-9])/gi;
const ERRORS_ARRAY =
  /(?<![A-Za-z0-9_])errors?(?:\s*\[|\s*:\s*\[|\s+(?:array|list)\b)/gi;
const BROKER_ORDER_FIELDS = "warnings[], errors[], notes[]";

/** The tools exactly as the server lists them. Building the server sends nothing. */
const TOOLS = (
  new TastytradeMCPServer({
    apiUrl: "https://api.cert.tastyworks.com",
  }) as unknown as { getTools(): Tool[] }
)
  .getTools()
  .map(decorateTool);

const normal = (name: string): string => name.toLowerCase().replace(/-/g, "_");

/** Every property name and enum value under a schema fragment. */
function schemaNames(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) schemaNames(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.add(normal(key));
      if (key === "enum" && Array.isArray(value)) {
        for (const item of value)
          if (typeof item === "string") out.add(normal(item));
      }
      schemaNames(value, out);
    }
  }
}

/** Every `description` string under a schema fragment. */
function schemaDescriptions(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) schemaDescriptions(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") out.push(value);
      else schemaDescriptions(value, out);
    }
  }
}

const KNOWN = new Set<string>(
  [...TOOL_ERROR_CODES, ...OTHER_IDENTIFIERS].map(normal),
);
for (const tool of TOOLS) {
  KNOWN.add(normal(tool.name));
  KNOWN.add(normal(tool.name.replace(/^tastytrade_/, "")));
  schemaNames(tool.inputSchema, KNOWN);
  schemaNames(tool.outputSchema, KNOWN);
}

/** Each rule `text` breaks, as "rule <n>: <the words>". */
function wordingProblems(text: string): string[] {
  const problems: string[] = [];
  for (const [word] of text.matchAll(IDENTIFIER)) {
    if (!KNOWN.has(normal(word))) problems.push(`rule 1: ${word}`);
  }
  for (const [words] of text.matchAll(REFUSAL_NAME)) {
    problems.push(`rule 2: ${words}`);
  }
  const plain = text.replace(/`/g, "");
  for (const match of plain.matchAll(ERRORS_ARRAY)) {
    const at = match.index;
    const fieldsAt = at - "warnings[], ".length;
    const broker =
      plain.slice(at - "upstream.".length, at) === "upstream." ||
      plain.slice(fieldsAt, fieldsAt + BROKER_ORDER_FIELDS.length) ===
        BROKER_ORDER_FIELDS;
    if (!broker) problems.push(`rule 3: ${match[0]}`);
  }
  return problems;
}

describe("error wording in tool descriptions", () => {
  it("follows the three rules in every description the server lists", () => {
    const bad: string[] = [];
    for (const tool of TOOLS) {
      const texts = [tool.description ?? ""];
      schemaDescriptions(tool.inputSchema, texts);
      schemaDescriptions(tool.outputSchema, texts);
      for (const text of texts)
        for (const problem of wordingProblems(text))
          bad.push(`${tool.name}: ${problem}`);
    }
    expect(bad).toEqual([]);
  });

  it.each([
    ["Returns not_permitted when the account is not yours.", "rule 1"],
    ["Returns not_permitted.", "rule 1"],
    ["Returns the not_permitted code.", "rule 1"],
    ["Errors with a not_permitted ToolError envelope.", "rule 1"],
    ["Errors carry a code (e.g. auth_failed/not_permitted).", "rule 1"],
    ["Fails with NOT_PERMITTED.", "rule 1"],
    ["Fails with permission_error.", "rule 1"],
    ["Returns ACCESS_REVOKED.", "rule 1"],
    ["A foreign account is refused with code forbidden (404).", "rule 2"],
    ["Errors are auth_failed, validation, forbidden, or network.", "rule 2"],
    ["A bad name surfaces as a 'forbidden' ToolError.", "rule 2"],
    ["The ToolError code is forbidden.", "rule 2"],
    ["The error code is forbidden.", "rule 2"],
    ["Result has code: forbidden.", "rule 2"],
    ["Fails with a forbidden ToolError.", "rule 2"],
    ["Fails with not-permitted.", "rule 2"],
    ["Fails with Not Permitted.", "rule 2"],
    ["Returns notPermitted.", "rule 2"],
    ["Fails with UNAUTHORIZED.", "rule 2"],
    ["Returns permission denied.", "rule 2"],
    ["Returns not  permitted.", "rule 2"],
    ["Fails as un-authorized.", "rule 2"],
    ["Fails when permission is denied.", "rule 2"],
    ["Access was denied.", "rule 2"],
    ["Fails with access_denied.", "rule 2"],
    ["Errors come back in an errors[] envelope.", "rule 3"],
    ["Errors come back in an `errors[]` envelope.", "rule 3"],
    ["Each errors[] envelope entry is a ToolError.", "rule 3"],
    ["See the errors[] array.", "rule 3"],
    ["Returns an errors[] list of ToolError.", "rule 3"],
    ["Returns an errors array envelope.", "rule 3"],
    ["Read errors[0].code.", "rule 3"],
    ["Read each of errors[*].", "rule 3"],
    ["Read errors[ 0 ].", "rule 3"],
    ["Returns {errors: [...]} entries.", "rule 3"],
    ["Rejections come back inside the response errors[].", "rule 3"],
  ])("flags %j under %s", (text, rule) => {
    expect(wordingProblems(text).map((p) => p.split(":")[0])).toContain(rule);
  });

  it("accepts real codes, known names, the broker's errors array and plain words", () => {
    expect(
      wordingProblems(
        "Errors: auth_failed (401/403) for an account this credential does not " +
          "hold, not_found for an unknown order, validation on a bad date, network " +
          "on a dropped connection; wait retry_after_ms. A non-empty " +
          "`upstream.errors[]` means do not proceed. Returns warnings[], errors[], " +
          "notes[]. More than one collection is permitted; the endpoint is " +
          "unauthenticated; MAX_ORDER_NOTIONAL_USD caps the order.",
      ),
    ).toEqual([]);
  });
});
