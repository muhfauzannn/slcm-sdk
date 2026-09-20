# Manual SLCM login without the SDK

This document explains the login protocol so an integration can be built
without `slcm-sdk`. The values below reflect the SLCM web client at the time this
package was implemented and may change when the portal is updated.

## Protocol overview

SLCM uses Keycloak OpenID Connect Authorization Code flow with PKCE:

| Setting | Value |
| --- | --- |
| Client ID | `slcm-beasiswa` |
| Redirect URI | `https://slcm.ui.ac.id/portal` |
| Authorization endpoint | `https://login.ui.ac.id/realms/main/protocol/openid-connect/auth` |
| Token endpoint | `https://login.ui.ac.id/realms/main/protocol/openid-connect/token` |
| User endpoint | `https://slcm.ui.ac.id/akademik/api/user` |
| PKCE method | `S256` |
| Response mode | `fragment` |
| Scope | `openid` |

The login is browser-shaped but does not require browser automation. The
Keycloak page is server-rendered, so an HTTP client with cookie handling is
enough.

## Steps

1. Generate a cryptographically random PKCE `code_verifier` and calculate
   `BASE64URL(SHA256(code_verifier))` as the `code_challenge`.
2. Generate independent random `state` and `nonce` values.
3. Send `GET` to the authorization endpoint with the table values above plus
   `state`, `nonce`, `code_challenge`, and `code_challenge_method=S256`.
4. Retain every `Set-Cookie` value. Parse the returned HTML form action; it
   contains short-lived `session_code`, `execution`, and `tab_id` values. Never
   hard-code this URL.
5. Send a form-encoded `POST` to that action with `username`, `password`, and an
   empty `credentialId`. Include the retained cookies and disable automatic
   redirect following for this request.
6. A successful credential submission returns HTTP 302. Parse `code` and
   `state` from the fragment of its `Location` header. Reject the response if
   `state` is not exactly the generated value.
7. Exchange the code at the token endpoint using a form-encoded `POST` with
   `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and the
   original `code_verifier`.
8. Send `GET /akademik/api/user` with `Authorization: Bearer <access_token>`.
   Read `data.userToken` from the JSON response. This is the `x-app-token`.
9. Authenticated SLCM API requests require both headers:

   ```http
   Authorization: Bearer <access_token>
   x-app-token: <data.userToken>
   ```

## Minimal Node.js outline

This deliberately leaves production concerns such as timeout, retries, complete
cookie parsing, structured errors, and response validation visible. Those are
not optional in a deployed service.

```js
import crypto from "node:crypto";

const clientId = "slcm-beasiswa";
const redirectUri = "https://slcm.ui.ac.id/portal";
const authorize =
  "https://login.ui.ac.id/realms/main/protocol/openid-connect/auth";
const tokenEndpoint =
  "https://login.ui.ac.id/realms/main/protocol/openid-connect/token";

const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto
  .createHash("sha256")
  .update(verifier)
  .digest("base64url");
const state = crypto.randomUUID();

const authUrl = new URL(authorize);
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  state,
  response_mode: "fragment",
  response_type: "code",
  scope: "openid",
  nonce: crypto.randomUUID(),
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const page = await fetch(authUrl);
const html = await page.text();
const action = html.match(
  /action\s*=\s*["']([^"']*login-actions\/authenticate[^"']*)["']/i,
)?.[1].replaceAll("&amp;", "&");
if (!action) throw new Error("Login form not found");

// For production, use a real cookie jar and preserve every Set-Cookie header.
const cookies = page.headers
  .getSetCookie()
  .map((value) => value.split(";", 1)[0])
  .join("; ");

const submitted = await fetch(new URL(action, page.url), {
  method: "POST",
  redirect: "manual",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: cookies,
  },
  body: new URLSearchParams({
    username: process.env.SSO_UI_USERNAME,
    password: process.env.SSO_UI_PASSWORD,
    credentialId: "",
  }),
});
if (submitted.status !== 302) throw new Error("Credentials rejected");

const redirect = new URL(submitted.headers.get("location"), redirectUri);
const fragment = new URLSearchParams(redirect.hash.slice(1));
if (fragment.get("state") !== state) throw new Error("OIDC state mismatch");

const tokenResponse = await fetch(tokenEndpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: fragment.get("code"),
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  }),
});
const tokens = await tokenResponse.json();

const userResponse = await fetch(
  "https://slcm.ui.ac.id/akademik/api/user",
  { headers: { Authorization: `Bearer ${tokens.access_token}` } },
);
const user = await userResponse.json();

const authHeaders = {
  Authorization: `Bearer ${tokens.access_token}`,
  "x-app-token": user.data.userToken,
};
```

## Reading periods and schedules

Use both authentication headers from the login flow for every request below.

First retrieve the available periods:

```http
GET https://slcm.ui.ac.id/akademik/api/v1/shared/all-periods
Authorization: Bearer <access_token>
x-app-token: <data.userToken>
```

The response contains `data[]` entries with `year`, `term`, `period`, and
`value`. It does not contain an active flag and may put a future semester first,
so do not blindly assume `data[0]` is active. Use `activePeriod` from the login
session summary as the source of truth, then find the matching entry in this
list.

Once a period is chosen, request each supported class type separately:

```http
GET https://slcm.ui.ac.id/akademik/api/v1/class/table?type=internal&year=2026&term=1&lang=id
GET https://slcm.ui.ac.id/akademik/api/v1/class/table?type=group&year=2026&term=1&lang=id
GET https://slcm.ui.ac.id/akademik/api/v1/class/table?type=external&year=2026&term=1&lang=id
```

There is no reliable `type=all` request; fetch the three categories individually
and combine them in the application. The `periods`, `dates_rooms`, and
`lecturers` fields can be `null`, even when other rows return arrays.

## Refreshing tokens

Post to the same token endpoint with:

```text
grant_type=refresh_token
refresh_token=<refresh_token>
client_id=slcm-beasiswa
```

After every refresh, call `/akademik/api/user` again with the new access token
to obtain a fresh `x-app-token`. A refresh response may rotate the refresh token;
store the new one when present and retain the old one when absent.

## Production checklist

- Put a timeout on every network request and connect cancellation to the caller.
- Retry only transient failures (`429`, `5xx`, timeout, and transport errors).
- Validate OIDC `state` before exchanging a code.
- Parse the provider response instead of assuming every HTTP 200 is success.
- Never log credentials, cookies, authorization codes, or token values.
- Keep credentials and tokens server-side; do not expose them to browser code.
- Isolate session state per account so concurrent users cannot share tokens.
- Treat HTML selectors and endpoint response shapes as versioned integration
  contracts and cover them with fixtures or mocked tests.
