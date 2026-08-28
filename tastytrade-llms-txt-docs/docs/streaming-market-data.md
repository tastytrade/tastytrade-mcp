Streaming Market Data
Get an Api Quote Token
DXLink Streamer
DXLink Symbology
DXLink Documentation
Candle Events (Historic Data)
Candle Events Examples
tastytrade supports streaming quote data asynchronously via websocket. If you want to fetch quote data synchronously, head to our Market Data Guide.

The process to subscribe to streaming market events has two parts.

Get an API quote token.
Using the api quote token, clients may fetch market events from DXLink (see DXLink Streamer section below).
Important: Api quote tokens expire after 24 hours

Please note that DxLink publishes market data events as they occur. Some tickers change rapidly due to high trading volume. Tickers with lower trading volume will see fewer market events. For tickers with extremely low liquidity, this could mean no market events for minutes or hours. This is normal. If you have a websocket that is connected and heartbeating but you aren't receiving any messages from DxLink, please check the ticker's liquidity. If nobody is trading that ticker, there won't be any events to publish.

Get an Api Quote Token
The GET /api-quote-tokens endpoint will return an api quote token and its associated urls.

This token is unique to the Customer identified by the access token on the request. It's used to identify the customer to TW's quote provider, DXLink.

GET
/api-quote-tokens
{
    "data": {
        "token": "<redacted>",
        "dxlink-url": "wss://tasty-openapi-ws.dxfeed.com/realtime",
        "level": "api"
    },
    "context": "/api-quote-tokens"
}
Quote streamer tokens are valid for 24 hours.

Please note that you must be registered as a tastytrade customer if you want to stream quotes. This means going through the account opening process. If you've only registered a username/password, your api quote token request will be rejected with the following error:

{'error':
  {'code': 'quote_streamer.customer_not_found_error',
  'message': 'You must be a customer to access a quote stream.'}
}
Head to tastytrade.com and click "Open An Account" to open your tastytrade account.

DXLink Streamer
We recommend using one of DxLinks SDKs to receive real-time market data events. Tastytrade has a typecript SDK that integrates the DxLink Javascript SDK and makes the following steps much simpler.

DXLink data is sent and received via a websocket connection. Use the dxlink-url provided to you in the /api-quote-tokens response to open a websocket.

All of the steps below are very well documented on DXLink's protocol documentation site. That same site also lets you use your api quote token to test out the DxLink protocol. We are providing some high level instructions below for convenience.

If you want to test in your browser, there is a chrome extension called Browser Websocket Client that you can install in your Google Chrome browser. We have a configuration file here that you can configure the client with. The file includes all of the example messages below.

It's important to send the messages to DxLink in the proper order. At a high level, the order is as follows:

SETUP
AUTHORIZE
CHANNEL_REQUEST - open a channel
FEED_SETUP - configure the channel
FEED_SUBSCRIPTION - subscribe to market events for one or more symbols
KEEPALIVE
Let's go into a little more detail on these. We'll provide example messages based on what you'll see when using the tastytrade web trading platform.

SETUP

This is the first message you send to initiate a connection to DXLink.

Sent: {"type":"SETUP","channel":0,"version":"0.1-DXF-JS/0.3.0","keepaliveTimeout":60,"acceptKeepaliveTimeout":60}
Received: {"type":"SETUP","channel":0,"keepaliveTimeout":60,"acceptKeepaliveTimeout":60,"version":"1.0-1.2.1-20240722-153442"}
AUTHORIZE

After SETUP, you should receive an AUTH_STATE message with state: UNAUTHORIZED. This is when you'd authorize with your api quote token:

Received: {"type":"AUTH_STATE","channel":0,"state":"UNAUTHORIZED"}
Sent: {"type":"AUTH","channel":0,"token":"<redacted>"}
Received: {"type":"AUTH_STATE","channel":0,"state":"AUTHORIZED","userId":"<redacted>"}
CHANNEL_REQUEST

You can then open up a channel on which to send subscription messages and receive market event data. A channel is a virtual connection that you may use to subscribe to different data. For example, you may want one channel for equities and another for futures. The channel number is any number you want to use to identify that channel.

Sent: {"type":"CHANNEL_REQUEST","channel":3,"service":"FEED","parameters":{"contract":"AUTO"}}
Received: {"type":"CHANNEL_OPENED","channel":3,"service":"FEED","parameters":{"contract":"AUTO","subFormat":"LIST"}}
FEED_SETUP

Once a channel is opened, you should configure what data fields to receive on that channel.

