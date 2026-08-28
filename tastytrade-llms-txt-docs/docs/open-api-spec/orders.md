# Orders

The Orders API is the core trading interface for the tastytrade Open API. It provides endpoints for submitting, retrieving, modifying, and canceling orders, as well as managing complex multi-order strategies (OTO, OCO, OTOCO, PAIRS, BLAST). The dry-run endpoints allow pre-flight validation without placing live orders.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 0.0.1 (versioned as `20250813`)

---

## Endpoints — Single Orders

### Search Orders

Returns a paginated list of orders for an account, with filtering and sorting options.

```
GET /accounts/{account_number}/orders
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account_number` | string | Yes | The tastytrade account number |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start-date` | string (date) | No | Filter orders from this date forward (`YYYY-MM-DD`) |
| `end-date` | string (date) | No | Filter orders up to this date (`YYYY-MM-DD`) |
| `start-at` | string (datetime) | No | Filter orders from this datetime (full ISO 8601 datetime for more precision than `start-date`) |
| `end-at` | string (datetime) | No | Filter orders up to this datetime |
| `status` | array | No | Filter by order status. Pass as repeated params: `status[]=Filled&status[]=Live` |
| `underlying-symbol` | string | No | Filter by underlying symbol (e.g., `AAPL`) |
| `underlying-instrument-type` | string | No | Filter by underlying instrument type |
| `futures-symbol` | string | No | Filter by futures symbol (returns both futures and futures options orders) |
| `sort` | string | No | Sort direction: `Desc` (newest first, default) or `Asc` (oldest first) |
| `page-offset` | integer | No | Pagination offset (0-indexed) |
| `per-page` | integer | No | Results per page |

**Response** — `200 OK`: Returns an array of `Order` objects.

---

### Get Live Orders

Returns all orders from the current trading day, including all statuses (not only currently live/working orders).

```
GET /accounts/{account_number}/orders/live
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `page-offset` | query | integer | No | Pagination offset |
| `per-page` | query | integer | No | Results per page |

**Response** — `200 OK`: Returns an array of `Order` objects.

---

### Get Order by ID

Returns a single order by its ID.

```
GET /accounts/{account_number}/orders/{id}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `id` | path | string | Yes | The order ID |

**Response** — `200 OK`: Returns a single `Order` object.

---

### Submit Order

Place a new order for an account.

```
POST /accounts/{account_number}/orders
```

**Content-Type:** `application/json`

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |

**Request Body:** See [Order Request Body](#order-request-body) below.

**Response** — `200 OK`: Returns a `PlacedOrderResponse` containing the created order, buying power effect, fee calculations, and any warnings or errors.

---

### Order Dry Run

Validate an order through all pre-flight checks without actually placing it. Returns the same response as a live order submission, including buying power effect and fee calculations.

```
POST /accounts/{account_number}/orders/dry-run
```

**Request Body:** Same structure as [Submit Order](#submit-order).

**Response** — `200 OK`: Returns a `PlacedOrderResponse`.

---

### Cancel Order

Request cancellation of a live order.

```
DELETE /accounts/{account_number}/orders/{id}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `id` | path | string | Yes | The order ID to cancel |

**Response** — `200 OK`: Returns the updated `Order` object.

---

### Replace Order (Full)

Replace a live order with an entirely new order. The original order is canceled and the new order is submitted atomically. If the original order receives a fill between the cancel and replacement, the replacement is aborted.

```
PUT /accounts/{account_number}/orders/{id}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `id` | path | string | Yes | The ID of the order to replace |

**Request Body:** Full order body (same fields as Submit Order, minus `legs`). The legs from the original order are retained.

---

### Edit Order (Partial)

Edit the price and execution properties of a live order via cancel-replace. Only the fields you include in the body are modified. If the original order receives a fill between the cancel and replacement, the edit is aborted.

```
PATCH /accounts/{account_number}/orders/{id}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `id` | path | string | Yes | The ID of the order to edit |

