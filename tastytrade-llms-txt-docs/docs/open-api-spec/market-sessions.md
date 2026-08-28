# Market Sessions

The Market Sessions API provides endpoints for determining market open/close times, current market state, and trading holidays across equities and futures exchanges. Use this to determine whether the market is currently open, when it opens next, and to avoid submitting orders during closed sessions.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 1.0.0

---

## Instrument Collections

All endpoints in this API are organized by instrument collection, which represents the exchange or market:

| Collection | Description |
|------------|-------------|
| `Equity` | US equity and equity options markets (NYSE, NASDAQ, etc.) |
| `CME` | CME Group futures and futures options (E-mini S&P, Crude Oil, Gold, etc.) |
| `CFE` | Cboe Futures Exchange (VIX futures, etc.) |
| `Zero Hash CLOB` | Cryptocurrency markets (available on the sessions range endpoint only) |

---

## Endpoints — General

### Get Sessions for Date Range

Retrieve session timings for a date range across any instrument collection. The date range must not exceed 9 months.

**Request**

```
GET /market-time/sessions
```

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to-date` | string (date) | Yes | End date for the range (format: `YYYY-MM-DD`) |
| `from-date` | string (date) | No | Start date for the range (format: `YYYY-MM-DD`). Defaults to today. |
| `instrument-collection` | string | No | The instrument collection. Values: `Equity`, `CME`, `CFE`, `Zero Hash CLOB`. Defaults to `Equity`. |

**Response** — `200 OK`

Returns an array of `SimpleSession` objects, one per trading session in the date range.

---

### Get Current Sessions (Multi-Collection)

Retrieve the current session timings for one or more instrument collections in a single request. Includes the current session state plus next and previous session details.

**Request**

```
GET /market-time/sessions/current
```

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instrument-collections` | array | Yes | One or more instrument collections. Values: `CFE`, `CME`, `Equity`. Pass as repeated params: `instrument-collections[]=Equity&instrument-collections[]=CME` |

**Response** — `200 OK`

Returns a `CurrentSessionDetailed` object containing the current session, next session, previous session, and current market state.

---

## Endpoints — Equities

### Get Current Equities Session

Returns the current equities market session, including whether the market is open or closed.

**Request**

```
GET /market-time/equities/sessions/current
```

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `current-time` | string (datetime) | No | Override the current time for the session lookup (useful for testing). Defaults to now. |

**Response** — `200 OK`

Returns a `CurrentSession` object with the current session's open/close times, market state, and embedded next/previous session details.

---

### Get Next Equities Session

Returns the next equities trading session, or the next session on or after a given date.

**Request**

```
GET /market-time/equities/sessions/next
```

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string (date) | No | Find the next session on or after this date (format: `YYYY-MM-DD`). Defaults to today. |

**Response** — `200 OK`

Returns a `NextSession` object.

---

### Get Previous Equities Session

Returns the most recent past equities trading session, or the session before a given date.

**Request**

```
GET /market-time/equities/sessions/previous
```

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string (date) | No | Find the session before this date (format: `YYYY-MM-DD`). Defaults to today. |

**Response** — `200 OK`

Returns a `PreviousSession` object.

---

### Get Equity Holidays

Returns the equity market holiday calendar including full holidays and half days.

**Request**

```
GET /market-time/equities/holidays
```

**Parameters:** None.

**Response** — `200 OK`

Returns an array of `MarketCalendar` objects containing market holidays and half days.

---

## Endpoints — Futures

### Get Current Futures Sessions (All Exchanges)

Returns the current session for all futures exchanges.

**Request**

```
GET /market-time/futures/sessions/current
```

**Parameters:** None.

**Response** — `200 OK`

Returns an array of `CurrentSession` objects, one per futures exchange.

---

### Get Current Futures Session by Exchange

Returns the current session for a specific futures exchange.

**Request**

```
GET /market-time/futures/sessions/current/{instrument_collection}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instrument_collection` | string | Yes | The futures exchange: `CME` or `CFE` |

**Response** — `200 OK`

Returns a `CurrentSession` object.

---

### Get Next Futures Session by Exchange

Returns the next futures trading session for a specific exchange.

**Request**

```
GET /market-time/futures/sessions/next/{instrument_collection}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instrument_collection` | string | Yes | The futures exchange: `CME` or `CFE` |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string (date) | No | Find the next session on or after this date. Defaults to today. |

**Response** — `200 OK`

Returns a `NextSession` object.

---

### Get Previous Futures Session by Exchange

Returns the most recent past futures trading session for a specific exchange.

**Request**

```
GET /market-time/futures/sessions/previous/{instrument_collection}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instrument_collection` | string | Yes | The futures exchange: `CME` or `CFE` |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `date` | string (date) | No | Find the session before this date. Defaults to today. |