Sent: {"type":"FEED_SETUP","channel":3,"acceptAggregationPeriod":0.1,"acceptDataFormat":"COMPACT","acceptEventFields":{"Trade":["eventType","eventSymbol","price","dayVolume","size"],"TradeETH":["eventType","eventSymbol","price","dayVolume","size"],"Quote":["eventType","eventSymbol","bidPrice","askPrice","bidSize","askSize"],"Greeks":["eventType","eventSymbol","volatility","delta","gamma","theta","rho","vega"],"Profile":["eventType","eventSymbol","description","shortSaleRestriction","tradingStatus","statusReason","haltStartTime","haltEndTime","highLimitPrice","lowLimitPrice","high52WeekPrice","low52WeekPrice"],"Summary":["eventType","eventSymbol","openInterest","dayOpenPrice","dayHighPrice","dayLowPrice","prevDayClosePrice"]}}
Received: {"type":"FEED_CONFIG","channel":3,"dataFormat":"COMPACT","aggregationPeriod":0.1}
You can see from the above FEED_SETUP message that our web platform subscribes to a subset of data for each event type. This lets DxLink know to only send data like eventSymbol, price, dayVolume, and size when sending a Trade event.

FEED_SUBSCRIPTION

At this point you're ready to subscribe to market event data. DxLink will continue to stream these events to you over your channel until you unsubscribe to them. You can subscribe to multiple events for multiple symbols in a single message. We've abridged some of the message for readability.

Sent: {"type":"FEED_SUBSCRIPTION","channel":3,"reset":true,"add":[{"type":"Trade","symbol":"BTC/USD:CXTALP"},{"type":"Quote","symbol":"BTC/USD:CXTALP"},{"type":"Profile","symbol":"BTC/USD:CXTALP"},{"type":"Summary","symbol":"BTC/USD:CXTALP"},{"type":"Trade","symbol":"SPY"},{"type":"TradeETH","symbol":"SPY"},{"type":"Quote","symbol":"SPY"},{"type":"Profile","symbol":"SPY"},{"type":"Summary","symbol":"SPY"}]}
Received: {"type":"FEED_DATA","channel":3,"data":["Trade",["Trade","SPY",559.36,1.3743299E7,100.0,"Trade","BTC/USD:CXTALP",58356.71,"NaN","NaN"]]}
To stop receiving data for a symbol, you'd send another FEED_SUBSCRIPTION message with "remove" for each event type:

{"type":"FEED_SUBSCRIPTION","channel":3,"remove":[{"type":"Trade","symbol":"SPY"},{"type":"Quote","symbol":"SPY"},{"type":"Summary","symbol":"SPY"}]}
KEEPALIVE

You need to send a keepalive message at regular intervals to keep the websocket connection open. If DxLink doesn't receive a keepalive within the 60-second timeout, it will close the connection. Sending a keepalive message to them every 30 seconds will keep the connection alive indefinitely.

{"type":"KEEPALIVE","channel":0}
DxLink Market Data Events

DXLink provides several different market events, each of which has its own schema. For example, the Quote event provides data like bidPrice and askPrice while the Profile event provides data like high52WeekPrice and description. DXLink requires that you specify which market events you wish to subscribe to when you are adding a symbol subscription.

tastytrade's api quote token grants you access to the following market data events:

Profile
Quote
Summary
Trade
Greeks
TimeAndSale
For an overview of each of those events and the data they provice, head to DxLink's protocol docs which contains the schema for each event. For example, you can search the page for ProfileEvent or QuoteEvent and find all the data that comes in each of those events.

Symbology
To receive live market event data via DXLink, clients must convert symbols into a format that meets DxLink's requirements. For convenience, we provide these symbols via a field called streamer-symbol. You can find it in the http response body when fetching instrument data. For example, for subscribing to market events for a futures contract, you would hit the GET /instruments/futures endpoint:

GET
/instruments/futures
{
    "data": {
        "items": [
            {
                "symbol": "/6AM3",
                "streamer-exchange-code": "XCME",
                "streamer-symbol": "/6AM23:XCME"
            }
        ]
    }
}
An identical field is available for the following instruments endpoints:

GET /instruments/cryptocurrencies
GET /instruments/equities/:symbol
GET /instruments/futures
GET /futures-option-chains/:product-code/nested
GET /option-chains/:underlying-symbol/nested
DXLink Documentation
DXLink protocol documentation can be found here.

When setting up a feed with DxLink, be sure to use the COMPACT data format, as the FULL format uses a lot of data and will be turned off in the future. For example:

{
  "type": "FEED_SETUP",
  "channel": 1,
  "acceptAggregationPeriod": 10,
  "acceptDataFormat": "COMPACT",
  "acceptEventFields": {
    "Quote": ["eventType", "eventSymbol", "bidPrice", "askPrice", "bidSize", "askSize"]
  }
}
DXLink has an interactive debug console here. Use your api quote token to authenticate.

For convenience, DxFeed provides a number of SDKs for communicating with DxLink over websockets:

.NET API

Swift API

C/C++ API

Java API

JS API

Candle Events (Historic Data)
DxLink allows you to subscribe to different event types. One of these event types is Candle. A candle event represents quote data for a duration of time like 5 minutes, 1 hour, or 1 day. Each event has fields like open, close, high, and low.

When you subscribe to candle events for a specific symbol, you need to provide a period and a type. The type represents the unit of time with which each candle is measured, like minutes or hours. The period is a multiplier for the type, like five minutes or two hours.

You need both period and type to be present in the symbol when subscribing to candle events.

Please refer to DxFeed's guidelines for more information on how to generate a candle symbol correctly.

The final piece you need in order to subscribe to candle events is a fromTime timestamp. This is an integer in Unix epoch time format. For example, the timestamp representing August 8th, 2023 at 10:00am GMT is 1691402400. If today were August 9th, 2023 at 10:00am GMT and you used 1691402400 as the fromTime, you'd receive 24 hours of candle events.

Note: You can only set when to start getting candle data (fromTime). DxLink will give you all candles from that point until now. There's no way to set an end time - it always goes up to the current moment.

Here are a few use cases:

Suppose you wanted AAPL quote data from the past 24 hours and you wanted it grouped into 5-minute intervals. The fromTime would be now - 24 hours in epoch format. The symbol would look like AAPL{=5m} where 5 is the period and m is the type (minutes). Each candle event you receive will represent 5 minutes of data. The open field represents the price of AAPL at the start of the 5-minute candle duration and close represents the price of AAPL at the end of the 5-minute candle duration. high is the highest price that AAPL hit during those 5 minutes, and low is the lowest price that AAPL hit during those 5 minutes.

Suppose you wanted SPY quote data for the past 6 months grouped into 1-hour intervals. The symbol would look like SPY{=1h} and the fromTime would just be now - 6 months in epoch format.

Important We recommend using larger time intervals the further back you go. If you request too many candles you could get blasted with millions of events and bring your client to a crawl. For example, requesting 12 months of data grouped into 1-minute intervals would amount to around half a million events. That is a lot of data to process all at once.

Here is a rough guideline on what type and period to use based on how far back you reach:

Time Back	Recommended Type	Example	Notes
1 day	1 Minute	AAPL{=1m}	Returns around 1440 candle events
1 week	5 Minutes	AAPL{=5m}	Returns around 2016 candle events
1 month	30 Minutes	AAPL{=30m}	Returns around 1440 candle events
3 months	1 hour	AAPL{=1h}	Returns around 2160 candle events
6 months	2 hours	AAPL{=2h}	Returns around 2160 candle events
1 year+	1 day	AAPL{=1d}	Returns around 365 candle events
The last candle event you receive is always the "live" candle data. You may receive this event constantly as the quote changes and the candle data is updated for the current period. Specifically, the close value will update as the quote's price changes. For example, say you subscribed to AAPL{=5m} and it is currently 12:51. The "live" candle event should have a timestamp of 12:50. You should constantly receive messages for this event as the quote moves. Once the clock hits 12:55, the 12:50 event will close and the "live" event will be 12:55. This allows you to fetch whatever historica data you want and also be notified of the most recent quote statistics as they change.

Candle Events Examples
The following are code examples using tastytrade's typescript SDK. dxLinkFeed is an instance of DXLinkFeed from the DxLink javascript SDK. Refer to tastytrade's javascript SDK for instructions on setting that up.

5-minute candles for the past 24 hours
const date = new Date()
date.setDate(date.getDate() - 1) // Set date to 1 day ago
dxLinkFeed.addSubscriptions({ type: 'Candle', symbol: 'AAPL{=5m}', fromTime: date.getTime() })
30-minute candles for the past 30 days
const date = new Date()
date.setDate(date.getDate() - 30) // Set date to 30 days ago
dxLinkFeed.addSubscriptions({ type: 'Candle', symbol: 'AAPL{=30m}', fromTime: date.getTime() })
60-minute candles for the past 3 months
const date = new Date()
date.setDate(date.getDate() - 90) // Set date to 90 days ago
dxLinkFeed.addSubscriptions({ type: 'Candle', symbol: 'AAPL{=1h}', fromTime: date.getTime() })
