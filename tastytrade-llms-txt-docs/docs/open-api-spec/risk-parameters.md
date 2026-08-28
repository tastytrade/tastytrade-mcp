# Risk Parameters

The Risk Parameters API provides endpoints for retrieving account position limits, per-symbol margin requirements, the global margin configuration (including the risk-free rate), and raw SPAN margin data for futures exchanges.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 3.60.0

---

## Endpoints

### Get Position Limit

Retrieve the position and order size limits for an account.

```
GET /accounts/{account_number}/position-limit
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |

**Response** — `200 OK`: Returns a `PositionLimit` object.

---

### Get Effective Margin Requirements

Retrieve the effective margin requirements for a specific underlying symbol on an account. Returns the initial and maintenance margin rates for both long and short equity positions, plus naked option margin parameters.

```
GET /accounts/{account_number}/margin-requirements/{underlying_symbol}/effective
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `underlying_symbol` | path | string | Yes | The underlying symbol (e.g., `AAPL`, `SPY`) |

**Response** — `200 OK`: Returns a `MarginRequirement` object.

---

### Get Public Margin Configuration

Retrieve the publicly accessible, read-only global margin configuration. Currently returns the risk-free rate used in margin calculations.

```
GET /margin-requirements-public-configuration
```

**Parameters:** None. No authentication required.

**Response** — `200 OK`: Returns a `MarginRequirementsGlobalConfiguration` object.

---

### Get SPAN Rows

Retrieve raw SPAN (Standard Portfolio Analysis of Risk) margin data rows for a specific date and futures exchange. SPAN data is used by clearing firms to calculate futures and futures options margin requirements.

```
GET /span/rows
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `date` | query | string (date) | Yes | The date of the SPAN file (`YYYY-MM-DD`) |
| `exchange` | query | string | Yes | The exchange: `CME` or `CFE` |
| `page-offset` | query | integer | No | Pagination offset (default: `0`) |
| `per-page` | query | integer | No | Results per page (default: `1000`, min: `1`, max: `50000`) |

**Response** — `200 OK`: Returns an array of `Row` objects containing the raw SPAN data.

---

## Data Models

### PositionLimit

Defines the maximum order sizes and position sizes for an account across instrument types.

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Internal identifier |
| `account-number` | string | The tastytrade account number |
| `equity-order-size` | integer | Maximum number of shares per equity order |
| `equity-position-size` | integer | Maximum total equity position size (shares) |
| `equity-option-order-size` | integer | Maximum number of contracts per equity option order |
| `equity-option-position-size` | integer | Maximum total equity option position size (contracts) |
| `future-order-size` | integer | Maximum number of contracts per futures order |
| `future-position-size` | integer | Maximum total futures position size (contracts) |
| `future-option-order-size` | integer | Maximum number of contracts per futures option order |
| `future-option-position-size` | integer | Maximum total futures option position size (contracts) |
| `underlying-opening-order-limit` | integer | Maximum number of opening orders per underlying |

### MarginRequirement

Effective margin rates for a specific underlying symbol on an account.

| Field | Type | Description |
|-------|------|-------------|
| `underlying-symbol` | string | The underlying symbol |
| `clearing-identifier` | string | The clearing firm identifier for this symbol |
| `long-equity-initial` | number (double) | Initial margin requirement for long equity positions (as a decimal, e.g., `0.50` = 50%) |
| `long-equity-maintenance` | number (double) | Maintenance margin requirement for long equity positions |
| `short-equity-initial` | number (double) | Initial margin requirement for short equity positions |
| `short-equity-maintenance` | number (double) | Maintenance margin requirement for short equity positions |
| `naked-option-standard` | number (double) | Standard margin rate for naked (uncovered) options |
| `naked-option-minimum` | number (double) | Minimum margin for naked options |
| `naked-option-floor` | number (double) | Floor (absolute minimum) margin for naked options |
| `is-deleted` | boolean | Whether this requirement has been deleted/overridden |

### MarginRequirementsGlobalConfiguration

Global margin configuration parameters.

| Field | Type | Description |
|-------|------|-------------|
| `risk-free-rate` | number (double) | The current risk-free interest rate used in margin calculations (as a decimal, e.g., `0.0525` = 5.25%) |

### Row (SPAN Data)

A single row of raw SPAN margin data.

| Field | Type | Description |
|-------|------|-------------|
| `file-date` | date | The date of the SPAN file |
| `row-index` | integer | The index of this row within the SPAN file |
| `exchange` | string | The exchange (`CME` or `CFE`) |
| `row-data` | string | The raw SPAN data row content |

---

## Common Use Cases

- **Pre-trade position limit checks:** Before submitting an order, check `GET /accounts/{account_number}/position-limit` to verify the order size doesn't exceed the account's limits.
- **Custom margin calculations:** Use `GET /accounts/{account_number}/margin-requirements/{underlying_symbol}/effective` to get the exact margin rates for a symbol, then calculate expected margin impact locally.
- **Risk-free rate for pricing models:** The `GET /margin-requirements-public-configuration` endpoint provides the risk-free rate used in margin calculations, which is also useful as an input for options pricing models (Black-Scholes).
- **Futures margin analysis:** Use the SPAN rows endpoint to access raw SPAN data for advanced futures margin analysis and risk management.

---

## Important Notes

- **Margin rates as decimals:** Margin requirement values are expressed as decimals (e.g., `0.50` = 50% margin requirement), not percentages.
- **Public configuration endpoint:** The `GET /margin-requirements-public-configuration` endpoint does not require authentication and is publicly accessible.
- **SPAN data pagination:** SPAN files can be very large. Use the pagination parameters and note the maximum of 50,000 rows per page.
- **Symbol-specific rates:** Margin requirements can vary by symbol. Some high-volatility or low-liquidity stocks may have higher margin requirements than standard rates.
