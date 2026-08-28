Submitting an Order
Generating the proper JSON to submit an order for the first time can seem like a daunting task. For some, the biggest challenge is understanding how to structure a JSON order. For others, the challenge may be learning the meaning of the various JSON order attributes.

This page is intended to clarify all the order attributes for you as well as explain the rules about how to structure a JSON order. This page only describes attributes for submitting an order. Other order attributes like status are populated after order submission and are not described here.

This pag also assumes you are familiar with what an order means in the tastytrade ecosystem. For a primer, you can head to the High-level Concepts: Orders section of our API Overview.

Example Order
To start, take a look at the example multi-leg equity option order below. This order has 2 legs: the first is a 197.5 call that we are buying and the second is a 200 call that we are selling. The strike price is found in the last 8 numeric characters of the symbol, where the first 5 digits are the whole number value (left of the decimal point) and the last 3 digits are the decimal value (right of the decimal point).

Looking at each leg's symbol, we can see that both options have an expiration date of 2023-08-18.

Both legs have "Open" in the action, meaning we are opening up new positions.

We have specified a limit price of $1.09 Debit, meaning we won't pay more than $1.09 for this order.

If you submitted this order and it filled, the result would be 2 new positions in your account: a long 2023-08-18 call option with a 197.5 strike and a short 2023-08-18 call option with a 200 strike.

Example Multi-leg Equity Option Order
{   // Order Attributes
    "time-in-force": "Day", // Order will expire when the market closes
    "order-type": "Limit", // Order includes a limit price
    "price": "1.09", // Don't pay more than $1.09 for this trade as a whole
    "price-effect": "Debit", // Account will be debited for this trade
    "legs": [
    {
        // Leg Attributes
        "action": "Buy to Open", // Opening a new long position
        "symbol": "AAPL  230818C00197500", // AAPL Call Option with 197.5 strike price, option expires 2023-08-18
        "quantity": 1, // 1 option contract
        "instrument-type": "Equity Option", // Equity Option instrument
    },
    {
        // Leg Attributes
        "action": "Sell to Open", // Opening a new short position
        "symbol": "AAPL  230818C00200000", // AAPL Call Option with 200 strike price, option expires 2023-08-18
        "quantity": 1, // 1 option contract
        "instrument-type": "Equity", // Equity Option instrument
    }
  ]
}
The above order JSON might seem complicated, so let's simplify it a little by breaking the order JSON into 2 parts:

The Order attributes
The Leg attributes
Order Attributes
Order attributes are any attributes that apply to the order as a whole. In short, they are any JSON attributes outside the objects in the legs array.

Refer to the table below for the JSON attributes of an order object. Each attribute is explained in further detail in the sections below.

Order Attribute	Required	Type	Meaning
gtc-date	Only if time-in-force is GTD	Date string (yyyy-mm-dd)	The date at which a GTD order expires
legs	Yes	Array of leg objects	Refer to the Leg Attributes section below
order-type	Yes	String	The type of order being submitted
price	Yes unless order-type is Notional Market	Decimal	The limit price of the order
price-effect	Yes unless order-type is Notional Market	String	The price's direction in relation to your account (Credit or Debit)
source	No	String	Designates where the order originated. Value can be any string you want.
stop-trigger	Only if order-type is Stop or Stop Limit	String	The trigger price of a Stop or Stop Market order
time-in-force	Yes	String	How long the order will live if not filled or rejected
value	Only if order-type is Notional Market	Decimal	The dollar amount of an instrument to buy or sell
value-effect	Only if order-type is Notional Market	String	The direction of the value in relation to your account (Credit or Debit)
advanced-instructions	No	Json	Detailed instructions about the order
Order Type
Order type typically affects how the the price/value of an order is defined.

Refer to the table below for each order type and its meaning. Each order type is described in detail in the sections below as well.

Order Type	Meaning
Limit	Order must have a price and price-effect included in the JSON.
Market	Order must not have price or price-effect included in the JSON.
Stop	A market order with a stop-trigger price in the JSON.
Stop Limit	A limit order with a stop-trigger price in the JSON.
Notional Market	An order to buy a dollar amount of something rather than a specific quantity
Limit

Limit orders must have a price and price-effect, which is the min/max price you're willing to accept.

Here are the rules for the JSON structure of a Limit order:

