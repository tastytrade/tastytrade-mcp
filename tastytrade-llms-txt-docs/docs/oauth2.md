Oauth2
OAuth2 is a widely trusted security standard which tastytrade uses to keep your accounts safe. Instead of sharing your password with every app or website you use, OAuth2 lets you sign in through a service you already trust, like tastytrade. This means your password stays with tastytrade and is never shared with other apps. The app only receives a temporary access token that is limited to specific permissions and revoked anytime you want. It's like giving someone a temporary keycard to one room in your building instead of handing over your master key – much safer and you stay in control.

Short-lived, scoped access tokens (15 minutes) are significantly more secure than long-lived, unscoped session tokens (24 hours). If a 15-minute token gets compromised, an attacker has a very small window to cause damage and can only access the specific resources that token was authorized for – like read-only access to your account.

In contrast, a 24-hour session token gives an attacker an entire day with potentially full access to everything in your account (unless you have 2FA enabled on your account, which we highly recommend you do).

For these reasons, all tastytrade API users must use Oauth2 access tokens when interacting with the tastytrade API. Below are instructions on generating your own Oauth application, grant, and access tokens. Please also read through the Auth Patterns guide to learn how to provide access tokens as bearer tokens in the Authorization header of each API request.

1. Create an Oauth Application
Customers can create their own OAuth2 application on my.tastytrade.com by accessing the Manage tab > My Profile > API > OAuth Applications

Click + New OAuth client.
Client Name will be populated with your tastytrade username
You will then fill out the following items:
Redirect URI per environment requested
Multiple URIs can be sent
These must be full URIs. https://www.my-redirect-uri.com is valid but my-redirect.com is not.
Scopes requested
Valid values: read, trade, openid
Click Create
Upon creating your application you will be presented with your Client ID and Client Secret. These should be stored securely before clicking Finish Setup.

Please Note: Your client secret is a value that we will only show you one time. It is crucial to store it securely upon receipt from tastytrade as it cannot be shared again without creating new credentials. If you do need to create a new client secret, use the Regenerate button at the top of the page. This will invalidate any active grants you may have.



2. Generate a personal grant
Tastytrade makes it easy for you to generate an Oauth2 grant for your own personal application so that you don't have to go through the entire authorization flow.

To generate a grant, head to my.tastytrade.com by accessing the Manage tab > My Profile > API > OAuth Applications. This will display your personal application with a "Manage" button on the right. Click Manage, then click "Create Grant." This will show you your grant's refresh token, which you should use to generate or refresh an access token.



Please Note: Refresh tokens are long-lived and do not expire. If you lose your refresh token or if it becomes compromised, you should delete the corresponding grant on the Api page of my.tastytrade.com. You can always delete a grant and generate a new one. A new grant will have a new refresh token to use in generating an access token.

3. Generate an Access Token
You can make an access token request at this endpoint: POST https://api.tastyworks.com/oauth/token (Sandbox: https://api.cert.tastyworks.com/oauth/token). The following parameters are required:

grant_type - refresh_token
refresh_token
client_secret
See the OAuth2 spec for more information: https://datatracker.ietf.org/doc/html/rfc6749#section-6.

The response will include a new access_token that you need to use as a bearer token in the Authorization header of each request. For example: Authorization: "Bearer <access token>"

Access tokens are good for 15 minutes, after which you'll need to generate another one. Sending a request with an expired access token will result in an Http 401 response code.

Please Note: The client_secret is the secret shown to you after you created the oauth application in step 1. If you lose your client secret, you can generate a new one by going to my.tastytrade.com and navigating to the Manage tab > My Profile > API page. Find your application and click Manage > Settings. The settings page will let you generate a new client secret for your Oauth application. This will not change your client id.



Becoming a Trusted Partner
Personal OAuth applications are designed with security as the top priority. Initially, these applications are restricted to your account only – you can test and develop your integration, but other tastytrade users cannot connect to it yet. This protection ensures that only verified, trustworthy applications can request access to customer accounts.

To enable your application for other users, you'll need to complete our trusted partner verification process. This review helps us maintain the highest security standards for our customers' financial data and ensures your application meets our requirements for data handling and user protection.

If you're interested in becoming a trusted partner and allowing other tastytrade users to securely connect to your application, please contact api.support@tastytrade.com. Once approved, users will be able to safely authorize your application through our secure OAuth flow, with full control over what permissions they grant.

The instructions below apply only to trusted partner Oauth applications.

User Authorization
tastytrade supports the authorization code grant OAuth2 flow. After tastytrade verifies and approves your application, you can direct users to authorize your application at https://my.tastytrade.com/auth.html (Sandbox: https://cert-my.staging-tasty.works/auth.html) with the following parameters:

client_id - required
redirect_uri - required
response_type - required
scope - optional
state - optional
See the OAuth2 spec for more information: https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1.

The screenshot below is what users will see when directed to my.tastytrade.com/auth.html:

Upon successful authorization, the page will redirect users back to the provided redirect_uri with the following query parameters:

code - authorization code
state
See the OAuth2 spec for more information: https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.2.

Request an Access Token
Upon obtaining an authorization code, clients must request an access token by hitting tastytrade's token endpoint: POST https://api.tastyworks.com/oauth/token (Sandbox: https://api.cert.tastyworks.com/oauth/token). The following parameters are required:

grant_type - authorization_code
code - the authorization code sent to the redirect uri
client_id
client_secret
redirect_uri
See the OAuth2 spec for more information: https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.3.

The response will include the following data:

access_token - the token to be sent in each subsequent request in the Authorization header
refresh_token - never expires
token_type - Bearer
expires_in - The number of seconds the access token will be valid
id_token - only returned if using the openid scope
See the OAuth2 spec for more information: https://datatracker.ietf.org/doc/html/rfc6749#section-5.1.

Refresh an Access Token
You can make a refresh token request at this endpoint: POST https://api.tastyworks.com/oauth/token (Sandbox: https://api.cert.tastyworks.com/oauth/token). The following parameters are required:

grant_type - refresh_token
refresh_token
client_secret
See the OAuth2 spec for more information: https://datatracker.ietf.org/doc/html/rfc6749#section-6.

The response will include a new access_token.

Please Note: Refresh tokens are long-lived and do not expire. If you lose your refresh token or if it becomes compromised, please reach out to tastytrade API support immediately.

Two Factor Authentication - 2FA
For sensitive scopes, tastytrade requires customers to use two factor authentication (2FA) in order to grant an application access to their account. Sensitive scopes currently include:

read
trade
In order to enable 2FA, a customer must navigate to My Profile | Security and enable either Authenticator App or SMS Authentication.



During the ‘Authorize with tastytrade’ step, after entering your tastytrade account credentials and clicking ‘Login’ the customer will be prompted to enter their 2FA code either sent via SMS or on the Authenticator App they have set up.



