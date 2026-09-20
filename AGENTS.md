# AGENTS.md — SLCM SDK

Instructions for AI agents and contributors working in this repository. Read
this file completely before changing code or documentation.

## Project purpose

`slcm-sdk` is a reusable Node.js package that hides SLCM integration details
behind a typed, maintainable API. It is a library, not an application, backend,
CLI product, database service, or browser automation project.

Current supported features:

1. SSO UI login through OpenID Connect Authorization Code + PKCE.
2. OAuth token refresh and retrieval of SLCM's required `x-app-token`.
3. Active-period resolution.
4. Reading all available academic periods.
5. Reading offered `internal`, `group`, and `external` classes.
6. Reading classes in the logged-in user's current course plan.

The package must remain usable as an independent dependency installed through
pnpm, npm, or another Node.js package manager.

## Commands and completion gate

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm run ci       # required before handoff
pnpm verify:login # optional live check; requires temporary SSO credentials
```

`pnpm run ci` must pass before work is considered complete. It runs strict
TypeScript checking, mocked protocol tests, and ESM/CommonJS production builds.

Do not perform a live login unless the user explicitly provides credentials or
runs the verifier themselves. Never place credentials in source code, fixtures,
command history, logs, or documentation.

## Documentation ownership

Each documentation surface has exactly one responsibility:

| Surface | Audience | Content |
| --- | --- | --- |
| `README.md` | SDK consumers | Installation, public API usage, examples, configuration, errors, verification. |
| `AGENTS.md` | AI agents and contributors | Architecture, invariants, change process, restrictions, test expectations. |
| `docs/` | Developers implementing SLCM manually | Raw HTTP protocol, endpoint contracts, payload handling, reliability and security without the SDK. |

### Mandatory synchronization rule

Any code change that affects a public method, public type, endpoint, request,
response mapping, authentication behavior, retry behavior, or documented quirk
must update every affected documentation surface in the same change.

Before handoff, verify all of the following:

- README examples compile conceptually against the exported API.
- AGENTS architecture and invariants still match the implementation.
- Manual docs describe the actual raw SLCM protocol, not SDK abstractions.
- Endpoint paths and authentication requirements are identical everywhere.
- No removed behavior remains documented.
- No new public behavior is undocumented.

Do not copy the same long explanation into all three surfaces. Update each from
its audience's perspective.

## Technology and package contract

- Node.js `>=20`.
- TypeScript with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- ESM source using NodeNext resolution. Relative TypeScript imports include
  `.js` extensions.
- ESM and CommonJS output built by `tsup`.
- No runtime dependencies unless a future feature cannot reasonably be built
  with Node.js platform APIs.
- Native `fetch`, `AbortSignal.timeout`, Web `Response`, and Node crypto APIs.
- Public declarations emitted to `dist/index.d.ts` and `dist/index.d.cts`.

The package name, exports map, Node engine, module formats, and public symbols in
`src/index.ts` are compatibility-sensitive. Do not change them casually.

## Repository map

```text
src/
  index.ts                    Public export surface only
  client.ts                   Configuration, login, refresh, authenticated I/O
  session.ts                  Public logged-in session methods and state
  types.ts                    Public request/result types
  constants.ts                Default endpoints and protocol constants
  errors.ts                   Stable public error taxonomy
  internal/
    crypto.ts                 PKCE material
    cookies.ts                Minimal Keycloak cookie jar
    http.ts                   Timeout, cancellation, transient retry
    protocol.ts               Login/token/user/active-period parsing
    schedule-protocol.ts      Period, class-table, and course-plan parsing
test/
  login.test.ts               OIDC, refresh, validation, secret redaction
  schedule.test.ts            Active period and schedule endpoint contracts
docs/
  README.md                   Manual-integration index
  authentication.md           OIDC + PKCE and x-app-token
  periods-and-schedules.md    Active period and offered-class endpoints
  course-plan.md              Classes taken by the user
  reliability-and-security.md Timeouts, refresh, retries, secrets, validation
verify-login.mjs              Safe live smoke test
.github/
  workflows/
    ci.yml                    Node 20/24 validation for pushes and pull requests
    publish.yml               npm release publishing through trusted OIDC