**Response** — `200 OK`

Returns a `PreviousSession` object.

---

### Get Futures Holidays by Exchange

Returns the holiday calendar for a specific futures exchange.

**Request**

```
GET /market-time/futures/holidays/{instrument_collection}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instrument_collection` | string | Yes | The futures exchange: `CME` or `CFE` |

**Response** — `200 OK`

Returns an array of `MarketCalendar` objects.

---

## Data Models

### Session Time Fields

All session objects share a common set of time fields:

| Field | Type | Description |
|-------|------|-------------|
| `start-at` | datetime | The start time of the session (pre-market/overnight session open for equities; session open for futures) |
| `open-at` | datetime | The regular market open time (e.g., 9:30 AM ET for equities) |
| `close-at` | datetime | The regular market close time (e.g., 4:00 PM ET for equities) |
| `close-at-ext` | datetime | The extended-hours close time (e.g., 8:00 PM ET for equities after-hours) |
| `instrument-collection` | string | The instrument collection this session belongs to (`Equity`, `CME`, `CFE`) |

### SimpleSession

Returned by the date range sessions endpoint. Contains the core time fields only.

| Field | Type | Description |
|-------|------|-------------|
| `start-at` | datetime | Session start time |
| `open-at` | datetime | Regular market open |
| `close-at` | datetime | Regular market close |
| `close-at-ext` | datetime | Extended hours close |
| `instrument-collection` | string | The instrument collection |

### CurrentSession

Returned by current session endpoints. Includes the current session times plus nested next and previous sessions, and the current market state.

| Field | Type | Description |
|-------|------|-------------|
| `start-at` | datetime | Current session start time |
| `open-at` | datetime | Current session regular open |
| `close-at` | datetime | Current session regular close |
| `close-at-ext` | datetime | Current session extended hours close |
| `instrument-collection` | string | The instrument collection |
| `state` | string | The current market state (e.g., `Open`, `Closed`, `Pre-Market`, `After-Hours`) |
| `next-session` | object | The next trading session (contains `session-date`, `start-at`, `open-at`, `close-at`, `close-at-ext`, `instrument-collection`) |
| `previous-session` | object | The previous trading session (same fields as `next-session`) |

### NextSession

Returned by next session endpoints.

| Field | Type | Description |
|-------|------|-------------|
| `session-date` | date | The date of the next session |
| `start-at` | datetime | Next session start time |
| `open-at` | datetime | Next session regular open |
| `close-at` | datetime | Next session regular close |
| `close-at-ext` | datetime | Next session extended hours close |
| `instrument-collection` | string | The instrument collection |

### PreviousSession

Returned by previous session endpoints.

| Field | Type | Description |
|-------|------|-------------|
| `session-date` | date | The date of the previous session |
| `start-at` | datetime | Previous session start time |
| `open-at` | datetime | Previous session regular open |
| `close-at` | datetime | Previous session regular close |
| `close-at-ext` | datetime | Previous session extended hours close |
| `instrument-collection` | string | The instrument collection |

### MarketCalendar

Contains holiday and half-day schedules for a market.

| Field | Type | Description |
|-------|------|-------------|
| `market-holidays` | object | Map of dates that are full market holidays (market closed all day) |
| `market-half-days` | object | Map of dates that are half days (early close) |

---

## Common Use Cases

- **Is the market open?** Call `GET /market-time/equities/sessions/current` and check the `state` field. Use this to gate order submission or to display market status in a UI.
- **When does the market open next?** Call `GET /market-time/equities/sessions/next` to get the next session's `open-at` timestamp. Useful for scheduling automated trading.
- **Holiday-aware scheduling:** Fetch holidays via `GET /market-time/equities/holidays` to avoid scheduling trades or alerts on market holidays.
- **Multi-market awareness:** Use `GET /market-time/sessions/current?instrument-collections[]=Equity&instrument-collections[]=CME` to check whether both equity and futures markets are open simultaneously.
- **Futures session times:** Futures markets have different hours than equities and vary by exchange (CME vs. CFE). Use the exchange-specific futures endpoints to get accurate session times for the products you're trading.

---

## Important Notes

- **All timestamps are in UTC.** Convert to the user's local timezone for display. US equity regular hours are 9:30 AM – 4:00 PM Eastern Time.
- **Futures trade nearly 24 hours.** CME futures typically trade Sunday 5:00 PM CT through Friday 4:00 PM CT with a daily maintenance break. Session times from this API reflect the actual trading windows.
- **Date range limit:** The `GET /market-time/sessions` endpoint has a maximum range of 9 months between `from-date` and `to-date`.
- **Extended hours:** The `close-at-ext` field reflects the end of after-hours trading for equities or the end of the extended session for futures. Orders with `time-in-force` of `Ext` can execute during these windows.