Must include a price and price-effect
Here's an example: If you are buying shares of stock and submit a limit order with a price of $5, you're effectively saying "I won't pay more than $5 per share for 100 shares of AAPL." In a dream world some nice person would sell you those shares for $5 per share. In the real world your order would go live and probably remain live until it expires or you cancel it.

Limit Order Example
{
    "time-in-force": "Day",
    "order-type": "Limit",
    "price": 5,
    "price-effect": "Debit"
    "legs": [
    {
        "instrument-type": "Equity",
        "symbol": "AAPL",
        "quantity": 100,
        "action": "Buy to Open"
    }
  ]
}
Market

Market orders don't have a price at all. By submitting a market order, you are basically saying "I want this order filled as quick as possible and I'll accept any price."

Here are the rules for the JSON structure of a Market order:

Orders must only have 1 leg
Must not include a price or price-effect
time-in-force must not be GTC
Opening market orders cannot be submitted while the market is closed.

Please see our help center article on market orders for the pros and cons of market orders.

Market Order Example
{
    "time-in-force": "Day",
    "order-type": "Market",
    "legs": [
    {
        "instrument-type": "Equity",
        "symbol": "AAPL",
        "quantity": 100,
        "action": "Buy to Open"
    }
  ]
}
Stop

Stop orders are market orders that are triggered when the quote hits a specific price, called a stop-trigger. When the quote hits the stop-trigger, the order becomes a market order.

Here are the rules for the JSON structure of a Stop order:

Must not include a price or price-effect
Must include a stop-trigger price
time-in-force must not be GTC for opening orders
"Stop" and "Stop Market" are the same concept, but only a value of Stop is allowed in the JSON.

Please refer to our help center article on stop orders for more information about this order type.

Closing Stop Market Order Example
{
    "time-in-force": "GTC",
    "order-type": "Stop",
    "stop-trigger": 105,
    "legs": [
    {
        "instrument-type": "Equity",
        "symbol": "AAPL",
        "quantity": 100,
        "action": "Sell to Close"
    }
  ]
}
Stop Limit

Stop limit orders are limit orders that are triggered when the quote hits a specific price, called a stop-trigger. When the quote hits the stop-trigger, the order becomes a limit order.

Here are the rules for the JSON structure of a Stop Limit order:

Must include a price and price-effect
Must include a stop-trigger price
Please refer to our help center article on stop orders for more information about this order type.

Stop Limit Order Example
{
    "time-in-force": "GTC",
    "order-type": "Stop",
    "stop-trigger": 110,
    "price": 115,
    "price-effect": "Debit"
    "legs": [
    {
        "instrument-type": "Equity",
        "symbol": "AAPL",
        "quantity": 100,
        "action": "Buy to Open"
    }
  ]
}
Notional Market

Notional Market means you are buying a dollar amount of an instrument. For example, instead of buying 1 share of AAPL, you could buy $10 of AAPL.

NOTE - Notional orders can only be used to trade fractional shares. Please submit an order below ask price, or route a non-notional order for full shares.

Here are the rules for the JSON structure of a Notional Market order:

order-type must be Notional Market
Orders must only have 1 leg
Order legs cannot have quantity
Order must include value and value-effect
Only cryptocurrency and eligible equity symbols are permitted
Opening Notional Market orders cannot be submitted while the market is closed.

Notional Market orders must only have a single leg and the leg must not include a quantity.

The order must include a value, which is the dollar amount you wish to buy/sell. Along with value, you must also include value-effect. Refer to the value section below for more info.

Notional market orders are allowed for cryptocurrencies and eligible equities. To determine if an equity is eligible, refer to the is-fractional-quantity-eligible field of the equity instrument's JSON representation. If the value is false, your order will be rejected. See the equities section below for info on fetching an equity instrument.

Below is an example order JSON of buying $10 of AAPL:

Notional Market Order Example
{
    "time-in-force": "Day",
    "order-type": "Notional Market",
    "value": 10,
    "value-effect": "Debit",
    "legs": [
    {
        "instrument-type": "Equity",
        "symbol": "AAPL",
        "action": "Buy to Open"
    }
  ]
}
The amount of shares you receive depends on the underlying price. If AAPL stock were at $100 right now and you submitted the above order for $10 worth of stock, you'd receive approximately 0.1 shares.

Price and Price Effect
Price only applies to Limit and Stop Limit orders. Submitting a Market, Stop, or Notional Market order with a price is invalid and the request will be rejected.

