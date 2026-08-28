# Account Status

The Account Status API provides information about an account's current trading permissions, restrictions, and configuration. Use this endpoint to determine what asset classes and strategies an account is authorized to trade, whether the account is in any restricted state (margin call, closing-only, frozen), and key margin and day-trading parameters.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 6.0.0

---

## Endpoints

### Get Account Trading Status

Retrieve the current trading status for a specific account.

**Request**

```
GET /accounts/{account_number}/trading-status
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number (e.g., `5WX34382`) |

**Response** — `200 OK`

Returns a `TradingStatus` object wrapped in the standard tastytrade response envelope under `data`.

---

## TradingStatus Object

The `TradingStatus` object contains all fields describing an account's trading permissions and current state.

### Account Identification

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Internal identifier for the trading status record |
| `account-number` | string | The tastytrade account number |
| `clearing-account-number` | string | The account number at the clearing firm |
| `clearing-aggregation-identifier` | string | Identifier used for aggregating accounts at the clearing level |
| `is-aggregated-at-clearing` | boolean | Whether this account is part of an aggregated clearing group |
| `ext-crm-id` | string | External CRM identifier for the account |
| `autotrade-account-type` | string | The autotrade account type designation, if applicable |

### Account State

| Field | Type | Description |
|-------|------|-------------|
| `is-closed` | boolean | Whether the account has been permanently closed |
| `is-frozen` | boolean | Whether the account is frozen (no trading activity permitted) |
| `is-closing-only` | boolean | Whether the account is restricted to closing transactions only (no new positions) |
| `is-risk-reducing-only` | boolean | Whether the account is restricted to risk-reducing trades only |
| `updated-at` | datetime | Timestamp of the last update to the trading status record |

### Options Permissions

| Field | Type | Description |
|-------|------|-------------|
| `options-level` | string | The approved options trading level for the account (determines which strategies are permitted) |
| `short-calls-enabled` | boolean | Whether the account is approved to sell naked (short) calls |
| `are-deep-itm-carry-options-enabled` | boolean | Whether deep in-the-money carry option positions are enabled |
| `are-far-otm-net-options-restricted` | boolean | Whether far out-of-the-money net option positions are restricted |
| `are-options-values-restricted-to-nlv` | boolean | Whether option position values are restricted relative to the account's net liquidating value |
| `are-single-tick-expiring-hedges-ignored` | boolean | Whether single-tick expiring hedges are ignored in margin calculations |

### Equities & Margin

| Field | Type | Description |
|-------|------|-------------|
| `equities-margin-calculation-type` | string | The margin calculation methodology used for equities (e.g., Reg-T, portfolio margin) |
| `has-intraday-equities-margin` | boolean | Whether the account has access to intraday (reduced) equities margin rates |
| `is-full-equity-margin-required` | boolean | Whether full equity margin is required (no reduced intraday margin) |
| `is-portfolio-margin-enabled` | boolean | Whether portfolio margin (risk-based) is enabled for the account |
| `is-in-margin-call` | boolean | Whether the account is currently in a margin call |
| `cmta-override` | integer | CMTA (Clearing Member Trade Assignment) override value |

### Day Trading

| Field | Type | Description |
|-------|------|-------------|
| `is-pattern-day-trader` | boolean | Whether the account is flagged as a Pattern Day Trader (PDT) under FINRA rules |
| `day-trade-count` | integer | The current count of day trades within the rolling 5-business-day window |
| `is-in-day-trade-equity-maintenance-call` | boolean | Whether the account is in a day trade equity maintenance call (PDT minimum equity violation) |
| `pdt-reset-on` | date | The date when the PDT flag was last reset, if applicable |
| `is-roll-the-day-forward-enabled` | boolean | Whether the roll-the-day-forward feature is enabled for day trade counting |

### Futures

| Field | Type | Description |
|-------|------|-------------|
| `is-futures-enabled` | boolean | Whether the account is approved for futures trading |
| `is-futures-closing-only` | boolean | Whether futures trading is restricted to closing transactions only |
| `is-futures-intra-day-enabled` | boolean | Whether intraday futures trading (with reduced margin) is enabled |
| `futures-margin-rate-multiplier` | number (double) | Multiplier applied to the base futures margin requirement for this account |
| `is-small-notional-futures-intra-day-enabled` | boolean | Whether intraday trading of small-notional futures products (e.g., /MES, /MNQ) is enabled |
| `small-notional-futures-margin-rate-multiplier` | number (double) | Multiplier applied to the base margin requirement for small-notional futures |

### Cryptocurrency

| Field | Type | Description |
|-------|------|-------------|
| `is-cryptocurrency-enabled` | boolean | Whether cryptocurrency trading is enabled for the account |
| `is-cryptocurrency-closing-only` | boolean | Whether crypto trading is restricted to closing transactions only |

### Equity Offerings

| Field | Type | Description |
|-------|------|-------------|
| `is-equity-offering-enabled` | boolean | Whether the account can participate in equity offerings (e.g., IPOs) |
| `is-equity-offering-closing-only` | boolean | Whether equity offering activity is restricted to closing only |

### Fees & Risk

| Field | Type | Description |
|-------|------|-------------|
| `fee-schedule-name` | string | The name of the fee schedule applied to this account |
| `enhanced-fraud-safeguards-enabled-at` | datetime | Timestamp when enhanced fraud safeguards were enabled for this account |

---

## Example Response

```json
{
  "data": {
    "account-number": "5WX34382",
    "options-level": "Advanced",
    "is-cryptocurrency-enabled": true,
    "is-futures-enabled": true,
    "is-pattern-day-trader": false,
    "day-trade-count": 0,
    "is-closing-only": false,
    "is-frozen": false,
    "is-in-margin-call": false,
    "equities-margin-calculation-type": "Reg-T",
    "is-portfolio-margin-enabled": false,
    "futures-margin-rate-multiplier": 1.0,
    "short-calls-enabled": true,
    "updated-at": "2026-03-15T14:22:00.000+00:00"
  }
}
```

Note: The response is wrapped in the standard tastytrade API envelope with a `data` key. Not all fields are returned in every response — only fields relevant to the account's current configuration will be present.

---

## Common Use Cases

- **Pre-trade validation:** Check `is-closing-only`, `is-frozen`, or `is-risk-reducing-only` before attempting to submit an order to avoid unnecessary rejections.
- **Asset class gating:** Verify `is-futures-enabled`, `is-cryptocurrency-enabled`, or `options-level` to determine which instruments are available for the account.
- **Margin monitoring:** Check `is-in-margin-call` and `is-in-day-trade-equity-maintenance-call` to detect accounts that need attention.
- **PDT awareness:** Use `is-pattern-day-trader` and `day-trade-count` to warn users approaching the PDT threshold on accounts under $25K.
