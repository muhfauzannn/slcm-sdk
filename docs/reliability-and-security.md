# Reliability and security for manual integrations

Direct SLCM integration handles credentials and short-lived tokens. Treat the
following requirements as part of the protocol, not optional polish.

## Timeouts and cancellation

Native `fetch` has no application-specific deadline. Give every request a
timeout and connect it to caller cancellation.

```js
function request(url, init = {}, callerSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeout])
    : timeout;
  return fetch(url, { ...init, signal });
}
```

Do not retry when the caller's signal is already aborted.

## Retry policy

Bound retries and use exponential backoff.

Safe transient retry candidates:

- transport failures;
- request timeout;
- HTTP 429;
- HTTP 5xx.

Do not retry ordinary HTTP 4xx responses as network failures. For authenticated
read endpoints, a 401/403 can trigger one token refresh and one replay.

Before adding any mutation endpoint, determine whether repeating it is
idempotent. Do not apply the read-request retry policy to mutations by default.

## Token lifecycle

Store at least:

- `access_token`;
- `refresh_token`;
- `id_token`;
- `token_type`;
- `expires_in`;
- the local timestamp at which tokens were obtained;
- `x-app-token` from `/akademik/api/user`.

Refresh before access expiry with a safety margin. After refreshing OAuth,
request a new `x-app-token`; the old application token must not be assumed valid
with the new access token.

A refresh response may omit replacement `refresh_token` or `id_token` values.
Retain the previous values when absent.

## Secret handling

Never log or expose:

- SSO username or password;
- Keycloak cookies;
- authorization code;
- PKCE verifier;
- OAuth access, refresh, or ID tokens;
- `x-app-token`;
- full provider HTML that may echo credentials or session parameters.

If a provider error message is surfaced, redact known credentials before
returning or logging it. Remove query strings and fragments when logging URLs.

Keep integration code server-side. Do not ship account credentials, OAuth
tokens, or `x-app-token` to browser bundles.

## OIDC validation

- Generate state, nonce, and PKCE verifier with cryptographic randomness.
- Require PKCE S256.
- Verify the credential form remains on the expected identity-provider origin.
- Verify callback origin and path.
- Compare returned state exactly before exchanging the code.
- Reject missing code, state, redirect, or dynamic form action.

## Response validation

Treat every JSON response as untrusted input.

- Validate top-level objects and `data` arrays.
- Validate every required scalar type.
- Handle only documented nullable fields.
- Reject mismatched parallel arrays.
- Distinguish an empty valid array from a malformed response.
- Do not assume HTTP 200 means the payload has the expected business shape.

Provider field names should be translated at your application boundary. Keep
raw shapes isolated so a provider change does not leak through the codebase.

## Session isolation

Maintain tokens and metadata per logged-in account. Do not use module-level
mutable tokens or one shared cookie jar. Concurrent accounts must never share:

- cookies;
- OAuth tokens;
- `x-app-token`;
- active-period metadata;
- user metadata.

## Testing without live SLCM

Inject or mock `fetch` and test the complete request sequence.

At minimum, cover:

- PKCE parameters and code verifier exchange;
- Keycloak cookie forwarding;
- credential rejection;
- OIDC state mismatch;
- secret redaction;
- token refresh with and without rotated tokens;
- both authentication headers on academic endpoints;
- authoritative active period winning over `all-periods[0]`;
- all three offered-class categories;
- nullable class-table arrays;
- course-plan teacher and meeting mapping;
- stale-data warning preservation;
- malformed provider payloads.

Never send schedule mutations to the live service from automated tests.