```

## Continuous integration

`.github/workflows/ci.yml` is the required GitHub Actions gate. It runs for
every pull request and every push to `main`, using both Node.js 20 (the minimum
supported runtime) and Node.js 24. Each matrix job must:

1. install the pinned pnpm version from `packageManager`;
2. install dependencies with `--frozen-lockfile`;
3. run `pnpm run ci`.

Keep the workflow read-only (`contents: read`). Publishing does not belong in
this workflow.

`.github/workflows/publish.yml` is the separate npm release workflow. It runs
only when a GitHub Release is published, checks out that release's tag, and
requires the tag to equal `v<package.json version>` before calling
`npm publish`. The package's `prepublishOnly` script runs the complete CI gate
before npm uploads anything. Publishing uses npm trusted publishing/OIDC with
`id-token: write`; never add a long-lived `NPM_TOKEN`. Keep release builds on a
Node/npm combination supported by npm trusted publishing.

Before the first automated release, configure the package's trusted publisher
on npm for GitHub user `muhfauzannn`, repository `slcm-sdk`, and workflow
filename `publish.yml`. Do not configure a GitHub environment unless the same
environment name is added to both the workflow job and npm trusted publisher.

Release versions are immutable. To release after `0.1.0`, update the package
version, commit it, let CI pass, and create a GitHub Release whose tag is the
matching `v`-prefixed version (for example, package `0.1.1` uses tag `v0.1.1`).

Pin every third-party GitHub Action to its immutable, full 40-character commit
SHA. Keep the corresponding release tag in an inline comment so dependency
updates remain understandable. Never reference an action by a mutable branch or
version tag alone.

## Architecture

### Public boundary

Consumers create one `SlcmClient`, call `login()`, and receive an isolated
`SlcmSession`. A client stores configuration only. Account-specific tokens and
metadata belong to the session.

```text
SlcmClient.login(credentials)
  -> OIDC + PKCE
  -> OAuth token set
  -> GET /akademik/api/user
  -> x-app-token + user metadata
  -> GET /akademik/api/v1/class/period
  -> authoritative active-period identity
  -> SlcmSession
