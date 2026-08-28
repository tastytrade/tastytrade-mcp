# Symbol Search

The Symbol Search API provides a simple search endpoint for looking up instruments by symbol or partial symbol match. Use it to build typeahead/autocomplete search functionality or to resolve a symbol fragment into full instrument details.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 1.0.0

---

## Endpoints

### Search Symbols

Search for instruments by symbol or partial symbol. Results include matching equities, options underlyings, futures, and other instrument types.

**Request**

```
GET /symbols/search/{symbol}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `symbol` | string | Yes | The symbol or symbol fragment to search (e.g., `AAP` will return results for `AAP`, `AAPL`, and other matches) |

**Response** — `200 OK`

Returns an array of `SymbolData` objects matching the search query.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "symbol": "AAPL",
        "description": "Apple Inc.",
        "listed-market": "NASDAQ",
        "instrument-type": "Equity",
        "options": true,
        "price-increments": "$0.01 to $1.00: $0.01, above $1.00: $0.01",
        "trading-hours": "09:30-16:00 ET"
      },
      {
        "symbol": "AAP",
        "description": "Advance Auto Parts Inc.",
        "listed-market": "NYSE",
        "instrument-type": "Equity",
        "options": true,
        "price-increments": "$0.01 to $1.00: $0.01, above $1.00: $0.01",
        "trading-hours": "09:30-16:00 ET"
      }
    ]
  }
}
```

---

## Data Models

### SymbolData

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The full instrument symbol |
| `description` | string | Company name or instrument description (e.g., `Apple Inc.`) |
| `listed-market` | string | The exchange where the instrument is listed (e.g., `NASDAQ`, `NYSE`) |
| `instrument-type` | string | The instrument type (e.g., `Equity`, `Future`) |
| `options` | boolean | Whether the instrument has listed options available for trading |
| `price-increments` | string | Human-readable description of the price increment (tick size) rules |
| `trading-hours` | string | Human-readable trading hours |

---

## Common Use Cases

- **Search/autocomplete:** Build a typeahead search box that calls this endpoint as the user types. A query of `AAP` returns both `AAP` and `AAPL`.
- **Symbol validation:** Verify that a user-entered symbol exists before attempting to fetch quotes or place orders.
- **Options availability check:** Use the `options` boolean field to determine whether you can fetch an option chain for a given symbol.
- **Instrument type discovery:** If a user enters a symbol, use the `instrument-type` field to determine what kind of instrument it is and route to the appropriate order ticket.

---

## Important Notes

- **Partial matching:** The search performs prefix matching. Entering `SP` will return `SPY`, `SPXL`, `SPLG`, etc.
- **Single endpoint:** Unlike most other tastytrade API services, Symbol Search has only one endpoint. For detailed instrument data (tick sizes, option chains, futures products), use the Instruments API after resolving the symbol.
- **No pagination:** Results are returned in a single response without pagination parameters.
