# Manual SLCM integration

This directory documents how to integrate with SLCM directly, without using
`slcm-sdk`. It describes the raw HTTP protocol and provider payloads rather than
the package's public abstractions.

The values and response shapes reflect verified SLCM behavior at the time of
implementation. SLCM is an external service and can change without notice.

## Guide

1. [Authentication](authentication.md)
   - OIDC Authorization Code + PKCE
   - Keycloak form submission and cookies
   - OAuth tokens and `x-app-token`
   - token refresh
2. [Periods and offered schedules](periods-and-schedules.md)
   - authoritative active period
   - complete period list
   - `internal`, `group`, and `external` class tables
3. [User course-plan classes](course-plan.md)
   - classes actually taken by the logged-in user
   - meeting and teacher normalization
   - stale-data warning
4. [Reliability and security](reliability-and-security.md)
   - timeouts, retries, cancellation, validation, secret handling, and testing

## End-to-end flow

```text
OIDC authorization page
  -> dynamic Keycloak credential form
  -> authorization code
  -> OAuth token exchange
  -> GET /akademik/api/user
  -> x-app-token
  -> GET /akademik/api/v1/class/period
  -> active period
  -> authenticated academic endpoints
```

Every authenticated academic request requires both:

```http
Authorization: Bearer <access_token>
x-app-token: <data.userToken from /akademik/api/user>
```

## Endpoint inventory

| Purpose | Method | URL |
| --- | --- | --- |
| OIDC authorization | GET | `https://login.ui.ac.id/realms/main/protocol/openid-connect/auth` |
| OAuth token exchange/refresh | POST | `https://login.ui.ac.id/realms/main/protocol/openid-connect/token` |
| User metadata and x-app-token | GET | `https://slcm.ui.ac.id/akademik/api/user` |
| Active period summary | GET | `https://slcm.ui.ac.id/akademik/api/v1/class/period` |
| All academic periods | GET | `https://slcm.ui.ac.id/akademik/api/v1/shared/all-periods` |
| Offered classes | GET | `https://slcm.ui.ac.id/akademik/api/v1/class/table` |
| Classes taken by user | GET | `https://slcm.ui.ac.id/akademik/api/course-plan/me/classes` |

## Important distinction

The class-table endpoint returns classes offered to the account, including
classes the user did not take. The course-plan endpoint returns only the classes
currently taken by the user. These payloads have different field names and
types and must not be treated as one raw model.