**Request Body:** Partial order body — only include the fields you want to change (e.g., `price`, `price-effect`, `time-in-force`).

---

### Replace/Edit Dry Run

Run pre-flight checks for a cancel-replace or edit without actually routing the order.

```
POST /accounts/{account_number}/orders/{id}/dry-run
```

**Request Body:** Same structure as Edit Order.

**Response** — `200 OK`: Returns a `PlacedOrderResponse`.

---

## Endpoints — Complex Orders

Complex orders combine multiple orders into a single strategy with defined execution relationships.

### Get Complex Orders

Returns a paginated list of all complex orders for an account.

```
GET /accounts/{account_number}/complex-orders
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `account_number` | path | string | Yes | The tastytrade account number |
| `page-offset` | query | integer | No | Pagination offset |
| `per-page` | query | integer | No | Results per page |

---

### Get Live Complex Orders

Returns all complex orders where a component order was placed today.

```
GET /accounts/{account_number}/complex-orders/live
```

---

### Get Complex Order by ID

```
GET /accounts/{account_number}/complex-orders/{id}
```

---

### Submit Complex Order

Create a new complex order strategy.

```
POST /accounts/{account_number}/complex-orders
```

**Request Body:** See [Complex Order Request Body](#complex-order-request-body) below.

---

### Complex Order Dry Run

Validate a complex order without placing it.

```
POST /accounts/{account_number}/complex-orders/dry-run
```

---

### Edit Complex Order

Edit the threshold price of a PAIRS trade.

```
PATCH /accounts/{account_number}/complex-orders/{id}
```

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `ratio-price-comparator` | string | `gte` (Greater than or Equal To) or `lte` (Less than or Equal To) |
| `ratio-price-threshold` | number (double) | The updated ratio price threshold |

---

### Cancel Complex Order

Cancel all non-terminal component orders of a complex order.

```
DELETE /accounts/{account_number}/complex-orders/{id}
```

---

### Complex Order Edit Dry Run

```
POST /accounts/{account_number}/complex-orders/{id}/dry-run
```

---

## Endpoints — Customer-Level Order Queries

These endpoints return orders across all accounts for a customer.

### Search Customer Orders

```
GET /customers/{customer_id}/orders
```

Same query parameters as the account-level search, plus:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account-numbers` | array | No | Filter to specific account numbers |

### Get Customer Live Orders

```
GET /customers/{customer_id}/orders/live
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account-numbers` | array | No | Filter to specific account numbers |

---

## Order Request Body

Used for `POST /accounts/{account_number}/orders` and the dry-run equivalent.

### Order-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `order-type` | string | Yes | `Limit`, `Market`, `Marketable Limit`, `Notional Market`, `Stop`, `Stop Limit` |
| `time-in-force` | string | Yes | `Day`, `Ext`, `Ext Overnight`, `GTC`, `GTC Ext`, `GTC Ext Overnight`, `GTD`, `IOC` |
| `price` | number (double) | Conditional | The limit price. Required for `Limit` and `Stop Limit` orders. For multi-leg orders, this is the **net** price of all legs combined. |
| `price-effect` | string | Conditional | `Credit` or `Debit`. Required when `price` is specified. |
| `stop-trigger` | number (double) | Conditional | The stop trigger price. Required for `Stop` and `Stop Limit` orders. |
| `value` | number (double) | Conditional | The notional dollar value. Required for `Notional Market` orders (fractional share purchases by dollar amount). |
| `value-effect` | string | Conditional | `Credit` or `Debit`. Required when `value` is specified. |
| `gtc-date` | string (date) | Conditional | Expiration date for `GTD` orders (`YYYY-MM-DD`). Only valid when `time-in-force` is `GTD`. |
| `legs` | array | Yes | Array of 1–4 order legs (see below) |
| `rules` | object | No | Conditional execution rules (see below) |
| `advanced-instructions` | object | No | Advanced order instructions (see below) |
| `source` | string | No | Identifier for the source of the order (e.g., your application name) |
| `external-identifier` | string | No | Your external identifier for the order |
| `automated-source` | boolean | No | Set to `true` if the order was placed by an automated/algorithmic system |
| `preflight-id` | string | No | Transient identifier for matching preflight errors to a specific order |
| `partition-key` | string | No | Account partition key |

