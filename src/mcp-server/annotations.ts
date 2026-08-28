/**
 * MCP tool annotation constants.
 *
 * Per the MCP spec, annotations are *hints* to clients about tool behavior so
 * the client can render appropriate UI (read-only badge, destructive warning,
 * etc.). They are not enforcement primitives — clients should treat them as
 * advisory only.
 *
 * Every tool registered by this server picks exactly one of the constants
 * below. See the TOOL_ANNOTATIONS table in src/mcp-server/index.ts
 * for the policy.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Idempotent read with no side effects (e.g. fetching a static reference). */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Read with no side effects, but the same call may return different results
 * over time (e.g. listing live orders, current quotes).
 */
export const READ_ONLY_NON_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Write that produces the same end-state on repeated calls with the same args
 * (e.g. PUT /watchlists/{name} replacing the whole list).
 */
export const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Write where two calls = two distinct effects (e.g. submitting an order). */
export const WRITE_NON_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Destructive op (cancels, deletes, places live orders that move money). */
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Destructive but idempotent (e.g. cancelling an already-cancelled order). */
export const DESTRUCTIVE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * How much a tool is allowed to change: the three-way split the dispatcher
 * gates on.
 *
 * This is not a rate-limit concept: the limiter is keyed on the endpoint a call
 * reaches, not on its annotation (see src/safety/rate-limit.ts). It answers the
 * question
 * read-only mode asks: may this tool run when the server is forbidden to
 * change anything? The dispatcher uses it twice, and both uses are that
 * question — withholding the write and destructive tools from ListTools, and
 * refusing them by name for a client that calls one anyway.
 */
export type AccessClass = "read" | "write" | "destructive";

/** Classify a tool's annotation into its access class. */
export function accessClassFor(a: ToolAnnotations): AccessClass {
  if (a.destructiveHint) return "destructive";
  if (a.readOnlyHint) return "read";
  return "write";
}

/**
 * Former names, kept so callers outside this module can be renamed in a
 * separate pass. Nothing in src/ uses them; they are scheduled for removal
 * once the remaining test call sites move to `accessClassFor`.
 *
 * @deprecated Use {@link AccessClass}.
 */
export type RateBucket = AccessClass;

/** @deprecated Use {@link accessClassFor}. */
export const bucketFor = accessClassFor;
