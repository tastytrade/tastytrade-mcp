# Market Metrics

The Market Metrics API provides volatility, liquidity, dividend, and earnings data for equity underlyings. This is a key resource for options-focused workflows — implied volatility rank (IVR) and implied volatility percentile are core inputs for deciding when to sell premium, and per-expiration IV data helps identify which expirations offer the richest opportunities.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 1.9.1

---

## Endpoints

### Get Market Metrics

Returns volatility and liquidity data for one or more symbols, including per-expiration implied volatility breakdowns.

**Request**

```
GET /market-metrics?symbols={symbols}
```

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbols` | string | Yes | Comma-separated list of underlying symbols (e.g., `AAPL,SPY,TSLA`). URL-encode special characters in symbols (e.g., `BRK%2FB` for `BRK/B`). |

**Response** — `200 OK`

Returns an array of `MarketMetricInfo` objects, one per requested symbol.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "symbol": "AAPL",
        "implied-volatility-index": 0.2845,
        "implied-volatility-index-5-day-change": -0.0132,
        "implied-volatility-rank": 0.35,
        "implied-volatility-percentile": 0.42,
        "liquidity": 0.95,
        "liquidity-rank": 0.98,
        "liquidity-rating": 5,
        "option-expiration-implied-volatilities": [
          {
            "expiration-date": "2026-04-17T00:00:00.000+00:00",
            "settlement-type": "PM",
            "option-chain-type": "Standard",
            "implied-volatility": 0.2715
          },
          {
            "expiration-date": "2026-05-15T00:00:00.000+00:00",
            "settlement-type": "PM",
            "option-chain-type": "Standard",
            "implied-volatility": 0.2890
          }
        ]
      }
    ]
  }
}
```

---

### Get Historical Dividends

Returns historical dividend data for a symbol.

**Request**

```
GET /market-metrics/historic-corporate-events/dividends/{symbol}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | path | Yes | The equity symbol (e.g., `AAPL`) |

**Response** — `200 OK`

Returns an array of `DividendInfo` objects.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "occurred-date": "2026-02-07",
        "amount": 0.25
      },
      {
        "occurred-date": "2025-11-08",
        "amount": 0.25
      }
    ]
  }
}
```

---

### Get Historical Earnings Reports

Returns historical earnings data for a symbol within a date range.

**Request**

```
GET /market-metrics/historic-corporate-events/earnings-reports/{symbol}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | path | Yes | The equity symbol (e.g., `AAPL`) |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start-date` | string (date) | Yes | Start of the date range (format: `YYYY-MM-DD`). Returns earnings from this date forward. |
| `end-date` | string (date) | No | End of the date range (format: `YYYY-MM-DD`). If omitted, returns earnings from `start-date` through the present. |

**Response** — `200 OK`

Returns an array of `EarningsInfo` objects.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "occurred-date": "2026-01-30",
        "eps": 2.41
      },
      {
        "occurred-date": "2025-10-30",
        "eps": 1.64
      }
    ]
  }
}
```

---

## Data Models

### MarketMetricInfo

Volatility and liquidity data for an underlying symbol, including per-expiration implied volatility breakdowns.

#### Underlying Volatility

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The underlying symbol |
| `implied-volatility-index` | number (float) | The current implied volatility index for the underlying, expressed as a decimal (e.g., `0.2845` = 28.45% IV) |
| `implied-volatility-index-5-day-change` | number (float) | The change in IV index over the past 5 trading days (e.g., `-0.0132` = IV decreased by 1.32 points) |
| `implied-volatility-rank` | number (float) | IV Rank (IVR): where the current IV falls relative to the 52-week high and low IV, expressed as a decimal 0–1. An IVR of `0.35` means current IV is 35% of the way between the 52-week low and high. Higher IVR suggests options are relatively expensive. |
| `implied-volatility-percentile` | number (float) | IV Percentile: the percentage of days in the past year where IV was lower than the current level, expressed as a decimal 0–1. An IV percentile of `0.42` means IV was below the current level 42% of trading days. |

#### Liquidity

| Field | Type | Description |
|-------|------|-------------|
| `liquidity` | number (float) | A liquidity score for the underlying's options, expressed as a decimal 0–1 (higher = more liquid) |
| `liquidity-rank` | number (float) | The liquidity rank relative to other underlyings, expressed as a decimal 0–1 |
| `liquidity-rating` | integer | A liquidity rating on an integer scale (e.g., 1–5, where 5 is the most liquid) |

#### Per-Expiration Implied Volatility

| Field | Type | Description |
|-------|------|-------------|
| `option-expiration-implied-volatilities` | array | Array of objects, one per option expiration, containing expiration-specific IV data |

Each object in the array contains:

| Field | Type | Description |
|-------|------|-------------|
| `expiration-date` | datetime | The option expiration date |
| `settlement-type` | string | The settlement type: `AM` (morning settlement, e.g., SPX monthly) or `PM` (afternoon settlement, standard for most options) |
| `option-chain-type` | string | The chain type: `Standard` or `Non-standard` (adjusted options) |
| `implied-volatility` | number (double) | The implied volatility for this specific expiration, expressed as a decimal |

---

### DividendInfo

A single historical dividend record.

| Field | Type | Description |
|-------|------|-------------|
| `occurred-date` | date | The date the dividend occurred (ex-dividend date) |
| `amount` | number (float) | The per-share dividend amount in dollars |

---

### EarningsInfo

A single historical earnings report record.

| Field | Type | Description |
|-------|------|-------------|
| `occurred-date` | date | The date of the earnings announcement |
| `eps` | number (float) | Earnings per share (actual reported EPS) |

---

## Common Use Cases

- **Premium selling signals:** Fetch market metrics for a watchlist of underlyings and filter for those with high IVR (e.g., above 0.50) and good liquidity (rating 4+). High IVR suggests options are relatively expensive, making it a favorable time to sell premium.
- **Expiration selection:** Use `option-expiration-implied-volatilities` to compare IV across expirations. The expiration with the highest IV relative to its historical norm may offer the best premium for short strategies.
- **Earnings plays:** Combine `GET /market-metrics/historic-corporate-events/earnings-reports/{symbol}` with the IV data to analyze how IV typically behaves around earnings. Use historical EPS data to gauge the magnitude of typical earnings surprises.
- **Dividend risk for options:** Use the dividends endpoint to identify upcoming ex-dividend dates. Short call positions on dividend-paying stocks are at risk of early assignment around ex-dividend dates, especially for deep in-the-money calls.
- **Batch symbol lookup:** The market metrics endpoint accepts comma-separated symbols, so you can fetch volatility data for an entire portfolio or watchlist in a single request.

---

## Important Notes

- **IVR vs. IV Percentile:** These are different measures. IVR compares current IV to the 52-week range (high minus low). IV Percentile measures the percentage of days IV was lower. Both are useful but can diverge — a single IV spike can push the range wide, making IVR low even when IV percentile is high.
- **Volatility values are decimals:** An `implied-volatility-index` of `0.2845` means 28.45% annualized implied volatility. Multiply by 100 for percentage display.
- **URL encoding:** Symbols containing special characters (like `BRK/B`) must be URL-encoded in the query string (e.g., `BRK%2FB`).