When you include a price, you must always include a price-effect as well. Think of price effect as the direction the money is flowing in relation to your account. Debit means you are paying money. Credit means you are receiving money. In the example below, we are receiving $175.25 (Credit) to short sell 100 shares of AAPL stock.

Price effect is correlated to leg.action. If you are buying stock, your leg.action will be Buy to Open or Buy to Close. When buying, the price effect must be a Debit. Your order will be rejected if you try to buy for a credit. Same applies for selling. You can't sell something for a Debit.

Debit Limit Order Example
{
    "time-in-force": "Day",
    "order-type": "Limit",
    "price": 175.25,
    "price-effect": "Credit",
    "legs": [
    {
        "instrument-type": "Equity",
        "quantity": 100,
        "symbol": "AAPL",
        "action": "Sell to Open"
    }
  ]
}
Price Effect	Meaning
Credit	Price will be credited to the customer's account
Debit	Price will be debited from the customer's account
Time In Force
Time in force means "How long do I want this order to live before it expires?" Refer to the Market Sessions by Instrument Type section to see the hours for each session.

Time In Force	Meaning
Day	Works during regular market hours only. Expires at market close (3:00pm CT for equities, 4:00pm CT for futures).
GTC	Works during regular market hours and remains active until filled or manually canceled.
GTD	Works during regular market hours until filled or specified date. Requires gtc-date parameter.
Ext	Works during extended hours session (equities only: 6:00am - 7:00pm CT). Expires at 7:00pm CT.
GTC Ext	Works during extended hours session and remains active until filled or canceled.
Ext Overnight	Works during 24-hour session (equities only: 7:00pm - 7:00pm CT). Expires at 7:00pm CT.
GTC Ext Overnight	Works during 24-hour session and remains active until filled or canceled.
Day

Day orders (like the one above) will live until either the order fills or the market closes. If a day order does not get filled by the time the market closes, it transitions to expired.

GTC

Good 'til Canceled orders never expire. They will work until they are either filled or the customer cancels them.

GTD

Good 'til Date orders expire on a given date. If you submit a GTD order, you must also include a gtc-date in the JSON (Yes, calling it gtd-date would have made more sense - we apologize).

Please refer to our help center article about time in force for more information.

Ext

Extended hours orders expire at the end of the extended session. You may only submit single leg equity orders with this time in force.

GTC Ext

GTC Extended hours orders do not expire. They are active only during the extended session. You may only submit single leg equity orders with this time in force.

Ext Overnight

These orders are active during the 24-hour session (7pm-7pm CT). Expiration occurs every day at 7pm CT. If you submit an Ext Overnight order at noon, it will expire at 7pm the same day. If you submit an Ext Overnight order at 8:00pm CT, it will expire tomorrow at 7:00pm CT.

Markets are closed the night before a full holiday. For example, July 4th is a full day holiday. Markets will be closed starting July 3rd at 7:00pm CT. They will open up again July 4th at 7:00pm CT.

You may only submit single leg equity orders with this time in force.

GTC Ext Overnight

These orders are always active as long as the 24-hour session is open. They work until they are filled or until the user cancels the order.

You may only submit single leg equity orders with this time in force.

Market Sessions by Instrument Type
Equities and Equity Options
Regular: 8:30am-3:00pm CT
Extended: 6:00am-7:00pm CT
** 24-Hour**: 7:00pm-7:00pm CT. Session starts the night before a regular session. First session of the week starts 7:00pm CT Sunday night. Overnight market is closed the night before market holiday.
Futures
Regular: 5:00pm-4:00pm CT
Cryptocurrencies
Regular: 24/7 (continuous trading)
Value and Value Effect
This field only applies to Notional Market orders. It denotes the dollar amount you wish to buy/sell.

value must be accompanied by value-effect, which is identical to price-effect but only applies to Notional Market orders.

Including a price and a value is invalid and the request will be rejected.

Value Effect	Meaning
Credit	Value will be credited to the customer's account
Debit	Value will be debited from the customer's account
Leg Attributes
Leg attributes are specific to their order leg. Each order leg represents an actual instrument (like a stock or an option) with a quantity and a side (action).

All orders must have a minimum of 1 leg.

The maximum number of legs an order can have depends on the instrument type:

Equity, Futures, and Cryptocurrency orders are limited to 1 leg.

Equity Option and Future Option orders can have up to 4 legs.

Refer to the table below for the JSON attributes of a leg object. Each attribute is explained in further detail in the sections below.