### Leg Fields

Each order contains 1–4 legs. Each leg represents a single instrument action.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | The instrument symbol. Equity: `AAPL`. Equity Option (OCC format): `AAPL  260417C00200000`. Future: `/ESM6`. Future Option: `./ESZ9 EW4U9 190927P2975`. |
| `instrument-type` | string | Yes | `Cryptocurrency`, `Equity`, `Equity Option`, `Event Contract`, `Fixed Income Security`, `Future`, `Future Option`, `Liquidity Pool` |
| `action` | string | Yes | `Buy to Open`, `Buy to Close`, `Sell to Open`, `Sell to Close`. For futures only: `Buy`, `Sell`. |
| `quantity` | number (double) | Conditional | Number of shares or contracts. Required for all orders except `Notional Market`. |

**Action values explained:**

| Action | Use When |
|--------|----------|
| `Buy to Open` | Opening a new long position (buying stock, buying options) |
| `Buy to Close` | Closing an existing short position |
| `Sell to Open` | Opening a new short position (selling options, shorting stock) |
| `Sell to Close` | Closing an existing long position |
| `Buy` | Buying futures (futures do not distinguish open/close) |
| `Sell` | Selling futures |

### Rules (Conditional Execution)

Optional rules for controlling when an order is routed or canceled.

| Field | Type | Description |
|-------|------|-------------|
| `route-after` | datetime | Earliest time the order should be routed (delayed submission) |
| `cancel-at` | datetime | Latest time the order should remain active before auto-cancellation |
| `conditions` | array | Array of price-based conditions that must be met before the order is routed or canceled |

Each condition object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | `route` (route the order when triggered) or `cancel` (cancel the order when triggered) |
| `symbol` | string | No | The symbol to monitor for the condition (e.g., `AAPL`, `/ESZ9`) |
| `instrument-type` | string | No | The instrument type of the monitored symbol |
| `indicator` | string | Yes | The price indicator to monitor: `last` (last trade price) or `nat` (natural price) |
| `comparator` | string | Yes | `gte` (greater than or equal to) or `lte` (less than or equal to) |
| `threshold` | number (double) | Yes | The price threshold that triggers the condition |
| `price-components` | array | No | For complex conditions based on a synthetic price derived from multiple instruments |

### Advanced Instructions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `strict-position-effect-validation` | boolean | false | If true, the order is rejected when the open/close position effect is not valid (e.g., trying to `Sell to Close` a position you don't hold) |

---

## Complex Order Request Body

Used for `POST /accounts/{account_number}/complex-orders`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | The complex order strategy: `OTO`, `OCO`, `OTOCO`, `BLAST`, `PAIRS` |
| `trigger-order` | object | Conditional | The initial live order for OTO-based strategies. This order executes first. Required for `OTO` and `OTOCO`. Contains a full order body. |
| `orders` | array | Conditional | Array of child orders for OCO/BLAST strategies. Required for `OCO`, `BLAST`, and the child portion of `OTOCO`. Each element is a full order body. |
| `source` | string | No | Source identifier |
| `ratio-price-comparator` | string | No | For `PAIRS` trades: `gte` or `lte` |
| `ratio-price-threshold` | number (double) | No | For `PAIRS` trades: the ratio price threshold |
| `ratio-price-is-threshold-based-on-notional` | boolean | No | For `PAIRS` trades: whether the threshold comparison uses notional value |

**Complex Order Types:**

