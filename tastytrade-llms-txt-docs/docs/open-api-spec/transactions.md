# Transactions

The Transactions API provides endpoints for retrieving an account's transaction history, including trades, dividends, interest, fees, transfers, and other account activity. Transactions provide the definitive record of what happened in an account, including fill prices, commissions, and regulatory fees.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 9.1.2

---

## Endpoints

### Search Transactions

Returns a paginated list of transactions for an account with extensive filtering options.

**Request**

```
GET /accounts/{account_number}/transactions
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start-date` | string (date) | No | Start of date range (`YYYY-MM-DD`) |
| `end-date` | string (date) | No | End of date range (defaults to now) |
| `start-at` | string (datetime) | No | Start of datetime range (ISO 8601, more precise than `start-date`) |
| `end-at` | string (datetime) | No | End of datetime range |
| `symbol` | string | No | Filter by symbol. Accepts equity tickers (`AAPL`), OCC option symbols (`AAPL  191004P00275000`), futures symbols (`/ESZ9`), or futures option symbols (`./ESZ9 EW4U9 190927P2975`) |
| `underlying-symbol` | string | No | Filter by underlying symbol (e.g., `AAPL` returns both stock and option transactions). For futures, use the root symbol without date (`/M6E`) or the full symbol (`/ESU9`). |
| `futures-symbol` | string | No | Filter by futures symbol (e.g., `/ESZ9` or `/NGZ19`). Returns both futures and futures options transactions. |
| `instrument-type` | string | No | Filter by instrument type: `Bond`, `Cryptocurrency`, `Currency Pair`, `Equity`, `Equity Offering`, `Equity Option`, `Event Contract`, `Fixed Income Security`, `Future`, `Future Option`, `Index`, `Liquidity Pool`, `Unknown`, `Warrant` |
| `type` | string | No | Filter by single transaction type |
| `types` | array | No | Filter by multiple transaction types: `types[]=Trade&types[]=Receive Deliver` |
| `sub-type` | array | No | Filter by transaction sub-types: `sub-type[]=Sell to Open&sub-type[]=Buy to Close` |
| `action` | string | No | Filter by action: `Allocate`, `Buy`, `Buy to Close`, `Buy to Open`, `Sell`, `Sell to Close`, `Sell to Open` |
| `sort` | string | No | Sort direction: `Desc` (default, newest first) or `Asc` (oldest first) |
| `currency` | string | No | Filter by currency |
| `partition-key` | string | No | Account partition key |
| `page-offset` | integer | No | Pagination offset (default: `0`) |
| `per-page` | integer | No | Results per page (default: `250`, min: `1`, max: `2000`) |

**Response** — `200 OK`: Returns an array of `Transaction` objects.

---

### Get Transaction by ID

Retrieve a single transaction by its ID.

```
GET /accounts/{account_number}/transactions/{id}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `id` | path | integer | Yes | The transaction ID |

**Response** — `200 OK`: Returns a single `Transaction` object.

---

### Get Total Fees

Return the total fees charged for an account on a given day.

```
GET /accounts/{account_number}/transactions/total-fees
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `date` | query | string (date) | No | The date to get fees for (defaults to today) |

**Response** — `200 OK`: Returns the total fee amount for the specified day.

---

## Data Models

### Transaction

A single transaction record representing any account activity — trades, dividends, fees, transfers, etc.

#### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Unique transaction identifier |
| `account-number` | string | The account number |
| `transaction-type` | string | The type of transaction (e.g., `Trade`, `Receive Deliver`, `Dividend`, `Money Movement`, `Transfer`) |
| `transaction-sub-type` | string | The sub-type providing more detail (e.g., `Sell to Open`, `Buy to Close`, `Assignment`, `Expiration`, `Dividend`) |
| `transaction-date` | date | The date the transaction occurred |
| `executed-at` | datetime | The exact execution timestamp |
| `created-at` | datetime | When the transaction record was created |
| `description` | string | Human-readable description of the transaction |

#### Instrument

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The instrument symbol |
| `underlying-symbol` | string | The underlying symbol |
| `instrument-type` | string | The instrument type |