Leg Attribute	Required	Type	Meaning
action	Yes	String	The side you are taking in relation to your positions
instrument-type	Yes	String	The class of the instrument being traded
quantity	Yes unless order-type is Notional Market	Decimal	The amount being bought or sold
symbol	Yes	String	The symbol representing the instrument being traded
Action
This is the "side" you are taking (buy or sell) combined with an "opening" or "closing" designation.

Action	Meaning
Buy to Open	Open a long position by buying the instrument. You must not have an existing short position in that instrument.
Sell to Open	Open a short position by selling the instrument. You must not have an existing long position in that instrument.
Buy to Close	Close a short position by buying the instrument. You must have an existing short position in that instrument.
Sell to Close	Close a long position by selling the instrument. You must have an existing long position in that instrument.
Buy	Only applies to single leg outright futures trades. This action allows you to buy an outright future regardless of your position. If you are short an outright, this will result in closing your position.
Sell	Only applies to single leg outright futures trades. This action allows you to sell an outright future regardless of your position. If you are long an outright, this will result in closing your position.
If you don't own any shares of AAPL and want to buy 100 shares, the action would be Buy to Open with a quantity of 100.

If you don't own any shares of AAPL and want to sell short 100 shares, the action would be Sell to Open with a quantity of 100.

If you own 100 shares of AAPL and want to close 10 shares, the action would be Sell to Close with a quantity of 10.

If you own 100 shares of AAPL and want to buy 100 more shares, the action would be Buy to Open with a quantity of 100.

Buy to Open and Sell to Open are opening actions, meaning they result in a new position being added to your account.

Buy to Close and Sell to Close are closing actions, meaning they result in an existing position's quantity decreasing.

You may send Buy or Sell for single leg outright futures trades if you wish. tastytrade's system will convert it to the appropriate action for you. Sending a Sell order when you are long an outright future contract will close your position. Sending a Sell order when you have no position will result in a new short position. Same logic applies for the Buy action with outright futures orders. You may still send the full action when trading futures if you wish to specify opening vs closing. See Advanced Instructions below for more info.

Advanced Instructions
You should only submit closing orders against existing positions. For convenience, tastytrade will correct the Open/Close for you when you submit a closing order but don't have a corresponding position. For example, if you submit a Buy to Close order for AAPL but you don't have an AAPL position to close, tastytrade will route the order as Buy to Open. Likewise submitting a Sell to Close order when you don't have a position to close will result in a Sell to Open order being routed.

If you wish to block this behavior, you should submit your order with advanced-instructions specifying that you want strict-position-effect-validation: true. For example:

Advanced Instructions Example
{
    "time-in-force": "Day",
    "order-type": "Limit",
    "price": 175.25,
    "price-effect": "Credit",
    "advanced-instructions": {
      "strict-position-effect-validation": true
    },
    "legs": [
    {
        "instrument-type": "Equity",
        "quantity": 100,
        "symbol": "META",
        "action": "Sell to Close"
    }
  ]
}
With strict-position-effect-validation, the order will be rejected if you don't have an existing position to close.

Instrument Type
Valid instrument types are:

Cryptocurrency
Equity
Equity Option
Future
Future Option
Quantity
This denotes how much you want to buy or sell. For cryptocurrency orders, the quantity can have a decimal value. For equities, equity options, futures, and future options, the quantity must be a whole number (integer).

Here are the rules for including quantity in the order leg JSON:

Must be a positive number
Can have a decimal value for cryptocurrencies, otherwise must be a whole number (integer)
Must not be included if order-type is Notional Market
If order-type is Notional Market, quantity must not be included in the JSON. A notional market order means you are buying a dollar amount of something, like "I want $10 of AAPL stock" or "I want $10 of BTC/USD". Instead, you must include a value in the order JSON, which is the dollar amount you wish to buy/sell.

Symbol
The symbol is the primary identifier of an instrument. Each leg must have its own distinct symbol with no overlap. An order with multiple legs with the same symbol is invalid and the request will be rejected.

If you are trading stocks, you'd just use the ticker symbol (AAPL for Apple, TSLA for Tesla, etc). Symbols for other instruments types like equity options and futures are a little less intuitive and will require you to look up the actual instrument symbols via our API.

Refer to the sections below to learn how to look up a symbol for each type of instrument.

Equity Options

