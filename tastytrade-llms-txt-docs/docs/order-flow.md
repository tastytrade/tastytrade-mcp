Order Flow
Orders in the tastytrade system can go through many different status changes. These statuses can be hard to keep track of and can quickly become overwhelming for new traders. Don't get discouraged! This page is here to help you make sense of the order lifecycle and hopefully help you decipher the statuses of your various orders.

We find that it's easiest to group orders into 3 phases, each of which is described in more detail below:

Submission phase
Working phase
Terminal phase
Submission Phase
Order statuses in the submission phase: Received, Routed, Contingent, In Flight

This phase pertains to orders that have not yet been received by any exchange, and are therefore not considered "working" orders yet.

You may notice that when you initially submit your order, its status is often Routed. Routed means the order is currently being submitted to an exchange.

Immediately following Routed is the In Flight status. In Flight means the order has left our system and is awaiting confirmation that the exchange has received it.

You will see a Received status when you submit an order when the markets are closed. This means that we have received the order and it will be routed as soon as the markets open up.

A status of Contingent applies to complex orders, specifically OTOCO and OTO orders. These are special orders that sit dormant in our system until another order "triggers" them, at which point they will be routed to an exchange.

Replacement orders may also be Contingent immediately after you submit them. This means the replacement order is waiting to be "triggered" by the order it is replacing. The trigger occurs when the original order transitions to Canceled status, at which point the replacement order will be routed.

Occasionally you might submit an order and immediately get a Rejected status. This is considered a terminal status (see below) and can occur if, for example, your account doesn't have sufficient buying power to place the order.

Working Phase
Order statuses in the working phase: Live, Cancel Requested, Replace Requested

The working phase is when you can consider an order "live". In other words, it has made it to the exchange and the exchange has sent us confirmation. This phase can last anywhere from a few milliseconds to days or even months (GTC orders stay alive until you cancel them!)

The Live status is always the first status after the submission phase. Once an order is Live, you may cancel it or replace it.

Cancel Requested is the status when you decide to cancel your order. This means that we have sent your request to the exchange and are awaiting confirmation from them. Once we receive confirmation, the order status will become Canceled (see below).

Replace Requested works the same way. Suppose you have a Live order that you'd like to replace. We will refer to this Live order as the original order. You submit a replacement order and we mark the original order Replace Requested. We then send a cancel request for that original order to the exchange. During this time, the replacement order's status is Contingent, waiting for the original order to become Canceled. When the exchange confirms that it has canceled the original order, we will route the replacement order.

This highlights an important feature of the tastytrade system - we don't actually route your replacement order until your original order has been canceled. You can achieve the same effect by cancelling the original order and sending a new order separately. This just allows you to do it in one request.

Terminal Phase
Order statuses in the terminal phase: Filled, Canceled, Rejected, Expired

Once an order enters any of these statuses, it will receive no further status updates. It is terminal.

Filled means your order has been filled. If your order to buy to open 100 shares of AAPL was filled, you now own 100 shares of AAPL.

A few things happen when an order fills that we'd like to note here:

A position is created/updated. Fetch your positions here.
Your account balance is updated. Fetch your account balance here.
A trade transaction is created to reflect the trade and associated fees. Fetch your transactions here.
Note: tastytrade marks orders Filled as soon as possible, even if we haven't finished processing every single fill associated with the order. If your order's status is Filled but it missing fills for one or more legs, it means you hit our API while our system was still processing the fills. You should expect this behavior and can re-send your request to get the remaining fills after a brief delay. Fills should finish procesing within milliseconds.

Rejected status can occur during the submission phase or during the working phase. For example, an order for a non-existent stock symbol will be rejected without ever being routed.

Canceled means the user canceled the order.

Expired mostly applies to day orders that don't fill by the time the market closes. tastytrade automatically marks these as Expired.

Order Status Definitions
Status	Meaning	Terminal
Received	Initial order state	No
Routed	Order is on its way out of tastytrade's system	No
In Flight	Order is en route to the exchange	No
Live	Order is live at the exchange	No
Cancel Requested	Customer has requested to cancel the order. Awaiting a 'cancelled' message from the exchange.	No
Replace Requested	Customer has submitted a replacement order. This order is awaiting a 'cancelled' message from the exchange.	No
Contingent	This means the order is awaiting a status update of a related order. This pertains to replacement orders, complex OTOCO orders, and complex OTO orders.	No
Filled	Order has been fully filled	Yes
Cancelled	Order is cancelled	Yes
Expired	Order has expired. Usually applies to an option order.	Yes
Rejected	Order has been rejected by either tastytrade or the exchange.	Yes
Removed	Administrator has manually removed this order from customer account.	Yes
Partially Removed	Administrator has manually removed part of this order from customer account.	Yes
Examples of Order Status Transitions
1. Immediate fill

Suppose you submit a market order to buy a few shares of AMZN and it immediately gets filled. The order status would transition like this:

Received -> Routed -> In Flight -> Live -> Filled

2. Canceled by customer

Suppose you submit a limit order to buy some shares of AMZN but it doesn't fill right away, so you decide to cancel it:

Received -> Routed -> In Flight -> Live -> Cancel Requested -> Canceled

3. Expired day order

Suppose you submit a limit order to buy some shares of AMZN, give it a time-in-force of Day, but it sits at the exchange all day and doesn't fill. Finally the order expires when the markets close:

Received -> Routed -> In Flight -> Live -> Expired

4. Rejected by brokerage

Suppose you submit a limit order to buy some options that have already expired. tastytrade's system would recognize this and reject the order immediately. The order status would transition like this:

Received -> Rejected

