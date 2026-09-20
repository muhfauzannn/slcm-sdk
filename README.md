# SLCM SDK

A type-safe Node.js SDK for integrating with SLCM UI. The current release
implements SLCM login through OpenID Connect Authorization Code + PKCE without
opening a browser.

> This project is an independent integration library. It is not an official
> Universitas Indonesia package. Use it only with accounts and systems you are
> authorized to access.

## Requirements

- Node.js 20 or newer
- An active SSO UI account

The package has no runtime dependencies and works with ESM and CommonJS.

## Installation

```bash
pnpm add slcm-sdk
```

## Quick start

```ts
import { SlcmClient } from "slcm-sdk";

const slcm = new SlcmClient();
const session = await slcm.login({
  username: process.env.SSO_UI_USERNAME!,
  password: process.env.SSO_UI_PASSWORD!,
});

console.log(session.user?.full_name);
console.log(session.orgCode);
```

`login()` performs the complete handshake:

1. creates a PKCE verifier, challenge, state, and nonce;
2. loads the Keycloak login form and keeps its session cookie;
3. submits the SSO UI credentials;
4. validates the returned state and exchanges the authorization code;
5. calls SLCM `/user` to obtain the required `x-app-token` and account metadata.

Passwords are sent only to `login.ui.ac.id` over HTTPS. The SDK does not persist
credentials, tokens, or cookies.

## Calling an authenticated endpoint

SLCM API calls need both the OAuth bearer token and `x-app-token`.
`getAuthHeaders()` supplies both and refreshes an access token that is close to
expiry.

```ts
const headers = await session.getAuthHeaders();

const response = await fetch(
  "https://slcm.ui.ac.id/akademik/api/v1/class/period",
  { headers },
);

if (!response.ok) throw new Error(`SLCM returned ${response.status}`);
const periods = await response.json();
```

The current version deliberately keeps arbitrary endpoint calls outside the SDK
until those endpoint contracts are implemented and typed. This prevents a
generic request helper from becoming an unstable public API.

## Reading periods and class schedules

After login, a session can load the academic periods and the three SLCM class
categories:

```ts
const periods = await session.getPeriods();
const activePeriod = await session.getActivePeriod();
const schedule = await session.getSchedule({ period: activePeriod });

console.log(activePeriod.period); // for example, "2026-1"
console.log(schedule.classes.length);
console.log(schedule.byType.internal);
console.log(schedule.byType.group);
console.log(schedule.byType.external);
```

`getSchedule()` requests `internal`, `group`, and `external` concurrently. Each
class has a normalized camel-case shape and a `type` field. Nullable SLCM arrays
such as `dates_rooms`, `periods`, and `lecturers` are returned as empty arrays.
Trailing spaces in course names and lecturer names are removed.

The `all-periods` response has no active flag and may list a future semester
first. During login, the SDK loads the authoritative period summary from
`/akademik/api/v1/class/period`. `getActivePeriod()` matches that value against
`all-periods` for the complete period object. It never infers the active period
from array order or the current date. Applications may also pass a period
explicitly:

```ts
const schedule = await session.getSchedule({
  period: { year: 2026, term: 1, period: "2026-1", value: "" },
  language: "id",
});
```

For one category only:

```ts
const internal = await session.getClassTable({
  type: "internal",
  period: activePeriod,
});
```

### Classes taken by the user

The class-table methods above return classes offered to the account, including
classes the user did not take. Use `getMyClasses()` for the user's current
course-plan classes:

```ts
const myClasses = await session.getMyClasses();

console.log(myClasses.warningStaleData);
for (const courseClass of myClasses.classes) {
  console.log(courseClass.courseName, courseClass.className);
  console.log(courseClass.teachers);
  console.log(courseClass.meetings);
}
```

Each meeting contains a date range, day/time, and room. The API's
`warning-stale-data` flag is preserved as `warningStaleData` so applications can
warn users when the portal reports cached data.

## Refreshing a session

```ts
await session.refresh();

// A read-only copy. Updating it does not mutate the session.
console.log(session.tokens.expiresAt);
```

Refresh responses that omit a replacement refresh token or ID token retain the
previous value, matching standard Keycloak token rotation behavior.

## Cancellation and timeout

