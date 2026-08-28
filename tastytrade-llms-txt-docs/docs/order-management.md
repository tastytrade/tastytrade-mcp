Order Management
Search Orders
Live Orders
Order Dry Run
Submit Order
Cancel Order
Cancel Replace
Complex Orders
Submit Complex Order
Cancel Complex Order
Search Orders
Returns a paginated list of orders filtered by the given parameters.

Query Parameters
start-date
Date
Date to start searching orders
example: 
2023-01-01
end-date
Date
Date to stop searching orders
example: 
2023-01-10
underlyng-symbol
String
Filter orders with this underlying symbol
example: 
AAPL
status
Array[String]
Filter orders with this status
example: 
status[]=Live&status[]=Filled
futures-symbol
String
Filter futures and future option orders with this outright contract symbol
example: 
ESM3
underlying-instrument-type
String
Filter orders with this underlying instrument type. "Future" will return both futures and future option orders. "Equity" will return both equities and equity option orders.
Values: 
Cryptocurrency, Equity, Future
sort
String
default: Desc
The chronological order that results are returned (ascending or descending)
Values: 
Asc, Desc
start-at
DateTime
Date and time to start searching orders
example: 
2023-01-01T00:00:00
end-at
DateTime
Date and time to stop searching orders
example: 
2023-01-05T01:00:00
per-page
Integer
default: 10
Number of paginated results to return at a time
page-offset
Integer
default: 0
Page number to fetch
Live Orders
Important: Do not poll the GET /orders/live endpoint for real-time order updates. Repeated polling of this endpoint degrades platform performance and may result in throttling or suspension of your API access.

Use the Account Streamer to receive order status updates in real time. The streamer delivers updates as they occur with lower latency and no risk of rate-limit issues.

Returns all orders that were created or updated today. The name is a little misleading. You'd think that it would only return orders with a status of "Live". That was our intention when we created this endpoint, however it has shifted slightly over time. In this endpoint's response, you'll find orders that were cancelled today, orders that were rejected today, GTC orders from months ago that are still Live today, orders that were filled today, etc.

GET
/accounts/{account_number}/orders/live
{
    "data": {
        "items": [
            {
                "id": 54758826,
                "account-number": "5WT00001",
                "time-in-force": "GTC",
                "order-type": "Limit",
                "size": 1,
                "underlying-symbol": "QQQ",
                "price": "3.0",
                "price-effect": "Debit",
                "status": "Live",
                "cancellable": true,
                "editable": true,
                "edited": false,
                "legs": [
                    {
                        "instrument-type": "Equity Option",
                        "symbol": "QQQ   191115C00187000",
                        "quantity": 1,
                        "remaining-quantity": 1,
                        "action": "Buy to Close",
                        "fills": []
                    }
                ]
            },
            {
                "id": 53959020,
                "account-number": "5WT00001",
                "time-in-force": "GTC",
                "order-type": "Limit",
                "size": 1,
                "underlying-symbol": "SPY",
                "price": "1.27",
                "price-effect": "Debit",
                "status": "Cancelled",
                "cancellable": true,
                "editable": true,
                "edited": false,
                "legs": [
                    {
                        "instrument-type": "Equity Option",
                        "symbol": "SPY   191018P00300000",
                        "quantity": 1,
                        "remaining-quantity": 1,
                        "action": "Buy to Close",
                        "fills": []
                    },
                    {
                        "instrument-type": "Equity Option",
                        "symbol": "SPY   191018P00270000",
                        "quantity": 1,
                        "remaining-quantity": 1,
                        "action": "Sell to Close",
                        "fills": []
                    }
                ]
            }
        ]
    },
    "api-version": "v1",
    "context": "/accounts/5WT05758/orders/live"
}
Order Dry Run
The dry run endpoint gives you a way to verify that an order will be accepted by our system without actually sending the order. This endpoint also returns a buying power impact and cost of the order (including estimated fees).

There are 2 main factors our system considers when performing a dry run:

The validity of the order
The state of your account
Order Validity

There are dozens of checks our system performs to ensure your order is valid. These include (but aren't limited to) things like:

Does this order have an invalid symbol?
Is this an order for an expired option?
Is the customer trying to close a position that doesn't exist?
Does the customer already have a working order that conflicts with this one?
State of Your Account

Your account must have sufficient buying power to afford the order. Your account must also be in good standing with tastytrade in order to place orders with us.

The dry run endoint will return a warning in its response if it finds any issues with either your order or your account. If you try to actually submit the order after receiving a dry run warning, our system will reject the order and return an error message in the http response.

For more information on how to structure an order to submit, refer to our Order Submission guide.

POST
/accounts/{account_number}/orders/dry-run
{
    "data": {
        "order": {
            "account-number": "5WT0001",
            "time-in-force": "Day",
            "order-type": "Limit",
            "size": 1,
            "underlying-symbol": "SPY",
            "price": "2.0",
            "price-effect": "Credit",
            "status": "Received",
            "cancellable": true,
            "editable": true,
            "edited": false,
            "updated-at": 0,
            "legs": [
                {
                    "instrument-type": "Equity Option",
                    "symbol": "SPY   191018C00298000",
                    "quantity": 1,
                    "remaining-quantity": 1,
                    "action": "Buy to Open",
                    "fills": []
                },
                {
                    "instrument-type": "Equity Option",
                    "symbol": "SPY   191018C00295000",
                    "quantity": 1,
                    "remaining-quantity": 1,
                    "action": "Sell to Open",
                    "fills": []
                }
            ]
        },
        "warnings": [],
        "buying-power-effect": {
            "change-in-margin-requirement": "300.0",
            "change-in-margin-requirement-effect": "Debit",
            "change-in-buying-power": "102.302",
            "change-in-buying-power-effect": "Debit",
            "current-buying-power": "8995981.2613",
            "current-buying-power-effect": "Credit",
            "new-buying-power": "8995878.9593",
            "new-buying-power-effect": "Credit",
            "isolated-order-margin-requirement": "300.0",
            "isolated-order-margin-requirement-effect": "Debit",
            "is-spread": true,
            "impact": "102.302",
            "effect": "Debit"
        },
        "fee-calculation": {
            "regulatory-fees": "0.102",
            "regulatory-fees-effect": "Debit",
            "clearing-fees": "0.2",
            "clearing-fees-effect": "Debit",
            "commission": "2.0",
            "commission-effect": "Debit",
            "proprietary-index-option-fees": "0.0",
            "proprietary-index-option-fees-effect": "Debit",
            "total-fees": "2.302",
            "total-fees-effect": "Debit"
        }
    },
    "api-version": "v1",
    "context": "/accounts/5WT0001/orders/dry-run"
}
When you are ready to submit your order, you may post the exact same json to the submit order endpoint.

Submit Order
The requirements for this endpoint are identical to the dry-run endpoint, however this endpoint will actually send the order. The response will contain an id which you can use to look up or cancel the order.

For more information on how to structure an order to submit, refer to our Order Submission guide.

POST
/accounts/{account_number}/orders
{
    "data": {
        "order": {
            "id": 771043,
            "account-number": "5WT0001",
            "time-in-force": "Day",
            "order-type": "Limit",
            "size": 1,
            "underlying-symbol": "SPY",
            "price": "3.0",
            "price-effect": "Credit",
            "status": "Routed",
            "cancellable": false,
            "editable": false,
            "edited": false,
            "received-at": "2019-10-01T18:26:52.513+00:00",
            "updated-at": 1569954412572,
            "legs": [
                {
                    "instrument-type": "Equity Option",
                    "symbol": "SPY   191018C00295000",
                    "quantity": 1,
                    "remaining-quantity": 1,
                    "action": "Sell to Open",
                    "fills": []
                },
                {
                    "instrument-type": "Equity Option",
                    "symbol": "SPY   191018C00298000",
                    "quantity": 1,
                    "remaining-quantity": 1,
                    "action": "Buy to Open",
                    "fills": []
                }
            ]
        },
        "warnings": [],
        "buying-power-effect": {
            "change-in-margin-requirement": "300.0",
            "change-in-margin-requirement-effect": "Debit",
            "change-in-buying-power": "2.302",
            "change-in-buying-power-effect": "Debit",
            "current-buying-power": "8995871.0475",
            "current-buying-power-effect": "Credit",
            "new-buying-power": "8995868.7455",
            "new-buying-power-effect": "Credit",
            "isolated-order-margin-requirement": "300.0",
            "isolated-order-margin-requirement-effect": "Debit",
            "is-spread": true,
            "impact": "2.302",
            "effect": "Debit"
        },
        "fee-calculation": {
            "regulatory-fees": "0.102",
            "regulatory-fees-effect": "Debit",
            "clearing-fees": "0.2",
            "clearing-fees-effect": "Debit",
            "commission": "2.0",
            "commission-effect": "Debit",
            "proprietary-index-option-fees": "0.0",
            "proprietary-index-option-fees-effect": "Debit",
            "total-fees": "2.302",
            "total-fees-effect": "Debit"
        }
    },
    "api-version": "v1",
    "context": "/accounts/5WT0001/orders/"
}
Cancel Order
Requests cancellation of a given order. If the order is in a terminal status, this endpoint will return an HTTP 422 error with the following json:

{
    "error": {
        "code": "cannot_update_order",
        "message": "the order could not be cancelled"
    }
}
For more information on terminal order statuses, refer to our Order Flow guide.

For successful cancel requests, the order status will be Cancel Requested in the response. This means that our system is reaching out to the exchange to cancel your order. You should receive a notification via the Account Websocket when the order transitions to Cancelled status.

Path Parameters
account-number
String
The account number the order belongs to
id
Integer
The id of the order

DELETE
/accounts/{account_number}/orders/{id}
{
    "data": {
        "id": 12345,
        "account-number": "5WT00001",
        "time-in-force": "Day",
        "order-type": "Limit",
        "size": 1,
        "underlying-symbol": "AAPL",
        "underlying-instrument-type": "Equity",
        "price": "100.0",
        "price-effect": "Debit",
        "status": "Cancel Requested",
        "cancellable": false,
        "editable": false,
        "edited": false,
        "ext-exchange-order-number": "1234",
        "ext-client-order-id": "abcd1234",
        "ext-global-order-number": 9999,
        "received-at": "2023-07-31T15:33:45.899+00:00",
        "updated-at": 1690817636722,
        "legs": [
            {
                "instrument-type": "Equity",
                "symbol": "AAPL",
                "quantity": 1,
                "remaining-quantity": 1,
                "action": "Buy to Open",
                "fills": []
            }
        ]
    },
    "context": "/accounts/5WT00001/orders/12345"
}
Cancel Replace
When entering a cancel/replace order the following body parameters are able to be changed: price, order-type, and time-in-force. The rest of the json body must be the same as the original order being replaced.

PUT
/accounts/{account_number}/orders/{id}
{
  "time-in-force": "Day",
  "order-type": "Limit",
 "price": "3.0",
  "price-effect": "Credit",
  "legs": [
     {
     "instrument-type": "Equity Option",
      "symbol": "SPY   191018C00299000",
      "quantity": 1,
      "action": "Buy to Open"
     },
     {
     "instrument-type": "Equity Option",
      "symbol": "SPY   191018C00295000",
      "quantity": 1,
      "action": "Sell to Open"
    }
  ]
}
Complex Orders
Complex orders, commonly referred to as bracket orders, have separate endpoints for submission, retrieval, and cancellation.

The order JSON you submit is structured differently than normal orders. The structure depends on the type of complex order you are submitting.

To learn more about bracket orders and their purpose, refer to tastytrade's help center article here.

Submit Complex Order
OTOCO

OTOCO orders have one trigger-order and two orders in the JSON. The trigger order is an opening order that will "trigger" the 2 other orders if it fills.

The 2 other orders will sit dormant in Contingent status waiting for the trigger order to be filled. They are both closing orders, one being a "stop loss" order and the other being a "close at profit" order.

Example Request Body
{
  "type": "OTOCO",
  "trigger-order": {
    "time-in-force": "Day",
    "order-type": "Limit",
    "underlying-symbol": "UA",
    "price": 6.50,
    "price-effect": "Debit",
    "legs": [
      {
        "instrument-type": "Equity",
        "symbol": "UA",
        "quantity": 100,
        "action": "Buy to Open"
      }
    ]
  },
  "orders": [
    {
      "time-in-force": "Day",
      "order-type": "Limit",
      "underlying-symbol": "UA",
      "price": 8,
      "price-effect": "Credit",
      "legs": [
        {
          "instrument-type": "Equity",
          "symbol": "UA",
          "quantity": 100,
          "action": "Sell to Close"
        }
      ]
    },
    {
      "time-in-force": "Day",
      "order-type": "Stop",
      "underlying-symbol": "UA",
      "stop-trigger": 6,
      "legs": [
        {
          "instrument-type": "Equity",
          "symbol": "UA",
          "quantity": 100,
          "action": "Sell to Close"
        }
      ]
    }
  ]
}
The complex order response JSON contains an id for the overall complex order as well as 3 individual order ids (the trigger order id and the 2 closing order ids). The complex-order.id attribute can be used to fetch the complex order from the GET /accounts/{account_number}/complex-orders/{id} endpoint.

Each nested order id can be used to fetch the individual order via the GET /accounts/{account_number}/orders/{id} endpoint.

POST
/accounts/{account_number}/complex-orders Response
{
    "data": {
        "complex-order": {
            "id": 2000010530, // Use this to fetch entire complex order via GET /accounts/{account_number}/complex-orders/{id}
            "account-number": "5WT00001",
            "type": "OTOCO",
            "trigger-order": {
                "id": 2002750870,
                "account-number": "5WT00001",
                "time-in-force": "Day",
                "order-type": "Limit",
                "size": 100,
                "underlying-symbol": "UA",
                "underlying-instrument-type": "Equity",
                "price": "6.5",
                "price-effect": "Debit",
                "status": "Contingent",
                "contingent-status": "Pending Order",
                "cancellable": true,
                "editable": true,
                "edited": false,
                "received-at": "2023-07-31T16:13:56.326+00:00",
                "updated-at": 1690820036326,
                "complex-order-id": 2000010530,
                "complex-order-tag": "OTOCO::trigger-order",
                "preflight-id": 0,
                "legs": [
                    {
                        "instrument-type": "Equity",
                        "symbol": "UA",
                        "quantity": 100,
                        "remaining-quantity": 100,
                        "action": "Buy to Open",
                        "fills": []
                    }
                ]
            },
            "orders": [
                {
                    "id": 2002750871, // Use this to fetch individual order via GET /accounts/{account_number}/orders/{id}
                    "account-number": "5WT00001",
                    "time-in-force": "Day",
                    "order-type": "Limit",
                    "size": 100,
                    "underlying-symbol": "UA",
                    "underlying-instrument-type": "Equity",
                    "price": "8.0",
                    "price-effect": "Credit",
                    "status": "Contingent",
                    "contingent-status": "Pending Order",
                    "cancellable": true,
                    "editable": true,
                    "edited": false,
                    "received-at": "2023-07-31T16:13:56.356+00:00",
                    "updated-at": 1690820036356,
                    "complex-order-id": 2000010530,
                    "complex-order-tag": "OTOCO::oco-1-order",
                    "preflight-id": 1,
                    "legs": [
                        {
                            "instrument-type": "Equity",
                            "symbol": "UA",
                            "quantity": 100,
                            "remaining-quantity": 100,
                            "action": "Sell to Close",
                            "fills": []
                        }
                    ]
                },
                {
                    "id": 2002750872,
                    "account-number": "5WT00001",
                    "time-in-force": "Day",
                    "order-type": "Stop",
                    "size": 100,
                    "underlying-symbol": "UA",
                    "underlying-instrument-type": "Equity",
                    "stop-trigger": "6.0",
                    "status": "Contingent",
                    "contingent-status": "Pending Order",
                    "cancellable": true,
                    "editable": true,
                    "edited": false,
                    "received-at": "2023-07-31T16:13:56.381+00:00",
                    "updated-at": 1690820036381,
                    "complex-order-id": 2000010530,
                    "complex-order-tag": "OTOCO::oco-1-order",
                    "preflight-id": 2,
                    "legs": [
                        {
                            "instrument-type": "Equity",
                            "symbol": "UA",
                            "quantity": 100,
                            "remaining-quantity": 100,
                            "action": "Sell to Close",
                            "fills": []
                        }
                    ]
                }
            ]
        },
        "warnings": [],
        "buying-power-effect": {
            "change-in-margin-requirement": "325.0",
            "change-in-margin-requirement-effect": "Debit",
            "change-in-buying-power": "325.289",
            "change-in-buying-power-effect": "Debit",
            "current-buying-power": "5698377.62922645",
            "current-buying-power-effect": "Credit",
            "new-buying-power": "5698052.34022645",
            "new-buying-power-effect": "Credit",
            "isolated-order-margin-requirement": "325.0",
            "isolated-order-margin-requirement-effect": "Debit",
            "is-spread": false,
            "impact": "325.289",
            "effect": "Debit"
        },
        "fee-calculation": {
            "regulatory-fees": "0.0245",
            "regulatory-fees-effect": "Debit",
            "clearing-fees": "0.08",
            "clearing-fees-effect": "Debit",
            "commission": "0.0",
            "commission-effect": "None",
            "proprietary-index-option-fees": "0.0",
            "proprietary-index-option-fees-effect": "None",
            "total-fees": "0.1045",
            "total-fees-effect": "Debit"
        }
    },
    "context": "/accounts/5WT00001/complex-orders"
}
OTO

OTO orders have a trigger order and up to 3 additional orders that get routed when the trigger order fills. The additional orders do not cancel each other out the way an OTOCO's orders do.

For the example below, assume you have an iron condor position of 1 long AAPL Call, 1 short AAPL Call, 1 long AAPL Put, and 1 short AAPL Put. You'd like to close the short legs first, and then immediately trigger 2 market orders to close the long legs:

Example Request Body
{
  "type": "OTO",
  "trigger-order": {
    "time-in-force": "Day",
    "order-type": "Limit",
    "underlying-symbol": "AAPL",
    "price": 11.50,
    "price-effect": "Debit",
    "legs": [
      {
        "instrument-type": "Equity Option",
        "symbol": "AAPL  250214C00240000",
        "quantity": 1,
        "action": "Buy to Close"
      },
      {
        "instrument-type": "Equity Option",
        "symbol": "AAPL  250214P00235000",
        "quantity": 1,
        "action": "Buy to Close"
      }
    ]
  },
  "orders": [
    {
      "time-in-force": "Day",
      "order-type": "Market",
      "underlying-symbol": "AAPL",
      "legs": [
        {
          "instrument-type": "Equity Option",
          "symbol": "AAPL  250214C00242500",
          "quantity": 1,
          "action": "Sell to Close"
        }
      ]
    },
    {
      "time-in-force": "Day",
      "order-type": "Market",
      "underlying-symbol": "AAPL",
      "legs": [
        {
          "instrument-type": "Equity Option",
          "symbol": "AAPL  250214P00232500",
          "quantity": 1,
          "action": "Sell to Close"
        }
      ]
    }
  ]
}
POST
/accounts/{account_number}/complex-orders Response
{
    "data": {
        "buying-power-effect": {
            "change-in-margin-requirement": "250.0",
            "change-in-margin-requirement-effect": "Credit",
            "change-in-buying-power": "471.235745",
            "change-in-buying-power-effect": "Credit",
            "current-buying-power": "1176610.3696536",
            "current-buying-power-effect": "Credit",
            "new-buying-power": "1177081.6053986",
            "new-buying-power-effect": "Credit",
            "isolated-order-margin-requirement": "0.0",
            "isolated-order-margin-requirement-effect": "None",
            "is-spread": false,
            "impact": "471.235745",
            "effect": "Credit"
        },
        "complex-order": {
            "id": 2000054627,
            "account-number": "5WT05674",
            "type": "OTO",
            "trigger-order": {
                "id": 4007362691,
                "account-number": "5WT05674",
                "cancellable": true,
                "complex-order-id": 2000054627,
                "complex-order-tag": "OTO::trigger-order",
                "contingent-status": "Pending Order",
                "editable": true,
                "edited": false,
                "global-request-id": "e2905f39e30d832b45595dd752341642",
                "order-type": "Limit",
                "preflight-id": 0,
                "price": "1.5",
                "price-effect": "Debit",
                "received-at": "2025-01-28T15:43:09.626+00:00",
                "size": 1,
                "status": "Contingent",
                "time-in-force": "Day",
                "underlying-instrument-type": "Equity",
                "underlying-symbol": "AAPL",
                "updated-at": 1738078989626,
                "legs": [
                    {
                        "action": "Buy to Close",
                        "instrument-type": "Equity Option",
                        "quantity": 1,
                        "remaining-quantity": 1,
                        "symbol": "AAPL  250214C00240000",
                        "fills": []
                    },
                    {
                        "action": "Buy to Close",
                        "instrument-type": "Equity Option",
                        "quantity": 1,
                        "remaining-quantity": 1,
                        "symbol": "AAPL  250214P00235000",
                        "fills": []
                    }
                ]
            },
            "orders": [
                {
                    "id": 4007362692,
                    "account-number": "5WT05674",
                    "cancellable": true,
                    "complex-order-id": 2000054627,
                    "complex-order-tag": "OTO::order",
                    "contingent-status": "Pending Order",
                    "editable": true,
                    "edited": false,
                    "global-request-id": "e2905f39e30d832b45595dd752341642",
                    "order-type": "Market",
                    "preflight-id": 1,
                    "received-at": "2025-01-28T15:43:09.644+00:00",
                    "size": 1,
                    "status": "Contingent",
                    "time-in-force": "Day",
                    "underlying-instrument-type": "Equity",
                    "underlying-symbol": "AAPL",
                    "updated-at": 1738078989644,
                    "legs": [
                        {
                            "action": "Sell to Close",
                            "instrument-type": "Equity Option",
                            "quantity": 1,
                            "remaining-quantity": 1,
                            "symbol": "AAPL  250214C00242500",
                            "fills": []
                        }
                    ]
                },
                {
                    "id": 4007362693,
                    "account-number": "5WT05674",
                    "cancellable": true,
                    "complex-order-id": 2000054627,
                    "complex-order-tag": "OTO::order",
                    "contingent-status": "Pending Order",
                    "editable": true,
                    "edited": false,
                    "global-request-id": "e2905f39e30d832b45595dd752341642",
                    "order-type": "Market",
                    "preflight-id": 2,
                    "received-at": "2025-01-28T15:43:09.654+00:00",
                    "size": 1,
                    "status": "Contingent",
                    "time-in-force": "Day",
                    "underlying-instrument-type": "Equity",
                    "underlying-symbol": "AAPL",
                    "updated-at": 1738078989654,
                    "legs": [
                        {
                            "action": "Sell to Close",
                            "instrument-type": "Equity Option",
                            "quantity": 1,
                            "remaining-quantity": 1,
                            "symbol": "AAPL  250214P00232500",
                            "fills": []
                        }
                    ]
                }
            ]
        },
        "fee-calculation": {...},
        "warnings": []
    },
    "context": "/accounts/5WT05674/complex-orders"
}
OCO

OCO orders do not have a trigger-order. An OCO order is just a "stop loss" order and a "close at profit" order. Both are closing orders, meaning you must have an existing position to close in order to submit this complex order. When one order fills, the other order gets cancelled.

Example Request Body
{
    "type": "OCO",
    "orders": [{
    "order-type": "Limit",
    "price": 200.50,
    "price-effect": "Credit",
    "time-in-force": "GTC",
    "legs": [
        {
            "symbol": "AAPL",
            "instrument-type": "Equity",
            "action": "Sell to Close",
            "quantity": 100
            }
        ]
    },
    {
        "order-type": "Stop",
        "time-in-force": "GTC",
        "stop-trigger": 150.25,
        "legs": [{
            "symbol": "AAPL",
            "instrument-type": "Equity",
            "action": "Sell to Close",
            "quantity": 100
            }]
        }
    ]
}
POST
/accounts/{account_number}/complex-orders Response
{
    "data": {
        "complex-order": {
            "id": 2000010529,
            "account-number": "5WT00001",
            "type": "OCO",
            "orders": [
                {
                    "id": 2002750868,
                    "account-number": "5WT00001",
                    "time-in-force": "GTC",
                    "order-type": "Limit",
                    "size": 100,
                    "underlying-symbol": "AAPL",
                    "underlying-instrument-type": "Equity",
                    "price": "200.5",
                    "price-effect": "Credit",
                    "status": "Contingent",
                    "contingent-status": "Pending Order",
                    "cancellable": true,
                    "editable": true,
                    "edited": false,
                    "received-at": "2023-07-31T15:57:55.245+00:00",
                    "updated-at": 1690819075245,
                    "complex-order-id": 2000010529,
                    "complex-order-tag": "OCO::order",
                    "preflight-id": 0,
                    "legs": [
                        {
                            "instrument-type": "Equity",
                            "symbol": "AAPL",
                            "quantity": 100,
                            "remaining-quantity": 100,
                            "action": "Sell to Close",
                            "fills": []
                        }
                    ]
                },
                {
                    "id": 2002750869,
                    "account-number": "5WT00001",
                    "time-in-force": "GTC",
                    "order-type": "Stop",
                    "size": 100,
                    "underlying-symbol": "AAPL",
                    "underlying-instrument-type": "Equity",
                    "stop-trigger": "150.25",
                    "status": "Contingent",
                    "contingent-status": "Pending Order",
                    "cancellable": true,
                    "editable": true,
                    "edited": false,
                    "received-at": "2023-07-31T15:57:55.289+00:00",
                    "updated-at": 1690819075289,
                    "complex-order-id": 2000010529,
                    "complex-order-tag": "OCO::order",
                    "preflight-id": 1,
                    "legs": [
                        {
                            "instrument-type": "Equity",
                            "symbol": "AAPL",
                            "quantity": 100,
                            "remaining-quantity": 100,
                            "action": "Sell to Close",
                            "fills": []
                        }
                    ]
                }
            ]
        },
        "warnings": [],
        "buying-power-effect": {
            "change-in-margin-requirement": "4904.25",
            "change-in-margin-requirement-effect": "Credit",
            "change-in-buying-power": "311.741",
            "change-in-buying-power-effect": "Credit",
            "current-buying-power": "5698526.349726",
            "current-buying-power-effect": "Credit",
            "new-buying-power": "5698838.090726",
            "new-buying-power-effect": "Credit",
            "isolated-order-margin-requirement": "9808.5",
            "isolated-order-margin-requirement-effect": "Debit",
            "is-spread": false,
            "impact": "311.741",
            "effect": "Credit"
        },
        "fee-calculation": {
            "regulatory-fees": "0.1745",
            "regulatory-fees-effect": "Debit",
            "clearing-fees": "0.08",
            "clearing-fees-effect": "Debit",
            "commission": "0.0",
            "commission-effect": "None",
            "proprietary-index-option-fees": "0.0",
            "proprietary-index-option-fees-effect": "None",
            "total-fees": "0.2545",
            "total-fees-effect": "Debit"
        }
    },
    "context": "/accounts/5WT00001/complex-orders"
}
Path Parameters
account-number
String
The account submitting the order
Cancel Complex Order
Complex orders must be canceled through a separate endpoint where the id is the id of the complex order, not its trigger order or any of its nested orders.

Path Parameters
account-number
String
The account number the order belongs to
id
Integer
The id of the complex order. Not the trigger order id or any of the nested complex order ids.

DELETE
/accounts/{account_number}/complex-orders/{id}
{
    "data": {
        "id": 2000010530,
        "account-number": "5WT00001",
        "type": "OTOCO",
        "trigger-order": {
            "id": 2002750870,
            "account-number": "5WT00001",
            "time-in-force": "Day",
            "order-type": "Limit",
            "size": 100,
            "underlying-symbol": "UA",
            "underlying-instrument-type": "Equity",
            "price": "6.5",
            "price-effect": "Debit",
            "status": "Cancel Requested",
            "cancellable": false,
            "editable": false,
            "edited": false,
            "ext-exchange-order-number": "4202480766358",
            "ext-client-order-id": "96000003d2775f8d96",
            "ext-global-order-number": 978,
            "received-at": "2023-07-31T16:13:56.326+00:00",
            "updated-at": 1690822223659,
            "complex-order-id": 2000010530,
            "complex-order-tag": "OTOCO::trigger-order",
            "legs": [
                {
                    "instrument-type": "Equity",
                    "symbol": "UA",
                    "quantity": 100,
                    "remaining-quantity": 100,
                    "action": "Buy to Open",
                    "fills": []
                }
            ]
        },
        "orders": [
            {
                "id": 2002750871,
                "account-number": "5WT00001",
                "time-in-force": "Day",
                "order-type": "Limit",
                "size": 100,
                "underlying-symbol": "UA",
                "underlying-instrument-type": "Equity",
                "price": "8.0",
                "price-effect": "Credit",
                "status": "Cancelled",
                "cancellable": false,
                "cancelled-at": "2023-07-31T16:50:23.419+00:00",
                "editable": false,
                "edited": false,
                "received-at": "2023-07-31T16:13:56.356+00:00",
                "updated-at": 1690822223466,
                "terminal-at": "2023-07-31T16:50:23.417+00:00",
                "complex-order-id": 2000010530,
                "complex-order-tag": "OTOCO::oco-1-order",
                "legs": [
                    {
                        "instrument-type": "Equity",
                        "symbol": "UA",
                        "quantity": 100,
                        "remaining-quantity": 100,
                        "action": "Sell to Close",
                        "fills": []
                    }
                ]
            },
            {
                "id": 2002750872,
                "account-number": "5WT00001",
                "time-in-force": "Day",
                "order-type": "Stop",
                "size": 100,
                "underlying-symbol": "UA",
                "underlying-instrument-type": "Equity",
                "stop-trigger": "6.0",
                "status": "Cancelled",
                "cancellable": false,
                "cancelled-at": "2023-07-31T16:50:23.552+00:00",
                "editable": false,
                "edited": false,
                "received-at": "2023-07-31T16:13:56.381+00:00",
                "updated-at": 1690822223582,
                "terminal-at": "2023-07-31T16:50:23.552+00:00",
                "complex-order-id": 2000010530,
                "complex-order-tag": "OTOCO::oco-1-order",
                "legs": [
                    {
                        "instrument-type": "Equity",
                        "symbol": "UA",
                        "quantity": 100,
                        "remaining-quantity": 100,
                        "action": "Sell to Close",
                        "fills": []
                    }
                ]
            }
        ]
    },
    "context": "/accounts/5WT00001/complex-orders/2000010530"
}