| Type | Description | Structure |
|------|-------------|-----------|
| `OTO` | One-Triggers-Other: when the trigger order fills, the child order(s) are activated | `trigger-order` + `orders` |
| `OCO` | One-Cancels-Other: multiple orders are live simultaneously; when one fills, the others are canceled | `orders` (array of 2+ orders) |
| `OTOCO` | One-Triggers-OCO: trigger order fills, then an OCO group is activated | `trigger-order` + `orders` |
| `BLAST` | All orders are submitted simultaneously (no conditional relationship) | `orders` (array of orders) |
| `PAIRS` | A pairs trade with a ratio-based price threshold | `orders` + ratio fields |

---

## Data Models

### Order (Response)

The full order object returned by GET and POST endpoints.

#### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The unique order identifier |
| `account-number` | string | The account number |
| `status` | string | Current order status (see Order Status values below) |
| `order-type` | string | The order type (`Limit`, `Market`, etc.) |
| `time-in-force` | string | The time-in-force setting |
| `price` | number (double) | The order price (limit price for limit orders) |
| `price-effect` | string | `Credit` or `Debit` |
| `stop-trigger` | string | The stop trigger price |
| `value` | number (double) | Notional value (for notional market orders) |
| `value-effect` | string | `Credit` or `Debit` |
| `size` | string | The total order size |
| `underlying-symbol` | string | The underlying symbol |
| `underlying-instrument-type` | string | The underlying instrument type |
| `gtc-date` | date | The GTD expiration date |
| `source` | string | The order source |
| `external-identifier` | string | External identifier |

#### Lifecycle Timestamps

| Field | Type | Description |
|-------|------|-------------|
| `received-at` | datetime | When the order was received by the system |
| `live-at` | datetime | When the order went live on the exchange |
| `in-flight-at` | datetime | When the order entered in-flight status |
| `terminal-at` | datetime | When the order reached a terminal state (filled, cancelled, rejected, expired) |
| `cancelled-at` | datetime | When the order was cancelled |
| `updated-at` | string | Last update timestamp |

#### State & Control

| Field | Type | Description |
|-------|------|-------------|
| `cancellable` | boolean | Whether the order can currently be cancelled |
| `editable` | boolean | Whether the order can currently be edited/replaced |
| `edited` | boolean | Whether the order has been edited |
| `reject-reason` | string | The reason the order was rejected (if applicable) |
| `replaces-order-id` | string | The ID of the order this order replaces (if cancel-replace) |
| `replacing-order-id` | string | The ID of the order replacing this one |
| `complex-order-id` | string | The ID of the parent complex order (if part of one) |
| `complex-order-tag` | string | The tag identifying this order's role in a complex order (e.g., `OTO::trigger-order`) |
| `contingent-status` | string | Contingent status for complex order components |
| `preflight-id` | string | The preflight identifier |
| `global-request-id` | string | Global request tracking ID |
| `leg-count` | string | Number of legs in the order |

#### User Information

| Field | Type | Description |
|-------|------|-------------|
| `user-id` | string | The user who placed the order |
| `username` | string | The username who placed the order |
| `cancel-user-id` | string | The user who cancelled the order |
| `cancel-username` | string | The username who cancelled the order |

#### Legs (Response)

Each leg in the response includes fill information:

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The instrument symbol |
| `instrument-type` | string | The instrument type |
| `action` | string | The order action |
| `quantity` | string | The ordered quantity |
| `remaining-quantity` | string | The quantity remaining to be filled |
| `fills` | array | Array of fill objects (see below) |

#### Fill Object

Each fill represents a partial or complete execution of a leg.

| Field | Type | Description |
|-------|------|-------------|
| `fill-id` | string | Unique fill identifier |
| `fill-price` | number (double) | The price at which the fill occurred |
| `quantity` | string | The quantity filled |
| `filled-at` | datetime | When the fill occurred |
| `destination-venue` | string | The venue where the fill occurred |
| `ext-exec-id` | string | External execution ID |
| `ext-group-fill-id` | string | External group fill ID (for multi-leg fills) |

#### Order Rule (Response)

