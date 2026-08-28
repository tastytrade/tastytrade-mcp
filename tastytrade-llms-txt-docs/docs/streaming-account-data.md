Streaming Account Data
Getting Started
Available Actions
Receiving Notifications
Notification Nuances
Hosts
Demo
The tastytrade API utilizes a websocket for publishing one-directional notifications from the API layer to trading client applications. We refer to this one-directional websocket as our "Account Streamer".

In general, we publish Account Streamer notifications about state changes to existing account data such as orders, balances, and positions. We also send notifications about state changes to non-account data such as public watchlists and quote alert triggers.

This allows clients to subscribe to real-time updates rather than polling API endpoints.

As an example, suppose you submit an opening order to buy 100 shares of AAPL. The HTTP response would look like this:

POST
/accounts/{account_number}/orders
{
    "data": {
        "order": {
            "id": 1,
            "account-number": "5WT00000",
            "time-in-force": "Day",
            "order-type": "Market",
            "size": 100,
            "underlying-symbol": "AAPL",
            "underlying-instrument-type": "Equity",
            "status": "Routed",
            "cancellable": true,
            "editable": true,
            "edited": false,
            "legs": [
                {
                    "instrument-type": "Equity",
                    "symbol": "AAPL",
                    "quantity": 100,
                    "remaining-quantity": 100,
                    "action": "Buy to Open",
                    "fills": []
                }
            ]
        }
    },
    "context": "/accounts/5WT00000/orders"
}
You'll notice the status is Routed, which means our system is in the process of sending your order to the exchange (for more info on order statuses and their many meanings, see the Order Flow page). Since this is a market order, it probably filled immediately. Let's re-fetch this order via the /GET /accounts/{account_number}/orders/{id} endpoint to verify:

GET
/accounts/{account_number}/orders/{id}
{
    "data": {
        "id": 1,
        "account-number": "5WT00000",
        "time-in-force": "Day",
        "order-type": "Market",
        "size": 100,
        "underlying-symbol": "AAPL",
        "underlying-instrument-type": "Equity",
        "status": "Filled",
        "cancellable": false,
        "editable": false,
        "edited": false,
        "ext-exchange-order-number": "12345",
        "ext-client-order-id": "67890",
        "ext-global-order-number": 1111,
        "received-at": "2023-07-05T19:07:32.444+00:00",
        "updated-at": 1688584052750,
        "in-flight-at": "2023-07-05T19:07:32.494+00:00",
        "live-at": "2023-07-05T19:07:32.495+00:00",
        "destination-venue": "TEST_A",
        "user-id": 99,
        "username": "coolperson",
        "terminal-at": "2023-07-05T19:07:32.737+00:00",
        "legs": [
            {
                "instrument-type": "Equity",
                "symbol": "AAPL",
                "quantity": 100,
                "remaining-quantity": 0,
                "action": "Buy to Open",
                "fills": [
                    {
                        "ext-group-fill-id": "0",
                        "ext-exec-id": "1122",
                        "fill-id": "24_TW::TEST_A47504::20230705.1179-TEST_FILL",
                        "quantity": 100,
                        "fill-price": "100.0",
                        "filled-at": "2023-07-05T19:07:32.496+00:00",
                        "destination-venue": "TEST_A"
                    }
                ]
            }
        ]
    },
    "context": "/accounts/5WT00000/orders/1"
}
The order is filled! But we had to make an additional HTTP request to fetch the order to check. What if you had an order that hadn't filled yet but instead was Live for a few minutes? Would you need to continuously be making requests to get its status? That seems like a pain! To alleviate this pain, you should utilize the account streamer.

The account streamer publishes real-time messages every time the order's status changes. All you need to do is open a websocket to the correct url (see hosts below) and subscribe to all account updates. As the order's status changes, you'll receive messages via the websocket that look like this:

Order Notification
{
  type: 'Order',
  data: {
    "id": 1,
    "account-number": "5WT00000",
    "time-in-force": "Day",
    "order-type": "Market",
    "size": 100,
    "underlying-symbol": "AAPL",
    "underlying-instrument-type": "Equity",
    "status": "Live",
    "cancellable": true,
    "editable": true,
    "edited": false,
    "legs": [
        {
            "instrument-type": "Equity",
            "symbol": "AAPL",
            "quantity": 100,
            "remaining-quantity": 100,
            "action": "Buy to Open",
            "fills": []
        }
    ]
  },
  timestamp: 1688595114405
}
Now you don't need to worry about polling or re-fetching your order!

Getting Started
At a high level, the following steps must be performed in order:

Open a websocket connection to the back-end host
Subscribe to notifications
Send heartbeats to back-end host
Note: If you don't perform these actions in the order listed above, you may get a not implemented error when attempting to subscribe to notifications. Please ensure you begin sending heartbeats after you have successfully sent a connect message.

