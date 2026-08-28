# Instruments

The Instruments API provides endpoints for looking up detailed instrument definitions across all asset classes: equities, equity options, futures, futures options, cryptocurrency, and warrants. It also serves option chain data in multiple formats (full, compact, nested) for both equity and futures options.

**Base URL:** `https://api.tastyworks.com`
**Authentication:** Requires a valid session token passed via the `Authorization` header.
**API Version:** 0.0.1 (versioned as `20250715`)

---

## Endpoints — Equities

### Get Equity by Symbol

Returns a single equity instrument definition.

```
GET /instruments/equities/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The equity ticker symbol (e.g., `AAPL`, `SPY`) |

**Response** — `200 OK`: Returns an `Equity` object.

---

### Get Active Equities

Returns all active equity instruments in a paginated fashion.

```
GET /instruments/equities/active
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `page-offset` | query | integer | No | Pagination offset (0-indexed) |
| `per-page` | query | integer | No | Number of results per page |
| `lendability` | query | string | No | Filter by lendability status. Values: `Easy To Borrow`, `Locate Required`, `Preborrow` |

**Response** — `200 OK`: Returns an array of `Equity` objects.

---

## Endpoints — Equity Options

### Get Equity Option by Symbol

Returns a single equity option instrument definition.

```
GET /instruments/equity-options/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The OCC option symbol (e.g., `AAPL  260417C00200000`) |
| `active` | query | boolean | No | Filter to active options only |

**Response** — `200 OK`: Returns an `EquityOption` object.

---

### Get Equity Option Chain (Full)

Returns the full option chain for an underlying equity symbol.

```
GET /option-chains/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The underlying equity symbol (e.g., `AAPL`) |

**Response** — `200 OK`: Returns an array of `EquityOption` objects across all expirations and strikes.

---

### Get Equity Option Chain (Compact)

Returns the option chain in a compact form to minimize response size. Symbols and streamer symbols are returned as delimited strings rather than full objects.

```
GET /option-chains/{symbol}/compact
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The underlying equity symbol (e.g., `AAPL`) |

**Response** — `200 OK`: Returns an array of `CompactOptionChainSerializer` objects.

---

### Get Equity Option Chain (Nested)

Returns the option chain in a nested structure organized by expiration date, then by strike price. Minimizes redundant data by grouping shared attributes at the expiration level.

```
GET /option-chains/{symbol}/nested
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The underlying equity symbol (e.g., `AAPL`) |

**Response** — `200 OK`: Returns an array of `NestedOptionChainSerializer` objects.

---

## Endpoints — Futures

### Get Futures by Symbol(s)

Returns one or more outright futures definitions. Can be filtered by symbol, product code, exchange, or security ID.

```
GET /instruments/futures
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | query | array | No | One or more futures symbols (e.g., `/ESM6`) |
| `product-code` | query | array | No | One or more futures product codes (e.g., `ES`, `NQ`, `CL`) |
| `exchange` | query | string | No | Filter by exchange |
| `security-id` | query | array | No | Filter by security ID(s) |
| `only-active-futures` | query | boolean | No | If true, return only active (tradeable) contracts |
| `page-offset` | query | integer | No | Pagination offset |
| `per-page` | query | integer | No | Results per page |

**Response** — `200 OK`: Returns an array of `Future` objects.

---

### Get Single Future by Symbol

Returns a single outright future definition.

```
GET /instruments/futures/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The futures symbol (e.g., `/ESM6`) |

**Response** — `200 OK`: Returns a `Future` object.

---

### Get Future Products

Returns metadata for all supported futures products (product-level definitions, not individual contracts).

