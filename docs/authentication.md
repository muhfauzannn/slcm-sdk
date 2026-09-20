# Authentication without the SDK

SLCM uses Keycloak OpenID Connect Authorization Code flow with PKCE. The login
page is server-rendered, so the flow can be completed with HTTP requests and a
cookie jar; browser automation is not required.

## OIDC configuration

| Setting | Value |
| --- | --- |
| Client ID | `slcm-beasiswa` |
| Redirect URI | `https://slcm.ui.ac.id/portal` |
| Authorization endpoint | `https://login.ui.ac.id/realms/main/protocol/openid-connect/auth` |
| Token endpoint | `https://login.ui.ac.id/realms/main/protocol/openid-connect/token` |
| Response type | `code` |
| Response mode | `fragment` |
| Scope | `openid` |
| PKCE method | `S256` |

## Login sequence

1. Generate a cryptographically random PKCE `code_verifier`.
2. Calculate `BASE64URL(SHA256(code_verifier))` as `code_challenge`.
3. Generate independent cryptographically random `state` and `nonce` values.
4. Request the authorization endpoint with the OIDC settings above.
5. Retain every Keycloak `Set-Cookie` header.
6. Parse the returned HTML form action. It contains short-lived
   `session_code`, `execution`, and `tab_id` query parameters; never hard-code
   it.
7. Validate that the form action remains on `login.ui.ac.id` before sending
   credentials.
8. Form-POST `username`, `password`, and an empty `credentialId`, including the
   retained cookies. Use `redirect: "manual"`.
9. Successful credentials return HTTP 302. Read `code` and `state` from the
   fragment in the `Location` header.
10. Validate the callback origin, path, and exact `state` value.
11. Exchange `code` plus the original `code_verifier` at the token endpoint.
12. Call SLCM `/akademik/api/user` with the access token and read
    `data.userToken`. This is the required `x-app-token`.

## Minimal Node.js implementation

This example shows the protocol. Production code also needs the timeout,
retry, cancellation, validation, and secret-handling requirements in
[Reliability and security](reliability-and-security.md).

```js
import crypto from "node:crypto";

const clientId = "slcm-beasiswa";
const redirectUri = "https://slcm.ui.ac.id/portal";
const authorizationEndpoint =
  "https://login.ui.ac.id/realms/main/protocol/openid-connect/auth";
const tokenEndpoint =
  "https://login.ui.ac.id/realms/main/protocol/openid-connect/token";

const codeVerifier = crypto.randomBytes(32).toString("base64url");
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");
const state = crypto.randomUUID();

const authorizationUrl = new URL(authorizationEndpoint);
authorizationUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  response_mode: "fragment",
  scope: "openid",
  state,
  nonce: crypto.randomUUID(),
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
}).toString();

const loginPage = await fetch(authorizationUrl);
if (!loginPage.ok) throw new Error(`Login page: HTTP ${loginPage.status}`);

const html = await loginPage.text();
const encodedAction = html.match(
  /action\s*=\s*["']([^"']*login-actions\/authenticate[^"']*)["']/i,
)?.[1];
if (!encodedAction) throw new Error("Keycloak login form was not found");

const formAction = new URL(
  encodedAction.replaceAll("&amp;", "&"),
  loginPage.url,
);
if (formAction.origin !== new URL(authorizationEndpoint).origin) {
  throw new Error("Unexpected credential form origin");
}

// A production implementation must use a complete cookie jar.
const cookieHeader = loginPage.headers
  .getSetCookie()
  .map((cookie) => cookie.split(";", 1)[0])
  .join("; ");

const credentialResponse = await fetch(formAction, {
  method: "POST",
  redirect: "manual",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: cookieHeader,
  },
  body: new URLSearchParams({
    username: process.env.SSO_UI_USERNAME,
    password: process.env.SSO_UI_PASSWORD,
    credentialId: "",
  }),
});
if (credentialResponse.status !== 302) {
  throw new Error(`Credentials rejected: HTTP ${credentialResponse.status}`);
}

const location = credentialResponse.headers.get("location");
if (!location) throw new Error("OIDC callback location is missing");
const callback = new URL(location, redirectUri);
const expectedCallback = new URL(redirectUri);
if (
  callback.origin !== expectedCallback.origin ||
  callback.pathname !== expectedCallback.pathname
) {
  throw new Error("Unexpected OIDC callback location");
}

const fragment = new URLSearchParams(callback.hash.slice(1));
if (fragment.get("state") !== state) throw new Error("OIDC state mismatch");
const code = fragment.get("code");
if (!code) throw new Error("Authorization code is missing");

const tokenResponse = await fetch(tokenEndpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  }),
});
if (!tokenResponse.ok) {
  throw new Error(`Token exchange: HTTP ${tokenResponse.status}`);
}
const tokens = await tokenResponse.json();

const userResponse = await fetch(
  "https://slcm.ui.ac.id/akademik/api/user",
  { headers: { Authorization: `Bearer ${tokens.access_token}` } },
);
if (!userResponse.ok) throw new Error(`SLCM user: HTTP ${userResponse.status}`);
const user = await userResponse.json();
const xAppToken = user.data?.userToken;
if (!xAppToken) throw new Error("SLCM x-app-token is missing");

const authHeaders = {
  Authorization: `Bearer ${tokens.access_token}`,
  "x-app-token": xAppToken,
};
```

## Refreshing tokens

POST the refresh token to the same token endpoint:

```http
POST /realms/main/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=<refresh_token>&client_id=slcm-beasiswa
```

The response may rotate `refresh_token` and `id_token`. Use new values when
present; otherwise retain their previous values. After every refresh, call
`/akademik/api/user` again with the new access token to obtain a fresh
`x-app-token`.

For a 401/403 from a read endpoint, refresh and repeat the request once. Do not
create an unbounded authentication loop.