Every login and refresh request has a 15-second timeout by default. Pass an
`AbortSignal` to cancel the complete operation:

```ts
const controller = new AbortController();

const login = slcm.login({
  username: process.env.SSO_UI_USERNAME!,
  password: process.env.SSO_UI_PASSWORD!,
  signal: controller.signal,
});

controller.abort();
await login;
```

## Configuration

```ts
const slcm = new SlcmClient({
  timeoutMs: 10_000,
  retries: 2,
  retryDelayMs: 250,
  refreshMarginMs: 60_000,
  userAgent: "my-service/1.0",
  onEvent(event) {
    logger.info(event);
  },
});
```

`onEvent` never receives credentials or token values. Transient network errors,
HTTP 429, and HTTP 5xx responses are retried with exponential backoff. An
externally aborted request is not retried.

`fetch`, OIDC client settings, and endpoints can also be injected for testing or
controlled environments. Changing the default SLCM identity-provider settings
is an advanced option and can break the login contract.

## API reference

### `new SlcmClient(options?)`

Creates an isolated client. A client contains configuration only; it does not
store a shared logged-in user.

### `client.login({ username, password, signal? })`

Returns `Promise<SlcmSession>`. Every invocation creates an independent SLCM
session, so one client can safely log in multiple accounts concurrently.

### `SlcmSession`

- `tokens` — a copy of the OAuth token set, with `obtainedAt` and `expiresAt`.
- `xAppToken` — the SLCM application token required by API requests.
- `user` — user metadata decoded from the application token, or `null`.
- `orgCode` — normalized organization code, or `null`.
- `role` — normalized SLCM role, or `null`.
- `isExpired` — whether the access token has passed its expiry timestamp.
- `refresh(signal?)` — explicitly refresh the OAuth and application tokens.
- `getAuthHeaders(signal?)` — return both authentication headers, refreshing
  first when needed.
- `snapshot()` — return a detached snapshot suitable for short-lived transfer.
- `getPeriods(signal?)` — list all periods returned by SLCM.
- `activePeriod` — authoritative active-period identity from the login summary.
- `getActivePeriod(options?)` — match the login summary's active period against
  `all-periods`.
- `getClassTable(options)` — load one class category for a period.
- `getSchedule(options?)` — load and combine all three class categories.
- `getMyClasses(signal?)` — load only classes in the user's course plan.

Treat every token and snapshot as a secret. Do not send them to a browser,
include them in logs, or store them without appropriate encryption and access
controls.

### Errors

All SDK errors extend `SlcmError` and have a stable `code`:

| Class | Code | Meaning |
| --- | --- | --- |
| `SlcmAuthenticationError` | `AUTHENTICATION_FAILED` | Credentials or session were rejected, or state validation failed. |
| `SlcmNetworkError` | `NETWORK_ERROR` | Network, timeout, rate-limit, or server failure after retries. |
| `SlcmProtocolError` | `PROTOCOL_ERROR` | The provider returned an unexpected page or payload. |
| `SlcmInvalidArgumentError` | `INVALID_ARGUMENT` | Invalid SDK input or configuration. |

```ts
import { SlcmAuthenticationError } from "slcm-sdk";

try {
  await slcm.login({ username, password });
} catch (error) {
  if (error instanceof SlcmAuthenticationError) {
    // Ask the user to check their credentials.
  }
  throw error;
}
```

## Manual implementation

For a protocol-level explanation and a standalone implementation outline that
does not use this package, see [Manual SLCM login](docs/manual-login.md).

## Development

```bash
pnpm install
pnpm run ci
```

`pnpm run ci` runs strict TypeScript checks, unit tests, and both ESM/CommonJS
production builds.

## Live login verification

The automated tests use mocked provider responses. To verify the current live
SLCM portal, provide credentials through temporary environment variables and
run the bundled smoke test:

```bash
read "SSO_UI_USERNAME?SSO UI username: "
read -s "SSO_UI_PASSWORD?SSO UI password: "
echo

export SSO_UI_USERNAME SSO_UI_PASSWORD
pnpm verify:login
unset SSO_UI_USERNAME SSO_UI_PASSWORD
```

The verifier prints account metadata, boolean token checks, the selected active
period, offered-class counts, and the user's taken-class count. It never prints
the password, token values, or class details.