If you want to trade options for a particular stock, the easiest thing to do is fetch the full option chain via the GET /option-chains/{stock_symbol}/nested endpoint found here. This endpoint returns all of the expirations that tastytrade offers for that given equity symbol. Nested inside each expiration is a list of strikes where each strike has a call and a put field, which are the call symbol and the put symbol, respectively. For an example, view the Instruments section of our Api Guide.

The nested endpoint is nice because it groups the options into their expirations and each expiration lists out the strike price with its associated call and put symbols in a very concise JSON format.

There are a couple other endpoints for fetching option chains: GET /option-chains/{stock_symbol}/compact lists out all option symbols for a given stock symbol without any expiration grouping. This endpoint might be useful if you already have a good idea of what you're looking to trade and just want a list of every option symbol for an underlying stock.

The last option chain endpoint is GET /option-chains/{stock_symbol}, which returns a list of equity option instruments for a given symbol. Each equity option is a full data representation, meaning it includes all data fields pertinent to that instrument, such as exercise-style, expiration-date, and expiration-type. As a result, this endpoint returns a lot of data. You would probably be better served by fetching data from the /option-chains/{stock_symbol}/nested endpoint, locating the symbols you're interested in trading, and then fetching only those instruments directly from the GET /instruments/equity-options endpoint.

Of course, fetching the instruments isn't required for submitting an order. You only need an instruments's symbol to trade. However, the equity option instrument JSON does provide additional data that many will find useful.

Equity Option orders can contain up to 4 legs.

Equities

Most of the time you won't need to look up any information for a particular stock. If you know the ticker symbol that you want to trade, you can just plug that into the symbol field of the leg JSON and submit your order.

If you want to view a full JSON representation of an equity instrument, you can either search multiple instruments by symbol or fetch a single isntrument by symbol:

To search for equities by symbol, send a GET /instruments/equities?symbol[]=AAPL&symbol[]=TSLA. View the docs for this endpoint here.

To fetch a single equity instrument by its symbol, you can hit the GET /instruments/equities/{symbol} endpoint directly.

The equity instrument JSON includes fields like is-index, listed-market, active, is-fractional-quantity-eligible, and is-closing-only.

Equity orders can contain only 1 leg.

Futures

To view all of the active futures contracts we offer, hit the GET /instruments/futures endpoint. Each item in the list returned is a full JSON representation of a future instrument. The JSON includes fields like symbol, expiration-date, expires-at, and last-trade-date. You can view the full JSON representation here.

If you are only interested in trading one or two specific futures products, you can filter the results by one or more product-code like this: GET /instruments/futures?product-code[]=CL&product-code[]=ES.

To get a list of all of the future product codes tastytrade supports, hit GET /instruments/future-products. This endpoint returns a JSON representation of a future product, not its instruments. You can't trade Crude Oil futures (/CL) the same way you trade stock. You must trade a specific futures contract, such as /CLU3, which is the September 2023 Crude Oil contract.

Futures orders can contain only 1 leg.

Future Options

The process of finding future options symbols is almost identical to the equity options process, but instead of hitting GET /option-chains/{stock_symbol}/nested, you hit GET /futures-option-chains/{product_code}/nested. The JSON returned is formatted a little differently than the equity options chains, but the overall idea is the same. Instruments are grouped into expirations, each of which contains a list of strikes with call and put fields, representing the call symbol and the put symbol, respectively.

There is also a GET /futures-option-chains/{product_code} endpoint which returns a list of all future option instruments for a given product code. This endpoint returns a lot of data. You would probably be better served by fetching data from the /futures-option-chains/{product_code}/nested endpoint and locating the symbols you're interested in trading. If you need more info on the symbols and their respective instruments, you should then fetch those instruments directly from the GET /instruments/futures-options?symbol[]=symbol1&symol[]=symbol2 endpoint documented here.

If you only want to trade a specific future option product, like monthly E-mini S&P 500 options (ES), you can filter your search by that option product code: GET /instruments/future-options?option-root-symbol=ES.

To get a list of all the future option product codes that tastytrade supports, hit GET /instruments/future-option-products. This endpoint returns a JSON representation of a future option product, not its instruments.

A future option product's JSON contains fields like root-symbol, code, exchange, and expiration-type. You should treat root-symbol as the primary identifier for a product, not code.

Future option orders can contain up to 4 legs.

Cryptocurrencies

You can retrieve a list of cryptocurrencies that tastytrade supports via the GET /instruments/cryptocurrencies endpoint documented here. Each instrument returned contains a symbol field that you should include in the leg JSON.