```

Do not introduce shared mutable authentication state. Multiple accounts must be
able to log in concurrently through one client without sharing tokens, cookies,
periods, or user information.

### Transport boundary

All SLCM and identity-provider I/O goes through `internal/http.ts`. New code must
not call global `fetch` directly. This guarantees:

- timeout per request;
- caller cancellation;
- bounded retry of transport failures, HTTP 429, and HTTP 5xx;
- injectable `fetch` for tests;
- safe retry events without secrets.

Mutation endpoints require an explicit retry/idempotency review before being
added. The current endpoints are read-only except for credential submission and
token exchange.

### Parser boundary

Network responses are `unknown` until validated by a parser. Do not cast raw
JSON directly to public result types.

- Login/token/user payloads: `internal/protocol.ts`.
- Academic payloads: `internal/schedule-protocol.ts`.
- Provider field names remain inside internal parsers.
- Public results use readable camelCase names.
- Unexpected shapes throw `SlcmProtocolError` with no secret data.

### Public error boundary

Every SDK-controlled failure uses the stable taxonomy in `errors.ts`:

| Error | Stable code | Use |
| --- | --- | --- |
| `SlcmAuthenticationError` | `AUTHENTICATION_FAILED` | Rejected credentials/tokens, unsafe OIDC response. |
| `SlcmNetworkError` | `NETWORK_ERROR` | Exhausted transport, timeout, 429, or 5xx failure. |
| `SlcmProtocolError` | `PROTOCOL_ERROR` | Unexpected HTML, redirect, endpoint payload, or missing invariant. |
| `SlcmInvalidArgumentError` | `INVALID_ARGUMENT` | Invalid caller input or configuration. |

Do not expose provider HTML, credentials, cookies, authorization codes, or token
values inside errors.

## Protocol invariants

### Login

- Flow: OpenID Connect Authorization Code with PKCE S256.
- Keycloak login form action is dynamic and must be parsed from HTML.
- Preserve Keycloak cookies between login-page GET and credential POST.
- Credential POST uses `redirect: "manual"`; success is HTTP 302.
- Validate the returned `state` exactly.
- Validate login form and callback origins before transmitting credentials or
  accepting a code.
- Never log username, password, cookies, authorization code, or token values.

### Authenticated SLCM requests

Every authenticated SLCM request requires both:

```http
Authorization: Bearer <access_token>
x-app-token: <userToken>
```

The `x-app-token` comes from `data.userToken` at
`GET /akademik/api/user`. OAuth access alone is insufficient.

When access is near expiry, refresh OAuth tokens and fetch a fresh
`x-app-token`. If a read request receives 401/403, refresh and retry once.

### Active period

The only source of truth is:

```text
GET /akademik/api/v1/class/period
```

The SDK loads this authenticated summary during login and stores its first
period as `session.activePeriod`.

`GET /akademik/api/v1/shared/all-periods` is only the complete list. Its first
item may be a future period. Never infer active period from:

- `all-periods[0]`;
- numeric sorting;
- system date;
- an academic-calendar heuristic.

`getActivePeriod()` must match the authoritative summary identity against the
complete list and fail explicitly if they disagree.

### Offered classes

SLCM has three valid class-table types:

- `internal`
- `group`
- `external`

There is no supported `type=all`. `getSchedule()` fetches all three concurrently
and preserves their category in each public `SlcmClass.type`.

Provider arrays `periods`, `dates_rooms`, and `lecturers` may be `null`; public
results normalize them to `[]`. Trim provider whitespace from user-facing names.

### Classes taken by the user

`GET /akademik/api/course-plan/me/classes` is distinct from class-table data.
It returns only the current course-plan classes.

- Preserve top-level `warning-stale-data` as `warningStaleData`.
- `periods`, `dates`, and `rooms` are parallel arrays. Match by index.
- Reject mismatched array lengths rather than silently pairing wrong meetings.
- Split newline-separated `teachers`, remove list-marker `-`, and trim names.
- Keep `jadwal` as `scheduleText` for display parity and diagnosis.
- Class codes are strings in this endpoint, even though class-table codes are
  numbers. Do not collapse the two public models without evidence.

## Adding a feature

Follow this sequence for every new endpoint or operation.

1. **Collect evidence.** Obtain an actual sanitized response or authoritative
   technical documentation. Record nullable fields, inconsistent types, empty
   states, and top-level warnings.
2. **Define the consumer API.** Add the smallest clear method and public type.
   Do not expose raw provider naming unless preserving it is necessary.
3. **Add the endpoint constant.** Extend `SlcmEndpoints` and
   `SLCM_ENDPOINTS`. Keep it injectable for tests.
4. **Route through authenticated transport.** Reuse session token freshness,
   dual headers, timeout, cancellation, retry, and 401/403 recovery.
5. **Add a strict parser.** Accept `unknown`, validate every required field,
   normalize deliberate provider quirks, and throw `SlcmProtocolError` on
   disagreement.
6. **Export public types.** Update `src/index.ts`; internal helpers remain
   unexported.
7. **Add tests.** Mock every network step. Assert URL, query, both auth headers,
   mapping, null/empty behavior, and at least one malformed response when the
   parser has a meaningful invariant.
8. **Update documentation.** Update README usage, AGENTS contracts/file map if
   relevant, and manual integration docs in `docs/`.
9. **Update live verification carefully.** Add only non-secret booleans/counts.
   Never print full records or tokens.
10. **Run `pnpm run ci`.** Also smoke-test both module formats or package content
    when exports/build configuration changed.

## AI-agent restrictions

AI agents must not:

- treat this old directory name or historical war-service instructions as the
  product specification;
- add application-specific databases, queues, HTTP servers, UI code, or global
  account stores to this SDK;
- use browser automation when the flow is supported by HTTP;
- add a public generic `request()` method as a substitute for typed features;
- guess endpoint payloads, field meanings, active periods, or null behavior;
- use `all-periods[0]` as the active period;
- log or return credentials, cookies, codes, raw tokens, or unredacted provider
  HTML;
- persist credentials or tokens without an explicit product requirement;
- bypass `internal/http.ts` with direct network calls;
- cast unvalidated JSON directly to a public type;
- silently ignore malformed parallel arrays or required fields;
- retry future mutation requests without proving the operation is idempotent;
- weaken OIDC state/origin checks for convenience;
- introduce a runtime dependency when Node's platform APIs are sufficient;
- change public names or result shapes without considering semver impact;
- finish a code change while leaving README, AGENTS, or manual docs inaccurate.

If live behavior contradicts documentation or tests, live sanitized evidence
wins. Fix the parser, fixtures, and every affected document together.

## Testing rules

- Tests must never contact live SLCM.
- Keep `*.test.ts` files directly inside `test/`. The package test script uses a
  flat glob because Node.js 20 does not expand the recursive `**` pattern
  consistently. If tests become nested, replace the runner command with a
  cross-version discovery mechanism in the same change.
- Use injected `fetch` and realistic sanitized fixtures.
- Assert credentials are not leaked through provider error messages.
- Assert OIDC state and redirect validation.
- Assert authenticated calls include both required headers.
- Assert future `all-periods` entries do not override the summary's active
  period.
- Assert provider nulls and whitespace normalize as documented.
- Keep tests deterministic; never depend on current date or timezone.
- Live behavior is checked only through `verify-login.mjs` and user-supplied
  temporary environment variables.

## Code style

- Keep public methods small and intention-revealing.
- Prefer private methods and internal pure parsers over broad utility modules.
- Use `unknown` for untrusted input and caught values; do not introduce `any`.
- Preserve exact optional-property semantics.
- Comments explain protocol reasons and provider quirks, not obvious code.
- User-facing SDK errors are English and stable; internal documentation may
  explain Indonesian provider field names.
- Do not use `console.log` in library source. The verifier may print only safe
  summaries.

## Current endpoint inventory

| Purpose | Method | Path |
| --- | --- | --- |
| OIDC authorization | GET | `https://login.ui.ac.id/realms/main/protocol/openid-connect/auth` |
| OIDC token exchange/refresh | POST | `https://login.ui.ac.id/realms/main/protocol/openid-connect/token` |
| SLCM user and x-app-token | GET | `/akademik/api/user` |
| Active period summary | GET | `/akademik/api/v1/class/period` |
| All periods | GET | `/akademik/api/v1/shared/all-periods` |
| Offered classes | GET | `/akademik/api/v1/class/table` |
| User course-plan classes | GET | `/akademik/api/course-plan/me/classes` |

When adding an endpoint, update this table, `constants.ts`, relevant manual docs,
and tests in the same change.
