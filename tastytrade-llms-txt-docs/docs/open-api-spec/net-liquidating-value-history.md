# Net Liquidating Value History

The Net Liquidating Value History API returns historical net-liq snapshots for an account in OHLC (Open/High/Low/Close) candlestick format. Use this to chart account value over time or to calculate portfolio performance metrics.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** v0

---

## Endpoints

### Get Net Liq History

Retrieve historical net liquidating value data for an account. Data is returned in OHLC candlestick format, with each candle representing a time interval.

**Request**

```
GET /accounts/{accountNumber}/net-liq/history
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accountNumber` | string | Yes | The tastytrade account number |

**Query Parameters**

Use either `time-back` for a relative lookback or `start-time`/`end-time` for an absolute window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `time-back` | string | No | Relative time lookback. Values: `1d` (1 day), `1w` (1 week), `1m` (1 month), `3m` (3 months), `6m` (6 months), `1y` (1 year), `all` (all available history) |
| `start-time` | string | No | Absolute start time in ISO 8601 zoned datetime format (e.g., `2026-01-01T00:00:00+00:00[UTC]`) |
| `end-time` | string | No | Absolute end time in same format |
| `interval` | string | No | The time interval for each OHLC candle |

**Response** — `200 OK`

Returns an array of `NetLiqOhlc` objects.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "open": 10250.50,
        "high": 10420.75,
        "low": 10180.30,
        "close": 10350.00,
        "totalOpen": 10250.50,
        "totalHigh": 10420.75,
        "totalLow": 10180.30,
        "totalClose": 10350.00,
        "pendingCashOpen": 0.0,
        "pendingCashHigh": 0.0,
        "pendingCashLow": 0.0,
        "pendingCashClose": 0.0,
        "time": "2026-04-09T00:00:00+00:00"
      }
    ]
  }
}
```

---

## Data Models

### NetLiqOhlc

Each object represents one OHLC candle of net liquidating value data for a time interval.

#### Net Liq OHLC

| Field | Type | Description |
|-------|------|-------------|
| `open` | number (double) | Net liquidating value at the open of the interval |
| `high` | number (double) | Highest net liquidating value during the interval |
| `low` | number (double) | Lowest net liquidating value during the interval |
| `close` | number (double) | Net liquidating value at the close of the interval |
| `time` | string | The timestamp for this candle |

#### Total OHLC (Including Pending)

| Field | Type | Description |
|-------|------|-------------|
| `totalOpen` | number (double) | Total account value at open (net liq + pending cash) |
| `totalHigh` | number (double) | Highest total value during the interval |
| `totalLow` | number (double) | Lowest total value during the interval |
| `totalClose` | number (double) | Total account value at close |

#### Pending Cash OHLC

| Field | Type | Description |
|-------|------|-------------|
| `pendingCashOpen` | number (double) | Pending cash value at open |
| `pendingCashHigh` | number (double) | Highest pending cash during the interval |
| `pendingCashLow` | number (double) | Lowest pending cash during the interval |
| `pendingCashClose` | number (double) | Pending cash value at close |

---

## Common Use Cases

- **Portfolio performance chart:** Use `time-back=1y` to fetch a year of daily net-liq data and chart account value over time. Use the `close` value for each candle.
- **Daily P&L calculation:** Compare consecutive `close` values to calculate daily profit/loss.
- **Drawdown analysis:** Use the `high` and `low` fields to calculate maximum drawdown within each interval, or across the full dataset.
- **Custom date range:** Use `start-time` and `end-time` for a specific analysis window (e.g., performance during a specific market event).

---

## Important Notes

- **camelCase field names:** This endpoint uses camelCase field names (e.g., `totalClose`, `pendingCashOpen`) rather than the kebab-case convention used by most other tastytrade API endpoints.
- **Zoned datetime format:** The `start-time` and `end-time` parameters expect ISO 8601 zoned datetime format with timezone (e.g., `2026-01-01T00:00:00+00:00[UTC]`), not plain dates.
- **OHLC format:** Data is in candlestick format. For a simple line chart of account value, use the `close` field from each candle.
- **Total vs. Net Liq:** The `total*` fields include pending cash (unsettled funds), while the base `open`/`high`/`low`/`close` fields represent net liquidating value only.