| Field | Type | Description |
|-------|------|-------------|
| `route-after` | datetime | Earliest routing time |
| `routed-at` | datetime | When the order was actually routed |
| `cancel-at` | datetime | Auto-cancel time |
| `cancelled-at` | datetime | When the auto-cancel executed |
| `order-conditions` | array | Array of conditions with their trigger state (`triggered-at`, `triggered-value`) |

---

### PlacedOrderResponse

Returned by order submission and dry-run endpoints.

| Field | Type | Description |
|-------|------|-------------|
| `order` | Order | The created or validated order object |
| `complex-order` | ComplexOrder | The complex order object (if submitting a complex order) |
| `buying-power-effect` | string | The impact on the account's buying power (formatted as a string with the amount and direction) |
| `fee-calculation` | string | Estimated fees for the order |
| `closing-fee-calculation` | string | Estimated fees specific to closing transactions |
| `warnings` | array | Non-blocking warnings about the order |
| `errors` | array | Blocking errors that prevent the order from being placed |
| `notes` | array | Informational notes about the order |

---

### ComplexOrder (Response)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The complex order identifier |
| `account-number` | string | The account number |
| `type` | string | The complex order type (`OTO`, `OCO`, `OTOCO`, `BLAST`, `PAIRS`) |
| `trigger-order` | Order | The trigger order (tagged with `complex-order-tag` like `OTO::trigger-order`) |
| `orders` | array | The child orders |
| `related-orders` | array | Related orders |
| `terminal-at` | string | When the complex order reached terminal state |
| `ratio-price-comparator` | string | For PAIRS: `gte` or `lte` |
| `ratio-price-threshold` | number (double) | For PAIRS: the ratio threshold |
| `ratio-price-is-threshold-based-on-notional` | boolean | For PAIRS: notional-based comparison |

---

## Order Status Values

| Status | Terminal? | Description |
|--------|-----------|-------------|
| `Received` | No | Order received by the system, not yet routed |
| `Routed` | No | Order has been routed to the exchange |
| `In Flight` | No | Order is in flight to the exchange |
| `Live` | No | Order is live and working on the exchange |
| `Contingent` | No | Order is contingent on another event (e.g., part of OTO waiting for trigger) |
| `Filled` | Yes | Order has been completely filled |
| `Cancelled` | Yes | Order was cancelled |
| `Expired` | Yes | Order expired (e.g., Day order at market close) |
| `Rejected` | Yes | Order was rejected (see `reject-reason` for details) |
| `Remove Pending` | No | Cancellation is pending |
| `Dead` | Yes | Order is dead (terminal, no fills) |

---

## Example Requests

### Buy 100 Shares of Stock

```json
{
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": 185.00,
  "price-effect": "Debit",
  "legs": [
    {
      "symbol": "AAPL",
      "instrument-type": "Equity",
      "action": "Buy to Open",
      "quantity": 100
    }
  ]
}
```

### Sell to Close an Equity Position

```json
{
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": 190.00,
  "price-effect": "Credit",
  "legs": [
    {
      "symbol": "AAPL",
      "instrument-type": "Equity",
      "action": "Sell to Close",
      "quantity": 100
    }
  ]
}
```

### Buy a Call Option

```json
{
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": 3.50,
  "price-effect": "Debit",
  "legs": [
    {
      "symbol": "AAPL  260619C00200000",
      "instrument-type": "Equity Option",
      "action": "Buy to Open",
      "quantity": 1
    }
  ]
}
```

### Sell a Put Credit Spread (2-Leg)

```json
{
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": 1.25,
  "price-effect": "Credit",
  "legs": [
    {
      "symbol": "SPY   260619P00540000",
      "instrument-type": "Equity Option",
      "action": "Sell to Open",
      "quantity": 1
    },
    {
      "symbol": "SPY   260619P00535000",
      "instrument-type": "Equity Option",
      "action": "Buy to Open",
      "quantity": 1
    }
  ]
}
```

### Iron Condor (4-Leg)

