# Market Data

The Market Data API provides a REST endpoint for fetching point-in-time market data snapshots for multiple symbols across all asset classes. This is the non-streaming alternative to the DXLink WebSocket — use it when you need a one-time quote rather than continuous real-time data.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** v0

---

## Endpoints

### Get Market Data by Type

Fetch market data for multiple symbols, organized by instrument type. The combined limit across all types is **100 symbols per request**.

**Request**

```
GET /market-data/by-type
```

**Query Parameters**

All parameters accept arrays of symbols. Pass multiple values as repeated params: `equity[]=AAPL&equity[]=SPY`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `equity` | array of strings | No | Equity symbols (e.g., `AAPL`, `SPY`) |
| `equity-option` | array of strings | No | Equity option symbols in OCC format (e.g., `AAPL  260619C00200000`) |
| `future` | array of strings | No | Futures symbols (e.g., `/ESM6`) |
| `future-option` | array of strings | No | Futures option symbols in tastytrade format |
| `cryptocurrency` | array of strings | No | Cryptocurrency symbols (e.g., `BTC/USD`) |
| `index` | array of strings | No | Index symbols (e.g., `SPX`, `VIX`) |

**Important:** The parameter names use **singular hyphenated** form (`equity-option`, not `equity-options`). The combined total of symbols across all parameters must not exceed 100.

**Response** — `200 OK`

