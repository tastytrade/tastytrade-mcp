Sandbox Environment
The sandbox environment is a controlled system for open-api users.
The system resets every 24 hours, meaning all trades, transactions, and positions are deleted and balances are cleared out. Users, customers, and accounts are untouched.
To start, you will need to sign in with your sandbox user credentials. All subsequent actions here (customer creation, account creation) will be tied to this user.
The base url for all sandbox api endpoints is api.cert.tastyworks.com
The websocket url for account streamer updates is streamer.cert.tastyworks.com
Quotes in the sandbox environment are always 15-minutes delayed.
Please note our Sandbox Environment instrumentation sometimes lags behind our live trading environment, which occasionally causes valid symbols to fail with 422 error codes. If you experience this please send a message to api.support@tastytrade.com and we will correct them right away.

Not every service is available in our sandbox environment. The following services are only available in our live trading system currently:

Net liquidating value history
Market metrics
Real-time market-data (streaming-market-data available via delayed feed)
OAuth2 in Sandbox

OAuth2 is supported in the Sandbox environment. Please use the tools at the bottom of the page to create and manage your personal application once you have logged in with your Sandbox user. If you lose your client secret you will need to regenerate it as it will only be shown once after creating the initial application.