Cryptocurrency orders can only contain 1 leg.

Order Responses
Order Rejected
Our system runs a number of validations on any order it receives. Any validation errors will result in your order being rejected with a 422 status code and a json payload detailing the reason. For example:

"error": {
    "code": "preflight_check_failure",
    "message": "One or more preflight checks failed",
    "errors": [
        {
            "code": "cant_buy_for_credit",
            "message": "You cannot buy for a credit."
        }
    ]
}
The above response indicates that you tried to submit a buy order with a "price-effect": "Credit", which is not allowed.

Order Accepted
Assuming your order passes all the validations our order system performs, you will receive a response with an order id and a status of Routed, among other data. We'll provide a description of the response keys below:

buying-power-effect - A json object containing data that details the impact this order will have on your account's buying power.

closing-fee-calculation - An estimation of the fees you may see in the future when you close the position created by this order. This is provided as a convenience and is purely an estimation. The fees are not applied to this order.

fee-calculation - An estimation of the fees you may see as a result of this order being filled. Fees are broken into separate categories and totaled at the end.

order - A json object containing status and tracking details about your order. For an overview of order status flow, head to our Order Flow section. For an overview of tracking and managing your orders, head to our Order Management section.

order.legs.fills - An array of order leg fill details. An order leg can have zero or many fills. For example, if you have a buy order for 100 shares, you could potentially receive 100 fills (1 per share). You could also receive a single fill for 100 shares. Each fill will have a quantity and will affect your positions. For example, a buy order of 100 shares will result in a position with quantity 100 when the order fills. Head to our overview section on orders and positions for more details.

warnings - We return warnings when you do an order dry run via POST /accounts/{account_number}/orders/dry-run. These are informational warnings. Some may give you a heads up that your order will be rejected if you were to try to route it. Other warnings may indicate that the market is closed and your order will be routed when the market opens up again.

Example Order JSON Requests
The following are examples json bodies for POST /accounts/{account_number}/orders http requests. You may hit /accounts/{account_number}/orders/dry-run to validate the order without sending to any venue.

AAPL Market Order
{
    "time-in-force": "Day",
    "order-type": "Market",
    "legs": [
      {
          "instrument-type": "Equity",
          "symbol": "AAPL",
          "quantity": 1,
          "action": "Buy to Open"
      }
    ]
}
AAPL GTC Closing Order
{
    "time-in-force": "GTC",
    "price": 150.25,
    "price-effect": "Credit",
    "order-type": "Limit",
    "legs": [
      {
          "instrument-type": "Equity",
          "symbol": "AAPL",
          "quantity": 1,
          "action": "Sell to Close"
      }
    ]
}
Short Futures Limit Order
{
    "time-in-force": "Day",
    "price": 90.03,
    "price-effect": "Credit",
    "order-type": "Limit",
    "legs": [
      {
          "instrument-type": "Future",
          "symbol": "/CLZ2",
          "quantity": 1,
          "action": "Sell to Open"
      }
    ]
}
AAPL Bear Call Spread
{
    "time-in-force": "Day",
    "price": 0.85,
    "price-effect": "Credit",
    "order-type": "Limit",
    "legs": [
      {
          "instrument-type": "Equity Option",
          "symbol": "AAPL  221118C00155000",
          "quantity": 1,
          "action": "Sell to Open"
      },
      {
          "instrument-type": "Equity Option",
          "symbol": "AAPL  221118C00157500",
          "quantity": 1,
          "action": "Buy to Open"
      }
    ]
}
AAPL GTD Order
{
    "time-in-force": "GTD",
    "gtc-date": "2022-12-01",
    "price": 0.85,
    "price-effect": "Credit",
    "order-type": "Limit",
    "legs": [
      {
          "instrument-type": "Equity",
          "symbol": "AAPL",
          "quantity": 1,
          "action": "Buy to Open"
      }
    ]
}
Stop Limit Order
{
    "time-in-force": "Day",
    "price": 150.0,
    "price-effect": "Debit",
    "stop-trigger": 150.0,
    "order-type": "Limit",
    "legs": [
      {
          "instrument-type": "Equity",
          "symbol": "AAPL",
          "quantity": 1,
          "action": "Buy to Open"
      }
    ]
}
Iron Condor Order
{
  "source": "my-api-code",
  "order-type": "Limit",
  "time-in-force": "Day",
  "price": "1.51",
  "price-effect": "Credit",
  "legs": [
    {
      "instrument-type": "Equity Option",
      "symbol": "TSLA  230714P00210000",
      "action": "Buy to Open",
      "quantity": "1"
    },
    {
      "instrument-type": "Equity Option",
      "symbol": "TSLA  230714P00215000",
      "action": "Sell to Open",
      "quantity": "1"
    },
    {
      "instrument-type": "Equity Option",
      "symbol": "TSLA  230714C00282500",
      "action": "Sell to Open",
      "quantity": "1"
    },
    {
      "instrument-type": "Equity Option",
      "symbol": "TSLA  230714C00290000",
      "action": "Buy to Open",
      "quantity": "1"
    }
  ]
}
Notional Cryptocurrency Order
{
    "time-in-force": "GTC",
    "order-type": "Notional Market",
    "value": 10.0,
    "value-effect": "Debit",
    "legs": [
      {
          "instrument-type": "Cryptocurrency",
          "symbol": "BTC/USD",
          "action": "Buy to Open"
      }
    ]
}
Complex Orders
These orders are submitted to the POST /accounts/{account_number}/complex-orders endpoint.

