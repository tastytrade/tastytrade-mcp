/**
 * The result cap: what is measured, where the line is, and that every hint
 * names a real read tool and a call that would help.
 */

import { describe, it, expect } from "@jest/globals";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  TastytradeMCPServer,
  TOOL_ANNOTATIONS,
} from "../../src/mcp-server/index.js";
import { accessClassFor } from "../../src/mcp-server/annotations.js";
import {
  CAP_HINT_ROWS,
  GENERIC_CAP_HINT,
  RESULT_LIMIT_BYTES,
  capHintFor,
  measureToolResult,
  resourceCapRefusal,
  resultCapRefusal,
} from "../../src/mcp-server/result-cap.js";

const TOOLS = (
  new TastytradeMCPServer({
    apiUrl: "https://api.cert.tastyworks.com",
  }) as unknown as { getTools(): Tool[] }
).getTools();

const READ_TOOLS = TOOLS.filter(
  (t) => accessClassFor(TOOL_ANNOTATIONS[t.name]) === "read",
);
const READ_NAMES = new Set(READ_TOOLS.map((t) => t.name));
const hasParam = (tool: Tool, param: string): boolean =>
  Object.keys(tool.inputSchema.properties ?? {}).includes(param);

/** A text block of exactly `bytes` ASCII bytes. */
const text = (bytes: number) => ({ type: "text", text: "a".repeat(bytes) });

describe("measureToolResult", () => {
  it("counts the UTF-8 bytes of the text and of the structured mirror", () => {
    // "é" is two bytes. The mirror serialises to {"a":"é"}, ten bytes. Both are
    // sent to the client, so both are counted.
    expect(
      measureToolResult({
        content: [{ type: "text", text: "é" }],
        structuredContent: { a: "é" },
      }),
    ).toBe(12);
  });

  it("counts every text block and ignores other block types", () => {
    expect(
      measureToolResult({
        content: [text(3), { type: "image", data: "xxxxxxxx" }, text(4)],
      }),
    ).toBe(7);
  });

  it("is zero for a result with neither", () => {
    expect(measureToolResult({})).toBe(0);
  });
});

describe("the limit", () => {
  it("passes a result of exactly 1 MiB and refuses one byte more", () => {
    expect(RESULT_LIMIT_BYTES).toBe(1_048_576);
    expect(
      resultCapRefusal({ content: [text(1_048_576)] }, "tastytrade_get_orders"),
    ).toBeUndefined();
    const refusal = resultCapRefusal(
      { content: [text(1_048_577)] },
      "tastytrade_get_orders",
    );
    expect(refusal?.code).toBe("result_too_large");
    expect(refusal?.retryable).toBe(false);
    expect(refusal?.message).toBe(
      "The result is 1,048,577 bytes, over the 1,048,576-byte (1 MiB) limit for one tool result, so it was not returned.",
    );
  });

  it("adds the structured mirror to the text before comparing", () => {
    const half = 600_000;
    const refusal = resultCapRefusal(
      {
        content: [text(half)],
        structuredContent: { v: "a".repeat(half) },
      },
      "tastytrade_get_orders",
    );
    expect(refusal?.message).toContain("1,200,008 bytes");
  });

  it("reports the size in bytes, with separators", () => {
    const refusal = resultCapRefusal(
      { content: [text(3 * 1_048_576)] },
      "tastytrade_get_orders",
    );
    expect(refusal?.message).toBe(
      "The result is 3,145,728 bytes, over the 1,048,576-byte (1 MiB) limit for one tool result, so it was not returned.",
    );
  });

  it("applies the same line to a resource body", () => {
    expect(resourceCapRefusal("a".repeat(1_048_576))).toBeUndefined();
    const refusal = resourceCapRefusal("é".repeat(524_289));
    expect(refusal?.code).toBe("result_too_large");
    expect(refusal?.message).toContain("1,048,578 bytes");
    expect(refusal?.message).toContain("resource read");
    expect(refusal?.hint).toContain(GENERIC_CAP_HINT);
  });
});

describe("the hints", () => {
  it("each names only registered read tools, and its list equals the names in its text", () => {
    for (const row of CAP_HINT_ROWS) {
      const named = [...row.hint.matchAll(/tastytrade_[a-z_]+/g)].map(
        (m) => m[0],
      );
      expect([...named].sort()).toEqual([...row.names].sort());
      for (const name of row.names) expect(READ_NAMES.has(name)).toBe(true);
      for (const tool of row.tools) expect(READ_NAMES.has(tool)).toBe(true);
    }
  });

  it("send the option chains to the compact chain and to single contracts", () => {
    expect(capHintFor("tastytrade_get_option_chain")).toContain(
      "tastytrade_get_option_chain_compact",
    );
    expect(capHintFor("tastytrade_get_option_chain_nested")).toContain(
      "tastytrade_get_equity_option",
    );
    expect(capHintFor("tastytrade_get_futures_option_chain_full")).toContain(
      "tastytrade_get_futures_option_chains",
    );
    expect(capHintFor("tastytrade_get_futures_option_chain_full")).toContain(
      "tastytrade_get_future_option",
    );
  });

  it("put every read tool that takes per_page in the dated or the paged row", () => {
    const dated = CAP_HINT_ROWS.find((r) => r.hint.includes("start_date"));
    const paged = CAP_HINT_ROWS.find(
      (r) => r !== dated && r.hint.includes("per_page"),
    );
    expect(dated).toBeDefined();
    expect(paged).toBeDefined();
    const paging = READ_TOOLS.filter((t) => hasParam(t, "per_page"));
    expect(paging.length).toBeGreaterThan(8);
    for (const tool of paging) {
      const row = hasParam(tool, "start_date") ? dated : paged;
      expect([tool.name, row?.tools.includes(tool.name)]).toEqual([
        tool.name,
        true,
      ]);
    }
    // And the rows hold nothing that does not page.
    for (const name of dated?.tools ?? []) {
      const tool = READ_TOOLS.find((t) => t.name === name);
      expect(tool && hasParam(tool, "per_page")).toBe(true);
      expect(tool && hasParam(tool, "start_date")).toBe(true);
    }
    for (const name of paged?.tools ?? []) {
      const tool = READ_TOOLS.find((t) => t.name === name);
      expect(tool && hasParam(tool, "per_page")).toBe(true);
      expect(tool && hasParam(tool, "start_date")).toBe(false);
    }
  });

  it("fall back to the generic hint for any other tool, and for no tool", () => {
    expect(capHintFor("tastytrade_get_accounts")).toBe(GENERIC_CAP_HINT);
    expect(capHintFor(undefined)).toBe(GENERIC_CAP_HINT);
  });
});