```json
{
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": 2.00,
  "price-effect": "Credit",
  "legs": [
    {
      "symbol": "SPY   260619P00530000",
      "instrument-type": "Equity Option",
      "action": "Buy to Open",
      "quantity": 1
    },
    {
      "symbol": "SPY   260619P00540000",
      "instrument-type": "Equity Option",
      "action": "Sell to Open",
      "quantity": 1
    },
    {
      "symbol": "SPY   260619C00570000",
      "instrument-type": "Equity Option",
      "action": "Sell to Open",
      "quantity": 1
    },
    {
      "symbol": "SPY   260619C00580000",
      "instrument-type": "Equity Option",
      "action": "Buy to Open",
      "quantity": 1
    }
  ]
}
```

### Notional Market Order (Fractional Shares by Dollar Amount)

```json
{
  "order-type": "Notional Market",
  "time-in-force": "Day",
  "value": 500.00,
  "value-effect": "Debit",
  "legs": [
    {
      "symbol": "AAPL",
      "instrument-type": "Equity",
      "action": "Buy to Open"
    }
  ]
}
```

### OTO (One-Triggers-Other) Complex Order

```json
{
  "type": "OTO",
  "trigger-order": {
    "order-type": "Limit",
    "time-in-force": "Day",
    "price": 185.00,
    "price-effect": "Debit",
    "legs": [
      {
        "symbol": "AAPL",
        "instrument-type": "Equity",
        "action": "Buy to Open",
        "quantity": 100
      }
    ]
  },
  "orders": [
    {
      "order-type": "Stop",
      "time-in-force": "GTC",
      "stop-trigger": 175.00,
      "price-effect": "Credit",
      "legs": [
        {
          "symbol": "AAPL",
          "instrument-type": "Equity",
          "action": "Sell to Close",
          "quantity": 100
        }
      ]
    }
  ]
}
```

---

## Common Use Cases

- **Place and monitor:** Submit an order via POST, then poll `GET /accounts/{account_number}/orders/{id}` or use the account streamer WebSocket to monitor status changes through `Received` → `Routed` → `Live` → `Filled`.
- **Pre-flight validation:** Always use the dry-run endpoint first to check buying power, fees, and potential errors before submitting a live order. The response structure is identical.
- **Cancel-replace to adjust price:** Use `PATCH /accounts/{account_number}/orders/{id}` with just the new `price` field to adjust a working limit order's price without resubmitting the full order.
- **Bracket orders:** Use an `OTOCO` complex order to submit an entry order that, when filled, automatically activates a take-profit limit and a stop-loss as an OCO pair.
- **Search for fills:** Use `GET /accounts/{account_number}/orders?status[]=Filled&start-date=2026-04-09` to find all filled orders for today. Each order's legs contain `fills` with the execution details.

---

## Important Notes

- **Price for multi-leg orders:** The `price` field represents the **net** price of all legs combined, not the price of any individual leg. For a credit spread priced at `1.25` credit, set `price: 1.25` and `price-effect: "Credit"`.
- **Options quantity:** The `quantity` for equity options is the **number of contracts**, not the number of shares. A quantity of `1` means 1 contract = 100 shares of exposure (for standard options).
- **Options price:** The `price` for options orders is the **per-contract price** (e.g., `3.50`), not the total cost. The total cost is `price × quantity × multiplier` (e.g., `3.50 × 1 × 100 = $350`).
- **Futures actions:** Futures use `Buy` and `Sell` (not `Buy to Open`/`Sell to Close`) because futures do not distinguish between opening and closing transactions.
- **Time-in-force values:** `Ext` = extended hours, `Ext Overnight` = extended hours including overnight session, `GTC Ext` = good-til-canceled including extended hours, `IOC` = immediate-or-cancel.
- **Automated source flag:** Set `automated-source: true` for algorithmically-generated orders. This may affect order handling and regulatory reporting.
- **Dry run before live:** The dry-run response includes `errors` (blocking) and `warnings` (non-blocking). Always check `errors` — if non-empty, the order would be rejected.
