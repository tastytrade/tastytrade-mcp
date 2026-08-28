# Accounts and Customers

The Accounts and Customers API provides endpoints for retrieving customer profile information, associated account details, and API quote streamer tokens. This is typically the first set of endpoints called after authentication to discover which accounts a customer has and to obtain credentials for streaming market data.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 9.25.0

**Note:** For all customer endpoints, you can use the literal string `me` in place of the `customer_id` path parameter to reference the currently authenticated customer. This avoids the need to know or store the internal customer identifier.

---

## Endpoints

### Get API Quote Tokens

Returns the DXLink streaming endpoint URL and authentication token needed to connect to the real-time market data WebSocket streamer.

**Request**

```
GET /api-quote-tokens
```

**Parameters:** None (uses the authenticated session to determine the customer's market data entitlements).

**Response** — `200 OK`

Returns a `QuoteStreamerTokenAuthResult` object.

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | The authentication token to pass when connecting to the DXLink streamer |
| `dxlink-url` | string | The DXLink WebSocket URL to connect to for streaming market data |
| `websocket-url` | string | Alternative WebSocket URL for the streaming connection |
| `level` | string | The market data entitlement level for this customer (determines data depth and speed) |
| `issued-at` | datetime | Timestamp when the token was issued |
| `expires-at` | datetime | Timestamp when the token expires (tokens must be refreshed before expiry) |

**Example Response**

```json
{
  "data": {
    "token": "dGVzdF90b2tlbl9leGFtcGxl...",
    "dxlink-url": "wss://tasty-live-web.dxfeed.com/live/cometd",
    "websocket-url": "wss://tasty-live-web.dxfeed.com/live/cometd",
    "level": "live",
    "issued-at": "2026-04-09T12:00:00.000+00:00",
    "expires-at": "2026-04-09T13:00:00.000+00:00"
  }
}
```

---

### Get Customer

Retrieve the full profile for a customer.

**Request**

```
GET /customers/{customer_id}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `customer_id` | string | Yes | The customer identifier, or `me` for the currently authenticated customer |

**Query Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `allow-missing` | boolean | No | If true, returns a partial result even if some customer data is unavailable |

**Response** — `200 OK`

Returns a `Customer` object (see schema below).

---

### Get Customer Accounts

Retrieve all accounts associated with a customer, including the authority level the customer has on each account.

**Request**

```
GET /customers/{customer_id}/accounts
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `customer_id` | string | Yes | The customer identifier, or `me` for the currently authenticated customer |

**Response** — `200 OK`

Returns an array of `AccountAuthorityDecorator` objects, each containing an `Account` object and the customer's authority level on that account.

**Example Response**

```json
{
  "data": {
    "items": [
      {
        "account": {
          "account-number": "5WX34382",
          "account-type-name": "Individual",
          "margin-or-cash": "Margin",
          "is-closed": false,
          "is-futures-approved": true,
          "day-trader-status": "false",
          "opened-at": "2023-06-15T00:00:00.000+00:00",
          "nickname": "Main Trading",
          "investment-objective": "GROWTH",
          "risk-tolerance": "HIGH"
        },
        "authority-level": "owner"
      },
      {
        "account": {
          "account-number": "5WZ29543",
          "account-type-name": "Individual",
          "margin-or-cash": "Cash",
          "is-closed": false,
          "is-futures-approved": false,
          "day-trader-status": "false",
          "opened-at": "2024-01-10T00:00:00.000+00:00",
          "nickname": "Cash Account"
        },
        "authority-level": "owner"
      }
    ]
  }
}
```

---

### Get Specific Account

Retrieve full details for a specific account under a customer.

**Request**

```
GET /customers/{customer_id}/accounts/{account_number}
```

**Path Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `customer_id` | string | Yes | The customer identifier, or `me` for the currently authenticated customer |
| `account_number` | string | Yes | The tastytrade account number |

**Response** — `200 OK`

Returns a single `Account` object.

---

## Data Models

### AccountAuthorityDecorator

Wraps an `Account` object with the customer's authority level on that account.

| Field | Type | Description |
|-------|------|-------------|
| `account` | Account | The full account object (see below) |
| `authority-level` | string | The customer's authority on this account (e.g., `owner`, `power-of-attorney`, `custodian`) |

### Account

Describes a tastytrade brokerage account and its configuration.

#### Core Identification

| Field | Type | Description |
|-------|------|-------------|
| `account-number` | string | The tastytrade account number (e.g., `5WX34382`) |
| `account-type-name` | string | The account type (e.g., `Individual`, `Joint`, `IRA`, `Entity`) |
| `nickname` | string | User-assigned nickname for the account |
| `external-id` | string | External identifier for the account |
| `ext-account-id` | string | External account identifier used in partner integrations |
| `ext-crm-id` | string | External CRM identifier |
| `external-fdid` | string | External FDID (Financial Data Identifier) |
| `submitting-user-id` | string | The user ID that submitted the account application |

#### Account Status

| Field | Type | Description |
|-------|------|-------------|
| `margin-or-cash` | string | Whether the account is a `Margin` or `Cash` account |
| `is-closed` | boolean | Whether the account has been closed |
| `closed-at` | datetime | Timestamp when the account was closed (null if open) |
| `created-at` | datetime | Timestamp when the account record was created |
| `opened-at` | datetime | Timestamp when the account was opened |
| `funding-date` | date | The date the account was first funded |
| `is-firm-error` | boolean | Whether the account is a firm error account |
| `is-firm-proprietary` | boolean | Whether the account is a firm proprietary account |
| `is-foreign` | string | Whether the account belongs to a foreign (non-US) customer |
| `regulatory-domain` | string | The regulatory domain for the account (e.g., US) |

#### Trading Configuration

| Field | Type | Description |
|-------|------|-------------|
| `day-trader-status` | string | The account's day trader status designation |
| `is-futures-approved` | boolean | Whether the account is approved for futures trading |
| `futures-account-purpose` | string | The stated purpose for the futures account (if futures-approved) |
| `suitable-options-level` | string | The options level the account is suitable for based on suitability responses |

#### Suitability & Investment Profile

| Field | Type | Description |
|-------|------|-------------|
| `investment-objective` | string | The customer's stated investment objective (e.g., `GROWTH`, `INCOME`, `SPECULATION`) |
| `investment-time-horizon` | string | The customer's investment time horizon (e.g., `SHORT_TERM`, `AVERAGE`, `LONGEST`) |
| `liquidity-needs` | string | The customer's stated liquidity needs |
| `risk-tolerance` | string | The customer's stated risk tolerance (e.g., `LOW`, `MEDIUM`, `HIGH`) |

### Customer

The full customer profile. Contains personal information, contact details, regulatory status, and account application state.

#### Identity

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The internal customer identifier (use `me` in API paths instead of this value) |
| `first-name` | string | Customer's first name |
| `last-name` | string | Customer's last name |
| `middle-name` | string | Customer's middle name |
| `prefix-name` | string | Name prefix (e.g., Mr., Mrs., Dr.) |
| `suffix-name` | string | Name suffix (e.g., Jr., III) |
| `first-surname` | string | First surname (used in some regional naming conventions) |
| `second-surname` | string | Second surname (used in some regional naming conventions) |
| `gender` | string | Customer's gender |
| `birth-date` | string | Customer's date of birth |
| `birth-country` | string | Customer's country of birth |
| `user-id` | string | The customer's user ID for authentication |
| `external-id` | string | External identifier for the customer |

#### Contact Information

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Customer's email address |
| `home-phone-number` | string | Home phone number |
| `mobile-phone-number` | string | Mobile phone number |
| `work-phone-number` | string | Work phone number |
| `address` | object | Primary residential address |
| `mailing-address` | object | Mailing address (if different from residential) |

#### Citizenship & Tax

| Field | Type | Description |
|-------|------|-------------|
| `citizenship-country` | string | Customer's country of citizenship |
| `usa-citizenship-type` | string | Type of US citizenship (e.g., citizen, resident alien, non-resident alien) |
| `is-foreign` | string | Whether the customer is classified as a foreign person |
| `regulatory-domain` | string | The regulatory domain the customer falls under |
| `tax-number` | string | Tax identification number (SSN or ITIN for US customers) |
| `tax-number-type` | string | Type of tax number provided |
| `foreign-tax-number` | string | Foreign tax identification number (for non-US customers) |
| `subject-to-tax-withholding` | boolean | Whether the customer is subject to backup tax withholding |
| `visa-type` | string | Visa type (for non-citizen residents) |
| `visa-expiration-date` | string | Visa expiration date |

#### Affiliations & Disclosures

| Field | Type | Description |
|-------|------|-------------|
| `has-industry-affiliation` | boolean | Whether the customer has an affiliation with a FINRA member firm |
| `industry-affiliation-firm` | string | Name of the affiliated FINRA member firm |
| `has-listed-affiliation` | boolean | Whether the customer is affiliated with a publicly listed company |
| `listed-affiliation-symbol` | string | The ticker symbol of the affiliated listed company |
| `has-political-affiliation` | boolean | Whether the customer has a political affiliation requiring disclosure |
| `political-organization` | string | Name of the political organization |
| `has-institutional-assets` | string | Whether the customer has institutional-level assets |
| `is-investment-adviser` | string | Whether the customer is a registered investment adviser |
| `family-member-names` | string | Names of family members (for affiliated person disclosures) |

#### Account Application & Status

| Field | Type | Description |
|-------|------|-------------|
| `has-pending-or-approved-application` | string | Whether the customer has a pending or approved account application |
| `permitted-account-types` | string | Account types the customer is permitted to open |
| `is-professional` | boolean | Whether the customer is classified as a professional for market data purposes |
| `has-delayed-quotes` | boolean | Whether the customer receives delayed (rather than real-time) quotes |
| `created-at` | datetime | Timestamp when the customer record was created |

#### Agreements

| Field | Type | Description |
|-------|------|-------------|
| `agreed-to-margining` | boolean | Whether the customer has agreed to the margin agreement |
| `agreed-to-terms` | boolean | Whether the customer has agreed to the terms of service |
| `signature-of-agreement` | boolean | Whether the customer has signed the account agreement |

#### Related Objects

| Field | Type | Description |
|-------|------|-------------|
| `customer-suitability` | object | Nested suitability questionnaire responses |
| `entity` | object | Entity details (for entity/trust/corporate accounts) |
| `person` | object | Person details (additional personal information) |
| `identifiable-type` | string | The type of identifiable entity (e.g., `person`, `entity`) |
| `desk-customer-id` | string | Internal desk customer identifier |
| `ext-crm-id` | string | External CRM identifier |

---

## Common Use Cases

- **Session bootstrap:** After authentication, call `GET /customers/me/accounts` to discover all accounts the user has access to, then use those account numbers for all subsequent API calls.
- **Market data streaming setup:** Call `GET /api-quote-tokens` to obtain the DXLink WebSocket URL and token, then connect to the streamer for real-time quotes.
- **Account selection UI:** Use the `account-type-name`, `nickname`, `margin-or-cash`, and `authority-level` fields to display a user-friendly account selector.
- **Pre-trade checks:** Use `is-futures-approved` and `suitable-options-level` to determine which products an account can trade before presenting order entry options.
- **Professional data classification:** Check `is-professional` to determine market data billing tier and `has-delayed-quotes` to know if the user has real-time data.
