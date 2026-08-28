# Quote Alerts

The Quote Alerts API allows you to create, retrieve, and cancel price-based alerts on symbols. Alerts trigger when a specified market data field (last price, bid, ask, or implied volatility) crosses a threshold. Alerts are scoped to the authenticated user, not to a specific account.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 1.23.0

---

## Endpoints

### Get Quote Alerts

Retrieve all quote alerts for the current user.

**Request**

```
GET /quote-alerts
```

**Parameters:** None.

**Response** — `200 OK`

Returns an array of `QuoteAlert` objects.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "alert-external-id": "12345",
        "symbol": "AAPL",
        "instrument-type": "Equity",
        "field": "Last",
        "operator": ">",
        "threshold": "200.00",
        "threshold-numeric": 200.00,
        "dx-symbol": "AAPL",
        "expires-at": "2026-05-01T00:00:00.000+00:00",
        "created-at": "2026-04-09T12:00:00.000+00:00",
        "triggered-at": null,
        "completed-at": null,
        "dismissed-at": null,
        "expired-at": null,
        "provider": "dxfeed",
        "user-external-id": "U0000085345"
      }
    ]
  }
}
```

---

### Create Quote Alert

Create a new price alert for a symbol.

**Request**

```
POST /quote-alerts
```

**Content-Type:** `application/json`

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | The symbol to monitor (e.g., `AAPL`, `SPY`, `/ESM6`) |
| `field` | string | Yes | The market data field to monitor: `Last` (last trade price), `Bid`, `Ask`, or `IV` (implied volatility) |
| `operator` | string | Yes | The comparison operator: `>` (greater than) or `<` (less than) |
| `threshold` | string | Yes | The price or value threshold that triggers the alert (passed as a string, e.g., `"200.00"`) |
| `instrument-type` | string | No | The instrument type (e.g., `Equity`, `Equity Option`, `Future`) |
| `dx-symbol` | string | No | The DXLink streamer symbol (if different from `symbol`) |
| `threshold-numeric` | string | No | Numeric representation of the threshold |
| `expires-at` | string | No | When the alert should expire if not triggered (ISO 8601 datetime) |

**Example Request**

```json
{
  "symbol": "AAPL",
  "field": "Last",
  "operator": ">",
  "threshold": "200.00",
  "instrument-type": "Equity",
  "expires-at": "2026-05-01T00:00:00.000+00:00"
}
```

**Response** — `201 Created`

Returns the created `QuoteAlert` object.

---

### Cancel Quote Alert

Cancel (delete) an existing quote alert.

**Request**

```
DELETE /quote-alerts/{alert_external_id}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `alert_external_id` | integer | Yes | The external ID of the alert to cancel |

**Response** — `204 No Content`

---

## Data Models

### QuoteAlert

| Field | Type | Description |
|-------|------|-------------|
| `alert-external-id` | string | The unique identifier for the alert |
| `symbol` | string | The symbol being monitored |
| `instrument-type` | string | The instrument type |
| `dx-symbol` | string | The DXLink streamer symbol |
| `field` | string | The monitored field: `Last`, `Bid`, `Ask`, or `IV` |
| `operator` | string | The comparison operator: `>` or `<` |
| `threshold` | string | The threshold value as a string |
| `threshold-numeric` | number (double) | The threshold value as a number |
| `provider` | string | The market data provider (e.g., `dxfeed`) |
| `user-external-id` | string | The external ID of the user who created the alert |
| `created-at` | datetime | When the alert was created |
| `expires-at` | string | When the alert expires if not triggered |
| `triggered-at` | datetime | When the alert was triggered (null if not yet triggered) |
| `completed-at` | datetime | When the alert was completed/delivered |
| `dismissed-at` | datetime | When the user dismissed the alert |
| `expired-at` | datetime | When the alert expired without triggering |

### Alert Lifecycle

An alert progresses through these states:

1. **Created** — `created-at` is set, all other timestamps are null
2. **Triggered** — `triggered-at` is set when the threshold condition is met
3. **Completed** — `completed-at` is set when the alert notification is delivered
4. **Dismissed** — `dismissed-at` is set when the user dismisses the alert
5. **Expired** — `expired-at` is set if `expires-at` passes without the alert triggering

---

## Common Use Cases

- **Price breakout alerts:** Create an alert with `field: "Last"` and `operator: ">"` to get notified when a stock breaks above a resistance level.
- **Dip buying triggers:** Use `operator: "<"` to monitor for a stock dropping below a target entry price.
- **IV expansion alerts:** Set `field: "IV"` with `operator: ">"` on an options underlying to get notified when implied volatility spikes — useful for timing premium-selling entries.
- **Bid/ask monitoring:** Use `field: "Bid"` or `field: "Ask"` to monitor specific sides of the market, useful for limit order placement timing.

---

## Important Notes

- **User-scoped, not account-scoped:** Alerts are tied to the authenticated user, not a specific account. The `GET` and `POST` endpoints do not require an account number.
- **Threshold as string:** The `threshold` field in the request body is passed as a string (e.g., `"200.00"`), not a number.
- **One-shot alerts:** Alerts trigger once and are then in a completed state. To monitor continuously, you would need to create a new alert after each trigger.
- **IV field:** When using `field: "IV"`, the threshold represents implied volatility as a decimal (e.g., `"0.35"` for 35% IV), consistent with how IV is returned by the Market Metrics API.