```
GET /instruments/future-products
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `page-offset` | query | integer | No | Pagination offset |
| `per-page` | query | integer | No | Results per page |

**Response** — `200 OK`: Returns an array of `FutureProduct` objects.

---

### Get Future Product by Exchange and Code

Returns a specific futures product definition.

```
GET /instruments/future-products/{exchange}/{code}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `exchange` | path | string | Yes | The exchange. Values: `CME`, `CFE`, `CBOED`, `SMALLS` |
| `code` | path | string | Yes | The product code (e.g., `ES`, `NQ`, `CL`, `GC`) |

**Response** — `200 OK`: Returns a `FutureProduct` object.

---

## Endpoints — Futures Options

### Get Future Option by Symbol

Returns a single futures option definition.

```
GET /instruments/future-options/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The tastytrade futures option symbol (e.g., `./ESZ9 EW4U9 190927P2975`) |

**Response** — `200 OK`: Returns a `FutureOption` object.

---

### Get Futures Option Chain (Full)

Returns the full futures option chain for a futures product code.

```
GET /futures-option-chains/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The futures product code (e.g., `ES`, not the individual contract symbol) |

**Response** — `200 OK`: Returns the futures option chain.

---

### Get Futures Option Chain (Nested)

Returns the futures option chain in nested form, organized by underlying future and expiration.

```
GET /futures-option-chains/{symbol}/nested
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The futures product code (e.g., `ES`) |

**Response** — `200 OK`: Returns a `FuturesNestedOptionChainSerializer` object containing the futures and their option chains.

---

### Get Future Option Products

Returns metadata for all supported futures option products.

```
GET /instruments/future-option-products
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `page-offset` | query | integer | No | Pagination offset |
| `per-page` | query | integer | No | Results per page |

**Response** — `200 OK`: Returns an array of `FutureOptionProduct` objects.

---

### Get Future Option Product by Root Symbol

