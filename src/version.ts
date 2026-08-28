/**
 * The package version, read once from package.json.
 *
 * It is reported in two places a client can observe — the MCP `serverInfo`
 * handshake and the default `User-Agent` the tastytrade API requires — and both
 * a literal in either drifts from package.json with nothing to catch it.
 *
 * Reading the manifest makes package.json the single source of truth, so a
 * release bump cannot leave a stale version behind.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Reported when package.json cannot be read. */
const UNKNOWN_VERSION = "0.0.0-unknown";

function readVersion(): string {
  // Resolves from both src/ (dev) and dist/ (runtime) — the layouts are
  // parallel, so package.json sits one level up from either.
  const manifest = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "package.json",
  );

  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;

    return typeof version === "string" && version.length > 0
      ? version
      : UNKNOWN_VERSION;
  } catch {
    // A missing or malformed manifest is not worth refusing to start over —
    // unlike the vendored docs, a version string is not load-bearing content.
    // Degrade to a clearly bogus value instead, so it reads as a bug if seen.
    return UNKNOWN_VERSION;
  }
}

export const PACKAGE_VERSION = readVersion();

/** The product token sent as `User-Agent` when the env var is unset. */
export const DEFAULT_USER_AGENT = `tastytrade-mcp-server/${PACKAGE_VERSION}`;
