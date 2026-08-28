# Balances and Positions

The Balances and Positions API provides endpoints for retrieving an account's current cash balances, buying power, margin requirements, and open positions. This is the most commonly used API for portfolio monitoring, pre-trade validation, and account dashboards.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 0.0.1 (versioned as `20240501` — use this or later version for current field availability)

---

## Endpoints

### Get Account Balances

Returns the current balance values for an account across all currencies.

**Request**

```
GET /accounts/{account_number}/balances
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Response** — `200 OK`

Returns an array of `AccountBalance` objects (one per currency, typically just `USD`).

---

### Get Account Balance by Currency

Returns the current balance values for an account in a specific currency.

**Request**

```
GET /accounts/{account_number}/balances/{currency}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |
| `currency` | string | Yes | The currency code (e.g., `USD`) |

**Response** — `200 OK`

Returns a single `AccountBalance` object.

---

### Get Balance Snapshots

Returns historical balance snapshots for an account, useful for tracking portfolio value over time. The most recent snapshot plus the current balance are returned by default.

**Request**

```
GET /accounts/{account_number}/balance-snapshots
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `snapshot-date` | string (date) | No | Filter to a specific snapshot date (format: `YYYY-MM-DD`) |
| `start-date` | string (date) | No | Start of date range for snapshots |
| `end-date` | string (date) | No | End of date range for snapshots |
| `time-of-day` | string | No | Filter by time of day for the snapshot (e.g., `BOD` for beginning of day, `EOD` for end of day) |
| `currency` | string | No | Filter by currency code |
| `page-offset` | integer | No | Pagination offset (0-indexed) |
| `per-page` | integer | No | Number of results per page |

**Response** — `200 OK`

Returns an array of `AccountBalanceSnapshot` objects.

---

### Get Account Positions

Returns the account's current open positions. Can be filtered by symbol, underlying symbol, or instrument type.

**Request**

```
GET /accounts/{account_number}/positions
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | No | Filter to a specific symbol (exact match) |
| `underlying-symbol` | array | No | Filter by one or more underlying symbols (e.g., `AAPL`, `SPY`) |
| `instrument-type` | string | No | Filter by instrument type: `Equity`, `Equity Option`, `Future`, `Future Option`, `Cryptocurrency` |
| `include-closed-positions` | boolean | No | If true, include positions that have been fully closed. Default: false |
| `include-marks` | boolean | No | If true, include current mark price data on each position. Default: false |
| `net-positions` | boolean | No | If true, return net positions (aggregated across sub-lots) |
| `underlying-product-code` | string | No | Filter by the underlying futures product code (e.g., `ES`, `NQ`) |
| `partition-keys` | array | No | Filter by partition keys (form data parameter) |

**Response** — `200 OK`

