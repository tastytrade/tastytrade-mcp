# Margin Requirements

The Margin Requirements API provides endpoints for retrieving current margin and capital requirements for an account, and for estimating the margin impact of a prospective order before submission. The dry-run endpoint is particularly useful for pre-trade validation — it lets you see how an order would affect buying power and margin requirements without actually placing it.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 11.24.0

---

## Endpoints

### Get Account Margin Requirements

Fetch the current margin and capital requirements report for an account. Returns the breakdown of margin requirements across all existing positions.

**Request**

```
GET /margin/accounts/{account_number}/requirements
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Response** — `200 OK`

Returns the account's margin/capital requirements report, including per-position and aggregate margin requirements, buying power effects, and maintenance requirements.

---

### Margin Dry Run (Estimate Order Impact)

Estimate the margin requirements and buying power effect of a prospective order without actually submitting it. This is the margin-specific equivalent of the order dry-run endpoint, focused on the capital impact rather than order validation.

**Request**

```
POST /margin/accounts/{account_number}/dry-run
```

**Content-Type:** `application/json`

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Request Body**

The request body is an order object with the same structure used for order submission. The order is evaluated for margin impact but is **not** placed.

#### Order-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `account-number` | string | Yes | The tastytrade account number (must match the path parameter) |
| `underlying-symbol` | string | Yes | The underlying symbol for the order (e.g., `AAPL`, `SPY`, `/ES`) |
| `order-type` | string | Yes | The order type: `Limit`, `Market`, `Stop`, `Stop Limit` |
| `time-in-force` | string | Yes | Time in force: `Day`, `GTC` (Good Til Canceled), `GTD` (Good Til Date) |
| `price` | string (numeric) | No | The limit price (required for `Limit` and `Stop Limit` orders) |
| `price-effect` | string | No | `Credit` or `Debit` — whether the order results in a credit or debit to the account |
| `stop-trigger` | string (numeric) | No | The stop trigger price (required for `Stop` and `Stop Limit` orders) |
| `gtc-date` | string (date) | No | Expiration date for `GTD` orders (format: `YYYY-MM-DD`) |
| `replaces-order-id` | string (numeric) | No | If this order replaces an existing order, the ID of the order being replaced |
| `legs` | array | Yes | Array of 1–4 order legs (see below) |

#### Leg Fields

Each leg represents one side of the order. Multi-leg orders (spreads, strangles, iron condors, etc.) contain 2–4 legs.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | The instrument symbol. For equities: ticker (e.g., `AAPL`). For equity options: OCC symbol (e.g., `AAPL  260417C00200000`). For futures: futures symbol (e.g., `/ESM6`). |
| `instrument-type` | string | Yes | The instrument type: `Equity`, `Equity Option`, `Future`, `Future Option`, `Cryptocurrency` |
| `action` | string | Yes | The order action: `Buy to Open`, `Buy to Close`, `Sell to Open`, `Sell to Close` |
| `quantity` | string (numeric) | No | The number of shares or contracts |
| `remaining-quantity` | string (numeric) | No | The remaining quantity (relevant for replace orders) |

**Example Request — Single Equity Buy**

```json
{
  "account-number": "5WX34382",
  "underlying-symbol": "AAPL",
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": "185.00",
  "price-effect": "Debit",
  "legs": [
    {
      "symbol": "AAPL",
      "instrument-type": "Equity",
      "action": "Buy to Open",
      "quantity": "100"
    }
  ]
}
```

**Example Request — Vertical Spread**

```json
{
  "account-number": "5WX34382",
  "underlying-symbol": "SPY",
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": "2.50",
  "price-effect": "Debit",
  "legs": [
    {
      "symbol": "SPY   260619C00550000",
      "instrument-type": "Equity Option",
      "action": "Buy to Open",
      "quantity": "1"
    },
    {
      "symbol": "SPY   260619C00555000",
      "instrument-type": "Equity Option",
      "action": "Sell to Open",
      "quantity": "1"
    }
  ]
}
```

**Response** — `200 OK`

Returns the margin/capital requirements report showing the impact of the proposed order, including the buying power effect, initial margin requirement, maintenance requirement, and how the order would change the account's overall margin profile.

---

## Common Use Cases

- **Pre-trade buying power check:** Before submitting an order, POST to the dry-run endpoint with the exact same order body. The response tells you the buying power effect and whether the account has sufficient margin. This avoids order rejections due to insufficient buying power.
- **Strategy comparison:** Run multiple dry-run requests with different strategies (e.g., a put credit spread vs. an iron condor) to compare their margin requirements and choose the most capital-efficient approach.
- **Position sizing:** Use the margin dry-run to determine the maximum number of contracts you can trade by incrementally testing different quantities.
- **Current margin monitoring:** Use the GET endpoint to retrieve the full margin requirements report for an account and monitor for positions approaching margin thresholds.

---

## Important Notes

- **Numeric strings:** Price, quantity, and stop-trigger values are passed as strings with numeric format (e.g., `"185.00"`, `"100"`), not as raw numbers. This preserves decimal precision.
- **Leg limits:** Orders support 1 to 4 legs. Single-leg orders are used for simple equity and option trades. Multi-leg orders (2–4 legs) are used for spreads, strangles, iron condors, and other complex strategies.
- **Price-effect convention:** `Debit` means the order costs money (buying). `Credit` means the order generates cash (selling, or net credit spreads). For multi-leg orders, the price-effect reflects the net effect of all legs combined.
- **This endpoint does not place an order.** It only evaluates the margin impact. Use the Order Management API to actually submit orders.
