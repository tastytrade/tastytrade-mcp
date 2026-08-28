/**
 * tastytrade MCP Server
 * Entry point for the Model Context Protocol server
 *
 * This module is BOTH the package's library barrel (`main` in package.json)
 * and its runnable entrypoint (`node dist/index.js`), so the bottom half must
 * only run in the second case — see {@link isEntryModule}.
 */

// Re-export all public APIs
export {
  Action,
  InstrumentType,
  OrderType,
  TimeInForce,
  PriceEffect,
  Direction,
  OrderStatus,
} from "./enums.js";
export type {
  TastytradeConfig,
  OAuthTokens,
  Position,
  Order,
  OrderLeg,
} from "./types.js";
export { TastytradeOAuthClient } from "./oauth-client.js";
export { TastytradeClient } from "./api-client.js";
export { TastytradeMCPServer } from "./mcp-server/index.js";

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TastytradeMCPServer } from "./mcp-server/index.js";

/**
 * Was this module executed (`node dist/index.js`), or merely imported?
 *
 * Load-bearing, not tidiness: `main` points here and the exports above are a
 * public API, so importing this file is invited. Constructing a server at module
 * scope would write JSON-RPC frames onto a consumer's stdout, hold their event
 * loop open, and turn their stdin into a remote control for
 * `tastytrade_place_order` against a funded account.
 *
 * Compared through `pathToFileURL`, not as strings: argv[1] may be relative and
 * on Windows uses backslashes. The realpath comparison is the half that matters —
 * Node resolves an ESM specifier to the REAL path, so launched through a symlink
 * the two spellings differ and a real entrypoint would look like an import,
 * silently starting nothing. Both spellings are tried because failing that way is
 * quiet.
 */
export function isEntryModule(
  moduleUrl: string,
  argv1: string | undefined,
): boolean {
  if (!argv1) return false;
  try {
    if (moduleUrl === pathToFileURL(argv1).href) return true;
  } catch {
    // argv[1] was not a usable path. A barrel import must never be able to make
    // this throw, so fall through to the realpath attempt and then to false.
  }
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // No such path, or not resolvable. Then it is not this module.
    return false;
  }
}

if (isEntryModule(import.meta.url, process.argv[1])) {
  // `void`, with the failure path handling its own exit: a startup failure used
  // to be swallowed by `.catch(console.error)`, which left the process exiting
  // 0 — the code most supervisors and CI runners read as a clean shutdown, so a
  // server that never started looked like one that had finished its work.
  void (async () => {
    try {
      const server = new TastytradeMCPServer();
      await server.run();
    } catch (err) {
      // stderr, never stdout: stdout is the MCP protocol channel.
      console.error(
        `[tastytrade-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  })();
}
