# Watchlists

The Watchlists API provides endpoints for managing user watchlists, accessing tastytrade's curated public watchlists, and retrieving pairs watchlists. User watchlists are scoped to the authenticated user, not to a specific account.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 2.2.0

---

## Endpoints — User Watchlists

### Get All User Watchlists

Returns all watchlists for the authenticated user.

```
GET /watchlists
```

**Parameters:** None.

**Response** — `200 OK`: Returns an array of `Watchlist` objects.

---

### Get User Watchlist by Name

Returns a specific watchlist by name.

```
GET /watchlists/{watchlist_name}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `watchlist_name` | path | string | Yes | The watchlist name |

**Response** — `200 OK`: Returns a `Watchlist` object.

---

### Create Watchlist

Create a new watchlist with a name and list of symbols.

```
POST /watchlists
```

**Content-Type:** `application/json`

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | The watchlist name (must be unique among user's watchlists) |
| `watchlist-entries` | array | Yes | Array of instruments to watch (see entry format below) |
| `group-name` | string | No | The group this watchlist belongs to (for organizing watchlists) |
| `order-index` | integer | No | Display order index (default: `9999`) |

Each entry in `watchlist-entries`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `symbol` | string | Yes | The instrument symbol (e.g., `AAPL`, `/ESM6`) |
| `instrument-type` | string | No | The instrument type (e.g., `Equity`, `Future`) |

**Example Request**

```json
{
  "name": "AI Infrastructure",
  "group-name": "Thematic ETFs",
  "watchlist-entries": [
    { "symbol": "VRT", "instrument-type": "Equity" },
    { "symbol": "DELL", "instrument-type": "Equity" },
    { "symbol": "DLR", "instrument-type": "Equity" },
    { "symbol": "SMCI", "instrument-type": "Equity" }
  ]
}
```

**Response** — `201 Created`: Returns the created `Watchlist` object.

---

### Update Watchlist

Replace all properties of an existing watchlist. This is a full replacement — include all entries you want to keep.

```
PUT /watchlists/{watchlist_name}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `watchlist_name` | path | string | Yes | The name of the watchlist to update |

**Request Body:** Same structure as Create Watchlist.

**Response** — `200 OK`: Returns the updated `Watchlist` object.

---

### Delete Watchlist

Delete a user watchlist.

```
DELETE /watchlists/{watchlist_name}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `watchlist_name` | path | string | Yes | The name of the watchlist to delete |

**Response** — `200 OK`: Returns the deleted `Watchlist` object.

---

## Endpoints — Public Watchlists

tastytrade curates a set of public watchlists (e.g., sector watchlists, popular underlyings).

### Get All Public Watchlists

```
GET /public-watchlists
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `counts-only` | query | boolean | No | If `true`, return only the name and entry count for each watchlist without the full symbol list (default: `false`) |

**Response** — `200 OK`: Returns an array of `Watchlist` objects.

---

### Get Public Watchlist by Name

```
GET /public-watchlists/{watchlist_name}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `watchlist_name` | path | string | Yes | The public watchlist name |

**Response** — `200 OK`: Returns a `Watchlist` object.

---

## Endpoints — Pairs Watchlists

Pairs watchlists contain symbol pairs used for pairs trading strategies.

### Get All Pairs Watchlists

```
GET /pairs-watchlists
```

**Parameters:** None.

**Response** — `200 OK`: Returns an array of `PairsWatchlist` objects.

---

### Get Pairs Watchlist by Name

```
GET /pairs-watchlists/{pairs_watchlist_name}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `pairs_watchlist_name` | path | string | Yes | The pairs watchlist name |

**Response** — `200 OK`: Returns a `PairsWatchlist` object.

---

## Data Models

### Watchlist

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | The watchlist name |
| `watchlist-entries` | object | The instruments in the watchlist. Each entry contains a `symbol` and optionally an `instrument-type`. |
| `group-name` | string | The group this watchlist belongs to |
| `order-index` | integer | Display order index for sorting watchlists |
| `cms-id` | string | CMS identifier (for public watchlists managed via content management) |

### PairsWatchlist

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | The pairs watchlist name |
| `pairs-equations` | object | The pairs equations defining the symbol relationships |
| `order-index` | integer | Display order index |

---

## Common Use Cases

- **Portfolio tracking watchlist:** Create a watchlist with all the symbols in your portfolio, then use Market Data or Market Metrics endpoints to fetch data for those symbols in bulk.
- **Sector screening:** Fetch public watchlists to get tastytrade's curated sector groupings, then run Market Metrics on those symbols to find high-IVR candidates.
- **Watchlist sync:** Use GET to retrieve all user watchlists, then PUT to update them programmatically (e.g., syncing from an external system).
- **Organized groups:** Use `group-name` to organize watchlists into categories (e.g., "Thematic ETFs", "Earnings This Week", "High IVR").

---

## Important Notes

- **User-scoped:** User watchlists are tied to the authenticated user, not a specific account.
- **Full replacement on PUT:** The update endpoint replaces the entire watchlist. To add a symbol, you must include all existing entries plus the new one.
- **Watchlist name as identifier:** Watchlist names serve as the unique identifier in the URL path. Choose descriptive, URL-safe names.
- **Public watchlists are read-only:** You can only read tastytrade's public watchlists, not modify them.