Please refer to the help center article here for more information about these types of trades.

Please note that BLAST orders are deprecated and are not currently supported in any of our environments. Supported complex order types are: OTOCO, OCO, OTO, and PAIRS.

The following are some example JSON payloads for complex orders. Note that OTOCO orders have a trigger-order property as well as an orders property. The trigger order will go live immediately while the other orders will be in Contingent status until the trigger order fills. Once the trigger order fills, the other orders will be sent.

AAPL OTOCO Order
{
    "type": "OTOCO",
    "trigger-order": {
        "order-type": "Limit",
        "price": 157.97,
        "price-effect": "Debit",
        "time-in-force": "Day",
        "legs": [{
            "instrument-type": "Equity",
            "symbol": "AAPL",
            "action": "Buy to Open",
            "quantity": 100
        }]
    },
    "orders": [
        {
            "order-type": "Limit",
            "price": 198.68,
            "price-effect": "Credit",
            "time-in-force": "GTC",
            "legs": [{
                "symbol": "AAPL",
                "instrument-type": "Equity",
                "action": "Sell to Close",
                "quantity": 100
            }]
        },
        {
            "order-type": "Stop",
            "time-in-force": "GTC",
            "stop-trigger": 143.06,
            "legs": [{
                "symbol": "AAPL",
                "instrument-type": "Equity",
                "action": "Sell to Close",
                "quantity": 100
            }]
        }
    ]
}
OCO orders do not have a trigger-order property. The orders go live immediately.

AAPL OCO Order
{
    "type": "OCO",
    "orders": [
        {
            "order-type": "Limit",
            "price": 198.68,
            "price-effect": "Credit",
            "time-in-force": "GTC",
            "legs": [{
                "symbol": "AAPL",
                "instrument-type": "Equity",
                "action": "Sell to Close",
                "quantity": 100
            }]
        },
        {
            "order-type": "Stop",
            "time-in-force": "GTC",
            "stop-trigger": 143.06,
            "legs": [{
                "symbol": "AAPL",
                "instrument-type": "Equity",
                "action": "Sell to Close",
                "quantity": 100
            }]
        }
    ]
}
Fractional Stock Orders
tastytrade only supports fractional trading of certain equity products. To determine if an equity can be fractionally traded, fetch the equity instrument and check the is-fractional-quantity-eligible field. For example: GET /instruments/equities?symbol[]=AAPL returns "is-fractional-quantity-eligible": true.

Fractional orders must have a minimum monetary value of $5. Buy orders for 0.5 shares of a $1 stock will be rejected.

Fractional Quantity Order
{
    "time-in-force": "Day",
    "order-type": "Market",
    "legs": [
      {
          "instrument-type": "Equity",
          "symbol": "AAPL",
          "quantity": 0.5,
          "action": "Buy to Open"
      }
    ]
}
To buy $10 of AAPL stock, submit a Notional Market order with a value instead of a price. Omit the quantity field from the legs:

Notional Amount Order
{
    "time-in-force": "Day",
    "order-type": "Notional Market",
    "value": 10.0,
    "value-effect": "Debit",
    "legs": [
      {
          "instrument-type": "Equity",
          "symbol": "AAPL",
          "action": "Buy to Open"
      }
    ]
}
