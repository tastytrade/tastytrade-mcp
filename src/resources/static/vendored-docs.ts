/**
 * Reads the vendored tastytrade documentation the static MCP resources are built
 * from.
 *
 * `tastytrade-llms-txt-docs/docs/` is a RUNTIME dependency, not trimmable
 * reference material: the resource modules read it at MODULE LOAD, so a missing
 * directory throws during import and the server exits before serving anything.
 * Every packaging path must include it. `readVendoredDoc` translates the bare
 * ENOENT into a message naming the file, the resolved directory and the fix.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = fileURLToPath(import.meta.url);

/**
 * The vendored docs directory. Resolves identically from `src/` during
 * development and from `dist/` at runtime because the two layouts are
 * parallel — both sit one level below the package root.
 */
export const DOCS_ROOT = path.resolve(
  path.dirname(here),
  "../../..",
  "tastytrade-llms-txt-docs",
  "docs",
);

/**
 * Every vendored doc the server requires in order to start. Kept here so a
 * packaging check can assert against one list rather than grepping the
 * resource modules.
 */
export const REQUIRED_DOCS = [
  "api-overview.md",
  "order-flow.md",
  "streaming-account-data.md",
  "streaming-market-data.md",
] as const;

/**
 * Reads one vendored doc, or throws an error that says what to do about it.
 */
export function readVendoredDoc(file: string): string {
  try {
    return readFileSync(path.join(DOCS_ROOT, file), "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException)?.code ?? "unknown error";
    throw new Error(
      `Cannot start: the vendored documentation file "${file}" is missing or unreadable (${reason}).\n` +
        `Looked in: ${DOCS_ROOT}\n\n` +
        `The tastytrade MCP server builds its static resources from ` +
        `tastytrade-llms-txt-docs/docs/, which must ship alongside the built ` +
        `server. It is a runtime dependency, not optional reference material.\n` +
        `Required files: ${REQUIRED_DOCS.join(", ")}\n\n` +
        `If you are running from a clone, the directory is in the repository ` +
        `root — check it was not excluded. If you built a container or a ` +
        `tarball, confirm the directory was copied in.`,
      // Keep the original ENOENT reachable for anyone debugging the cause.
      { cause: err },
    );
  }
}
