/**
 * The contract every advertised tool must satisfy before a client ever sees it.
 *
 * The registry BIJECTION — advertised tools ↔ TOOL_ANNOTATIONS, no duplicates,
 * the exact tool count — is asserted over the wire in test/e2e/protocol.test.ts
 * ("protocol: tools/list" and "protocol: registry bijection"), which is the
 * stronger statement of the same invariant and the one to change if the surface
 * changes. What lives here is what that suite does NOT reach: the presentation
 * contract `decorateTool` is responsible for, and the guard it throws when the
 * registry is incomplete.
 */

import { describe, it, expect } from "@jest/globals";
import {
  TastytradeMCPServer,
  TOOL_ANNOTATIONS,
  decorateTool,
} from "../../src/mcp-server/index.js";
import { TOOL_METADATA } from "../../src/mcp-server/tool-metadata.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Instantiating with only an apiUrl performs NO network I/O — the constructor
 * just builds the axios client and registers handlers. We reach the private
 * getTools() via a cast to read the advertised tool surface.
 */
function rawTools(): Tool[] {
  const server = new TastytradeMCPServer({
    apiUrl: "https://api.cert.tastyworks.com",
  });
  return (server as unknown as { getTools(): Tool[] }).getTools();
}

const tools = rawTools();
const names = tools.map((t) => t.name);
const decorated = tools.map(decorateTool) as any[];

describe("decorateTool refuses an unregistered tool", () => {
  // The registry guard itself. Without it a tool with no TOOL_ANNOTATIONS entry
  // would be advertised with `annotations: undefined`, and the read-only gate —
  // which asks the annotation whether a tool may run — would have nothing to
  // ask. It is exercised here rather than by a missing-entry regression because
  // a missing entry takes every suite that imports this module down at load,
  // reporting a module-init failure instead of the invariant that broke.
  it("throws, naming the table to add the tool to", () => {
    expect(() =>
      decorateTool({
        name: "tastytrade_not_registered",
        description: "A tool nobody added to the registry.",
        inputSchema: { type: "object", properties: {} },
      } as Tool),
    ).toThrow(/TOOL_ANNOTATIONS/);
  });

  it("names the offending tool, so the fix is one edit away", () => {
    expect(() =>
      decorateTool({
        name: "tastytrade_not_registered",
        description: "A tool nobody added to the registry.",
        inputSchema: { type: "object", properties: {} },
      } as Tool),
    ).toThrow(/tastytrade_not_registered/);
  });

  it("accepts a tool that IS registered", () => {
    // Otherwise the two assertions above would pass for a decorateTool that
    // simply threw on everything.
    expect(() => decorateTool(tools[0])).not.toThrow();
    expect(decorateTool(tools[0]).annotations).toEqual(
      TOOL_ANNOTATIONS[tools[0].name],
    );
  });
});

describe("TOOL_METADATA covers exactly the advertised tools", () => {
  // decorateTool takes `title`, `description`, `outputSchema` and every
  // per-parameter description from this table, and silently omits each one it
  // cannot find. A tool missing from it is caught by the presentation checks
  // below; a STALE entry — metadata for a tool that no longer exists — is
  // caught by nothing else in the battery, and is how a renamed tool ends up
  // shipping with the old tool's description still in the table.
  it("has an entry for every advertised tool", () => {
    expect(names.filter((n) => !(n in TOOL_METADATA))).toEqual([]);
  });

  it("has no entry for a tool that is not advertised", () => {
    expect(
      Object.keys(TOOL_METADATA).filter((n) => !names.includes(n)),
    ).toEqual([]);
  });
});

describe("decorated tool definitions (modern MCP contract)", () => {
  it("every tool has a non-empty human title", () => {
    expect(
      decorated
        .filter((t) => !t.title || !String(t.title).trim())
        .map((t) => t.name),
    ).toEqual([]);
  });

  it("every tool declares an object-typed outputSchema (MCP spec requires it)", () => {
    expect(
      decorated
        .filter(
          (t) =>
            !t.outputSchema ||
            typeof t.outputSchema !== "object" ||
            t.outputSchema.type !== "object",
        )
        .map((t) => t.name),
    ).toEqual([]);
  });

  it("every tool description is substantive (>= 80 chars)", () => {
    expect(
      decorated
        .filter((t) => (t.description ?? "").length < 80)
        .map((t) => t.name),
    ).toEqual([]);
  });

  it("every tool input object is closed (additionalProperties:false)", () => {
    expect(
      decorated
        .filter((t) => t.inputSchema?.additionalProperties !== false)
        .map((t) => t.name),
    ).toEqual([]);
  });

  it("every input property has a description (zero undescribed params)", () => {
    const offenders: string[] = [];
    for (const t of decorated) {
      const props = t.inputSchema?.properties ?? {};
      for (const [p, schema] of Object.entries<any>(props)) {
        if (!schema?.description || !String(schema.description).trim()) {
          offenders.push(`${t.name}.${p}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
