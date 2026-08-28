/**
 * Static `tastytrade://streaming-reference` resource.
 *
 * Bundles the two streaming protocol docs (DXLink quote streamer + Account
 * Streamer) so agents have an authoritative reference without needing a
 * web fetch.
 *
 * The content is read at module load from the vendored
 * `tastytrade-llms-txt-docs/` directory shipped with the package — same
 * path resolves from both `src/` (during dev) and `dist/` (at runtime)
 * because the directory layout is parallel.
 */

import { readVendoredDoc as read } from "./vendored-docs.js";

const HEADER =
  "# tastytrade Streaming Reference\n\n" +
  "This document bundles the two real-time data protocols agents need to know about: the DXLink quote streamer for market data, and the Account Streamer for orders / fills / balances. The MCP server itself does NOT poll or maintain WebSocket connections — those happen client-side via direct connection to the official streamers, using credentials from `tastytrade_get_api_quote_token`.\n\n" +
  "### Rate limits & fair use\n\n" +
  "Because the streamer connections live **client-side**, the MCP server's own rate limiter (read/write/destructive token buckets) governs only the REST calls it makes — it **cannot** see or throttle DXLink channel/subscription traffic. Respecting the streamer's limits is the client's responsibility:\n\n" +
  "- **DXLink (market data):** per-connection limits are defined by the DXLink protocol itself, not by tastytrade. Consult dxFeed's DXLink protocol documentation (linked from the DXLink section below) for current numbers rather than relying on values hard-coded here. The `/api-quote-tokens` response gives you the `dxlink-url` websocket endpoint and a token that is **valid for 24 hours**. Open separate channels per data class (e.g. one for equities, another for futures) instead of one oversized subscription.\n" +
  "- **Account Streamer:** do **not** poll `GET /orders/live` for real-time order updates — repeated polling degrades platform performance and may result in throttling or suspension of your API access. Subscribe to the Account Streamer instead.\n" +
  "- **Snapshot fallback:** the synchronous `/market-data/by-type` snapshot (via `tastytrade_get_quote_snapshot`) is capped at 100 symbols per request and is rate-limited by the MCP's `read` bucket. Use it for one-off reads; switch to the DXLink streamer for anything continuous.\n\n" +
  "#### Candle subscriptions: use a coarser interval the further back you reach\n\n" +
  "Requesting too many candles will blast the client with events. 12 months grouped into 1-minute intervals is roughly half a million events. tastytrade's recommended pairings:\n\n" +
  "| Time back | Recommended type | Example | Approx. events |\n" +
  "| --- | --- | --- | --- |\n" +
  "| 1 day | 1 minute | `AAPL{=1m}` | ~1,440 |\n" +
  "| 1 week | 5 minutes | `AAPL{=5m}` | ~2,016 |\n" +
  "| 1 month | 30 minutes | `AAPL{=30m}` | ~1,440 |\n" +
  "| 3 months | 1 hour | `AAPL{=1h}` | ~2,160 |\n" +
  "| 6 months | 2 hours | `AAPL{=2h}` | ~2,160 |\n" +
  "| 1 year+ | 1 day | `AAPL{=1d}` | ~365 |\n\n" +
  "Sections:\n" +
  "  1. DXLink Streaming Market Data\n" +
  "  2. Account Streamer\n\n" +
  "---\n\n";

const STREAMING_MARKET_DATA_MD = read("streaming-market-data.md");
const STREAMING_ACCOUNT_DATA_MD = read("streaming-account-data.md");

export const STREAMING_REFERENCE_MD =
  HEADER +
  "## 1. DXLink Streaming Market Data\n\n" +
  STREAMING_MARKET_DATA_MD +
  "\n\n---\n\n## 2. Account Streamer\n\n" +
  STREAMING_ACCOUNT_DATA_MD;
