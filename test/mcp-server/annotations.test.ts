/**
 * The annotation constants and the classifier the read-only gate asks.
 *
 * Both halves matter for a different reason. `accessClassFor` decides whether a
 * tool may run at all when the server is forbidden to change anything, so its
 * precedence is a safety property. The constants are DATA — they are shipped
 * verbatim to every MCP client as behaviour hints, and no amount of line
 * coverage says anything about whether their values are right. Every hint is
 * therefore pinned explicitly below; before that table existed, five of the ten
 * hint values could be flipped with the whole battery still green.
 */

import { describe, it, expect } from "@jest/globals";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  accessClassFor,
  READ_ONLY,
  READ_ONLY_NON_IDEMPOTENT,
  WRITE_IDEMPOTENT,
  WRITE_NON_IDEMPOTENT,
  DESTRUCTIVE,
  DESTRUCTIVE_IDEMPOTENT,
} from "../../src/mcp-server/annotations.js";

describe("accessClassFor", () => {
  it("routes destructive annotations to the destructive class", () => {
    expect(accessClassFor(DESTRUCTIVE)).toBe("destructive");
    expect(accessClassFor(DESTRUCTIVE_IDEMPOTENT)).toBe("destructive");
  });

  it("routes read-only annotations to the read class", () => {
    expect(accessClassFor(READ_ONLY)).toBe("read");
    expect(accessClassFor(READ_ONLY_NON_IDEMPOTENT)).toBe("read");
  });

  it("routes writes to the write class", () => {
    expect(accessClassFor(WRITE_IDEMPOTENT)).toBe("write");
    expect(accessClassFor(WRITE_NON_IDEMPOTENT)).toBe("write");
  });

  it("prioritizes destructive over read when flags combine", () => {
    // No shipped constant sets both, so nothing else in the battery pins the
    // precedence. It has to be this way round: a contradictory annotation
    // arriving from a future edit must fail CLOSED, not be waved through the
    // read-only gate as a read.
    expect(accessClassFor({ destructiveHint: true, readOnlyHint: true })).toBe(
      "destructive",
    );
  });
});

describe("annotation constants ship the hints they promise", () => {
  // Four hints x six constants, spelled out. These values leave the process:
  // ListTools sends them to the client, which uses them to decide whether to
  // show a destructive-action confirmation and whether a failed call is safe to
  // retry. A wrong `idempotentHint` on a destructive tool tells a client it may
  // resubmit an order.
  const hints = (
    readOnlyHint: boolean,
    destructiveHint: boolean,
    idempotentHint: boolean,
  ): ToolAnnotations => ({
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    // Every tool this server exposes calls the brokerage, so the world is open
    // for all six. Pinned rather than assumed: `false` would tell a client the
    // tool is a closed-domain local operation.
    openWorldHint: true,
  });

  const HINTS: Array<[string, ToolAnnotations, ToolAnnotations]> = [
    //  name                       actual                    readOnly destructive idempotent
    ["READ_ONLY", READ_ONLY, hints(true, false, true)],
    [
      "READ_ONLY_NON_IDEMPOTENT",
      READ_ONLY_NON_IDEMPOTENT,
      hints(true, false, false),
    ],
    ["WRITE_IDEMPOTENT", WRITE_IDEMPOTENT, hints(false, false, true)],
    ["WRITE_NON_IDEMPOTENT", WRITE_NON_IDEMPOTENT, hints(false, false, false)],
    ["DESTRUCTIVE", DESTRUCTIVE, hints(false, true, false)],
    [
      "DESTRUCTIVE_IDEMPOTENT",
      DESTRUCTIVE_IDEMPOTENT,
      hints(false, true, true),
    ],
  ];

  it.each(HINTS)("%s declares exactly its four hints", (_n, actual, want) => {
    expect(actual).toEqual(want);
  });

  it("never marks a constant both read-only and destructive", () => {
    // The contradiction accessClassFor has to arbitrate must not exist in the
    // constants themselves.
    expect(
      HINTS.filter(
        ([, a]) => a.readOnlyHint === true && a.destructiveHint === true,
      ).map(([name]) => name),
    ).toEqual([]);
  });
});