```
GET /instruments/future-option-products/{root_symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `root_symbol` | path | string | Yes | The futures option root symbol (e.g., `EW`) |

**Response** — `200 OK`: Returns a `FutureOptionProduct` object.

---

### Get Future Option Product by Exchange and Root Symbol

```
GET /instruments/future-option-products/{exchange}/{root_symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `exchange` | path | string | Yes | The exchange (e.g., `CME`, `CFE`) |
| `root_symbol` | path | string | Yes | The futures option root symbol |

**Response** — `200 OK`: Returns a `FutureOptionProduct` object.

---

## Endpoints — Cryptocurrency

### Get Cryptocurrencies

Retrieve one or more cryptocurrency instrument definitions.

```
GET /instruments/cryptocurrencies
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | query | string | No | One or more cryptocurrency symbols to filter by (e.g., `BTC/USD`) |

**Response** — `200 OK`: Returns an array of `Cryptocurrency` objects.

---

### Get Cryptocurrency by Symbol

Retrieve a single cryptocurrency definition.

```
GET /instruments/cryptocurrencies/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The cryptocurrency symbol (e.g., `BTC/USD`) |

**Response** — `200 OK`: Returns a `Cryptocurrency` object.

---

## Endpoints — Warrants

### Get Warrants

Returns warrant definitions, optionally filtered by symbol.

```
GET /instruments/warrants
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | query | string | No | Filter by warrant symbol(s) |

**Response** — `200 OK`: Returns an array of `Warrant` objects.

---

### Get Warrant by Symbol

Returns a single warrant definition.

```
GET /instruments/warrants/{symbol}
```

| Parameter | In | Type | Required | Description |
|-----------|----|------|----------|-------------|
| `symbol` | path | string | Yes | The warrant symbol (e.g., `RGTIW`) |

**Response** — `200 OK`: Returns a `Warrant` object.

---

## Endpoints — Utility

### Get Quantity Decimal Precisions

Returns the quantity decimal precision rules for all instrument types. Use this to determine the minimum order quantity increment for each instrument.

```
GET /instruments/quantity-decimal-precisions
```

**Parameters:** None.

**Response** — `200 OK`: Returns an array of `QuantityDecimalPrecision` objects.

---

## Data Models

### Equity

Describes an equity (stock/ETF) instrument.

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The ticker symbol (e.g., `AAPL`) |
| `instrument-type` | string | Always `Equity` for stocks/ETFs |
| `instrument-sub-type` | string | Sub-type classification (e.g., `Common Stock`, `ADR`) |
| `description` | string | Full name/description of the equity (e.g., `Apple Inc.`) |
| `short-description` | string | Abbreviated description |
| `active` | boolean | Whether the instrument is currently active and tradeable |
| `is-closing-only` | boolean | Whether trading is restricted to closing transactions only |
| `is-options-closing-only` | boolean | Whether options on this equity are restricted to closing only |
| `is-etf` | boolean | Whether the instrument is an ETF |
| `is-index` | boolean | Whether the instrument is an index |
| `is-fractional-quantity-eligible` | boolean | Whether fractional share orders are supported |
| `is-illiquid` | boolean | Whether the instrument is classified as illiquid |
| `listed-market` | string | The exchange where the equity is listed |
| `streamer-symbol` | string | The symbol to use for DXLink streaming market data |
| `lendability` | string | Short-selling availability: `Easy To Borrow`, `Locate Required`, or `Preborrow` |
| `borrow-rate` | number (double) | The current borrow rate for short selling |
| `halted-at` | datetime | Timestamp when trading was halted (null if not halted) |
| `stops-trading-at` | datetime | Timestamp when the instrument stops trading |
| `market-time-instrument-collection` | string | The market time collection this instrument belongs to |
| `country-of-incorporation` | string | Country where the company is incorporated |
| `country-of-taxation` | string | Country of taxation |
| `underlying-product-type` | string | The underlying product type classification |
| `overnight-trading-permitted` | boolean | Whether overnight/extended-hours trading is permitted |
| `bypass-manual-review` | boolean | Whether orders can bypass manual review |
| `tick-sizes` | object | Tick size rules for the equity |
| `option-tick-sizes` | object | Tick size rules for options on this equity |

---

### EquityOption

Describes a single equity option contract.

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The OCC option symbol (e.g., `AAPL  260417C00200000`). Format: 6-char left-padded underlying + YYMMDD expiration + C/P + 8-digit strike (price × 1000) |
| `instrument-type` | string | Always `Equity Option` |
| `underlying-symbol` | string | The underlying equity symbol |
| `root-symbol` | string | The option root symbol (usually same as underlying, but differs for adjusted options like SPXW) |
| `option-type` | string | `C` for call, `P` for put |
| `strike-price` | number (double) | The strike price of the option |
| `expiration-date` | date | The expiration date of the option contract |
| `expiration-type` | string | The expiration type (e.g., `Regular`, `Weekly`, `Quarterly`, `End of Month`) |
| `expires-at` | datetime | The exact expiration timestamp |
| `exercise-style` | string | `American` or `European` |
| `settlement-type` | string | `Physical` (stock delivery) or `Cash` (cash-settled, e.g., index options) |
| `option-chain-type` | string | The option chain type classification |
| `shares-per-contract` | integer | Number of shares per contract (typically `100`, but can vary for adjusted options) |
| `days-to-expiration` | integer | Number of days until expiration |
| `active` | boolean | Whether the option contract is active |
| `is-closing-only` | boolean | Whether trading is restricted to closing only |
| `listed-market` | string | The exchange where the option is listed |
| `streamer-symbol` | string | The DXLink streaming symbol |
| `halted-at` | datetime | Timestamp when trading was halted |
| `stops-trading-at` | datetime | Timestamp when the option stops trading |
| `market-time-instrument-collection` | string | Market time collection |
| `old-security-number` | string | Legacy security number identifier |

---

### Future

Describes a single futures contract.

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The futures symbol (e.g., `/ESM6`, `/NQU6`). Uses tastytrade symbology with `/` prefix |
| `product-code` | string | The product code (e.g., `ES`, `NQ`, `CL`, `GC`) |
| `product-group` | string | The product group classification |
| `exchange` | string | The exchange (e.g., `CME`, `CFE`) |
| `streamer-symbol` | string | The DXLink streaming symbol |
| `streamer-exchange-code` | string | The exchange code used in the DXLink streamer |
| `active` | boolean | Whether the contract is currently active |
| `active-month` | boolean | Whether this is the active (front-month) contract |
| `next-active-month` | boolean | Whether this is the next active month contract |
| `is-closing-only` | boolean | Whether trading is restricted to closing only |
| `is-tradeable` | boolean | Whether the contract can be traded |
| `expiration-date` | date | The contract expiration date |
| `expires-at` | datetime | The exact expiration timestamp |
| `last-trade-date` | date | The last date the contract can be traded |
| `first-notice-date` | date | The first notice date for physical delivery contracts |
| `closing-only-date` | date | The date when the contract becomes closing-only |
| `stops-trading-at` | datetime | Timestamp when the contract stops trading |
| `contract-size` | number (double) | The contract size |
| `notional-multiplier` | number (double) | The notional multiplier (used to calculate notional value) |
| `tick-size` | number (double) | The minimum price increment |
| `display-factor` | number (double) | Factor for converting internal prices to display prices |
| `main-fraction` | number (double) | Main fraction for price display (used in fractional pricing like bonds/treasuries) |
| `sub-fraction` | number (double) | Sub-fraction for price display |
| `security-id` | string | The security identifier |
| `true-underlying-symbol` | string | The true underlying symbol for the futures contract |
| `roll-target-symbol` | string | The symbol of the next contract for roll purposes |
| `back-month-first-calendar-symbol` | boolean | Whether this is the first calendar symbol for back months |
| `future-product` | object | Nested `FutureProduct` object with product-level metadata |
| `future-etf-equivalent` | object | ETF equivalent information (if applicable) |
| `tick-sizes` | object | Detailed tick size rules |
| `option-tick-sizes` | object | Tick size rules for options on this future |
| `spread-tick-sizes` | object | Tick size rules for spread orders |

---

### FutureProduct

Describes a futures product family (not an individual contract, but the product definition).

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | The product code (e.g., `ES`, `NQ`, `CL`) |
| `root-symbol` | string | The root symbol for the product |
| `exchange` | string | The exchange (e.g., `CME`, `CFE`) |
| `description` | string | Product description (e.g., `E-mini S&P 500`) |
| `underlying-description` | string | Description of the underlying |
| `underlying-identifier` | string | Identifier for the underlying |
| `true-underlying-code` | string | The true underlying product code |
| `product-type` | string | The product type classification |
| `product-subtype` | string | The product sub-type |
| `market-sector` | string | The market sector (e.g., `Equity`, `Energy`, `Metals`) |
| `listed-months` | string | The months in which contracts are listed (e.g., `HMUZ` for March, June, September, December) |
| `active-months` | string | The currently active contract months |
| `notional-multiplier` | number (double) | The dollar multiplier per point move |
| `tick-size` | number (double) | The minimum price increment |
| `display-factor` | number (double) | Factor for display price conversion |
| `streamer-exchange-code` | string | Exchange code for the DXLink streamer |
| `small-notional` | boolean | Whether this is a small-notional (micro) product |
| `base-tick` | integer | The base tick value |
| `sub-tick` | integer | The sub-tick value |
| `price-format` | string | The price format notation |
| `security-group` | string | The security group |
| `contract-limit` | integer | Maximum number of contracts that can be held |
| `cash-settled` | boolean | Whether the product is cash-settled |
| `first-notice` | boolean | Whether the product has a first-notice date |
| `supported` | boolean | Whether the product is supported for trading on tastytrade |
| `back-month-first-calendar-symbol` | boolean | First calendar symbol for back months |

---

### FutureOption

Describes a single futures option contract.

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The tastytrade futures option symbol (e.g., `./ESZ9 EW4U9 190927P2975`) |
| `underlying-symbol` | string | The underlying futures contract symbol |
| `product-code` | string | The futures product code |
| `root-symbol` | string | The option root symbol |
| `option-root-symbol` | string | The option root symbol for the futures option series |
| `option-type` | string | `C` for call, `P` for put |
| `strike-price` | number (double) | The strike price |
| `strike-factor` | number (double) | Factor applied to the strike price |
| `expiration-date` | date | The expiration date |
| `expires-at` | datetime | The exact expiration timestamp |
| `days-to-expiration` | integer | Days until expiration |
| `exercise-style` | string | `American` or `European` |
| `settlement-type` | string | `Physical` or `Cash` |
| `exchange` | string | The exchange |
| `streamer-symbol` | string | The DXLink streaming symbol |
| `multiplier` | number (double) | The contract multiplier |
| `display-factor` | number (double) | Factor for display price conversion |
| `notional-value` | number (double) | The notional value of the contract |
| `future-price-ratio` | number (double) | Ratio between the option and underlying future price |
| `underlying-count` | number (double) | Number of underlying contracts per option |
| `active` | boolean | Whether the contract is active |
| `is-closing-only` | boolean | Whether restricted to closing only |
| `is-confirmed` | boolean | Whether the contract terms are confirmed |
| `is-exercisable-weekly` | boolean | Whether the option is exercisable weekly |
| `is-primary-deliverable` | boolean | Whether this is the primary deliverable |
| `is-vanilla` | boolean | Whether this is a vanilla (standard) option |
| `last-trade-time` | string | The last time the contract can be traded |
| `stops-trading-at` | datetime | Timestamp when the option stops trading |
| `maturity-date` | date | The maturity date |
| `security-id` | string | The security identifier |
| `future-option-product` | object | Nested `FutureOptionProduct` metadata |

---

### FutureOptionProduct

Describes a futures option product family.

| Field | Type | Description |
|-------|------|-------------|
| `root-symbol` | string | The root symbol for the futures option product |
| `code` | string | The product code |
| `exchange` | string | The exchange |
| `product-type` | string | The product type |
| `product-subtype` | string | The product sub-type |
| `market-sector` | string | The market sector |
| `expiration-type` | string | The expiration type |
| `settlement-delay-days` | integer | Number of days between expiration and settlement |
| `display-factor` | number (double) | Display factor for price conversion |
| `cash-settled` | boolean | Whether the product is cash-settled |
| `is-am-settled` | boolean | Whether settlement occurs at the AM opening price |
| `itm-rule` | string | The in-the-money exercise rule |
| `supported` | boolean | Whether the product is supported on tastytrade |

---

### Cryptocurrency

Describes a cryptocurrency instrument.

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Internal identifier |
| `symbol` | string | The crypto trading pair (e.g., `BTC/USD`, `ETH/USD`) |
| `instrument-type` | string | Always `Cryptocurrency` |
| `description` | string | Full name (e.g., `Bitcoin`) |
| `short-description` | string | Abbreviated description |
| `active` | boolean | Whether the instrument is active |
| `is-closing-only` | boolean | Whether restricted to closing only |
| `streamer-symbol` | string | The DXLink streaming symbol |
| `tick-size` | number (double) | The minimum price increment |

---

### Warrant

Describes a warrant instrument.

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | The warrant symbol (e.g., `RGTIW`) |
| `instrument-type` | string | Always `Warrant` |
| `description` | string | Description of the warrant |
| `cusip` | string | The CUSIP identifier |
| `listed-market` | string | The exchange where the warrant is listed |
| `active` | boolean | Whether the warrant is active |
| `is-closing-only` | boolean | Whether restricted to closing only |

---

### QuantityDecimalPrecision

Defines the minimum order quantity precision for an instrument type.

| Field | Type | Description |
|-------|------|-------------|
| `instrument-type` | string | The instrument type this rule applies to |
| `symbol` | string | The specific symbol (if the rule is symbol-specific) |
| `value` | integer | The number of decimal places allowed in order quantities |
| `minimum-increment-precision` | integer | The minimum increment precision for quantities |

---

### Option Chain Serializers

#### CompactOptionChainSerializer

A compact representation of an option chain, minimizing response size.

| Field | Type | Description |
|-------|------|-------------|
| `underlying-symbol` | string | The underlying equity symbol |
| `root-symbol` | string | The option root symbol |
| `option-chain-type` | string | The chain type |
| `settlement-type` | string | `Physical` or `Cash` |
| `shares-per-contract` | integer | Shares per contract |
| `expiration-type` | string | The expiration type |
| `deliverables` | object | Deliverable details |
| `symbols` | string | Delimited string of all option symbols in the chain |
| `streamer-symbols` | string | Delimited string of all DXLink streamer symbols |

#### NestedOptionChainSerializer

A nested representation organized by expiration date, then strike.

| Field | Type | Description |
|-------|------|-------------|
| `underlying-symbol` | string | The underlying equity symbol |
| `root-symbol` | string | The option root symbol |
| `option-chain-type` | string | The chain type |
| `shares-per-contract` | integer | Shares per contract |
| `tick-sizes` | object | Tick size rules |
| `deliverables` | object | Deliverable details |
| `expirations` | object | Nested object keyed by expiration date, each containing strikes with call/put option details |

#### FuturesNestedOptionChainSerializer

A nested representation for futures option chains.

| Field | Type | Description |
|-------|------|-------------|
| `futures` | object | The underlying futures contracts |
| `option-chains` | object | Option chains nested by underlying future and expiration |

---

## tastytrade Symbology Reference

Different instrument types use different symbol formats:

| Instrument Type | Symbol Format | Example |
|----------------|---------------|---------|
| Equity | Ticker symbol | `AAPL`, `SPY` |
| Equity Option | OCC format: `SYMBOL  YYMMDDCSSSSSSSS` (6-char padded symbol + date + C/P + 8-digit strike×1000) | `AAPL  260417C00200000` |
| Future | `/` prefix + product code + month code + year digit | `/ESM6` |
| Future Option | `./` prefix + underlying future + space + option root + expiration + C/P + strike | `./ESZ9 EW4U9 190927P2975` |
| Cryptocurrency | Trading pair with `/` separator | `BTC/USD` |
| Warrant | Ticker symbol (typically ending in `W`) | `RGTIW` |

**Futures month codes:** F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec

---

## Common Use Cases

- **Building an order ticket:** Look up the equity via `GET /instruments/equities/{symbol}` to verify it's active and check `is-fractional-quantity-eligible`, then fetch the option chain via `GET /option-chains/{symbol}/nested` to populate expiration and strike selectors.
- **Options chain display:** Use the `/nested` endpoint for UI rendering (grouped by expiration) or `/compact` for bandwidth-efficient retrieval. Use the full `/option-chains/{symbol}` endpoint when you need complete `EquityOption` objects for each contract.
- **Futures product discovery:** Call `GET /instruments/future-products` to list all available futures products, then `GET /instruments/futures?product-code=ES&only-active-futures=true` to get tradeable contracts for a specific product.
- **Symbol resolution:** When a position returns an OCC symbol like `AAPL  260417C00200000`, use `GET /instruments/equity-options/{symbol}` to get the full contract details including strike, expiration, and greeks availability.
- **Quantity precision:** Before submitting an order, call `GET /instruments/quantity-decimal-precisions` to verify the minimum increment for the instrument type (critical for cryptocurrency and fractional equity orders).
- **Short selling availability:** Use `GET /instruments/equities/{symbol}` and check the `lendability` field to determine if a stock can be sold short.
