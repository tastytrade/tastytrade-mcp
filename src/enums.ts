export enum TimeInForce {
  Day = "Day",
  Ext = "Ext",
  Exto = "Ext Overnight",
  GTC = "GTC",
  GTCExt = "GTC Ext",
  GTCExto = "GTC Ext Overnight",
  GTD = "GTD",
  IOC = "IOC",
}

export enum OrderType {
  Limit = "Limit",
  Market = "Market",
  StopLimit = "Stop Limit",
  StopMarket = "Stop",
  NotionalMarket = "Notional Market",
}

export enum PriceEffect {
  Credit = "Credit",
  Debit = "Debit",
}

export enum Direction {
  Long = "Long",
  Short = "Short",
  Zero = "Zero",
}

export enum OrderStatus {
  CancelRequested = "Cancel Requested",
  Cancelled = "Cancelled",
  Contingent = "Contingent",
  Received = "Received",
  Expired = "Expired",
  Filled = "Filled",
  InFlight = "In Flight",
  Live = "Live",
  PartiallyRemoved = "Partially Removed",
  Rejected = "Rejected",
  Removed = "Removed",
  ReplaceRequested = "Replace Requested",
  Routed = "Routed",
}

export enum InstrumentType {
  Equity = "Equity",
  EquityOption = "Equity Option",
  Future = "Future",
  FutureOption = "Future Option",
  Crypto = "Cryptocurrency",
}

/**
 * The `/market-data/by-type` query-parameter name for each agent-facing
 * instrument type.
 *
 * A CLOSED MAP, and the closure is the security property: the endpoint takes the
 * symbol list under a parameter named after the instrument class, so a caller
 * value lands in a KEY position. Reading a map inverts the direction of trust —
 * the key space is this object's server-authored VALUE set, so no caller string
 * can appear as a parameter name. A normaliser cannot do that: one that cannot
 * fail cannot validate.
 *
 * ONE map for both surfaces that reach this dimension (`getQuote` and
 * `buildQuoteSnapshotBuckets`); two maps for one dimension is how they drift. It
 * deliberately carries `Index`, which `InstrumentType` does not, because both
 * tool schemas declare it — so this map, not the enum, is the authority here, and
 * a test pins its key set against the schemas in both directions.
 */
export const MARKET_DATA_TYPE_PARAMS: Readonly<Record<string, string>> =
  Object.freeze({
    Equity: "equity",
    "Equity Option": "equity-option",
    Index: "index",
    Future: "future",
    "Future Option": "future-option",
    Cryptocurrency: "cryptocurrency",
  });

export enum Action {
  BuyToOpen = "Buy to Open",
  SellToClose = "Sell to Close",
  SellToOpen = "Sell to Open",
  BuyToClose = "Buy to Close",
  Buy = "Buy",
  Sell = "Sell",
}