1. Open a Websocket Connection
Open a websocket connection using your langauge of choice. For example, if you are running in a NodeJs environment, you could use the ws package:

Javascript Example
const WebSocket = require('ws')

const host = 'wss://streamer.cert.tastyworks.com'
const websocket = new WebSocket(host)
websocket.addEventListener('open', () => {
  // Schedule your heartbeat
})
websocket.addEventListener('message', (messageEvent) => {
  // Parse the message
})
You need to send an auth-token with every request made to the websocket server. This is your tastytrade access token. It's the same value you provide in the Authorization header of all other API requests. See our Auth Patterns section for more info.

NOTE: When using Access Tokens make sure you have 'Bearer ' preceding your token value within the auth-token field.

2. Subscribe to Notifications
There are several different types of notifications you can subscribe to. We refer to these types as "actions". You can think of it as subscribing to notifications regarding any actions that occur, such as quote changes, balance changes, watchlist updates, etc. For a complete list of the various actions, see Available Actions below.

Each subscribe message should contain an action, value, and auth-token key, like this:

Subscribe Message Schema
{
  "action": "<action>", // one of the available actions below
  "value": "<string>", // Optional. Depends on the message action being sent (see available actions below)
  "auth-token": "<string>" // access token
}
Most of the time you'll want to send a connect message, which subscribes you to account updates for whichever account numbers you provide:

Sample Connect Message
{
  "action": "connect",
  "value": ["5WT00000","5WT00001"],
  "auth-token": "your access token here",
  "request-id": 2
}
Connect Response Message
{
  "status": "ok",
  "action": "connect",
  "web-socket-session-id": "5b6e2799",
  "value": [ "5WT00000", "5WT00001" ],
  "request-id": 2
}
3. Send heartbeats
Once an active streamer connection has been established, you need to send heartbeat messages to the tastytrade server periodically (2s - 1m interval). This ensures that your websocket remains connected and also lets you detect streamer connection drops.

Sample Heartbeat Json
{
  "action": "heartbeat",
  "auth-token": "your access token here",
  "request-id": 1
}
The request-id isn't required, but our servers will include it in their response messages.

Heartbeat Response Message
{
  "status": "ok",
  "action": "heartbeat",
  "web-socket-session-id": "5b6e2799",
  "request-id": 1
}
Available Actions
heartbeat

Sent periodically to the streamer server to prevent the socket connection from being considered "stale"
When sending this message, value is blank
Heartbeat messages should be sent at regular intervals (2s-1m)
connect

Subscribes to all account-related notifications (orders, account balances, positions)
public-watchlists-subscribe

Although this subscribes to public watchlist updates, an auth token is still required
When sending this message, value is blank
quote-alerts-subscribe

Subscribes to quote alert messages about alerts the user has previously configured via a POST request to the /quote-alerts endpoint
When sending this message, value is blank
Important note: quote alerts exist at a user level, and not an account level
Receiving Notifications
All messages which are published via the streamer use the same json object representations as elsewhere in the API. Streamer messages always contain a full object representation, not a partial or a differential update.

Each message will have a type key that corresponds to the class of data being provided. For example, a notification with type: Order will have a full order json message in the data key:

Order Notification
{
  type: 'Order',
  data: {
    "id": 1,
    "account-number": "5WT00000",
    "time-in-force": "Day",
    "order-type": "Market",
    "size": 100,
    "underlying-symbol": "AAPL",
    "underlying-instrument-type": "Equity",
    "status": "Live",
    "cancellable": true,
    "editable": true,
    "edited": false,
    "legs": [
        {
            "instrument-type": "Equity",
            "symbol": "AAPL",
            "quantity": 100,
            "remaining-quantity": 100,
            "action": "Buy to Open",
            "fills": []
        }
    ]
  },
  timestamp: 1688595114405
}
Notification Nuances
Order Filled notifications
tastytrade marks an order Filled as soon as possible and sends fill data through the Account Streamer. Here’s how it works:

tastytrade gets fill data from the exchange for each leg of the order.
The order is marked Filled when there is no remaining quantity left to fill*.
tastytrade publishes fill data over the account streamer for each filled leg.
*For multi-leg option orders, which must be executed simultaneously, tastytrade marks the order Filled when the first leg is processed, assuming that leg has no remaining quantity. The first account streamer message will show the order as Filled with just one leg of fill data. The other fills will be processed and published over the account streamer immediately after. The final message will include all fill data for all legs.

We do this because order legs are often filled multiple times. For example, if you route an order to buy 100 shares of AAPL, you could receive 100 separate fills for 1 share each. We publish each of these fills as a separate message as they are processed.

Hosts
Sandbox : wss://streamer.cert.tastyworks.com

Production: wss://streamer.tastyworks.com

Demo
We have a demo page where you can subscribe to your sandbox account data. Head here to try it out.