#### Execution Details

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | The trade action (`Buy to Open`, `Sell to Close`, etc.) |
| `quantity` | number (double) | The quantity traded |
| `price` | number (double) | The execution price per unit |
| `value` | number (double) | The total value of the transaction |
| `value-effect` | string | `Debit` or `Credit` — the effect on the account balance |
| `net-value` | number (double) | The net value after fees |
| `net-value-effect` | string | `Debit` or `Credit` — the net effect on the account |
| `order-id` | integer | The order ID that generated this transaction |
| `leg-count` | integer | Number of legs in the originating order |
| `destination-venue` | string | The venue where the transaction was executed |
| `exchange` | string | The exchange |
| `exchange-affiliation-identifier` | string | Exchange affiliation ID |

#### Fees & Commissions

| Field | Type | Description |
|-------|------|-------------|
| `commission` | number (double) | Commission charged |
| `commission-effect` | string | `Debit` or `Credit` |
| `clearing-fees` | number (double) | Clearing fees charged |
| `clearing-fees-effect` | string | `Debit` or `Credit` |
| `regulatory-fees` | number (double) | Regulatory fees (SEC, TAF, etc.) |
| `regulatory-fees-effect` | string | `Debit` or `Credit` |
| `proprietary-index-option-fees` | number (double) | Fees for proprietary index options (e.g., SPX, VIX) |
| `proprietary-index-option-fees-effect` | string | `Debit` or `Credit` |
| `currency-conversion-fees` | number (double) | Currency conversion fees |
| `currency-conversion-fees-effect` | string | `Debit` or `Credit` |
| `other-charge` | number (double) | Any other charges |
| `other-charge-description` | string | Description of other charges |
| `other-charge-effect` | string | `Debit` or `Credit` |
| `is-estimated-fee` | boolean | Whether the fee amounts are estimated (may be reconciled later) |

#### Pricing

| Field | Type | Description |
|-------|------|-------------|
| `principal-price` | number (double) | The principal price of the transaction |
| `agency-price` | number (double) | The agency price (if applicable) |
| `currency` | string | The currency of the transaction values |

#### Lot & Cost Basis

| Field | Type | Description |
|-------|------|-------------|
| `lots` | object | Lot-level details including individual lot execution price, quantity, direction, and transaction date |
| `cost-basis-reconciliation-date` | date | The date when cost basis was reconciled with the clearing firm |
| `reverses-id` | integer | If this transaction reverses another, the ID of the reversed transaction |

#### External Identifiers

| Field | Type | Description |
|-------|------|-------------|
| `exec-id` | string | The execution ID |
| `ext-exec-id` | string | External execution ID |
| `ext-exchange-order-number` | string | External exchange order number |
| `ext-global-order-number` | integer | External global order number |
| `ext-group-fill-id` | string | External group fill ID (for multi-leg fills) |
| `ext-group-id` | string | External group ID |

---

## Common Use Cases

- **Trade history report:** Fetch all trades for a date range: `GET /accounts/{account_number}/transactions?types[]=Trade&start-date=2026-01-01&end-date=2026-04-09`
- **P&L calculation:** Use `value`, `value-effect`, `commission`, and `regulatory-fees` to calculate net realized P&L per transaction.
- **Fee analysis:** Use `GET /accounts/{account_number}/transactions/total-fees?date=2026-04-09` for a quick daily fee summary, or query individual transactions to break down fees by type.
- **Dividend tracking:** Filter with `types[]=Dividend` to get all dividend payments received.
- **Options assignment/expiration history:** Filter with `sub-type[]=Assignment` or `sub-type[]=Expiration` to find options that were assigned or expired.
- **Symbol-specific history:** Use `underlying-symbol=AAPL` to get all activity (stock trades + option trades) for a single underlying.

---

## Important Notes

- **Pagination limits:** Maximum of 2,000 results per page. For accounts with heavy trading activity, use date ranges and pagination to retrieve complete history.
- **Effect fields:** Every monetary value has a corresponding `*-effect` field indicating `Debit` (reduces account value) or `Credit` (increases account value).
- **Net value:** The `net-value` field is the transaction value after all fees. Use this for accurate P&L calculations rather than computing `value - commission - fees` manually.
- **Cost basis reconciliation:** Cost basis data may lag trades by a day due to nightly reconciliation with the clearing firm. Check `cost-basis-reconciliation-date` for the most recent reconciliation.
- **Transaction types vs. sub-types:** `transaction-type` is the broad category (Trade, Dividend, Money Movement). `transaction-sub-type` provides the specific action (Sell to Open, Assignment, Expiration, Dividend).