Returns an array of `MarketData` objects, one per requested symbol.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "symbol": "AAPL",
        "instrumentType": "Equity",
        "bid": 184.50,
        "bidSize": 200.0,
        "ask": 184.55,
        "askSize": 150.0,
        "mid": 184.525,
        "mark": 184.53,
        "last": 184.52,
        "volume": 45230000.0,
        "open": 183.20,
        "dayHighPrice": 185.10,
        "dayLowPrice": 182.90,
        "close": 183.80,
        "prevClose": 183.80,
        "yearHighPrice": 210.50,
        "yearLowPrice": 155.30,
        "beta": 1.25,
        "dividendAmount": 0.25,
        "dividendFrequency": 4.0,
        "tradingHalted": false,
        "updatedAt": "2026-04-09T14:30:00.000+00:00"
      }
    ]
  }
}
```

---

## Data Models

### MarketData

A comprehensive market data snapshot for a single instrument.

#### Identification

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The instrument symbol |
| `instrumentType` | string | The instrument type: `Equity`, `Equity Option`, `Future`, `Future Option`, `Cryptocurrency`, `Index`, `Bond`, and others |
| `updatedAt` | datetime | When this market data was last updated |
| `instrument` | Instrument | Nested instrument details (see below) |

#### Quote Data

| Field | Type | Description |
|-------|------|-------------|
| `bid` | number (double) | Current best bid price |
| `bidSize` | number (double) | Size at the best bid |
| `ask` | number (double) | Current best ask price |
| `askSize` | number (double) | Size at the best ask |
| `mid` | number (double) | Midpoint price: `(bid + ask) / 2` |
| `mark` | number (double) | Mark price (exchange-calculated or mid) |

#### Last Trade

| Field | Type | Description |
|-------|------|-------------|
| `last` | number (double) | Last trade price during regular hours |
| `lastExt` | number (double) | Last trade price during extended hours |
| `lastMkt` | number (double) | Last market trade price |
| `lastTradeTime` | integer (int64) | Timestamp of the last trade (epoch milliseconds) |
| `volume` | number (double) | Total trading volume for the session |

#### Day Session Prices

| Field | Type | Description |
|-------|------|-------------|
| `open` | number (double) | Session opening price |
| `dayHighPrice` | number (double) | Session high price |
| `dayLowPrice` | number (double) | Session low price |
| `close` | number (double) | Session closing price (or last if still open) |
| `closePriceType` | string | Type of close price: `REGULAR`, `INDICATIVE`, `PRELIMINARY`, `FINAL`, `UNKNOWN` |
| `prevClose` | number (double) | Previous session's close price |
| `prevClosePriceType` | string | Type of previous close: same enum as `closePriceType` |
| `summaryDate` | date | The date of this session's summary data |
| `prevCloseDate` | date | The date of the previous close |

#### Annual Range

| Field | Type | Description |
|-------|------|-------------|
| `yearHighPrice` | number (double) | 52-week high price |
| `yearLowPrice` | number (double) | 52-week low price |

#### Fundamental Data

| Field | Type | Description |
|-------|------|-------------|
| `beta` | number (double) | Beta coefficient relative to the market |
| `dividendAmount` | number (double) | Current dividend amount per share |
| `dividendFrequency` | number (double) | Number of dividend payments per year (e.g., `4.0` for quarterly) |

#### Trading Halts & Limits

| Field | Type | Description |
|-------|------|-------------|
| `tradingHalted` | boolean | Whether trading is currently halted for this instrument |
| `tradingHaltedReason` | string | The reason for the trading halt |
| `haltStartTime` | integer (int64) | When the halt started (epoch milliseconds) |
| `haltEndTime` | integer (int64) | When the halt is expected to end (epoch milliseconds) |
| `lowLimitPrice` | number (double) | The lower price limit (circuit breaker, applicable to futures) |
| `highLimitPrice` | number (double) | The upper price limit (circuit breaker, applicable to futures) |

#### Deprecated Fields

These fields are deprecated — use the replacements listed above.

| Deprecated Field | Replacement |
|-----------------|-------------|
| `dayOpen` | `open` |
| `dayHigh` | `dayHighPrice` |
| `dayLow` | `dayLowPrice` |
| `dayClose` | `close` |
| `prevDayClose` | `prevClose` |

### Instrument

Nested instrument metadata returned within each `MarketData` object.

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The instrument symbol |
| `instrumentType` | string | The instrument type |
| `rootSymbol` | string | The root symbol (for options) |
| `exchange` | string | The exchange: `EQUITY`, `CME`, `CFE`, `CBOED`, `SMALLS`, `BOND`, `CRYPTOCURRENCY`, `EQUITY_OFFERING`, `UNKNOWN` |
| `instrumentKey` | object | Contains `symbol` and `instrumentType` as a compound key |
| `underlyingInstrument` | Instrument | The underlying instrument (for derivatives) |

---

## Common Use Cases

- **Portfolio mark-to-market:** Fetch quotes for all position symbols in a single request to calculate current portfolio value. Use the `mark` field for valuation.
- **Pre-trade pricing:** Before submitting a limit order, check `bid`, `ask`, and `mid` to set an appropriate limit price.
- **Batch quotes:** Fetch up to 100 symbols in a single request by mixing instrument types (e.g., 50 equities + 30 equity options + 20 futures).
- **Trading halt detection:** Check `tradingHalted` before submitting orders to avoid rejections on halted securities.
- **Extended hours pricing:** Use `lastExt` for after-hours pricing when `last` reflects regular-session-only data.

---

## Important Notes

- **100 symbol limit:** The combined total across all instrument type parameters cannot exceed 100 symbols per request.
- **camelCase field names:** Unlike most tastytrade API responses that use kebab-case (`net-liquidating-value`), this endpoint returns fields in camelCase (`netLiquidatingValue`). This is because the Market Data service is a Java-based service with different serialization conventions.
- **Singular parameter names:** Use `equity` not `equities`, `equity-option` not `equity-options`, `future` not `futures`. This is a common source of errors.
- **Snapshot, not streaming:** This endpoint returns a point-in-time snapshot. For real-time continuous data, use the DXLink WebSocket streaming API via the quote token from `GET /api-quote-tokens`.
- **Epoch timestamps:** `lastTradeTime`, `haltStartTime`, and `haltEndTime` are epoch milliseconds (not ISO 8601 strings).