Returns an array of `CurrentPosition` objects.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "account-number": "5WX34382",
        "symbol": "AAPL",
        "instrument-type": "Equity",
        "underlying-symbol": "AAPL",
        "quantity": "10",
        "quantity-direction": "Long",
        "average-open-price": "178.50",
        "close-price": "185.25",
        "mark": "1852.50",
        "mark-price": "185.25",
        "multiplier": 1,
        "cost-effect": "Debit",
        "realized-day-gain": "0.0",
        "realized-day-gain-effect": "None",
        "realized-today": "0.0",
        "realized-today-effect": "None",
        "created-at": "2026-02-17T15:30:00.000+00:00",
        "updated-at": "2026-04-09T14:00:00.000+00:00"
      },
      {
        "account-number": "5WX34382",
        "symbol": "AAL   270115C00017000",
        "instrument-type": "Equity Option",
        "underlying-symbol": "AAL",
        "quantity": "1",
        "quantity-direction": "Long",
        "average-open-price": "3.50",
        "multiplier": 100,
        "cost-effect": "Debit",
        "expires-at": "2027-01-15T21:00:00.000+00:00",
        "created-at": "2025-11-01T12:00:00.000+00:00",
        "updated-at": "2026-04-09T14:00:00.000+00:00"
      }
    ]
  }
}
```

---

## Data Models

### CurrentPosition

Represents a single open (or closed) position in an account.

#### Position Identification

| Field | Type | Description |
|-------|------|-------------|
| `account-number` | string | The tastytrade account number |
| `symbol` | string | The full symbol for the position. For equities, this is the ticker (e.g., `AAPL`). For equity options, this is the OCC symbol (e.g., `AAL   270115C00017000`). For futures, this is the futures symbol (e.g., `/ESM6`). |
| `underlying-symbol` | string | The underlying symbol (e.g., `AAPL` for both the stock and its options) |
| `instrument-type` | string | The instrument type: `Equity`, `Equity Option`, `Future`, `Future Option`, `Cryptocurrency` |
| `streamer-symbol` | string | The symbol used for the DXLink streaming feed (may differ from the `symbol` field) |

#### Quantity & Direction

| Field | Type | Description |
|-------|------|-------------|
| `quantity` | object | The position quantity (returned as a string-encoded decimal for precision) |
| `quantity-direction` | string | `Long` or `Short` — indicates whether the position is a long or short holding |
| `restricted-quantity` | object | The quantity of the position that is restricted (e.g., from unsettled trades) |
| `multiplier` | number (double) | The contract multiplier. `1` for equities, `100` for standard equity options, varies for futures |

#### Pricing & Valuation

| Field | Type | Description |
|-------|------|-------------|
| `average-open-price` | number (double) | The average price at which the position was opened (cost basis per unit) |
| `close-price` | number (double) | The most recent closing price of the instrument |
| `mark` | number (double) | The current total mark value of the position (mark-price × quantity × multiplier) |
| `mark-price` | number (double) | The current mark price per unit of the instrument |
| `average-daily-market-close-price` | number (double) | The average daily market close price |
| `average-yearly-market-close-price` | number (double) | The average yearly market close price |
| `fixing-price` | number (double) | The fixing price (applicable to certain instruments like crypto) |
| `face-value` | number (double) | The face value (applicable to bonds and fixed-income instruments) |
| `par-size` | number (double) | The par size (applicable to bonds and fixed-income instruments) |

#### Realized Gains

| Field | Type | Description |
|-------|------|-------------|
| `realized-day-gain` | number (double) | Realized gain/loss for the current trading day |
| `realized-day-gain-date` | date | The date of the realized day gain calculation |
| `realized-day-gain-effect` | string | `Debit` or `Credit` — the direction of the realized day gain |
| `realized-today` | number (double) | Total realized gain/loss today (may include multiple closing transactions) |
| `realized-today-date` | date | The date of the realized-today calculation |
| `realized-today-effect` | string | `Debit` or `Credit` — the direction of today's realized gain/loss |

#### Position Metadata

| Field | Type | Description |
|-------|------|-------------|
| `cost-effect` | string | `Debit` or `Credit` — whether opening this position was a debit or credit to the account |
| `is-frozen` | boolean | Whether the position is frozen (cannot be traded) |
| `is-suppressed` | boolean | Whether the position is suppressed from display |
| `deliverable-type` | string | The deliverable type (relevant for options and futures approaching delivery) |
| `expires-at` | datetime | The expiration date and time for options and futures contracts |
| `created-at` | datetime | Timestamp when the position was first opened |
| `updated-at` | datetime | Timestamp of the last update to this position record |
| `order-id` | integer | The order ID of the most recent order that modified this position |
| `update-type` | string | The type of the most recent update to the position |

---

### AccountBalance

Represents the complete current balance state of an account. This is a comprehensive object with 71 fields covering cash, margin, buying power, and position values across all asset classes.

#### Core Balances

| Field | Type | Description |
|-------|------|-------------|
| `account-number` | string | The tastytrade account number |
| `currency` | string | The currency of the balance values (typically `USD`) |
| `cash-balance` | number (double) | The total cash balance in the account |
| `net-liquidating-value` | number (double) | The total account value: cash + long positions − short positions. This is the primary measure of account value. |
| `cash-available-to-withdraw` | number (double) | The amount of cash that can be withdrawn without liquidating positions |
| `pending-cash` | number (double) | Cash that is pending (e.g., from unsettled trades or pending transfers) |
| `pending-cash-effect` | string | `Debit` or `Credit` — direction of the pending cash |
| `updated-at` | datetime | Timestamp of the last balance update |

#### Buying Power

| Field | Type | Description |
|-------|------|-------------|
| `available-trading-funds` | number (double) | Total funds available for placing new trades |
| `equity-buying-power` | number (double) | Buying power available for equity (stock) purchases |
| `derivative-buying-power` | number (double) | Buying power available for options trades |
| `day-trading-buying-power` | number (double) | Intraday buying power for day trades (typically 4× margin equity for PDT accounts) |
| `used-derivative-buying-power` | number (double) | The amount of derivative buying power currently in use |
| `effective-cryptocurrency-buying-power` | number (double) | Buying power available specifically for cryptocurrency trades |
| `sma-equity-option-buying-power` | number (double) | Special Memorandum Account (SMA) based buying power for equity options |
| `buying-power-adjustment` | number (double) | Any adjustment applied to buying power |
| `buying-power-adjustment-effect` | string | `Debit` or `Credit` — direction of the buying power adjustment |

#### Settlement Balances

| Field | Type | Description |
|-------|------|-------------|
| `cash-settle-balance` | number (double) | The settled cash balance |
| `margin-settle-balance` | number (double) | The settled margin balance |
| `total-settle-balance` | number (double) | The total settled balance across all settlement types |
| `closed-loop-available-balance` | number (double) | Balance available under closed-loop withdrawal rules |

#### Margin Requirements

| Field | Type | Description |
|-------|------|-------------|
| `maintenance-requirement` | number (double) | The total maintenance margin requirement for all positions |
| `maintenance-excess` | number (double) | Excess margin above the maintenance requirement (positive = cushion, negative = margin call) |
| `reg-t-margin-requirement` | number (double) | The Regulation T initial margin requirement |
| `futures-margin-requirement` | number (double) | Margin requirement for futures positions |
| `futures-overnight-margin-requirement` | number (double) | Overnight margin requirement for futures positions (typically higher than intraday) |
| `futures-intraday-margin-requirement` | number (double) | Intraday margin requirement for futures positions (typically lower than overnight) |
| `bond-margin-requirement` | number (double) | Margin requirement for bond/fixed-income positions |
| `cryptocurrency-margin-requirement` | number (double) | Margin requirement for cryptocurrency positions |
| `equity-offering-margin-requirement` | number (double) | Margin requirement for equity offering positions |
| `fixed-income-security-margin-requirement` | number (double) | Margin requirement for fixed-income security positions |

#### Margin Calls & Day Trading

| Field | Type | Description |
|-------|------|-------------|
| `margin-equity` | number (double) | The account's margin equity (net liquidating value minus non-margineable assets) |
| `maintenance-call-value` | number (double) | The outstanding maintenance call amount (0 if no call) |
| `reg-t-call-value` | number (double) | The outstanding Reg-T margin call amount |
| `day-equity-call-value` | number (double) | The outstanding day trade equity call amount |
| `day-trading-call-value` | number (double) | The outstanding day trading call value |
| `day-trade-excess` | number (double) | Excess equity above the day trade minimum requirement |
| `special-memorandum-account-value` | number (double) | The SMA (Special Memorandum Account) value |
| `special-memorandum-account-apex-adjustment` | number (double) | Apex clearing adjustment to the SMA value |
| `apex-starting-day-margin-equity` | number (double) | The margin equity value at the start of the trading day as reported by Apex |
| `pending-margin-interest` | number (double) | Pending margin interest charges |

#### Long Position Values

| Field | Type | Description |
|-------|------|-------------|
| `long-equity-value` | number (double) | Total market value of long equity (stock) positions |
| `long-derivative-value` | number (double) | Total market value of long options positions |
| `long-futures-value` | number (double) | Total market value of long futures positions |
| `long-futures-derivative-value` | number (double) | Total market value of long futures options positions |
| `long-cryptocurrency-value` | number (double) | Total market value of long cryptocurrency positions |
| `long-bond-value` | number (double) | Total market value of long bond positions |
| `long-fixed-income-security-value` | number (double) | Total market value of long fixed-income security positions |
| `long-margineable-value` | number (double) | Total value of long positions that are margineable |
| `long-index-derivative-value` | number (double) | Total market value of long index options positions |

#### Short Position Values

| Field | Type | Description |
|-------|------|-------------|
| `short-equity-value` | number (double) | Total market value of short equity positions |
| `short-derivative-value` | number (double) | Total market value of short options positions |
| `short-futures-value` | number (double) | Total market value of short futures positions |
| `short-futures-derivative-value` | number (double) | Total market value of short futures options positions |
| `short-cryptocurrency-value` | number (double) | Total market value of short cryptocurrency positions |
| `short-margineable-value` | number (double) | Total value of short positions that are margineable |
| `short-index-derivative-value` | number (double) | Total market value of short index options positions |

#### Intraday Cash Adjustments

| Field | Type | Description |
|-------|------|-------------|
| `intraday-equities-cash-amount` | number (double) | Intraday cash adjustment for equities activity |
| `intraday-equities-cash-effect` | string | `Debit` or `Credit` — direction of the equities intraday cash adjustment |
| `intraday-equities-cash-effective-date` | date | Effective date of the equities intraday cash adjustment |
| `intraday-futures-cash-amount` | number (double) | Intraday cash adjustment for futures activity |
| `intraday-futures-cash-effect` | string | `Debit` or `Credit` — direction of the futures intraday cash adjustment |
| `intraday-futures-cash-effective-date` | date | Effective date of the futures intraday cash adjustment |

#### Cryptocurrency Settlement

| Field | Type | Description |
|-------|------|-------------|
| `unsettled-cryptocurrency-fiat-amount` | number (double) | Unsettled fiat amount from cryptocurrency transactions |
| `unsettled-cryptocurrency-fiat-effect` | string | `Debit` or `Credit` — direction of unsettled crypto fiat |
| `previous-day-cryptocurrency-fiat-amount` | number (double) | Previous day's cryptocurrency fiat settlement amount |
| `previous-day-cryptocurrency-fiat-effect` | string | `Debit` or `Credit` — direction of previous day's crypto fiat |
| `previous-date-cryptocurrency-fiat-effective-date` | date | Effective date of the previous day crypto fiat calculation |
| `total-pending-liquidity-pool-rebate` | number (double) | Total pending liquidity pool rebate amount |

#### Snapshot Fields (on AccountBalanceSnapshot only)

| Field | Type | Description |
|-------|------|-------------|
| `snapshot-date` | date | The date of the balance snapshot |
| `time-of-day` | string | The time of day for the snapshot (e.g., `BOD`, `EOD`) |

Note: The `AccountBalanceSnapshot` object contains the same balance fields as `AccountBalance` (minus a few real-time-only fields like `updated-at` and the futures intraday/overnight margin breakdowns), plus the `snapshot-date` and `time-of-day` fields.

---

## Common Use Cases

- **Portfolio dashboard:** Call `GET /accounts/{account_number}/balances` for the headline numbers (`net-liquidating-value`, `cash-balance`, `equity-buying-power`) and `GET /accounts/{account_number}/positions` for the holdings table.
- **Pre-trade buying power check:** Before submitting an order, check `derivative-buying-power` (for options), `equity-buying-power` (for stocks), or `day-trading-buying-power` (for intraday trades) to verify sufficient funds.
- **Margin monitoring:** Monitor `maintenance-excess` — when this goes negative, the account is in a margin call. Also check `maintenance-call-value`, `reg-t-call-value`, and `day-equity-call-value` for specific call types.
- **Position-level P&L:** Use `average-open-price` with the current `mark-price` to calculate unrealized P&L per position. Use `realized-day-gain` and `realized-today` for intraday realized gains.
- **Historical performance tracking:** Use `GET /accounts/{account_number}/balance-snapshots` with `start-date` and `end-date` to chart account value over time.
- **Filtering positions:** Use `instrument-type=Equity` to get only stock positions, or `underlying-symbol=AAPL` to get all positions (stock + options) for a single underlying.
- **Options expiration awareness:** Check `expires-at` on option and futures positions to identify positions approaching expiration.

---

## Important Notes

- **Quantity precision:** Position quantities are returned as string-encoded decimals for precision (important for fractional shares and cryptocurrency).
- **Effect fields:** Many balance fields have a corresponding `*-effect` field with values `Debit`, `Credit`, or `None` indicating the direction. A `Debit` effect means the value reduces the account balance; `Credit` increases it.
- **Mark vs. mark-price:** `mark-price` is the per-unit price; `mark` is the total position value (mark-price × quantity × multiplier).
- **Options multiplier:** For standard equity options, `multiplier` is `100`. Always use the returned multiplier rather than assuming a value.
- **OCC symbol format for options:** Equity option symbols follow OCC format: `SYMBOL  YYMMDDCSSSSSSSS` where the symbol is left-padded with spaces to 6 characters, followed by expiration date, `C`/`P` for call/put, and the strike price as an 8-digit integer (price × 1000).
